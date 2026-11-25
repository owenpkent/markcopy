# Binary viewers and triage tools: prior art for MarkCopy

**Status: research note, 2026-11-24.** This note looks at the tools people use to inspect executables and packages, for two things: what they show that MarkCopy's read-only [executable and package previews](guide/files.md) do not, and where the line falls between a metadata preview and real analysis. Claims with a source are cited inline. Claims that could not be confirmed say so. Versions and prices were current on the date above.

## What MarkCopy already shows

For a PE file (`.exe`, `.dll` and the like):

- the version block and the manifest
- type, architecture, subsystem, SHA-256, and build time (or "not recorded" for a reproducible build)
- the loader mitigations (ASLR, DEP, Control Flow Guard and the rest)
- the PDB path
- each section with its read, write and execute flags
- imported DLLs, each with a count of its functions and whether it is delay-loaded (the function names are counted, not decoded), and exports
- the size of any data appended after the image
- the embedded Authenticode signature's signer, issuer and validity dates, which are not verified

For a package, it shows each format's metadata, dependencies, which maintainer scripts exist, the file list, signer names, and a File section with the SHA-256. An Android package's signature section names each recognized signing scheme (v1, v2, v3 and v3.1, for example "APK Signature Scheme v2").

Everything is read as bytes in bounded ranges. The metadata reader fetches at most 256 distinct 64 KiB pages (16 MiB) per file, and the SHA-256 pass reads the whole file only up to 256 MiB. A large installer can therefore be previewed without most of its bytes being read. Nothing is run, installed or verified.

## The tools

**Deep reverse engineering.** These tools take a binary apart instruction by instruction. They are the opposite end of the scale from a metadata preview.

- [Ghidra](https://github.com/NationalSecurityAgency/ghidra) (NSA, Apache-2.0, version 12.2 released 2026-10-22) disassembles and decompiles many architectures, and includes free course material in [`GhidraDocs/GhidraClass`](https://github.com/NationalSecurityAgency/ghidra/tree/master/GhidraDocs/GhidraClass).
- [IDA Free](https://hex-rays.com/pricing) handles x86 only. IDA Pro is a paid subscription.
- [Binary Ninja](https://binary.ninja/free) has a local free tier for four architectures. Its Cloud tier uploads the binary to the vendor.
- [rizin](https://rizin.re) and its GUI [Cutter](https://cutter.re), and [radare2](https://rada.re), are free command-line frameworks.

**Quick inspection.** These are the closest to MarkCopy's previews.

- [Detect It Easy](https://github.com/horsicq/Detect-It-Easy) (MIT) identifies the format, compiler, linker, language and packer or protector, and flags high entropy.
- [PE-bear](https://github.com/hasherezade/pe-bear) (GPL-2.0) is a structural PE viewer that copes with malformed files.
- [pestudio](https://www.winitor.com) leads with suspicious indicators. Its current license terms were not confirmed.
- [CFF Explorer](https://ntcore.com/explorer-suite/) is a long-standing freeware PE editor. Its maintenance status was not confirmed.
- Sysinternals [sigcheck](https://learn.microsoft.com/en-us/sysinternals/downloads/sigcheck) shows version info, the full certificate chain, catalog signing, the manifest, hashes and entropy.
- The libraries [pefile](https://github.com/erocarrera/pefile) (Python, MIT) and [LIEF](https://github.com/lief-project/LIEF) (Apache-2.0) parse the same structures.

**Hex editors.** [ImHex](https://github.com/WerWolv/ImHex) (GPL-2.0) and [010 Editor](https://www.sweetscape.com/010editor/) (paid) both lay a file's structure over its bytes. ImHex does it with a pattern language, 010 Editor with binary templates. [HxD](https://mh-nexus.de/en/hxd/) is a free, simple editor.

**Packages.** [7-Zip](https://www.7-zip.org) opens most installer and archive formats. [lessmsi](https://github.com/activescott/lessmsi) and Orca read `.msi` tables. [jadx](https://github.com/skylot/jadx) and [apktool](https://apktool.org) unpack Android packages.

**Malware triage.** [capa](https://github.com/mandiant/capa) infers what a program can do and maps it to MITRE ATT&CK. [YARA](https://virustotal.github.io/yara/) matches rules. VirusTotal shares uploaded files with partner companies, so it is no place for a confidential file.

## Candidate additions

These are all static reads that fit the current design: bounded, read-only, and nothing verified. Some reuse bytes the previews already fetch. Others need more reads, and the read limits above apply to them, so each one notes its cost.

**Executable preview:**

1. **Entropy per section and for the whole file.** Detect It Easy and sigcheck both show it, and it is the most useful of these additions. Entropy measures how evenly the bytes are spread. A section near 8 bits per byte is consistent with packed or encrypted data, but an ordinary lookup table holding every byte value equally often also scores exactly 8. So show the number with that explanation, and never call the file packed or encrypted. Cost: the whole-file figure needs every byte, so share the existing SHA-256 pass where it runs, and above the 256 MiB hash limit either leave it out or label it clearly as a sample. Per-section figures need each section's bytes, which the 16 MiB metadata budget may not cover for a large image. Cap them the same way.
2. **Import hash (imphash).** The MD5 of the ordered, normalized import names, a standard way to group related builds ([Mandiant's definition](https://cloud.google.com/blog/topics/threat-intelligence/tracking-malware-import-hashing/)). The current reader does not keep the names: it records each DLL, a count of its functions, and whether it is delay-loaded. So this needs bounded decoding of the normal (not delay-loaded) imports in order, with names lowercased and imports by ordinal written the way the definition does it. Two files with the same DLLs and counts can import different functions, so a hash built from counts would be wrong. Check the result against `pefile`'s `get_imphash()` on real files before shipping it.
3. **Rich header.** The undocumented block between the DOS stub and the PE header that records the compiler and linker build IDs, plus its hash. Microsoft's [PE format](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format) page does not document it, so cite a community reference for the layout.
4. **Signature details.** Add the timestamp countersignature, the certificate thumbprint and the digest algorithm to the signer, issuer and dates already shown. Keep saying "not verified": checking the chain and revocation needs a trust store.
5. **Warnings for odd layouts.** Examples: a section that is both writable and executable, an entry point outside every section, a raw size far from the virtual size, a header checksum that does not match, TLS callbacks, and an original file name that differs from the name on disk. Each is a fact about the bytes, stated as such.
6. **The type of appended data.** Identify what follows the image (ZIP, CAB, MSI, another PE, the end of a certificate table) by its first bytes, instead of only its size. Its entropy has the same cost and caveats as item 1.

**Package preview:**

1. The signing certificate's subject read from an APK's v2 or later signing block (the scheme names are already shown), and counts of signed and unsigned entries in a JAR.
2. Executables embedded in a package: how many there are, and the largest files.
3. Compression ratio, as a rough hint at packing.

## Out of scope

These need real analysis, a maintained database or the network, and would invite the question "is it malware?":

- packer and protector names from a signature database (entropy and a short, explainable heuristic are the honest version)
- capa-style capability inference, or anything that needs disassembly
- malware verdicts, and lookups on VirusTotal or any other service, which would also send a fingerprint of the user's file off the machine
- full certificate-chain or revocation checks
