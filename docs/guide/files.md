# File information

Look inside an executable or a package without running it. Both pages answer "what is this file?" from the file's own headers and tables, read as bytes, and neither can start the file.

## Reading a file is a step you take

Opening one of these files, which a single click in the Explorer does, shows only the file's name, its size and a **Read this file** button. Nothing inside the file is read until you press the button or run **MarkCopy: Read This File** from the Command Palette (it is enabled while one of these pages is in front). The question is asked again for each file you open: confirming one does not confirm the next. Once a page has been read, a change to the file on disk redraws it without asking again.

The reading does not happen in the extension host, which other extensions share. It runs in a worker thread with a 256 MB heap limit and a 15 second time limit; a file that goes past either ends the worker and the page shows a notice, and VS Code carries on. This limits runaway memory and time. It is not a separate process or an operating-system sandbox, and it does not count memory allocated outside the JavaScript heap, which the readers' own caps on buffers and dictionaries bound instead.

To skip the question, turn off `markcopy.fileInfo.confirm` (see [Commands and settings](settings.md)): the file is then read as soon as it is opened, still in the worker.

## Executable info preview

MarkCopy registers as the editor for `.exe`, `.dll`, `.sys`, `.ocx`, `.scr`, `.cpl` and `.efi` files (either case), so opening one shows a page about the file instead of VS Code's "file is binary" notice (after you press **Read this file**, as above). It is for answering "what is this file?" without running it.

- **Icon.** The file's own icon, above its name: the largest image of the first icon in the file, drawn at up to 48 pixels. A file with no icon of its own (most DLLs) shows none.
- **Version.** The version resource Explorer's Details tab reads: description, product, company, file and product versions, copyright, original file name and any other strings, plus the numeric versions, build flags and language.
- **File.** Type, architecture ("Any CPU" for .NET), PE32 or PE32+, subsystem, size, SHA-256, build time (or "not recorded" for a reproducible build), minimum Windows version, .NET runtime, linker version, image base, entry point, size in memory, header checksum, and any data appended after the program, such as an installer payload.
- **Signature.** Whether an embedded Authenticode signature is present, and the signer, organization, issuer and certificate validity dates it names. **Nothing is verified**: not the signature, the hash, the certificate chain, revocation or expiry, and the page says so. A file can carry a certificate with any name in it, so treat these as the file's claims, and use `Get-AuthenticodeSignature` or Explorer's Digital Signatures tab for a verdict. Files signed through a catalog (many Windows components) show as having no embedded signature.
- **Permissions and protections.** From the manifest, the requested execution level, UI access, DPI awareness and identity; from the headers, ASLR, high-entropy ASLR, DEP, forced integrity and AppContainer, and large address aware for 32-bit files. Control Flow Guard is checked against the image's guard data, not just the header flag, so a file that sets the flag without carrying the data is shown as such. Where the file records them, it also shows stack cookies (/GS), SafeSEH for 32-bit x86, EH continuation metadata, and CET shadow stack compatibility for x64.
- **Debug information, Build tools, Sections, Imports and Exports.** The PDB path and symbol ID, the tools Microsoft's linker recorded building the file (shown only when it left that record, and as a claim, not proof), the sections (long MinGW names such as `.debug_info` are spelled out), each imported library with a count of its functions and whether it loads at start or on first use, and the export count with the first 100 names.
- **Go.** For a program built by the Go toolchain: the Go version, main package and module, the build settings, and the modules it was built from (the first 200, with a count of the rest), as `go version -m` prints them. Files built by other toolchains show no Go section.

The file is **only read as bytes**. It is never run, loaded, or handed to the operating system, and there is no **Open in Default App** row in this preview's menu, because for an executable the default app is the file itself. A file on disk is read in bounded ranges, not loaded whole, with a budget of 16 MiB; the SHA-256 is computed for files up to 256 MB (a larger one shows "Not computed"), and a file on a virtual or remote file system is read whole and limited to 64 MB. A damaged or hostile file produces a notice or a warning, not a crash. Within a table, an entry that points outside the file is left out and the rest are shown, with a warning saying how many were skipped. A library whose function list cannot be read is listed as "Not counted".

It is built on the same shared shell as the Word and Excel previews, so right-click **Copy as Rich Text** and **Copy as Markdown**, a table's **Copy Table** (with Markdown, CSV, TSV and PNG under **Copy as**), **Save as PDF / Word / PowerPoint**, Reveal in file manager, the themes and Search Google all work. Its one setting is `markcopy.fileInfo.confirm`, shared with the [package info page](#package-info-preview).

Not shown: 16-bit and DOS executables (the page says so), Mach-O files (ELF files open in the [package info page](#package-info-preview)), the full list of imported function names, resources other than the icon, version block and manifest, signature verification, countersignature and timestamp details, and .NET metadata beyond the runtime version and flags.

## Package info preview

MarkCopy registers as the editor for `.deb`, `.udeb`, `.rpm`, `.msi`, `.dmg`, `.pkg`, `.apk`, `.jar`, `.war`, `.ear`, `.vsix`, `.whl`, `.nupkg`, `.snupkg`, `.so`, `.elf`, `.ko` and `.AppImage` files (either case) and `*.so.*` shared libraries, so opening one shows a page about the file instead of VS Code's "file is binary" notice (after you press **Read this file**, as above). It is for answering "what is this, what version, who made it, and what does it need?" before you install it. The format is decided by what the file holds, not by its name, so a `.jar` that is an Android library or a `.apk` that is an Alpine package is read as what it is.

Every page starts with the file's name, format and a one-line summary, and ends with a **File** section: format, size and SHA-256. What is in between depends on the format.

- **Debian package (.deb).** The control fields, the description, the dependency relations, which maintainer scripts exist, and the file list from the package's checksums. Only the control archive is unpacked (gzip, xz or zstd); the data archive is never opened.
- **RPM (.rpm).** The header tags, the description, the dependencies (internal `rpmlib` entries are hidden and counted), what the package provides, which scripts exist, the file list with sizes, and whether an OpenPGP signature is present with its key ID.
- **Alpine package (a .apk that is gzip).** The `.PKGINFO` fields, the dependencies, which scripts exist, and the name of the signing key.
- **Windows Installer (.msi).** The product name, version, manufacturer, the product, upgrade and package codes, platform, the install context its properties request and what its summary flag says about elevation; how many merge modules were merged into it; how many rows its file, component, feature, registry, shortcut, service and custom-action tables hold; any embedded cabinets; and the Authenticode signer. These are what the package states, not a prediction of what an install will do: conditions and custom actions can change it. A patch, a transform or a merge module is labelled as one and nothing more.
- **Apple disk image (.dmg).** Size, compression, checksum type, the partitions, whether it is encrypted, and what its embedded code-signing data holds: a signature with a signer, an ad-hoc signature with none, or only a notarization ticket, which is not a signature. The file system inside is not read, so the app's name and version are not shown.
- **macOS installer package (.pkg).** The title, identifiers, versions, install location, whether it installs as root, the components and bundles, which components run scripts, the file list, and the names on its signing certificates.
- **Linux binaries (.so, .elf, .ko, .AppImage).** Type, architecture, interpreter, SONAME, build ID, whether it is stripped, for a Go program its Go version, package, module, build settings and modules, its protections (PIE, non-executable stack, RELRO, RPATH or RUNPATH, and Intel CET or Arm BTI and pointer authentication on those architectures), the libraries it needs, its sections, kernel module information for a `.ko`, and the payload size of an AppImage.
- **Java archive (.jar, .war, .ear).** The manifest, the Maven coordinates if the build left them, the class count and the Java version, and the JAR signer.
- **VS Code extension (.vsix).** Identity, the engine it needs, activation events, and counts of what it contributes. An extension's Marketplace signature is a separate file, so it cannot be seen from the VSIX and the page says so.
- **Python wheel (.whl).** The metadata, the requirements and the entry points. It also lists the startup files (`.pth` and `.start`) and says whether each runs code when Python starts; where that depends on the installer, on the installation scheme or on a part of the archive that could not be listed, the page says so.
- **NuGet package (.nupkg, .snupkg).** The nuspec, the dependencies by framework, whether it carries build or install scripts, and the signer.
- **Android package (.apk).** Package name, versions, SDK levels, permissions, components and how many of them are exported, native ABIs, and which signing schemes are present.
- **Any other zip.** The contents only.

The file is **only read as bytes**. It is never installed, run, mounted, or handed to the operating system, and there is no **Open in Default App** row in this preview's menu, because the default app for a package is an installer, and for a `.jar` or an AppImage it is the file itself. Reads are in bounded ranges of 64 KiB pages, with a budget of 32 MiB per file, so a multi-gigabyte installer costs its headers. The SHA-256 is computed for files up to 256 MB (a larger one shows "Not computed"), and a file on a virtual or remote file system is read whole and refused above 64 MB. Decompression stops at a fixed size. A damaged part of a file becomes a warning on the page, and a file that is not the format it claims becomes a notice.

**Scripts are never shown or run.** The page says only that they exist, because that is what tells you an install will run code, and for most of these formats it runs as root.

**Signatures are reported, never verified.** The page says who the file names as its signer and that nothing was checked. A file can carry a certificate with any name in it, so treat these as the file's claims. An Android package signed only with scheme v2 or later shows the scheme without a signer, and an RPM signature is OpenPGP, so it has a key ID and no certificate name.

It is built on the same shared shell as the Word and executable previews, so right-click **Copy as Rich Text** and **Copy as Markdown**, a table's **Copy Table** (with Markdown, CSV, TSV and PNG under **Copy as**), **Save as PDF / Word / PowerPoint**, Reveal in file manager, the themes and Search Google all work. Its one setting is `markcopy.fileInfo.confirm`, shared with the executable info page.

Not shown: Mach-O binaries, the app inside a disk image, an Android app's label and icon, the contents of any script, and signature verification. A Debian package whose control archive is compressed with bzip2 or lzma shows a warning instead of its fields.

[Back to the user guide](README.md)
