# Structural (file-format) data hiding, deterministic detection, and JS/TS parsing libraries (as of Nov 2026)

Method note: primary specs were fetched where the fetch tool could read them. Several large specs were truncated by the fetcher (W3C PNG, APPNOTE), and some pages gave no usable detail (CIPA EXIF PDF failed to parse; NDSS paper PDF was binary and unreadable by the fetcher). Byte-level facts that come from my own knowledge of the specs and not from a page fetched this session are placed under "Inferences" and marked "(background knowledge, not re-verified)" so the report writer can weigh them. Library versions and dates were read directly from the npm registry on 2026-11-26.

## PNG: chunk layout, case bits, data after IEND, text/eXIf/APNG

### Takeaway

A PNG is a strict sequence of length/type/data/CRC chunks, so structural hiding (private ancillary chunks, oversized text chunks, trailing bytes after IEND) is detectable with a single linear walk plus CRC check. The spec says nothing may follow IEND, so any trailing bytes are a conformance violation.

### Cited Findings

- Chunk = Length (data only, 0 to 2^31-1), 4-byte Type (each byte ASCII letter), Data, CRC. CRC covers type and data, not length, uses the gzip polynomial, stored MSB first. Chunks need not be aligned. — [W3C PNG Third Edition, section 5.3, 5.5](https://www.w3.org/TR/png-3/)
- Case bits of the four type bytes (bit 5, value 32): byte 1 lowercase = ancillary; byte 2 lowercase = private (non-registered); byte 3 must be uppercase (lowercase means the datastream does not conform); byte 4 lowercase = safe-to-copy. Decoders must flag unknown critical chunks and may ignore unknown ancillary ones. — [W3C PNG 3, section 5.4, Table 6](https://www.w3.org/TR/png-3/)
- Critical chunks: IHDR, PLTE, IDAT, IEND. One IHDR (first), one IEND (last). PLTE before first IDAT. Multiple IDAT must be consecutive with no intervening chunks. IDAT payloads concatenate into one zlib stream; chunk boundaries may fall anywhere inside it; "trailing unused bytes after the stream are undesirable". — [W3C PNG 3, sections 5.6, 10.2, 11.2.3](https://www.w3.org/TR/png-3/)
- Conformance item: "No chunks or other content follow the IEND chunk" (15.3.1 item 3). A security note about potentially malicious data after IEND was added in change log F.6 (text not retrieved). — [W3C PNG 3, 15.3.1 and F.6](https://www.w3.org/TR/png-3/)
- eXIf: single, must precede IDAT; may carry GPS (privacy note 13.4). tEXt, zTXt, iTXt: multiple allowed, no ordering constraint. tIME single. — [W3C PNG 3, Table 7 and 13.4](https://www.w3.org/TR/png-3/)
- APNG (now in the Third Edition): acTL single, before IDAT (its presence marks APNG); fcTL multiple, first may precede IDAT, rest after; fdAT after IDAT, same as IDAT with a 4-byte sequence number prefix; fcTL and fdAT share one zero-based sequence with no gaps or duplicates. — [W3C PNG 3, 4.9, 5.6](https://www.w3.org/TR/png-3/)
- Decoders that skip CRC checks risk corrupted pixels; chunks "can be extremely large" (up to 2^31-1), so buffer-overflow risk exists in naive decoders. — [W3C PNG 3, 13.3](https://www.w3.org/TR/png-3/)
- Real abuse: the Worok espionage group hid payloads in PNG pixel LSBs, extracted by a C# loader (PNGLoad). That is pixel stego (out of scope here) but it shows PNG is a live carrier. — [ESET, Worok: the big picture](https://www.welivesecurity.com/2022/09/06/worok-big-picture/), summarised in [TechSpot](https://www.techspot.com/news/96630-meet-worok-cyber-espionage-group-hiding-malware-within.html)

### Inferences

- Cheap deterministic PNG check, one linear pass (background knowledge, not re-verified): verify 8-byte signature `89 50 4E 47 0D 0A 1A 0A`; walk chunks; recompute CRC32 for each; flag (a) bad CRC, (b) type bytes not ASCII letters, (c) chunk length exceeding remaining file, (d) first chunk not IHDR, (e) IDAT chunks non-consecutive, (f) bytes remaining after the IEND chunk's CRC (offset of IEND + 12), (g) multiple IEND, (h) third type byte lowercase, (i) private chunks (second byte lowercase, e.g. `prVt`, `ruSt`) and unknown ancillary names, (j) tEXt/zTXt/iTXt/eXIf over a size threshold (for example more than 1 KB, or more than a few percent of file size), (k) chunk sizes in a tail after IDAT with high-entropy payload, (l) IDAT inflated length not equal to height*(1+row_bytes) (extra bytes after zlib stream end), (m) fcTL/fdAT sequence gaps.
- Likely false positives: editors and tools legitimately write private ancillary chunks (Adobe Fireworks `prVW`/`mkBT`, Photoshop `iDOT` from Apple (Apple adds `iDOT`, `CgBI` in iPhone-optimised PNGs), `caBX` C2PA manifests, `eXIf`, `iCCP`, `tIME`). Apple CgBI PNGs are non-conforming by design. C2PA/Content Credentials will make large `caBX` chunks more common. Treat "unknown private chunk" as info, "data after IEND" and "bad CRC" as warnings.
- Multiple IDAT chunks are normal (encoders split at 8 to 64 KB); only non-consecutive IDAT or content after the zlib end is odd.
- Real-world frequency of data after IEND is non-trivial (screenshot tools, some CMS pipelines, and deliberate ZIP-in-PNG polyglots), so report offset and length plus a signature sniff of the tail (PK, %PDF, MZ, 7z, Rar!).

### Gaps

- tEXt/zTXt/iTXt field layouts and the eXIf layout (11.3.3, 11.3.4.5) and the exact CRC-error rule in 13.2 were beyond the fetched portion of the 337k-character spec; verify against the live spec before quoting.
- No sourced real-world incident for pure "data after IEND" or private-chunk abuse was located in this pass.

## JPEG / JFIF / EXIF / MPF / motion photos

### Takeaway

JPEG is a marker stream (`FF xx`, 2-byte length) so APPn/COM payloads and trailing data are easy to enumerate, but legitimate cameras append large trailers (Google/Samsung motion photos, MPF secondary images), so "data after EOI" needs classification, not a blanket alarm.

### Cited Findings

- Marker format: `FF xx s1 s2 data`, length = 256*s1+s2 and includes the two length bytes; SOI `FF D8`, SOS `FF DA` (entropy-coded data follows), EOI `FF D9`. JFIF APP0 `FF E0 len 4A 46 49 46 00` must directly follow SOI, with an optional uncompressed RGB thumbnail (3*Xthumb*Ythumb bytes); JFXX extension APP0 can hold a JPEG thumbnail (`FF D8`...`FF D9`, format byte 0x10), a palettised one (0x11), or RGB (0x13). Exif uses APP1 and must follow SOI directly; ICC is carried in an APP segment; Adobe Photoshop IRBs are JFIF-compatible extensions. — [Wikipedia, JFIF](https://en.wikipedia.org/wiki/JPEG_File_Interchange_Format)
- Google Motion Photo format 1.0: a primary JPEG/HEIC/AVIF with a video file appended; Container XMP (`http://ns.google.com/photos/1.0/container/`) lists items; secondary items carry `Item:Length`; the `MotionPhoto` semantic item "must be at the end of the file. No other bytes may be placed after this media item's bytes"; JPEG primary may have `Item:Padding` between image end and the video; locating the video = read `Length` bytes back from end of file. `Camera:MotionPhoto=1` can be stale after the video is stripped, so "readers must always confirm that a video is present". HEIC/AVIF variant ends with a top-level `mpvd` box (8-byte header, padding=8). — [Android Developers, Motion Photo format 1.0](https://developer.android.com/media/platform/motion-photo-format)
- Samsung motion photos append a trailer after the JPEG containing named blocks with `SEFH`/`SEFT` markers and `MotionPhoto_Data` (embedded MP4); Phil Harvey says the format is not formally documented, and XMP is an unreliable way to locate it. I found no official Samsung spec. — [ExifTool forum, Samsung trailer threads](https://exiftool.org/forum/index.php?msg=85677), [ExifTool Samsung tag table](https://exiftool.org/TagNames/Samsung.html)
- ExifReader supports Exif, IPTC, XMP, ICC and MPF segments plus thumbnails for JPEG, PNG, WebP, HEIC, AVIF, TIFF, JPEG XL, GIF (GIF only image details); Photoshop support is partial. — [ExifReader README](https://github.com/mattiasw/ExifReader)

### Inferences

- Cheap JPEG check (background knowledge, not re-verified): walk markers from SOI; for each segment record marker, offset, length; stop at SOS and scan entropy data for the next real marker (skip `FF 00` stuffing and `FF D0..D7` RST); on `FF D9` record EOI offset; any bytes after the final EOI are the trailer. Flag: trailer length, trailer sniff (MP4 `ftyp` at offset 4, `PK`, `%PDF`, `MZ`, Samsung `SEFT` in the last 8 bytes, a second `FF D8`), COM (`FF FE`) segments with non-trivial text, APPn segments with unknown identifier strings, APP1 Exif larger than expected (typical 10-60 KB; MakerNote and embedded IFD1 thumbnail can be large), APP segments hitting the 65,533-byte payload limit repeatedly (chunked payloads: ICC in APP2 `ICC_PROFILE\0`, MPF in APP2 `MPF\0`, Photoshop in APP13 `Photoshop 3.0\0`, XMP extended in APP1 `http://ns.adobe.com/xmpmeta/`), and multiple SOI/EOI pairs.
- Legitimate trailers (false positives): Google/Samsung motion photo video, MPF (APP2 `MPF\0`, CIPA DC-007) secondary images (Ultra HDR gain map, Apple/Fujifilm/Sony stereo or depth images, preview images) each starting with its own `FF D8`, Apple/Android depth data, Sony/Canon maker trailers, and some cameras' pad bytes. Rule: if Container XMP or MPF index describes the trailing bytes and offsets/lengths match exactly, classify as "declared"; otherwise "undeclared trailer".
- Embedded thumbnails (Exif IFD1, JFXX, MakerNote previews) are a known place where a stale or different image survives cropping; compare thumbnail dimensions/aspect to main image as an info-level check.
- Progressive/multi-scan JPEGs contain several SOS; do not mistake them for appended data.

### Gaps

- The CIPA DC-008 EXIF PDF could not be parsed by the fetcher, so EXIF IFD structure and MakerNote claims are unsourced here. CIPA DC-007 (MPF) was not fetched.
- No sourced incident of malware hidden in JPEG APPn/COM segments was retrieved in this pass (earlier notes cover JPEG stego theory).

## GIF, WebP/RIFF, BMP, SVG, WAV/RIFF, MP3/ID3, MP4/ISO-BMFF

### Takeaway

RIFF (WebP, WAV) and ISO-BMFF (MP4) are explicitly extensible so unknown chunks/boxes are legal and ignored by readers, making them natural cavities; the cheap check is to walk the container and compare declared sizes to file size.

### Cited Findings

- WebP/RIFF: header `RIFF` + 4-byte File Size (counts from offset 8) + `WEBP`; chunk = FourCC + uint32 size + payload, odd sizes padded with a byte that "MUST be 0". "The file SHOULD NOT contain any data after the data specified by File Size. Readers MAY parse such files, ignoring the trailing data." Unknown chunks MAY appear at end of file or at the end of ANMF chunks, "Readers SHOULD ignore these chunks", and metadata/unknown chunks MAY appear out of order. EXIF/XMP/ICCP SHOULD appear at most once; readers MAY ignore extras. ANIM chunk with animation flag unset "MUST be ignored". — [Google WebP RIFF container spec](https://developers.google.com/speed/webp/docs/riff_container)
- ID3: ID3v1 is a fixed 128-byte block at end of file; ID3v2 uses variable-size tags made of frames, normally at file start, v2.4 allows the tag at end; Lyrics3 sits before ID3v1; ID3v2 tags also appear in WAV/AIFF and MP4. — [Wikipedia, ID3](https://en.wikipedia.org/wiki/ID3)
- ISO-BMFF: all data is in boxes with a type and length; `ftyp` first; `moov` ideally before `mdat`. (Fetched page did not cover size/largesize/free/skip/uuid.) — [Wikipedia, ISO base media file format](https://en.wikipedia.org/wiki/ISO_base_media_file_format)
- mp4box.js has an `allowInvalidBoxTypes` option and a `keepMdatData` option; page does not document handling of `free`/`skip`/`uuid`. — [mp4box.js README](https://github.com/gpac/mp4box.js)
- music-metadata reads ID3v1/v1.1/v2.2/v2.3/v2.4, WAV with RIFF/INFO tags, MP4, FLAC, Ogg and more; MIT; ESM since v8, Node 22+. — [music-metadata README](https://github.com/Borewit/music-metadata)

### Inferences

- GIF (background knowledge, not re-verified; the GIF89a spec was not fetched): structure is header `GIF87a`/`GIF89a`, logical screen descriptor, optional global colour table, then blocks introduced by `21` (extension: `F9` graphic control, `FE` comment, `FF` application, `01` plain text) or `2C` (image descriptor), ending with trailer `3B`. Hiding places: bytes after `3B`; comment extensions (`21 FE`, sub-block chains up to 255 bytes each); application extensions with unknown 11-byte identifiers (NETSCAPE2.0, XMP DataXMP, ICCRGBG1012 are legitimate); colour-table entries unused by pixels; sub-block data after the LZW end code. Check: walk blocks to `3B`, count/size comments and unknown app extensions, report trailing bytes. GIFAR-style GIF+JAR polyglots exploit that JAR/ZIP parses from the end.
- WebP check: read RIFF size; if file length > size+8, flag trailer (spec allows it, so warning not error); if file length < size+8, truncated; walk chunks and flag unknown FourCCs beyond `VP8 `, `VP8L`, `VP8X`, `ALPH`, `ANIM`, `ANMF`, `ICCP`, `EXIF`, `XMP `; non-zero padding bytes are a spec violation (the cited MUST-be-0) and a classic hiding spot; VP8X flag bits E/X/I/A that disagree with chunk presence.
- BMP (background knowledge): `BM` header with `bfSize`, `bfOffBits`; slack between the DIB header/colour table and `bfOffBits` (gap), reserved fields `bfReserved1/2`, row padding to 4 bytes, and data after `bfSize` are cavities. Check: `bfSize` vs file length, `bfOffBits` vs header+palette size, nonzero reserved or padding bytes.
- SVG (background knowledge): it is XML so treat as active content: `<script>`, `on*=` handlers, `<foreignObject>` (embeds HTML), `<a href="javascript:...">`, `<use href>` to external resources, `data:` URIs (base64 images or entire SVG/HTML), `<!-- -->` comments, CDATA, `<metadata>`, unreferenced `<defs>` elements, elements with `display:none`/`opacity=0`/zero size, `<image href="data:...">` with non-image MIME or large base64, and `xlink:href` to remote URLs (tracking). Detection is DOM walk plus size thresholds. SVG phishing/smuggling campaigns using embedded script are widely reported but no primary source was fetched here.
- WAV/RIFF: same walk as WebP but with `RIFF`/`WAVE`; legitimate chunks `fmt `, `data`, `LIST` (INFO), `bext`, `iXML`, `id3 `, `JUNK`/`PAD ` (padding, legal cavity), `fact`, `cue `. Check: RIFF size vs file length, `data` chunk size vs remaining, nonzero `JUNK`, unknown chunks, trailing bytes. Large `JUNK` is normal (BWF/aligned writers).
- MP3: scan for ID3v2 header (`49 44 33`, version, flags, 4 syncsafe size bytes = 7 bits each), frames `PRIV`, `GEOB`, `APIC`, `COMM`, `TXXX` can carry arbitrary data, padding after frames inside the declared size (zero bytes normal; nonzero is odd); ID3v1 `TAG` at length-128; APEv2 `APETAGEX` footer; bytes after the last valid MPEG frame; ancillary-bit data inside frames (MP3Stego-class stego is not structural, see audio section).
- MP4 (background knowledge): box header = 32-bit size + 4-byte type, size 1 means 64-bit `largesize` follows, size 0 means "to end of file", `uuid` boxes have a 16-byte extended type; `free`/`skip` boxes are explicitly ignorable padding; `udta`/`meta` carry user data; `mdat` may contain bytes not referenced by any `stco`/`co64`/`stsz` sample table (slack). Check: walk top-level boxes, flag `free`/`skip` with nonzero content or large size, `uuid` boxes by UUID (Spherical Video, PIFF, XMP `BE7ACFCB-97A9-42E8-9C71-999491E3AFAC` are legitimate), unknown top-level types, trailing bytes after the last box, and `mdat` bytes not covered by sample tables (needs `stbl` parsing).

### Gaps

- No primary spec fetched for GIF89a, BMP, ISO 14496-12 box syntax, SVG 2, or WAV (RIFF/RF64); the byte-level statements for those are background knowledge.
- No sourced real-world abuse examples collected for GIF/WAV/BMP/MP4 container slack in this pass.

## PDF: incremental updates, hidden content, shadow attacks, and what pdf.js exposes

### Takeaway

PDF's legal incremental-update mechanism lets a signed or reviewed document be changed after the fact, and the keyword triage approach (Didier Stevens' pdfid) is cheap but string-based. pdf.js exposes attachments, JS actions, OCG config, metadata and open action, but not the raw xref/revision list through its public API.

### Cited Findings

- Shadow Attacks (Mainka, Mladenov, Rohlmann, Ruhr University Bochum, NDSS 2021): three variants, Hide, Replace, Hide-and-Replace, work on digitally signed PDFs using standard-compliant, well-formed incremental updates rather than malformed files; 16 of 29 tested viewers (including Adobe Acrobat and Foxit Reader) were vulnerable; Hide and Hide-and-Replace bypass deny/allow-list defences; tools released: PDF-Attacker and PDF-Detector (blocks shadow documents from being signed or helps detect exploitation in signed PDFs). — [NDSS 2021 paper page](https://ndss-symposium.org/ndss-paper/shadow-attacks-hiding-and-replacing-content-in-signed-pdfs), summary corroborated via [Schneier](https://www.schneier.com/blog/archives/2021/03/hacking-digitally-signed-pdf-files.html); technical text of the paper PDF was not readable by the fetcher.
- Albertini's PDF notes: PDF supports incremental updates so objects plus a trailer placed after `%%EOF` can still be read and displayed; readers parse bottom-up, but a dummy first object with `/Linearized` can switch to top-down parsing and change which trailer wins; header tolerance varies widely (truncated `%PDF-1.` accepted by Adobe, `%PDF-\0` works in Adobe Reader, no header works in some readers but fails in Adobe Reader and Chrome); unrecognised tags are ignored; pdf.js, Evince, Chrome, MuPDF, Sumatra differ on malformed "generic" files. — [corkami PDF notes](https://github.com/corkami/docs/blob/master/PDF/PDF.md)
- Didier Stevens: `/AA` and `/OpenAction` trigger automatic actions on view; "All malicious PDF documents with JavaScript I've seen in the wild had an automatic action to launch the JavaScript"; a 2017 sample combined `/JavaScript`, `/OpenAction` and `/EmbeddedFile`. pdfid counts keywords (`/JS`, `/JavaScript`, `/OpenAction`, `/AA`, `/EmbeddedFile`, and others); it does not understand structure, so 3-byte tokens like `/JS` and `/AA` appear by chance inside compressed streams in multi-MB files, so hits must be confirmed with pdf-parser. — [Didier Stevens PDF tools](https://blog.didierstevens.com/programs/pdf-tools/), [PDFiD false positives](https://blog.didierstevens.com/2013/06/10/pdfid-false-positives)
- pdf.js `PDFDocumentProxy` exposes: `getAttachments()` (Map or null), `getJSActions()` (name-tree and catalog A/AA JS actions), `hasJSActions()` (AcroForm), `getOptionalContentConfig()` (OCG layers), `getMetadata()` (info dict plus XMP), `getOpenAction()`, `getDestinations()`, `getPermissions()`, `getFieldObjects()`, `getPageLabels()`, `getOutline()`, `saveDocument()`, `numPages`, `fingerprints` (second element defined only for modified documents). No `getJavaScript` in the current docs (older name). — [pdf.js PDFDocumentProxy API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDocumentProxy.html)
- pdf.js ships a PDF debugger to "browse the internal structure of a PDF document"; Apache-2.0. — [pdf.js repo](https://github.com/mozilla/pdf.js)
- pdfjs-dist latest 6.5.438, published 2026-11-01, Apache-2.0, unpacked about 37.6 MB. — [npm registry](https://registry.npmjs.org/pdfjs-dist)

### Inferences

- Cheap PDF byte scan without a full parser (background knowledge, not re-verified): (1) count `%%EOF` markers and `startxref` keywords; more than one means incremental updates (legit for forms, signing, Word/Acrobat saves); compare the last `%%EOF` offset to file length to find data after the final `%%EOF` (some producers add a trailing newline or up to a few bytes; hundreds of bytes or a recognisable signature is suspicious); (2) check `%PDF-` within the first 1024 bytes and offset of that header, because bytes before it are the classic polyglot slot; (3) count `trailer`/`/Prev` chain length and `/Type /XRef`; (4) keyword inventory like pdfid: `/JS`, `/JavaScript`, `/OpenAction`, `/AA`, `/Launch`, `/EmbeddedFile`, `/Filespec`, `/RichMedia`, `/XFA`, `/SubmitForm`, `/URI`, `/GoToR`, `/ObjStm`, `/Encrypt`; note that keywords inside object streams and obfuscated names (`/J#53`) are missed by raw scans, and decoding streams is needed for completeness; (5) unreferenced objects need a real xref walk (objects present in the body but not reachable from /Root).
- Hidden-layer and visually hidden text checks need parsing: `/OCProperties` with `/OFF` groups (pdf.js `getOptionalContentConfig()` can list them), text render mode 3 (`3 Tr`, invisible, used legitimately by OCR layers), text with fill colour equal to background, font size under about 1 pt, text outside the `/MediaBox`/`/CropBox`, annotations with `/F` hidden flags. OCR scans commonly have legitimate invisible text, so mode 3 on image-only pages is a false positive.
- Shadow-attack defence logic: for each incremental revision, check which objects changed and whether changes are limited to allowed signed-PDF modifications (form fill, signatures, annotations). Detecting "new /Page tree or replaced content stream objects after a signature" requires revision-aware parsing, which pdf.js's public API does not provide (only `fingerprints` hints modification). A raw-byte alternative: split at each `%%EOF`, parse each revision's xref, and diff object numbers (heavy, background knowledge).
- Practical stack for MarkCopy (a read-only viewer): use pdf.js API for attachments, JS actions, OCGs and metadata, plus a small custom tail scanner for `%%EOF` count, post-EOF bytes and header offset.

### Gaps

- Shadow attack mechanism details (which objects /Annots, /Pages, form fields) and countermeasures were not retrieved because the NDSS PDF was unreadable; pdf-insecurity.org URL tried (`/sign-shadow/shadow-attacks.html`) returned 404.
- ISO 32000-2 / PDF Association page on incremental updates not fetched. No numeric stats on how common multi-`%%EOF` files are among benign PDFs.
- pdf.js internals (`Catalog`, `XRef` classes in the worker) were not inspected; whether `getRawData`-style access exists remains unverified.

## OOXML (docx, xlsx, pptx) and ZIP generally

### Takeaway

OOXML files are ZIPs of XML parts, so hiding splits into (a) container-level tricks (prefix/suffix bytes, comments, duplicate or mismatched directories, concatenated archives) and (b) markup-level concealment (hidden sheets/slides/text, orphan parts). Real-world parser disagreement on concatenated ZIPs has been used to evade AV.

### Cited Findings

- ZIP layout: local file header sig `0x04034b50` (fixed fields: version, flags, method, time/date, CRC-32, compressed size, uncompressed size, name length, extra length, then name and extra); central directory header sig `0x02014b50` (adds comment length, disk start, attributes, local header offset); EOCD sig `0x06054b50` with central directory size, offset and a 2-byte comment length plus comment; ZIP64 EOCD `0x06064b50` and locator `0x07064b50`; archive extra data record `0x08064b50`; digital signature record `0x05054b50` after the central directory. A ZIP "MUST contain" an EOCD record. Comments are not encrypted or authenticated (4.4.26). Each local header must have a matching central directory entry (4.3.2); central directory order may differ from file order (4.4.1.3). The fetched excerpt gave no rule for bytes before the first local header and none on resolving local/central conflicts. — [PKWARE APPNOTE.TXT](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)
- ZIP concatenation evasion: attackers join several ZIPs so the file has multiple central directories; 7-Zip shows the first, WinRAR the second (reads all structures), Windows File Explorer shows only the second; OPSWAT found only 16 of 34 AV engines detected the malware; linked to SmokeLoader; Gootloader used many concatenated structures with truncated EOCD (suggested signal: 100+ concatenated structures); CrowdStrike notes some libraries (Python zipfile, zip-rs, Info-ZIP unzip) treat the central directory offset as relative to the start of the file, allowing two directories. — [BleepingComputer, Nov 2024](https://www.bleepingcomputer.com/news/security/hackers-now-use-zip-file-concatenation-to-evade-detection/), [Dark Reading](https://darkreading.com/threat-intelligence/flexible-structure-zip-archives-exploited-hide-malware-undetected), [CrowdStrike](https://www.crowdstrike.com/en-us/blog/how-to-prevent-zip-file-exploitation/)
- Excel sheet visibility enum: `visible`, `hidden`, `veryHidden` (serialised strings). — [Open XML SDK, SheetStateValues](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.sheetstatevalues)
- `w:vanish` (ISO/IEC 29500-1 17.3.2.41): run property that hides the run's text at display; applications can have settings to force hidden text visible; toggle property. — [Open XML SDK, Vanish](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.vanish)
- PresentationML `p:sld` has a `show` attribute ("Show Slide in Slide Show", default true when omitted), so `show="0"` hides a slide from the show while it stays in the file; also `showMasterSp`. — [Open XML SDK, Slide](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.presentation.slide)
- OOXML implementation notes for Microsoft Office: MS-OI29500 revision 25.0 published 2026-08-18. — [MS-OI29500](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/)
- olevba (oletools) detects VBA macros, OLE objects, XLM macros and DDE in OLE and OpenXML files, flagging auto-exec (A), suspicious keywords (S), IOCs (I); OOXML formats cannot store macros unless macro-enabled (docm/xlsm/pptm, `vbaProject.bin`). It is not a hidden-text detector. — [oletools / olevba docs](https://decalage.info/python/olevba), [oletools repo](https://github.com/decalage2/oletools)

### Inferences

- Cheap OOXML check (background knowledge, not re-verified): open the ZIP central directory only (no inflation); compare entry list to `[Content_Types].xml` (Default extensions plus Override part names) and to the transitive closure of `_rels/.rels` and `*/_rels/*.rels` targets; parts present in the ZIP but unreachable, or listed in content types but missing, are anomalies; also flag: `customXml/` items (legitimate for SharePoint metadata and bibliography; arbitrary data fits), `docProps/custom.xml`, `word/vbaProject.bin`, `*/embeddings/*` (OLE `oleObject*.bin`, embedded packages), `word/afchunk.*` with `altChunk` references (embeds another document/HTML/RTF), `xl/externalLinks`, `ppt/embeddings`, `_xmlsignatures`, `word/comments.xml`, `ppt/comments/`, `word/people.xml`, tracked changes (`w:ins`, `w:del`), `w:vanish`, `w:color w:val="FFFFFF"`, `w:sz w:val="2"` (1 pt = 2 half-points), `w:specVanish`, `xl/workbook.xml` `<sheet state="hidden|veryHidden">` and `definedName hidden="1"`, hidden rows/columns (`hidden="1"`), `p:sld show="0"`, off-slide shape offsets (negative or beyond `sldSz`), notes slides, zero-size or fully transparent shapes. Also check duplicate entry names in the central directory, names with `..`, backslashes, or case-variant duplicates.
- ZIP-level anomalies to flag: bytes before the first local header (offset of first `PK\x03\x04` not zero; valid for self-extractors and polyglots); bytes between entries not accounted for by any local header+data span; data after the EOCD (EOCD offset+22+commentLen not equal to file length); non-empty ZIP comment; multiple EOCD signatures (search backwards up to 65,557 bytes); central directory offset/size that does not land on a `PK\x01\x02`; local header name/size/CRC/method disagreeing with the central entry (parser-differential risk); extra fields with unknown IDs or large size; entries with data descriptor flag (bit 3) and zero local sizes (legit); compressed size mismatch with computed extent; central-directory entries overlapping each other (zip-bomb overlap trick). Office writes tidy ZIPs with no comments and no prefix, so any non-empty comment or gap in an Office file is high-signal, but general ZIPs (JAR, APK, self-extractors, Android APK signing block between entries and central directory) legitimately have gaps.
- Polyglot-friendly facts: ZIP is parsed from the end (EOCD), so prefix bytes (a PNG, PDF, GIF, executable stub) can precede it, which is why JAR/GIFAR and ZIP-in-PNG work; PNG decoders ignore everything after IEND, so a ZIP appended there is a valid PNG and a valid ZIP (when offsets are fixed up or the unzipper tolerates prefix).

### Gaps

- Did not fetch the ECMA-376/ISO 29500 text itself (only the Open XML SDK reference pages that quote it); no primary source for altChunk, customXml semantics, or OLE embedding rules.
- ZIP spec sections on "data before first local header" (the APPNOTE excerpt covered only 100k of 174k characters) and on local/central mismatch rules were not found; claims on those are inferences.
- No sourced real-world incident for hidden `w:vanish` text or `veryHidden` sheets abuse was located (veryHidden is commonly cited in Excel 4.0 macro malware but I did not fetch a source).

## Polyglots and file-type confusion (Albertini, Mitra, binwalk)

### Takeaway

Polyglots exploit the fact that formats anchor differently (start, end, or anywhere), so a scanner must identify embedded signatures at non-zero offsets and verify each candidate structurally, which is what binwalk-style tools do.

### Cited Findings

- Mitra (Ange Albertini, MIT) generates binary polyglots, near-polyglots and "polymocks" for about 49 formats (ZIP, 7Z, RAR, PDF, ISO, TAR, PS, MP4, BMP, ELF, GIF, PE, PNG, TIFF, Java, PCAP, WASM, ID3v1, XZ), 288 combinations; layouts: stacks (concatenation), cavities (payload placed in blank space), parasites (payload hidden in a comment-like field), zippers (each payload comments on the other). `--overlap` makes near-polyglots; `mocky.py` injects other formats' signatures into a valid file so tools report several types (example: a PDF that `file` reports as tar). 1.3k stars, 84 commits; maintenance recency not shown. — [corkami/mitra](https://github.com/corkami/mitra)
- Binwalk (ReFirmLabs, MIT) "can identify, and optionally extract, files and data that have been embedded inside of other files" and uses entropy analysis to spot unknown compression or encryption; its signature-matching method was not described on the fetched page. — [ReFirmLabs/binwalk](https://github.com/ReFirmLabs/binwalk)
- Albertini's PDF notes document viewer-specific header tolerance and bottom-up vs top-down parsing, the basis for PDF/ZIP/other polyglots. — [corkami PDF notes](https://github.com/corkami/docs/blob/master/PDF/PDF.md)
- ZIP parser differential in the wild: concatenated ZIPs (see OOXML/ZIP section). — [BleepingComputer](https://www.bleepingcomputer.com/news/security/hackers-now-use-zip-file-concatenation-to-evade-detection/)
- `file-type` (npm) latest 22.3.0, 2026-10-29, MIT, a JS magic-number detector. — [npm registry](https://registry.npmjs.org/file-type)

### Inferences

- A browser-side polyglot detector can: (1) sniff the magic of the declared type at offset 0; (2) scan the whole buffer (or head 64 KB plus tail 64 KB plus a bounded middle scan) for a table of signatures at nonzero offsets: `PK\x03\x04`, `PK\x05\x06`, `%PDF-`, `\x89PNG\r\n\x1a\n`, `GIF8`, `\xFF\xD8\xFF`, `MZ` plus a valid `PE\0\0` pointer, `\x7FELF`, `Rar!\x1A\x07`, `7z\xBC\xAF\x27\x1C`, `\x1F\x8B\x08`, `ftyp` at +4, `OggS`, `RIFF....WEBP`, `<?xml`/`<svg`/`<html`; (3) validate each hit structurally (a PE needs a consistent `e_lfanew`; a ZIP needs a locatable EOCD; a PNG needs a valid IHDR CRC) to cut the false positives that binwalk-style raw matching produces on compressed data; (4) report the container-specific "legal slot" the hit sits in (after IEND, after EOI, after EOCD, before header, in a comment/free chunk). Random compressed or encrypted data contains short signatures by chance (2 to 4 byte magics), so require length plus structural validation; low-entropy header vs high-entropy tail is a useful extra signal.
- This is detection by structure, not by classification of intent; legitimate multi-type files (motion photos, self-extracting archives, APK with signing block, PDF with embedded attachments compressed away) will trigger and need an "explained by declared metadata" rule.

### Gaps

- Funky File Formats talk and corkami "pocs"/"docs" polyglot pages were not retrievable (corkami/pocs README was a stub); no direct source for the "ZIP in PNG" specific PoC; the PNG-plus-ZIP mechanism above is background knowledge.
- Binwalk v3 signature mechanics and release date not retrieved.

## JS/TS libraries for browser or Node (no native code)

### Takeaway

All candidates are pure JS/TS and work in browsers, but only a few are actively maintained in 2026; for structural scanning of PNG/ZIP/RIFF/ISO-BMFF a hand-written ~100 line walker is probably lighter than any dependency, and pdf.js plus ExifReader plus fflate (or zip.js) cover the heavy formats.

### Cited Findings (versions and dates from npm registry, queried 2026-11-26)

- pdfjs-dist 6.5.438, 2026-11-01, Apache-2.0, ~37.6 MB unpacked (includes worker and wasm/cmaps). Very active. — [npm](https://registry.npmjs.org/pdfjs-dist)
- ExifReader 4.56.0, published 2026-11-26, MPL-2.0 (file-level copyleft), default build about 42 KiB (brotli minified), 12 KiB for a JPEG date/GPS-only reader; supports Exif, IPTC, XMP, ICC, MPF, thumbnails across JPEG, JPEG XL, TIFF, PNG, HEIC, AVIF, WebP, GIF (image details only); Photoshop and MakerNote support partial; uses DataView. Very active. — [npm](https://registry.npmjs.org/exifreader), [README](https://github.com/mattiasw/ExifReader)
- exifr 7.1.3, last release 2021-08-05 (registry modified 2022-05-01), MIT; JPG, TIFF/IIQ, PNG, HEIC, AVIF; bundles full 73 KB (22 KB gz), lite 45 KB, mini 29 KB, core 15 KB; effectively unmaintained since 2021. — [npm](https://registry.npmjs.org/exifr), [README](https://github.com/MikeKovarik/exifr)
- png-chunks-extract 1.0.0, 2015-10-04, MIT; `extract(data)` returns `[{name, data}]`; README does not mention CRC validation; single commit; 35 stars. — [npm](https://registry.npmjs.org/png-chunks-extract), [repo](https://github.com/hughsk/png-chunks-extract)
- pngjs 7.0.0, 2023-02-20, MIT (full decoder/encoder; ~650 KB unpacked). — [npm](https://registry.npmjs.org/pngjs)
- fast-png 8.0.0, 2025-12-18, MIT, ~163 KB unpacked (decoder/encoder, exposes decoded metadata, not a chunk-level raw view). — [npm](https://registry.npmjs.org/fast-png)
- fflate 0.8.3, 2026-05-16 (registry modified 2026-07-20), MIT; `unzipSync` with a `filter(file)` callback exposing `name` and `originalSize`; README does not document central-directory, extra-field or ZIP-comment exposure. — [npm](https://registry.npmjs.org/fflate), [README](https://github.com/101arrowz/fflate)
- JSZip 3.10.2, 2026-09-08, dual MIT or GPL-3.0-or-later; README silent on ZIP comment and central-directory exposure; 357 open issues. — [npm](https://registry.npmjs.org/jszip), [repo](https://github.com/Stuk/jszip)
- zip.js (@zip.js/zip.js) 2.25.0, 2026-11-12, BSD-3-Clause, active (not fetched beyond registry metadata). — [npm](https://registry.npmjs.org/@zip.js/zip.js)
- mp4box 2.6.0, 2026-11-20, BSD-3-Clause, browser and Node, options `keepMdatData`, `allowInvalidBoxTypes`; the "simple" build parses only some boxes; active (changesets in repo). — [npm](https://registry.npmjs.org/mp4box), [repo](https://github.com/gpac/mp4box.js)
- music-metadata 13.0.1, 2026-11-25, MIT, ESM-only, Node 22+, browser use via bundler; very active. — [npm](https://registry.npmjs.org/music-metadata), [repo](https://github.com/Borewit/music-metadata)

### Inferences

- Licence caution: ExifReader is MPL-2.0 (acceptable if unmodified and bundled, but file-level copyleft); JSZip is MIT-or-GPL (choose MIT). fflate, exifr, pngjs, fast-png, music-metadata, pdfjs-dist, mp4box, zip.js all permissive.
- exifr is stale (5 years); ExifReader is the maintained choice for Exif/XMP/ICC/MPF in the browser. For a structural scanner MarkCopy only needs offsets and lengths, which none of the metadata libraries return reliably, so a custom marker/chunk/box walker with these libraries used only for decoding metadata content is the lower-risk design.
- For ZIP structure checks (comment, prefix, multiple EOCD, local/central mismatch) fflate and JSZip hide the details; plan a ~100 line hand-written central-directory reader and use fflate only for inflating selected small parts (XML) with a size cap to avoid zip bombs.
- pdf.js worker already runs in a worker; keep it capped (page limits, `disableAutoFetch`) when scanning untrusted files.

### Gaps

- Bundle sizes for fflate, JSZip, zip.js, mp4box, music-metadata not measured (only unpacked sizes via registry for some). A bundlephobia check was not done.
- pdf.js raw `XRef`/trailer access via public API was not confirmed; pdfjs-dist 6.x API changes versus the doc page (draft API) were not diffed.

## Audio steganography (LSB in WAV, echo hiding, phase coding, MP3Stego)

### Takeaway

I did not retrieve any primary source for audio stego detectors in this pass. From background knowledge, only structural/format-level audio checks are cheap and deterministic; signal-domain stego needs statistical steganalysis.

### Cited Findings

- No sourced findings in this pass (searches were not run for this subtopic because of the tool budget).

### Inferences

- (Background knowledge, not re-verified.) LSB in 16-bit PCM WAV is the audio analogue of image LSB; echo hiding adds tiny delayed copies encoding bits; phase coding alters the phase of the first segment's DFT; MP3Stego hides bits in the parity of the Huffman-coded part2_3_length during the inner loop of the LAME encoder, so it lives inside valid MP3 frames. A cheap deterministic structural check is possible only for container-level hiding: WAV chunk walk (unknown chunks, nonzero `JUNK`, trailing bytes, `data` size vs file), MP3 tag/trailer checks above. Signal-level detection would need chi-square or RS-style tests on sample LSBs (a histogram of LSB bits near 0.5 and weak correlation with the next-higher bit on 16-bit PCM) and is probabilistic with false positives on dithered or noisy recordings; existing earlier notes cover ML steganalysis.

### Gaps

- No source for audio stego detection tools, MP3Stego mechanics, or practical false-positive rates; recommend a follow-up search if audio is in scope.

## Cross-cutting notes for the report writer

- Highest-value cheap checks, in order: data after logical end (IEND, EOI, `%%EOF`, EOCD, RIFF size, last box, GIF `3B`); bytes before the real header (ZIP/PDF polyglots); comment/free/private slots (PNG private chunks, JPEG COM/APPn, GIF comment/app extensions, RIFF unknown chunks and `JUNK`, MP4 `free`/`uuid`, ZIP comment); active content (PDF `/JS` `/OpenAction` `/EmbeddedFile`, SVG script/foreignObject, OOXML macros, OLE embeddings); concealed-but-legal content (OOXML hidden sheets/slides/text, PDF OCG-off layers and mode-3 text).
- Dominant false-positive sources: motion-photo trailers and MPF/gain maps, Apple CgBI and `iDOT` PNGs, C2PA `caBX`/JUMBF payloads, OCR text layers in PDFs, self-extracting/Android signing-block ZIPs, WAV `JUNK` padding, PDF incremental saves from normal editors.
- Everything above that cites "background knowledge" should be spot-checked against the named specs (PNG 3 sections 11.3.3/11.3.4, ISO 14496-12 section 4.2, CIPA DC-007/DC-008, GIF89a, ISO 32000-2, ECMA-376 Part 1) before shipping as user-facing claims.
