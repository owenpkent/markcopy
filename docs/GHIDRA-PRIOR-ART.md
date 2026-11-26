# Ghidra's binary readers: prior art for MarkCopy

**Status: research note, 2026-11-24.** We read the NSA's Ghidra reverse-engineering
suite for how it parses the formats MarkCopy previews, how it handles hostile input,
and what is worth borrowing. Source: a local clone at commit `5e553af53d` (2026-11-24). Paths
are relative to the Ghidra repository. Two shorthands are used:

- `Base` = `Ghidra/Features/Base/src/main/java/ghidra`
- `FF` = `Ghidra/Features/FileFormats/src/main/java/ghidra/file/formats`

Line numbers are for that commit. Claims marked _(inferred)_ come from reading around
the code, not from a confirmed path. The constants quoted were checked against the
source.

## Summary

Ghidra is a strong reference for **what to extract** and a weak one for **how to
survive hostile input**:

- **Extraction.** Ghidra parses more of PE and Mach-O than MarkCopy does, and it reads
  Go build info.
- **Robustness.** MarkCopy is already ahead of Ghidra in four ways:
  - Its caps are tighter: a 512-byte `cstr`, a fixed resource-walk depth, and linear
    export counting.
  - It bounds decompression output and the number of pages read.
  - It runs in a worker with a heap cap and a timeout.
  - It has a fuzzing plan.
- **What Ghidra relies on instead:**
  - A soft cache and the JVM heap.
  - Cancellation by the user rather than timeouts.
  - Libraries (Apache commons-compress) or subprocesses (`7z`, `cabarc`, a child JVM for
    DMG) for most container formats.

Ghidra has no fuzz tests and no checked-in binary fixtures for these readers.

The lessons worth taking are:

1. **Tolerance of damage.** When one entry is bad, Ghidra skips that entry and keeps
   the rest of the table. MarkCopy often drops the whole table.
2. **A short list of metadata additions**, chiefly:
   - Go build info
   - Mach-O and fat headers
   - the PE Rich header and load config
3. **A few ELF and PE edge cases** that MarkCopy does not handle yet.
4. **Cryptography.** Ghidra decrypts but verifies no signatures. MarkCopy should only
   detect and label encryption, show more certificate detail, and later check stored
   digests. It should not prompt for passwords, decrypt, or claim a signature is valid.

## Portable Executable (PE)

Ghidra's PE code lives in `Base/app/util/bin/format/pe/`. It is loaded by
`Base/app/util/opinion/PeLoader.java`.

### What MarkCopy already matches or beats

[read.ts](../src/pe/read.ts) already covers most of what Ghidra extracts:

- headers, sections and mitigation flags
- imports and delay imports
- exports, with a real function count
- the CodeView RSDS record (the PDB path and GUID) and REPRO entries
- the CLR header and runtime string
- the Authenticode signer
- overlay, version, icon and manifest

In a few places MarkCopy does better:

- **Machine names.** Ghidra's `pe/MachineName.java` prints the machine as a decimal
  number. MarkCopy prints a name.
- **Debug type 16 (REPRO).** Ghidra's `DebugDirectoryParser` stops at type 11.
  MarkCopy recognises 16.
- **Export count.** Ghidra matches export names to functions with a nested loop
  (`ExportDataDirectory.java`), so the work is quadratic in the number of exports.
  MarkCopy counts in one pass.
- **Resources.** Ghidra stops resource loops with a set of visited directory offsets
  (`pe/resource/ResourceDirectory.java:64-68`). The set is a static field, but the
  `ResourceDataDirectory` constructor replaces it with a new one before each walk
  (`pe/ResourceDataDirectory.java:175`), so files do not share it. There is no depth
  cap. MarkCopy walks a fixed three levels.
- **Strings.** Ghidra reads ASCII strings with no length cap. MarkCopy caps them.

### Defensive patterns worth copying

- **Count caps.** `NTHeader.MAX_SANE_COUNT = 0x10000` (`pe/NTHeader.java:42`) caps:
  - symbols
  - import descriptors and imports
  - export functions and names
  - the CLR version string length

  There are two smaller caps: at most 20 TLS callbacks (`pe/TLSDataDirectory.java:76`),
  and the data-directory count is forced to 16 when it is larger or negative. MarkCopy's
  own caps (`MAX_SECTIONS` 96, `MAX_IMPORTS` 1024, `MAX_EXPORT_SLOTS` 0x10000) are in
  the same range.

- **One bad directory does not stop the rest.** Each data directory is parsed in its
  own try/catch and logged (`OptionalHeader.java`). MarkCopy does the same per
  directory through `attempt()`.

### Gaps in MarkCopy that Ghidra handles

All of these were checked against MarkCopy's source.

1. **One bad entry loses the whole table.**
   - In [read.ts:697-722](../src/pe/read.ts#L697-L722) (`readImports`), `need(name)`
     throws when a single library-name RVA cannot be resolved. The partial list is
     thrown away and the whole import table becomes a warning.
   - Ghidra skips only that descriptor and continues.
   - The same applies to delay imports, exports, and the debug-directory loop.
   - Fix: give each entry its own try/catch, keep what was read, and add one warning
     that gives the number of entries skipped.
2. **Lookup-table fallback.**
   - MarkCopy uses `lookup || address`, so a lookup RVA that is nonzero but invalid
     throws.
   - Ghidra falls back to `FirstThunk` (the address table) when `OriginalFirstThunk`
     (the lookup table) does not resolve.
3. **`toOffset` ignores `VirtualSize`.**
   - [read.ts:347-356](../src/pe/read.ts#L347-L356) tests only `rva - va < rawSize`.
   - Windows and Ghidra map only `min(rawSize, align(VirtualSize, SectionAlignment))`.
     A virtual size of 0 means "use the raw size".
   - When the raw data is larger than the virtual size, MarkCopy can resolve an RVA
     into padding, or into bytes that belong to another section.
4. **A truncated section table kills the preview.** The table is read in one call
   ([read.ts:315](../src/pe/read.ts#L315)), so a file cut off inside it shows nothing,
   not even the headers MarkCopy already has. Ghidra clamps and carries on. Fix: clamp
   the section count to what fits in the file, and warn.
5. **Long section names.**
   - MinGW and GCC images name sections `/4`, `/21` and so on, meaning "offset into
     the COFF string table". MarkCopy shows `/4` as the name.
   - Ghidra resolves the name at
     `pointerToSymbolTable + numberOfSymbols * 18 + n` (`pe/FileHeader.java`,
     `pe/SectionHeader.java`).
   - This costs one bounded `cstr` read.

### Metadata Ghidra reads that MarkCopy does not

| Item                                                                                           | Ghidra source                                                                                        | Cost                                                                              | Value                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Rich header: compiler and linker product ids, builds and use counts                            | `pe/RichTable.java` (searches up to `MAX_TABLE_SEARCH_COUNT = 100` dwords), `pe/rich/CompId.java`    | Low. It sits between the DOS header and `e_lfanew`, and no pointers are followed. | High, for knowing which toolchain built the file                                                               |
| Load config: security cookie, `GuardFlags` and code integrity                                  | `pe/LoadConfigDirectory.java`. Each field is read only if it lies within the structure's own `Size`. | Low: one bounded struct                                                           | Medium. It shows that CFG is really present. Today the "Control Flow Guard" row reflects only the header flag. |
| More DllCharacteristics bits: NO_SEH, NO_ISOLATION, NO_BIND, WDM_DRIVER, TERMINAL_SERVER_AWARE | `pe/DllCharacteristics.java`                                                                         | Trivial                                                                           | Medium (NO_SEH especially)                                                                                     |
| COFF characteristics: RELOCS_STRIPPED, DEBUG_STRIPPED                                          | `pe/FileHeader.java`                                                                                 | Trivial                                                                           | Low                                                                                                            |
| Count of forwarded exports, entries whose RVA lies inside the export directory                 | `pe/ExportDataDirectory.java`                                                                        | Low                                                                               | Medium                                                                                                         |
| CLR metadata: version, stream list (`#~` or `#-`), entry-point token, ReadyToRun               | `pe/cli/CliMetadataRoot.java:82-98`                                                                  | Low. The stream count needs a cap.                                                | Medium                                                                                                         |
| TLS callback count                                                                             | `pe/TLSDataDirectory.java:76`                                                                        | Low. Needs a VA-to-offset step.                                                   | Medium, for triage                                                                                             |
| Extra machine types: MIPS, Alpha, SH, PowerPC and others                                       | `pe/MachineConstants.java`                                                                           | Trivial                                                                           | Low                                                                                                            |

Not in Ghidra either: checksum validation and section entropy. Leave out exception
tables, relocations, CHPE/ARM64EC metadata and the symbol tables. They are expensive and
add little to a preview.

## ELF

The ELF code lives in `Base/app/util/bin/format/elf/`. Note parsing is in its `info/`
folder.

[elf.ts](../src/pkg/elf.ts) already reads these, mostly through `attempt()`, so a bad
table becomes a warning rather than a failure:

- the header, segments and sections
- the dynamic table
- the interpreter
- notes: GNU build-id, the ABI tag, and the Go build ID
- `.comment`, `.gnu_debuglink` and `.modinfo`
- AppImage detection
- the RELRO, PIE and NX flags

### Ghidra's header defenses

All in `elf/ElfHeader.java`:

- **Offset limit.** `FILE_OFFSET_HARD_LIMIT = 0x7FFFFFFFFFFF` (:41). An `e_phoff` or
  `e_shoff` above the limit or past the end of the file is logged and zeroed, and the
  matching count is set to 0.
- **Extended counts.**
  - `PN_XNUM` (phnum 0xffff) takes the real program-header count from section 0's
    `sh_info`.
  - `e_shnum >= 0xff00` is treated as invalid.
  - `SHN_XINDEX` (0xffff) takes the section-name string table index from section 0's
    `sh_link`.
  - Section 0 must be `SHT_NULL` before Ghidra trusts any of these.
- **Counts that cannot fit.** `constrainHeaderCount` clamps each count to what the
  file can hold, and tolerates one truncated trailing entry.
- **Wrong entry size.** If one table's entry size is wrong, Ghidra falls back to the
  other table.
- **Note caps.** Note names are capped at 1024 bytes and descriptions at 1 MiB
  (`elf/info/ElfNote.java:40-41`).

### Gaps in MarkCopy

1. **`PN_XNUM` is not handled.**
   [elf.ts:255](../src/pkg/elf.ts#L255) takes `min(phnum, 256)` at face value. The
   extended count in section 0's `sh_info` is the cheap fix.
2. **Section 0 is not checked.** [elf.ts:328-336](../src/pkg/elf.ts#L328-L336) uses
   section 0's size and link for the extended section count and string index without
   first checking that section 0 is `SHT_NULL`.
3. **Note alignment** _(inferred, rare)_. MarkCopy picks 8-byte note alignment when
   the segment's `p_align` is 8. A merged `PT_NOTE` holding 4-aligned notes in an
   8-aligned segment would then be misread.
4. **AppImage payload offset** _(inferred, rare)_. The offset is computed from
   `h.shnum`, not from the extended section count.

### Metadata worth adding

- **Go build info.** This is the largest user-visible gain for Linux and Windows
  binaries.
  - It gives the Go version, the main module path and version, the dependency list
    and the build settings.
  - Parser: `Base/app/util/bin/format/golang/GoBuildInfo.java`.
    - The magic is `\xff Go buildinf:`.
    - Ghidra looks in the `.go.buildinfo` section for ELF and `go_buildinfo` for
      Mach-O. For PE it looks in the first 512 bytes of `.data`.
    - Strings are either inline or reached through two pointers.
    - The module text is checked against start and end sentinels.
  - Ghidra reads the string lengths without a bound (`readRawGoString`). MarkCopy
    must cap the length, the module text and the dependency count.
- **GNU property note** (`elf/info/NoteGnuProperty.java`). It carries the CET
  (IBT/SHSTK) and Arm BTI hardening bits. Ghidra does not decode those bits, so take the
  values from the gABI. The code also carries a TODO saying its walk to the next
  property is untested, so test this on real binaries.
- **`.gnu_debugaltlink`** and the **debuglink CRC32**
  (`elf/info/GnuDebugAltLink.java`, `GnuDebugLink.java`). Both are cheap.
- **Symbol versioning** (`GnuVerneed`, `GnuVerdef`) would show the minimum glibc
  version. It costs a section walk. Defer it.
- **Rust.** Ghidra detects Rust in ELF files
  (`Ghidra/Features/Rust/.../sourcelanguage/ElfRustSourceLanguage.java`, `existsIn`).
  It first looks for a `rustc version` string in `.comment`, and only then falls back
  to searching `.rodata`. The first check is the cheap one MarkCopy could copy: it
  already reads `.comment` for the Compiler row. The `.rodata` search costs more and
  is not needed for a preview.

## Mach-O and universal (fat) binaries

MarkCopy only sniffs Mach-O, to tell binary `.obj` files apart
([modelSniff.ts](../src/webview/modelSniff.ts)), and never parses it. Mach-O files
reach users inside DMG and `.pkg` installers and as bare command-line tools, so a
header reader would fill a visible gap.

### What to read

Every item is a fixed-size read from `Base/app/util/bin/format/macho/`:

- **Header** (`MachHeader.java`)
- **UUID** (`commands/UuidCommand.java`)
- **Platform, minimum OS and SDK**: `BuildVersionCommand.java`, and
  `VersionMinCommand.java` for older binaries
- **Linked dylibs and rpaths**: `DynamicLibraryCommand`, `RunPathCommand`
- **Code signature present**: `LC_CODE_SIGNATURE` (0x1d) through
  `LinkEditDataCommand.java`
- **Encryption**: `cryptid` in `EncryptedInformationCommand.java`
- **Fat arch list**: `ubi/FatHeader.java`, always big-endian

Skip entitlements and hardened-runtime flags: they need the code-signature blob
parser, which is much heavier.

### Caps

Copy Ghidra's caps:

- `MAX_LOAD_COMMANDS = 32_768` (`MachHeader.java:54`)
- `nfat_arch <= 0x1000` (`ubi/FatHeader.java:58`)

Do not copy the load-command walk. `MachHeader.java:174-185` adds each `cmdsize` to the
offset without checking it. MarkCopy must check every `cmdsize` itself:

- it is at least 8
- it is 4- or 8-aligned
- it fits inside `sizeofcmds` and inside the file

Ghidra wraps each command's parse failure in a `CorruptLoadCommand`
(`commands/LoadCommandFactory.java`) and carries on. That is the same
keep-the-rest pattern as for PE above.

### Telling fat binaries from Java classes

Fat binaries and Java class files share the magic `0xCAFEBABE`, which
[jar.ts](../src/pkg/jar.ts) already uses for class files. To tell them apart:

- In a fat binary the next u32 is a small architecture count (at most 0x1000).
- In a class file that u32 holds the minor and major version.
- The two ranges can overlap for small values, so also check that the arch table's
  offsets and sizes lie inside the file.

## Containers and installers

Ghidra does not parse deb, RPM, Alpine, OLE/CFB or MSI, so there is nothing to
compare there.

It does read ar archives, as COFF archives (static libraries).
`Base/app/util/bin/format/coff/archive/CoffArchiveHeader.java` checks the `!<arch>`
header and walks the member headers, including the long-name table.
`FF/coff/CoffArchiveFileSystem.java` then lists the members, leaving out only the two
special entries named `/` and `//` (`CoffArchiveMemberHeader.isCOFF`, :290-293).
Despite its name, that check looks at the member's name, not at whether its contents
are a COFF object, so any member is listed, including a Debian package's
`debian-binary`.

So both projects list ar members generically. What Ghidra lacks is what
[ar.ts](../src/pkg/ar.ts) and [deb.ts](../src/pkg/deb.ts) add for a Debian package:
requiring `debian-binary` first, then unpacking `control.tar.*` and reading its fields.
The long-name table is something MarkCopy's reader does not need for a `.deb`, whose
member names are short.

For the formats it does open, it hands the work to a library or a subprocess:

- **zip, tar, cpio, 7z, gzip, bzip2 and xz** go through Apache commons-compress.
- **Encrypted zip** goes through zip4j.
- **`7z` and `cabarc`** are run as subprocesses.
- **DMG** is copied whole to a temp file and parsed in a child JVM
  (`FF/ios/dmg/DmgServerProcessManager.java`):
  - 1 GB heap
  - 20 s watchdog per command
  - restarted after 25,000 commands

Ghidra's container caps:

- **File entries:** at most 500,000 per file system (`MAX_FILEENTRY_COUNT`,
  `Base/formats/gfilesystem/FileSystemIndexHelper.java:38`).
- **Symlinks:** recursion depth at most 10. A cpio symlink target is read only if it
  is under 64 KiB (`FF/cpio/CpioFileSystem.java:42`).
- **Decompression:** no cap on output size or ratio for gzip, bzip2, xz or squashfs.
  A decompression bomb spools to the cache _(inferred from the absence of any
  limit)_.
- **Nesting:** no limit on containers inside containers. A search found no depth
  constant.

Against that:

- **Duplicates and decompression.** MarkCopy's caps on zip entries, names and
  duplicates ([zipRange.ts](../src/pkg/zipRange.ts)) and its bounded inflate, zstd and
  xz ([decompress.ts](../src/pkg/decompress.ts)) are stricter.
- **AXML.** MarkCopy has pool, depth, element and chunk caps
  ([axml.ts](../src/pkg/axml.ts)). Ghidra's binary Android XML parser is a vendored
  class with no visible caps. Its internals are not in the repository, so they were not
  reviewed.
- **DMG.** Ghidra's koly offset check (`FF/ios/dmg/UDIFHeader.java`, `hasGoodOffsets`)
  is matched in [dmg.ts](../src/pkg/dmg.ts) by the ranged reader's bounds check plus
  a try/catch.
- **CFB.** MarkCopy's chain-loop detection and visited set in
  [cfb.ts](../src/pkg/cfb.ts) have no Ghidra counterpart.

### Formats Ghidra reads and MarkCopy might add

- **cpio (newc), inside RPM payloads.** MarkCopy already lists an RPM's files: the
  Contents table is built from the header's directory and file-name tags
  ([rpm.ts:764-825](../src/pkg/rpm.ts#L764-L825)), with no decompression. Reading the
  payload would add something different: the members that are actually in the archive,
  and whether they match what the header claims. Do that only if a mismatch check is
  wanted.
  - A newc header is 110 ASCII bytes. MarkCopy already decompresses gzip, xz and zstd.
  - Take two choices from Ghidra: the 64 KiB symlink cap, and keeping a partial listing
    when the archive is truncated.
  - Ghidra's cpio reader is bounded by the shared 500,000-entry cap: each member goes
    through `fsIndex.storeFile` or `storeSymlink` (`FF/cpio/CpioFileSystem.java:63-67`),
    and the index throws past `MAX_FILEENTRY_COUNT`
    (`Base/formats/gfilesystem/FileSystemIndexHelper.java:470`). MarkCopy would set a
    much lower cap, in line with the 200,000 files `rpm.ts` already allows.
- **Android DEX header summary**: format version, class and method counts, and
  multidex. A cheap addition to the APK preview.
- **cab file listing.** The CFHEADER, CFFOLDER and CFFILE records need no LZX
  decompression to list. Ghidra shells out to `cabarc` instead.
- **squashfs (snap, AppImage).** Medium to high cost. Ghidra's reader
  (`FF/squashfs/`) caps inodes at 500,000 but decompresses with no output cap.
- **7z and ext4.** High cost, low value for a package preview. Ghidra's ext4 extent
  tree recursion has no depth cap or visited set _(inferred)_, which is a reminder to
  add one if MarkCopy ever reads a tree like it.

## Reader layer, detection and errors

### The reader layer

Ghidra reads through `ByteProvider` (`Base/app/util/bin/ByteProvider.java`), which plays
the same role as MarkCopy's `ByteSource`.

Ghidra and MarkCopy agree on:

- **Page size and cache.** `FileByteProvider` uses 64 KiB buffers held by a soft
  reference map, with a few recent buffers pinned. MarkCopy's page cache uses the same
  page size, and its hard budget on the number of pages is stricter.

Ideas to take:

- **A validity check.** `ByteProvider` has `isValidRange(index, length)` (:106-113),
  which allows a zero-length read at EOF and compares unsigned. A non-throwing
  `RangeReader.isValid(offset, length)` would let probes check without a try/catch.
- **Sub-range views.** `ByteProviderWrapper` is a bounded window over a parent, and
  `RangeMappedByteProvider` joins scattered ranges into one stream. A
  `RangeReader.slice(offset, length)` that shares the page cache would serve nested
  members: a deb's `data.tar`, an RPM payload, a DMG partition.
  - It could also present CFB sector chains as one stream _(inferred)_.
- **A count helper.** `BinaryReader` turns a uint32 that does not fit into an
  `InvalidDataException` (`readNextUnsignedIntExact`, :746), and caps array counts. A
  `readCount(maxBytes, stride)` helper that divides by the stride before allocating
  would replace the scattered `count * stride` checks.

### Detection

Ghidra probes for containers in `Base/formats/gfilesystem/factory/FileSystemFactoryMgr.java`:

- **Probes are sorted by priority.** `FileSystemInfo` defines HIGH 10, DEFAULT 0 and
  LOW -10.
- **Cheap probes run first.** "Bytes only" probes see at most the first 64 KiB.
  Random-access probes, for formats such as DMG whose signature is in a trailer, run
  after them.
- **Every match is kept.** `probe()` collects all matching formats. A
  `FileSystemProbeConflictResolver` then picks one, or asks the user.
- **A probe that throws is logged and skipped**, so one bad probe never stops
  detection.

The loaders for executables work the same way (`Base/app/util/opinion/LoaderService.java`):

- Every loader's match is kept.
- Loaders are ordered by tier, then by priority within the tier.
- The raw "Binary" loader runs only when nothing else matched.

[index.ts](../src/pkg/index.ts) instead returns the first match in a chain of
`if` checks on magic numbers. For polyglot files (a zip that is also an APK, MSIX or
VSIX, a PE with a zip appended, a DMG whose start looks like gzip), a table of
probes would give a defined winner plus an "also looks like X" warning. Each entry
would have a name, a priority, a head check and an optional tail check. The probes
would run over one shared head read, each inside a try/catch.

### Errors and limits

- **Warnings alongside the result.** Ghidra's loaders return a `MessageLog` of
  warnings alongside the result. MarkCopy's `warnings` list and its `ReadError` /
  `PackageError` split are the same model.
  - The gap is the per-entry tolerance described under PE. A reader that reaches a bad
    table midway should return what it read plus a "stopped at X" warning.
- **Limits.** Ghidra has no per-parse timeout or memory cap. It relies on cooperative
  cancellation through `TaskMonitor` and on the JVM heap. MarkCopy's worker
  ([isolate.ts](../src/isolate.ts)) is stricter, and there is nothing to copy here.
- **Temp files.** Ghidra's `FileCache` keeps files under 2 MiB in memory and writes
  larger ones to disk, obfuscated so virus scanners leave them alone. MarkCopy writes
  nothing to disk and should keep it that way.

## Cryptography: encryption, passwords and signatures

### What Ghidra does

Ghidra decrypts, because it is a reverse-engineering tool. It verifies no signatures.

- **Passwords.** `Base/formats/gfilesystem/crypto/`:
  - `CryptoProviders` creates one `CryptoSession` per open operation. Nested
    containers share it, so a password that opened one container is tried on the next.
  - There are three password providers: an in-memory cache, a text file passed on the
    command line (`-Dfilesystem.passwords`), and a dialog.
  - The cache indexes each password by FSRL, file name and the file's MD5
    (`CachedPasswordProvider.java:50-63`). A password is therefore offered to any file
    with the same name or content.
  - Passwords are held in a `char[]` wrapper that is zero-filled on close
    (`Framework/Generic/.../auth/Password.java:73`), and are never written to disk.
- **Decryption.**
  - Encrypted zip entries go through zip4j. `SevenZipFileSystem` tries each password
    in the session against the archive.
  - iOS firmware (img3, img4) is decrypted with AES. The key and IV come from XML key
    files the user supplies (`FF/../crypto/CryptoKeyFactory.java`). These are plain
    files, not a keystore.
- **Signatures.**
  - PE: `pe/SecurityCertificate.java` reads the WIN_CERTIFICATE header and type and
    keeps the PKCS #7 blob as raw bytes. It does not decode the blob, name the signer
    or verify anything.
  - Mach-O: `macho/commands/codesignature/` lays out the SuperBlob and CodeDirectory
    structures for display. It computes no hashes and does not read the CMS signature.
  - APK: the APK opens as a plain zip, with no signature handling _(inferred)_.
- **Crypto detection.** There is no FindCrypt-style analyzer for crypto constants in
  the tree. MD5 is used only as a cache key and content id.

### What MarkCopy does

MarkCopy already reads more signature detail than Ghidra:

- **PE Authenticode.** [signer.ts](../src/pe/signer.ts) walks the PKCS #7. It finds
  the certificate the SignerInfo names and shows the subject, organization, issuer and
  validity dates.
- **Other signed formats.** The same reader names signers for MSI, NuGet, JAR, APK
  v1 and macOS `.pkg` (xar).
- **RPM.** Shows the OpenPGP key ID and algorithm.
- **Status wording.** Every signature status reads "present, not verified by
  MarkCopy" ([render.ts:206](../src/pe/render.ts#L206),
  [signature.ts:33](../src/pkg/signature.ts#L33)).
- **Encrypted DMG** (`encrcdsa`, `cdsaencr`) is detected and labelled
  ([dmg.ts:74-77](../src/pkg/dmg.ts#L74-L77)).
- **Encrypted zip entries** are flagged (general-purpose flag bits 0 and 6,
  [zipRange.ts:340](../src/pkg/zipRange.ts#L340)).

Gaps:

- **Zip encryption strength.** The WinZip AES extra field (0x9901) is not read, so
  AES-128, AES-192 or AES-256 and the AE-1 or AE-2 version are never shown, and
  legacy ZipCrypto looks the same as AES.
- **Password-protected Office files.** An encrypted Office file is an OLE file with
  `EncryptionInfo` and `EncryptedPackage` streams. These are not detected, so such a
  file fails to parse instead of being labelled "password protected".
- **APK v2 and v3 signers.** These signatures are detected by block ID only. Their
  certificate is not parsed ([androidApk.ts:223](../src/pkg/androidApk.ts#L223)).
- **Signature details.** No digest algorithm is shown, so a SHA-1 or MD5 signature
  is not marked weak. There is no certificate thumbprint either.
- **Stored digests.** RPM header digests (SHA-256 and SHA3) and Alpine's data hash
  are shown as text, but MarkCopy does not check them.

### What to add, in order

1. **Detect and label encryption.** This is cheap, and it changes no trust claims.
   - Read the 0x9901 field. With it (method 99), show "AES-256 (AE-2)" and so on.
   - Flag bit 6 means PKWARE Strong Encryption, which also sets bit 0 and can keep an
     ordinary compression method (APPNOTE section 4.4.4). Its algorithm is in the
     0x0017 extra field and the decryption header, so show it from there, or say
     "encrypted, scheme undetermined" when that metadata is missing.
   - Method 99 is itself the WinZip AES marker. An entry with method 99 but no 0x9901
     field is inconsistent: label it "encrypted, AES metadata incomplete", since
     without the field neither the key strength nor the AE version is known.
   - Show "ZipCrypto (legacy)" only when bit 0 is set, bit 6 is clear, the method is
     not 99 and there is no 0x9901 field.
   - Detect the OLE encryption streams.
   - Add a summary row, "Encrypted: N of M entries".
   - Never fail the whole preview because some entries are encrypted.
2. **More certificate detail.** This is cheap, because the DER walker exists.
   - Show the digest algorithm, and mark MD5 and SHA-1 as weak.
   - Show the serial number, a SHA-256 thumbprint of the certificate, and the
     signing time from the timestamp countersignature.
   - Parse the APK v2 and v3 signer certificate, again without verifying it.
3. **Integrity checks with exact wording.** These cost more.
   - The RPM header SHA-256 and the Authenticode image hash can be recomputed with
     `node:crypto` inside the worker. The image hash skips the checksum field, the
     certificate-table directory entry and the certificate table, and the reader
     already has those offsets.
   - Name the algorithm and report "the computed SHA-256 matches the stored digest"
     or "the computed SHA-256 differs from the stored digest". Do not give a cause
     for a difference. A changed file is one cause, but a signature record written
     with the wrong digest from the start is another, and with the signature itself
     unverified MarkCopy cannot tell them apart. The same applies to RPM header
     digests.
   - A match says only that the bytes are the ones the stored digest names. It says
     nothing about who signed them or whether to trust them.

### What not to do

- **Do not call a signature "valid" or "trusted".** No green tick either.
  - A self-made certificate can carry any name and still verify mathematically.
  - A trust verdict would also need the chain, revocation, expiry and timestamp
    handling.
  - Keep "not verified" next to any integrity result.
- **Do not prompt for passwords or cache them.** Ghidra's cache shows the cost: it
  creates a store of secrets that then has to be protected.
- **Do not decrypt, and do not load key files.**
- **Do not look up certificate stores, OCSP, CRLs or timestamp servers.** That means
  network access and writes, which MarkCopy's model rules out: a read-only worker with
  a memory cap and a timeout, reading untrusted files and writing nothing to disk.

## Testing

Ghidra tests its reader primitives with JUnit over in-memory bytes:

- `BinaryReaderTest`
- `RangeMappedByteProviderTest`, covering empty, misaligned and sparse reads
- `FileByteProviderTest`
- `FileCacheTest`

Its test resources are text and XML only. No fuzz harness was found, and no binary
format samples are checked in for these readers. It has no tests for its PE parser
beyond one CLI strings test. MarkCopy's
[fuzzing strategy](FUZZING-STRATEGY.md) and its fixtures built in code are already ahead.

Ideas to borrow for MarkCopy's tests:

1. **A boundary matrix for each reader primitive.** Read at:
   - offset 0
   - `size - 1`, `size` and `size + 1`
   - length 0 at EOF (allowed)
   - a negative offset
   - a non-integer offset
2. **Run-on strings.** No NUL before EOF, for `cstr` and for each reader's own string
   scan. Expect a clean error and no hang.
3. **Page-edge reads.** Reads that straddle a 64 KiB page boundary, and reads exactly
   at the page budget.
4. **Probe conflicts.** If detection becomes table-driven:
   - a file that matches two probes has a defined winner
   - a probe that throws does not hide the others
   - no two probes claim the same magic unless the overlap is declared
5. **Count overflow.** A uint32 count near 2^32 multiplied by the stride must give an
   error, not an allocation.
6. **Per-entry tolerance.** A PE whose third import descriptor has a bad name RVA
   still lists the other imports.

## Suggested order

Robustness first, then the additions users would notice most:

1. Per-entry tolerance in the PE import, delay-import, export and debug loops, and a
   clamped section count. Add tests to match.
2. Clamp `toOffset` by the aligned `VirtualSize`.
3. ELF `PN_XNUM`, and the `SHT_NULL` check on section 0.
4. Go build info, for ELF and PE.
5. Long PE section names, the extra DllCharacteristics rows, and the Rich header.
6. A Mach-O and fat header reader, with the caps and checks above. Decide how it is
   told apart from Java class files.
7. PE load config and GuardFlags. GNU property bits (CET, BTI).
8. A DEX summary for APKs. A check of an RPM's payload members against its header's
   file list, if that comparison is wanted (the header list is already shown).
9. Encryption labels (zip AES strength, password-protected Office files), then
   certificate detail and the APK v2/v3 signer, then digest checks (see
   [Cryptography](#cryptography-encryption-passwords-and-signatures)).
10. Table-driven detection with conflict warnings, if polyglot files become a
    real complaint.

### Status

As of 2026-11-26. "Open" means a pull request exists and has not been merged yet.

| Item                                | Pull request                                     | State       |
| ----------------------------------- | ------------------------------------------------ | ----------- |
| 1. Per-entry tolerance              | #263                                             | Open        |
| 2. `toOffset` and `VirtualSize`     | #263                                             | Open        |
| 3. ELF `PN_XNUM` and `SHT_NULL`     | #264                                             | Open        |
| 4. Go build info                    | #265                                             | Open        |
| 5. Section names, flags, Rich       | #268 (on #263)                                   | Open        |
| 6. Mach-O and fat reader            | #267                                             | Open        |
| 7. Load config and GuardFlags       | #269 (on #268)                                   | Open        |
| 7. GNU property bits (CET, BTI)     | #270 (on #264)                                   | Open        |
| 8. DEX summary, RPM payload members | #277 (DEX), #278 (RPM payload)                   | Open        |
| 9. Encryption labels                | #271                                             | Open        |
| 9. Certificate detail, APK signer   | #272                                             | Open        |
| 9. Digest checks                    | #275 (RPM, Alpine), #276 (Authenticode, on #275) | Open        |
| 10. Table-driven detection          | None                                             | Not started |
