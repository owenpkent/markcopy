# Hidden data structure inspector: design

**Status: proposed, not built.** This is rank 2 of
[Steganography and cryptography](research/reports/Steganography%20and%20cryptography.md),
with its byte-level rules checked against primary specifications on 2026-11-26. Every rule
below carries a tag: **verified** (with source and section) or **unverified** (a heuristic,
a vendor behaviour, or a rule no primary source was reachable for). Nothing unverified is
worded on the page as a fact about the format.

Builds on, and does not duplicate: PR #279 (`feat/polyglot-detection`, the signature
table in `src/binary/signatures.ts` and `readAppended`) and the branch
`feat/encryption-labels` (per-entry zip encryption labels in `src/pkg/zipRange.ts`).
Neither is merged; see [Composition](#composition-with-pr-279-and-the-encryption-branch).

## Sources and tags

| Key  | Source                                                                                                    | Reached                                       |
| ---- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| PNG3 | W3C PNG Third Edition, <https://www.w3.org/TR/png-3/>                                                     | Text read to character 300,000 of 337,718     |
| T81  | ITU-T T.81 (JPEG), w3.org copy                                                                            | Full text                                     |
| JFIF | JFIF 1.02, <https://www.w3.org/Graphics/JPEG/jfif3.pdf>                                                   | Full text                                     |
| MPF  | CIPA DC-X007-2009 (draft translation of the Multi-Picture Format)                                         | Full text; the 2009 draft, not the final      |
| MP   | Android Motion Photo format 1.0                                                                           | Full text                                     |
| C2PA | C2PA specification 2.2, Appendix A.3                                                                      | Appendix A.3 only                             |
| GIF  | GIF89a specification, w3.org                                                                              | Block sections 15 to 27                       |
| P17  | ISO 32000-1:2008 (Adobe's published copy). **ISO 32000-2 was not fetched**                                | Full text                                     |
| DS   | Didier Stevens, "PDFiD false positives" (2013)                                                            | Full page                                     |
| APP  | PKWARE APPNOTE.TXT, sections 4.1 to 5.10 and 7                                                            | Records 4.3, 4.4 read; no text on prefix data |
| APK  | Android APK Signature Scheme v2                                                                           | Full page                                     |
| BC   | BleepingComputer, 2024-11-10, zip concatenation                                                           | Full page                                     |
| SVG2 | W3C SVG 2 CR, chapters Conformance and Interact                                                           | Sections 2.2, 2.3, 15.8, 15.9                 |
| SEC  | Secondary: w3c/png issue 530 (iDOT), Hacker Factor "Connecting the iDOTs", darling-cocotron PR 391 (CgBI) | Search summaries only                         |

## Goal and non-goals

**Goal.** For a PNG, JPEG, GIF, SVG, PDF or zip, list the structural facts a careful reader
would want about bytes the format does not account for: where the format's logical end is,
what follows it, what that looks like, and which of it the file itself declares. Every
finding is a fact with an offset and a length.

**Non-goals.**

- No pixel or coefficient steganalysis, no entropy score, no "clean" verdict. A clean page
  says "no structural findings", and the page says what was not checked (see
  [Page wording rules](#page-wording-rules)).
- Never "contains a hidden message", "malicious" or "suspicious". Findings say what is
  there. The reader decides what it means.
- Never open, run, decode, decompress, render or extract a payload. Tail bytes are shown as
  a cleaned hex and ASCII dump of at most 256 bytes, and a format name from the signature
  table. A "Save tail as..." action is a later, separate decision (Q4).
- No writing to the file. Read-only, like the other file info previews.
- Not Office hidden content (rank 3), PE overlays (rank 4, partly in PR #279), or C2PA
  validation (rank 5). A `caBX` chunk or APP11 segment is reported as present and sized,
  and the page says it did not read or verify the manifest.

## Where it runs

**In the worker.** A new `kind: 'hidden'` on `FileInfoRequest` in
[src/fileInfoTask.ts](../src/fileInfoTask.ts), dispatched by `runFileInfoTask` and run by
`runInWorker()` in [src/isolate.ts](../src/isolate.ts) under the same 256 MB heap and 15 s
limits (entry point [src/fileInfoWorker.ts](../src/fileInfoWorker.ts), which must keep
`vscode` out of its imports). Reasons: the files are exactly the hostile kind the worker
exists for; the walks read most of the file, which the host should not do; and a bug in a
walker then ends a thread, not the extension host. The host would be simpler for a 20-byte
PNG, but PDFs and zips reach hundreds of megabytes, and one rule for all formats is easier
to defend in [SECURITY](../.github/SECURITY.md).

**Not through `FileInfoEditorProvider`.** That provider is a custom editor opened by file
extension, with a confirmation page whose point is that a single Explorer click must not
read an executable. The image and PDF previews are already open on the file, the user has
asked for the inspection by clicking, and the walk reads less than the preview already
does. So:

- New command `markcopy.hiddenData.inspect`, enabled when the active custom editor is the
  image, GIF or PDF preview (`activeCustomEditorId`, as `markcopy.fileInfo.read` does), and
  an **Inspect file structure** row in those previews' right-click menus.
- The result opens in a read-only webview panel beside the preview, rendered through the
  shared helpers in [src/binary/html.ts](../src/binary/html.ts) with the existing CSP and
  sanitization. The click is the confirmation; there is no second page. The webview posts
  only `{ type: 'close' }`, validated host-side like the other file info messages.
- Zip-based files (`.zip`, `.jar`, `.apk`, Office) open in the package or Office previews
  instead. The package page gains an **Inspect file structure** link on the zip reader's
  page, and the result is the same panel (Q1 asks whether to embed it as a section).
- Files not on a local disk: the host reads them whole, refuses above 64 MB, and sends
  bytes, exactly as the file info pipeline does.

**Request and result.**

```ts
export interface FileInfoRequest {
  kind: 'exe' | 'package' | 'hidden'; // 'hidden' is new
  fileName: string;
  path?: string;
  bytes?: Uint8Array;
}
// FileInfoResult gains: { ok: true; kind: 'hidden'; info: HiddenReport; digest: Digest }
```

The digest (SHA-256, streamed, up to 256 MB) stays: it identifies the file the report is
about. It shares the 15 s timer, so the walk has its own 10 s soft deadline (see
[Limits](#limits-and-budgets)).

## Composition with PR #279 and the encryption branch

PR #279's `src/binary/signatures.ts` has the structural tests the tail classifier needs:
`findZipEnd`, `looksLikePe`, `hasPdfHeader`, and the package `PROBES` table. They take a
`RangeReader` and look at the head and the last 64 KiB. For a tail at an arbitrary offset,
the inspector adds one helper, `sliceSource(source, start, length)`, a `ByteSource` view
that makes the tail look like a whole file, so the existing probes apply unchanged to
`new RangeReader(sliceSource(...))`. No signature is copied. Two additions are expected in
`signatures.ts` after #279 merges: a `sniffHead(head)` that returns a name for the leading
bytes (PK, MZ with PE check, `%PDF-`, PNG, GIF8, `FF D8 FF`, `ftyp` at +4, `7z`, `Rar!`,
gzip, ELF), and `looksLikePng`/`looksLikeJpeg`.

The division of labour with #279: it says a file is also a second format and reads it;
the inspector says where the second structure sits, how long it is, and whether the host
file declares it. The PE overlay note (`readAppended`) stays in the executable preview and
is not repeated here. This feature depends on #279's merge. Until then nothing here may be
imported from it.

From `feat/encryption-labels` the inspector reuses `openZip` and `ZipEntry` (entries,
offsets, `MAX_ZIP_ENTRIES`, `MAX_DIRECTORY_BYTES`) and does not label encryption itself;
the panel says "encryption: see the package page". If the branch changes `ZipEntry` to
omit the local header offset, the zip walker adds it in `src/hidden/zip.ts`.

## Output model

New directory `src/hidden/` (pure, no `vscode`; the Unicode scanner of rank 1 stays in
[src/hiddenText.ts](../src/hiddenText.ts)). One walker per format, one `readHidden()` that
picks it by magic number and not by extension.

```ts
export type HiddenFormat = 'png' | 'jpeg' | 'gif' | 'svg' | 'pdf' | 'zip';
export type Severity = 'info' | 'notable';

export interface Region {
  offset: number;
  length: number;
}

/** How the host file accounts for a region. */
export type Declared =
  | { by: 'format'; what: string } // the format defines it: "APK signing block", "MPF image 2"
  | { by: 'metadata'; what: string } // a field in the file names exactly these bytes
  | { by: 'none' }; // nothing in the file describes it

export interface Finding {
  id: string; // 'png.after-iend': stable, tested, used in docs
  severity: Severity;
  title: string; // the one-line fact, already worded: see wording rules
  detail?: string; // at most 400 chars, cleaned
  region?: Region;
  declared?: Declared;
  sniff?: string; // 'ZIP archive', from the shared signature table
  preview?: string; // hex and ASCII dump of the region's first 256 bytes
  verified: boolean; // false: shown with "heuristic" label
}

export interface HiddenReport {
  format: HiddenFormat;
  size: number;
  logicalEnd?: number; // where the format says the file ends
  findings: Finding[]; // at most 200, notable first, then by offset
  inventory: Array<{ heading: string; rows: string[][] }>; // chunks, segments, keywords
  notChecked: string[]; // what the walk did not read, in plain words
  stoppedEarly?: string; // budget, deadline or damage, with the offset
}
```

Strings from the file go through `printable()` and `clip()` in
[src/binary/text.ts](../src/binary/text.ts) before they enter a `Finding`, and through the
single escape in `src/binary/html.ts` at render. Findings are bounded by a `bound()` like
the one in `src/pkg/index.ts`.

## Page wording rules

1. State the structure, then the fact: "4,096 bytes follow the IEND chunk, which the PNG
   specification says must be last." Never an adjective about intent.
2. Put the spec's strength in the sentence. "must" (verified normative text) versus "is
   unusual" (heuristic). Unverified findings carry a small "heuristic" label.
3. A declared region is described as what the file says it is: "A video of 2,481,022 bytes
   is declared by the file's Container XMP (Motion Photo)." It is info, not notable, and it
   is never called unknown.
4. Always end the page with **Not checked**: pixel data, compressed content, signature and
   manifest validity, and whatever the walk skipped.
5. Zero findings reads: "No structural findings in what was read." Never "clean" or "safe".

## PNG

**Walk.** Check the 8-byte signature. Then read chunks in order: 4-byte length, 4-byte
type, data, 4-byte CRC. Stop at IEND, a bad length, or EOF. The CRC is recomputed over type
plus data (table-driven CRC-32, 1 KiB table, streamed in 64 KiB pieces). Record the first
64 bytes of data only for chunks whose type begins `tEXt`, `zTXt`, `iTXt`; never inflate
`zTXt` or `iTXt` data. After IEND, the tail is `[iendEnd, size)`.

| ID                   | Check and wording                                                                                                                                               | Sev.            | Tag                                                                                                                                                                                                                                                 | False positives and how avoided                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| png.signature        | "The file does not start with the PNG signature."                                                                                                               | notable         | unverified (bytes not re-read in this pass; PNG3 section 5.2)                                                                                                                                                                                       | None: the walk stops here and the page says it was not read as PNG                                                                                                                                                                      |
| png.crc              | "The CRC of the _X_ chunk at offset N does not match its contents."                                                                                             | notable         | verified: PNG3 5.3 (CRC over type and data, not length), 5.5 (MSB first), 13.3 (decoders that skip CRCs risk corruption)                                                                                                                            | Truncated downloads end the walk first (reported as truncation, not as CRC)                                                                                                                                                             |
| png.after-iend       | "N bytes follow the IEND chunk, which the PNG specification says must be last." plus tail sniff                                                                 | notable         | verified: PNG3 15.3.1 item 3 ("No chunks or other content follow the IEND chunk"), 13.3 ("data after the IEND chunk which could contain anything, including malicious code")                                                                        | Real tools append (unverified: screenshot tools, CMS pipelines). A tail of 0 to 3 bytes of 0x00, 0x0A, 0x0D or 0x20 is not reported. PNG has no declaring mechanism, so `declared` is always `none`; the tail sniff does the explaining |
| png.chunk-order      | IHDR not first; second IEND; IDAT chunks not consecutive; IDAT before IHDR or after IEND                                                                        | notable         | verified: PNG3 5.6 Table 7 (IEND "Shall be last"), 11.2 (one IHDR, one IEND); consecutive IDAT carried from the research note (cites 5.6 and 11.2.3, not re-fetched)                                                                                | CgBI files are exempt from "first chunk" (below)                                                                                                                                                                                        |
| png.chunk-name       | Third type byte lowercase: "The chunk name _x_ has a lowercase third letter, which the specification reserves."                                                 | notable         | verified: PNG3 5.4 Table 6                                                                                                                                                                                                                          | None                                                                                                                                                                                                                                    |
| png.private          | Private chunks (second byte lowercase): listed by name, size, offset                                                                                            | info            | verified: PNG3 5.4 Table 6; 5.7.3 (private chunks are for private and experimental use)                                                                                                                                                             | Many editors write them. Listed, never counted as a finding on their own if under 64 KiB total                                                                                                                                          |
| png.unknown          | Public ancillary names not in PNG3 Table 7                                                                                                                      | info            | verified: PNG3 5.4 (decoders may ignore unknown ancillary chunks); the registered list is taken from Table 7 and tested against it                                                                                                                  | Extension chunks newer than this build: wording "not in the list this version knows"                                                                                                                                                    |
| png.unknown-critical | Unknown critical chunk (first byte uppercase)                                                                                                                   | notable         | verified: PNG3 5.4 (decoders must flag unknown critical chunks)                                                                                                                                                                                     | None                                                                                                                                                                                                                                    |
| png.text-size        | A tEXt, zTXt, iTXt or eXIf chunk over 64 KiB (info) or 1 MiB (notable): "The _k_ text chunk holds N bytes." Keyword shown cleaned, text not shown               | info or notable | Sizes: **unverified** policy. Facts verified: keyword 1 to 79 bytes (11.3.3.1); text length bounded only by chunk size (11.3.3.2); text under 1,024 bytes should be uncompressed (12.9); one eXIf only (11.3.4.5), constrained only by 2^31-1 bytes | XMP in `iTXt` ("XML:com.adobe.xmp") and eXIf with thumbnails are legitimately large: the keyword is named and thresholds are set from the measured sample sets (below)                                                                  |
| png.exif-dup         | More than one eXIf chunk                                                                                                                                        | notable         | verified: PNG3 11.3.4.5 ("Only one eXIf chunk is allowed")                                                                                                                                                                                          | None                                                                                                                                                                                                                                    |
| png.apng             | acTL/fcTL/fdAT sequence numbers start at 0 and rise by 1 with no gap or duplicate; acTL before IDAT                                                             | notable         | verified: PNG3 4.9.1, 4.9.2, 5.6 Table 7                                                                                                                                                                                                            | None. Reported only when `acTL` is present                                                                                                                                                                                              |
| png.cgbi             | `CgBI` chunk before IHDR: "Apple's iPhone-optimised PNG variant, which is not a conforming PNG." Suppresses png.chunk-order for IHDR-first, and the IDAT checks | info            | verified (secondary only): darling-cocotron PR 391 (extra CgBI before IHDR, IDAT is raw deflate, premultiplied BGRA); Apple has no public spec                                                                                                      | Expected in app bundles                                                                                                                                                                                                                 |
| png.idot             | `iDOT`: "An Apple chunk that stores offsets to speed up decoding. It holds no image data."                                                                      | info            | verified (secondary only): w3c/png issue 530, Hacker Factor. Not in PNG3                                                                                                                                                                            | Offsets go stale if the file is edited; not checked in v1                                                                                                                                                                               |
| png.c2pa             | `caBX`: "Content Credentials (C2PA) manifest, N bytes. MarkCopy did not read or verify it." Notes if after IDAT                                                 | info            | verified: C2PA A.3 (ancillary, private, not-safe-to-copy chunk `caBX`; recommended before IDAT; between IDAT and IEND is "poor form", APNG excepted)                                                                                                | Common once signing spreads; never notable                                                                                                                                                                                              |

Skipped in v1: whether the inflated IDAT length equals `height * (1 + row bytes)`, and
zlib trailing bytes (PNG3 says trailing unused bytes are "undesirable", per the research
note, unverified). Both need inflation, which this feature does not do. The page lists
"image data was not decoded" under Not checked.

## JPEG

**Walk.** Check `FF D8` (verified: T81 B.2.1, compressed image data is SOI, frame, EOI).
Then, from offset 2:

1. Skip fill bytes: any run of `FF` before a marker's code byte (verified: T81 B.1.1.2).
2. A marker is `FF` plus a code that is neither `00` nor `FF` (verified: T81 B.1.1.2).
3. Standalone markers have no length: SOI, EOI, TEM (`FF 01`), RSTm (`FF D0` to `FF D7`)
   (verified: T81 Table B.1, asterisked).
4. Any other marker is followed by a 2-byte big-endian length that counts itself and not the
   marker (verified: T81 B.1.1.4). A length under 2 or past EOF ends the walk with a finding.
5. After an SOS segment, scan the entropy-coded data for the next marker. `FF 00` is a
   stuffed data byte and `FF D0` to `FF D7` are restart markers, so neither ends the scan
   (verified: T81 B.1.1.5 note 2, Table B.1). Anything else after `FF` ends it. Progressive
   files contain many SOS segments, so the walk continues after each scan.
6. Stop at `FF D9` (EOI). The tail is `[eoi + 2, size)`.

Segments are read by length, so an embedded thumbnail's own `FF D9` inside an APP1
segment cannot be mistaken for EOI.

| ID                    | Check and wording                                                                                                                          | Sev.         | Tag                                                                                                                                                                                                                                                                        | False positives and how avoided                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| jpeg.broken           | "The marker structure breaks at offset N (_reason_). The rest of the file was not read as JPEG."                                           | notable      | verified: T81 B.1.1.2 to B.1.1.4                                                                                                                                                                                                                                           | Truncated files end without EOI: "The file ends before the EOI marker." info                                                                                     |
| jpeg.tail-declared    | Trailer bytes described exactly by container XMP (below): "A _mime_ item of N bytes is declared by the file's Container XMP (_semantic_)." | info         | verified: MP (Container:Directory, Item:Length, Padding; MotionPhoto item last; GainMap before video)                                                                                                                                                                      | See the declared-trailer algorithm below                                                                                                                         |
| jpeg.tail-mpf         | Each MP entry whose offset lands on `FF D8` inside the file: "Image _n_ of N bytes is declared by the file's Multi-Picture index."         | info         | verified: MPF 5.1 (no restrictions between one image's EOI and the next SOI), 5.2.3.3.2 (size), 5.2.3.3.3 (offset relative to the MP Endian field; first image offset is a masked value in the draft, assumed 0: **unverified**), MPF header identifier and layout 5.2     | The MP Endian base is inside APP2, not the file start; offsets are rebased once. Uses the 2009 draft, not the final DC-007                                       |
| jpeg.tail-samsung     | Tail ends with `SEFT` and contains `SEFH`: "A Samsung trailer (a format Samsung has not published), N bytes."                              | info         | **unverified**: ExifTool forum and tag tables only, no spec. Recognition by the two markers only; no offsets or lengths are claimed                                                                                                                                        | Mislabel risk is accepted: the finding says "looks like", not "is"                                                                                               |
| jpeg.tail-unaccounted | Any trailer bytes not covered above: "N bytes follow the EOI marker that nothing in the file describes." plus sniff                        | notable      | Fact verified: MP ("No other bytes may be placed after" the video item); T81 B.2.1 (image ends at EOI)                                                                                                                                                                     | The main false-positive risk: other vendor trailers (unverified: Sony, Canon). Measured below; a vendor trailer that recurs gets its own `declared: format` rule |
| jpeg.motion-stale     | XMP says `Camera:MotionPhoto=1` but no video trailer exists: "The XMP says this is a Motion Photo, but no video follows."                  | info         | verified: MP ("readers must always confirm that a video is present"; flag can be a stale residue)                                                                                                                                                                          | Edited photos carry it routinely; never notable                                                                                                                  |
| jpeg.com              | COM segments (`FF FE`): count and sizes, first 120 characters cleaned, each shown. Over 1 KiB: notable                                     | info/notable | verified: T81 Table B.1 (COM). The 1 KiB threshold is **unverified**                                                                                                                                                                                                       | Camera and encoder tags ("CREATOR: gd-jpeg") are short. Threshold tuned on the sample sets                                                                       |
| jpeg.app-inventory    | APP0 to APP15 table: marker, identifier string, offset, size. Unknown identifier over 64 KiB total: notable                                | info/notable | Marker range verified: T81 Table B.1. Identifiers: JFIF (verified: JFIF, zero-terminated "JFIF"), `Exif\0\0`, `http://ns.adobe.com/xap/1.0/\0`, `ICC_PROFILE\0`, `Photoshop 3.0\0`, `Adobe`, `MPF\0` are **unverified** except where noted (CIPA DC-008 could not be read) | Fine to be wrong in v1: an unrecognised identifier is listed, not accused                                                                                        |
| jpeg.c2pa             | APP11 segments starting `JP`: "Content Credentials (C2PA) data, N bytes in K segments. Not read or verified."                              | info         | verified: C2PA A.3 (manifest in APP11, JPEG XT, multiple contiguous segments in order); the `JP` identifier is **unverified**                                                                                                                                              | The segments are before SOS, so never confused with a trailer                                                                                                    |

**Declared-trailer algorithm.** XMP is read from APP1 segments whose identifier is the XMP
namespace string (inventory above), parsed with `parseXmlBounded()`
([src/binary/xml.ts](../src/binary/xml.ts)); ExtendedXMP (multi-segment) is not joined in
v1, and the page then says "XMP was only partly read". For a Container:Directory with
`Item:Length` values for secondary items and an optional `Item:Padding` on the primary,
the declared tail is `padding + sum(secondary lengths)`. The MP spec says items are tightly
packed in directory order, the primary's length is found by parsing the image (our EOI),
and the `MotionPhoto` item is last with no byte after it (verified: MP). Rules:

- Declared length equals the trailer length: every item is declared (info).
- Declared is shorter than the tail: the declared items are info and the remainder is
  `jpeg.tail-unaccounted`.
- Declared is longer than the tail, or an item's bytes fail a cheap sanity check (a
  `video/mp4` item whose bytes 4 to 7 are not `ftyp`; **unverified**, from ISO BMFF
  background knowledge): "The XMP declares N bytes the file does not have." notable.
- Items with `Length` 0 share the previous item's bytes and are skipped (verified: MP).
- HEIC and AVIF motion photos end in an `mpvd` box and are out of scope (the walker is
  JPEG only).

## GIF

**Walk (verified: GIF sections 15 to 27).** Header `GIF` plus 3-byte version (section 17);
logical screen descriptor (section 18) with a flag for a global colour table; then blocks:
`0x21` extension introducer followed by a label (`F9` graphic control, `FE` comment, `01`
plain text, `FF` application) and data sub-blocks, each a size byte then that many bytes,
ended by a zero-length block (sections 15, 16, 23 to 26); `0x2C` image descriptor
(section 20) followed by an optional local colour table, an LZW minimum code size byte and
sub-blocks; `0x3B` trailer ends the stream (section 27). The colour table size formula
and the packed-field bit layout are **unverified** in this pass (they were not among the
sections read) and come from the research note; the walker is tested against the existing
`gifInfo` fixtures.

| ID                | Check and wording                                                                                                                                                                                                | Sev.         | Tag                                                                                                                | False positives and avoidance                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| gif.after-trailer | "N bytes follow the GIF trailer, which ends the data stream." plus sniff                                                                                                                                         | notable      | verified: GIF section 27 ("indicating the end of the GIF Data Stream")                                             | JAR/zip appended to a GIF (GIFAR) is exactly this; tail of 0 to 3 whitespace or NUL bytes is not reported                                                                |
| gif.no-trailer    | "The file ends before the GIF trailer."                                                                                                                                                                          | info         | verified: GIF section 27                                                                                           | Truncation                                                                                                                                                               |
| gif.bad-block     | A block introducer that is not `21`, `2C` or `3B`: "Unknown block byte 0x.. at offset N; the walk stopped."                                                                                                      | notable      | verified: GIF sections 20, 26.c.i, 27 (the three introducers)                                                      | Damage                                                                                                                                                                   |
| gif.comment       | Comment extensions: count, total bytes, first 120 characters of the first three. Over 4 KiB total: notable                                                                                                       | info/notable | verified: GIF section 24 (label `FE`). 4 KiB is **unverified**                                                     | Encoders write short comments (unverified)                                                                                                                               |
| gif.app-ext       | Application extension identifier (8 ASCII bytes) and authentication code (3 bytes), size. Known: `NETSCAPE2.0`, `ANIMEXTS1.0`, `XMP DataXMP`, `ICCRGBG1012`. Unknown identifier with over 1 KiB of data: notable | info/notable | verified: GIF section 26 (block size 11, 8-byte identifier, 3-byte code). The known identifiers are **unverified** | C2PA uses an application extension too (verified: C2PA A.3, after the header and before the first image descriptor; its identifier text is not recorded, **unverified**) |

## SVG

SVG is text, and MarkCopy already draws it only through `<img>` and never parses it into
the DOM ([IMAGE-DESIGN](IMAGE-DESIGN.md)). The inspector parses it with `parseXmlBounded()`
in the worker, under its element and depth budget, so a hostile document cannot expand.
Where the parse fails, the page reports that and falls back to a bounded text scan for the
same names. Findings say whether MarkCopy ran the content (it did not).

| ID             | Check and wording                                                                                                                       | Sev.         | Tag                                                                                                                                                        | False positives and avoidance                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| svg.script     | `<script>` element: "This SVG contains a script. The preview does not run it; a browser that opens the file directly can."              | notable      | verified: SVG2 15.9 (script element); 2.2.6 and 2.3 (secure static mode: "no script in the document must be run" for SVG used as an image)                 | D3 and map exports carry scripts on purpose. The wording says what runs where; notable is the maximum             |
| svg.event      | Attributes beginning `on` (verified: SVG2 15.8: "starts with 'on'", content is ECMAScript): "N elements have event handler attributes." | notable      | verified: SVG2 15.8                                                                                                                                        | Interactive exports. Attribute names matched exactly, case-sensitive as XML is (unverified for XML 1.0, not read) |
| svg.foreign    | `<foreignObject>`: "contains HTML or other non-SVG content (foreignObject)."                                                            | info         | verified: SVG2 2.3 (foreignObject is processed with restrictions as the surrounding document), 12.4 (listed; text not read)                                | draw.io and Mermaid use it for labels; never notable alone                                                        |
| svg.js-url     | `href` or `xlink:href` starting `javascript:`                                                                                           | notable      | **unverified**: SVG2 does not mention `javascript:` URLs in 15.8 or 15.9; the scheme is an HTML and URL matter, and the research note's list is background | Only checked on `<a>`                                                                                             |
| svg.data-uri   | `data:` hrefs: MIME type and decoded size, never decoded. Non-`image/*` MIME, or over 1 MiB: notable                                    | info/notable | **unverified** (SVG2 `data:` text not reached)                                                                                                             | Embedded rasters are everywhere in exported SVG. Only the MIME decides severity                                   |
| svg.external   | `href` to `http:` or `https:`: "The SVG refers to N external resources. The preview does not load them."                                | info         | verified: SVG2 2.2.1, 2.3 (external references fail as network errors in secure modes)                                                                     | Namespace URIs and `xmlns` values are not hrefs and are excluded                                                  |
| svg.after-root | Non-whitespace, non-comment text after the root element's end tag                                                                       | notable      | **unverified** (XML well-formedness is not in this pass)                                                                                                   | Trailing newline or comment: ignored                                                                              |

## PDF

PDF is read as bytes, never through pdf.js (the research report is explicit and pdf.js'
public API exposes no raw trailer; a worker-side scan also keeps it out of the viewer's
process). The scanner works over three windows: the head (first 1,024 bytes), the tail
(last 1 MiB) and a single streaming pass for keywords.

**Structure checks (head and tail).**

| ID                | Check and wording                                                                                                                                                                                                                 | Sev.    | Tag                                                                                                                                                                                                          | False positives and avoidance                                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pdf.pre-header    | `%PDF-` found at offset N > 0: "N bytes precede the PDF header." plus sniff of those bytes                                                                                                                                        | notable | Header is the first line: verified P17 7.5.2. Acceptance of an offset header within 1,024 bytes is reader behaviour, **unverified** in P17; PR #279 uses the same 1,024-byte window                          | Few legitimate files have a prefix; sniff explains self-contained cases                                                                                                                                                 |
| pdf.after-eof     | Bytes after the last `%%EOF` (past up to 2 bytes of CR, LF or space): "N bytes follow the last %%EOF marker." plus sniff                                                                                                          | notable | verified: P17 7.5.5 ("The last line of the file shall contain only the end-of-file marker, %%EOF")                                                                                                           | Some producers pad with a few bytes; the threshold is **unverified** and set from the sample sets. Linearized files have an earlier `%%EOF` and are not affected (verified: P17 Annex F, first-page trailer)            |
| pdf.startxref     | The last `startxref` offset does not land on `xref` or an `N G obj` header                                                                                                                                                        | notable | verified: P17 7.5.5 (startxref gives the offset of the last cross-reference section), 7.5.8 (xref streams)                                                                                                   | Broken xref in recovered files; a reader may rebuild it. The page says the file would be repaired by a reader                                                                                                           |
| pdf.revisions     | Follow `/Prev` from the last xref section (verified: P17 Table 15, 7.5.6): "This file has N revisions. Everything after the first is an incremental update." Table of `%%EOF` offsets and section offsets                         | info    | verified: P17 7.5.6 ("Each trailer shall be terminated by its own end-of-file (%%EOF) marker"; appended updates leave the original intact)                                                                   | Chain walk caps at 64 hops with a visited set (a `/Prev` cycle ends it). A count of raw `%%EOF` strings is not used because it also hits strings inside streams. Word and Acrobat saves are normal; never notable alone |
| pdf.signed-update | A signature dictionary's `/ByteRange [a b c d]` with `c + d` less than the file size: "N bytes follow the last signed range. A later signature or form fill is normal; this page does not say whether these changes are allowed." | notable | The incremental-update mechanism is verified (P17 7.5.6; NDSS 2021 shadow attacks per the research note). The `/ByteRange` rule is **unverified** (P17 section not read) and the signature is never verified | Certified documents and multiple signers legitimately extend the file; wording leaves the judgement to the reader                                                                                                       |

**Keyword inventory.** One streaming pass over the body, tracking `stream` to `endstream`
so stream bodies are skipped, and tokenising names so that `/J#53` and `/JS` count the same
(verified: P17 7.3.5, any character of a name may be written as `#` plus two hex digits).
Names counted: `/JavaScript`, `/JS`, `/OpenAction`, `/AA`, `/Launch`, `/EmbeddedFile`,
`/EmbeddedFiles`, `/Filespec`, `/RichMedia`, `/XFA`, `/SubmitForm`, `/GoToR`, `/URI`,
`/ObjStm`, `/Encrypt`, `/ByteRange`.

| Name                                         | Meaning stated on the page                                                     | Sev.              | Tag                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/OpenAction`, `/AA`                         | "An action runs when the document opens or a trigger fires."                   | info              | verified: P17 12.6.1, 12.6.3 (the catalog OpenAction entry; additional actions)                                     |
| `/JavaScript`, `/JS`                         | "N objects name a JavaScript action. MarkCopy did not read the script."        | info              | verified: P17 12.6.4.16 (JavaScript actions), 7.7.4 (document-level name tree)                                      |
| `/OpenAction` and `/JavaScript` both present | "The document names a JavaScript action and an action that runs on open."      | notable           | The pair is the pattern in Stevens' tools notes (research note, not re-fetched); **heuristic**                      |
| `/Launch`                                    | "A launch action names a file or program (not run)."                           | notable           | verified: P17 12.6.4.5 (launch actions)                                                                             |
| `/EmbeddedFile`, `/EmbeddedFiles`            | "N attached files (names shown, never opened)." File names cleaned, at most 20 | info              | verified: P17 7.11.4 (embedded file streams), 7.7.4 (EmbeddedFiles name tree)                                       |
| `/RichMedia`                                 | "Embedded rich media (video, audio or 3D)."                                    | info              | **unverified**: absent from ISO 32000-1 (searched), belongs to ISO 32000-2 and Adobe's extension level; not fetched |
| `/ObjStm`                                    | "N object streams were not read, so keywords inside them are not counted."     | info (limitation) | verified: P17 7.5.7 (objects compressed in streams)                                                                 |
| `/Encrypt`                                   | "The file is encrypted; strings and streams were not read."                    | info              | verified: P17 7.5.5 Table 15 (Encrypt entry)                                                                        |

**False positives and the structural fix.** pdfid counts bytes, and `/JS` or `/AA` appear by
chance inside compressed streams of large files (verified: DS: "statistically very likely
that /AA or /JS (only three bytes long) appear inside a stream"; confirmed with pdf-parser).
Skipping stream bodies removes that class, and the page says "counted outside stream
bodies". What stays missed is the inverse: keywords inside object streams, which the page
declares as above. `endstream` is found by searching for the keyword after `stream`, since
`/Length` may be indirect; a stream body that itself contains `endstream` ends the skip
early and can produce a miscount, which the fuzzer's determinism oracle bounds but cannot
remove. Findings are information, not alerts: an `/OpenAction` that goes to a page is
ordinary.

Skipped: hidden text and optional-content layers (need content-stream parsing; OCR text
layers are legitimate, per the research note), unreferenced objects (need a full xref
walk), and ISO 32000-2 additions.

## ZIP

Applies to `.zip`, `.jar`, `.apk` and Office files. Uses `openZip()` for the entry list and
the signature helpers for the tail.

| ID                 | Check and wording                                                                                                                                                                                                      | Sev.         | Tag                                                                                                                                                                                                             | False positives and avoidance                                                                                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zip.after-eocd     | EOCD at E with comment length C and `E + 22 + C < size`: "N bytes follow the end of the zip directory." plus sniff                                                                                                     | notable      | verified: APP 4.3.16 (EOCD ends with comment length and comment), 4.3.1 (EOCD required); search window 22 + 65,535 is derived from the 2-byte length                                                            | Some signers and uploaders append bytes (unverified); measured                                                                                                                                                                                                                                 |
| zip.comment        | Non-empty comment: length and cleaned first 120 characters                                                                                                                                                             | info         | verified: APP 7.3.3 (comment never encrypted); comment field 4.3.16. Office files having none is **unverified**                                                                                                 | Tools such as Info-ZIP and 7-Zip add comments on request; info only                                                                                                                                                                                                                            |
| zip.prefix         | Bytes before the first local header: "N bytes precede the first entry." Sniffed: MZ with PE check: "a self-extracting archive"; other known format: notable                                                            | info/notable | verified: APP 4.1.9 (self-extracting archives hold extraction code in the file); the spec is **silent** on prefixes (no passage found)                                                                          | Self-extractors are normal, so MZ with a PE is info. Prefix of another format (PNG, PDF, GIF) is the polyglot pattern: notable                                                                                                                                                                 |
| zip.offset-base    | Directory offset: compute `prefix = eocd - directorySize - directoryOffset`. If non-zero, check whether the central directory is found by both readings. "Readers may place this archive differently"                  | notable      | verified: APP 4.4.16 ("relative offset of local header", base not stated). The reader differential (some libraries treat the offset as file-relative) is from CrowdStrike via the research note, **unverified** | Self-extractors set prefix non-zero on purpose; reported only when both readings find a `PK\1\2`                                                                                                                                                                                               |
| zip.multiple       | EOCD signatures that validate (directory offset and size point at a `PK\1\2`) outside the primary directory and outside any entry's data span: "This file holds N zip archives end to end. Tools show different ones." | notable      | Phenomenon verified: BC (7-Zip reads the first, WinRAR shows both, Explorer may fail). The research note's "16 of 34 engines" is **not on the BleepingComputer page** and is dropped                            | **Nested stored archives.** Spring Boot fat jars and Office embeddings store whole zips uncompressed, and each contains an EOCD. Entry data spans (local header + name + extra + compressed size, plus up to 24 bytes of data descriptor) are computed from the central directory and excluded |
| zip.gap            | Bytes between entry spans, or between the last entry and the directory, that no entry accounts for: "N bytes sit between entries that no entry accounts for."                                                          | info         | verified: APK ("immediately before the ZIP Central Directory", layout, magic `APK Sig Block 42`). Data descriptors and bit 3: APP 4.4.4                                                                         | APK signing block is `declared: format` when its magic and matching sizes are present. zipalign padding sits inside the extra field and is not a gap                                                                                                                                           |
| zip.local-mismatch | Local header name or sizes differ from the central entry (not when bit 3 is set). Checked for the first 2,000 entries                                                                                                  | notable      | verified: APP 4.4.4 bit 3 (sizes zero in local header); mismatch as risk is the BC differential. The check set is **unverified**                                                                                | Sample only: a notice says "first 2,000 entries"                                                                                                                                                                                                                                               |
| zip.duplicate      | Two entries with the same name: "N names appear twice. Tools may extract different ones."                                                                                                                              | notable      | **unverified** (parser differential, research note); names never used as paths                                                                                                                                  | Case-insensitive match is shown as info and is not notable                                                                                                                                                                                                                                     |

Encryption labels (`feat/encryption-labels`) stay on the package page.

## Limits and budgets

| Limit                         | Value                                                                                                                                                                       | Why                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| File size                     | 64 MB when the host reads it whole (remote files). Local: ranged reads, any size                                                                                            | Same as the file info pipeline                                                                  |
| Read budget                   | 1,024 pages of 64 KiB (64 MiB) through `RangeReader`, 4 MiB per read                                                                                                        | Hidden-data walks read a linear pass; the package default (32 MiB) is too small for a 60 MB PNG |
| Soft deadline                 | 10 s from the start of the walk; the report is returned with `stoppedEarly` set                                                                                             | Leaves 5 s for the digest and render before the 15 s worker timer                               |
| Chunk and segment caps        | PNG 100,000 chunks; JPEG 10,000 segments and 1,000 scans; GIF 100,000 blocks; zip `MAX_ZIP_ENTRIES` (100,000) and `MAX_DIRECTORY_BYTES` (12 MiB); PDF 64 `/Prev` hops       | A cap says "N more not listed" and never loops                                                  |
| CRC and scans past the budget | PNG: chunks past the 64 MiB budget are listed without a CRC check and the page says so. JPEG: an entropy scan past the budget ends the walk with `stoppedEarly`             | An honest partial result, not a failure                                                         |
| Strings                       | 256 bytes shown per region, 120 characters per comment or keyword, 20 attachment names, 200 findings                                                                        | Bounded page; `bound()` as in the package preview                                               |
| Inflation                     | None. No `zTXt`, `iTXt`, PDF stream or zip entry is decompressed                                                                                                            | Removes the zip-bomb class                                                                      |
| Truncated or malformed        | A walker never throws on file content: it returns what it read, a `stoppedEarly` reason and the offset. A format other than its extension says so and is read as what it is | Same contract as `readPackage`'s `ReadError` and per-table warnings                             |

## Page layout

Same shell as the executable and package pages ([ARCHITECTURE](ARCHITECTURE.md#executable-info-preview)):
`pageHead()`, then `block()` sections, styled by `media/preview.css` with the Primer
`--mc-*` tokens and the blue accent (not alex-style or okstudio-style, per the repo's
convention). No new CSS beyond a severity chip.

```
 photo-MP.jpg                                    JPEG, 4.9 MB, SHA-256 ab12...
 -----------------------------------------------------------------------------
 Summary
   Logical end of image: offset 2,481,022 (EOI marker)
   1 notable finding, 2 informational. Read 4.9 MB in 0.3 s.

 Findings
   [notable]  38 bytes follow the EOI marker that nothing in the file describes.
              Offset 4,900,022. Begins like: ZIP archive.        [hex and ASCII]
   [info]     A video of 2,418,990 bytes is declared by the file's Container XMP
              (Motion Photo, video/mp4).
   [info]     Content Credentials (C2PA) data, 41,230 bytes in 1 segment.
              MarkCopy did not read or verify it.

 Segments            (collapsible grid: marker, name or identifier, offset, size)
 Not checked         pixel data and compressed content; signature or manifest
                     validity; 38 bytes of tail were not interpreted.
```

Notable findings first; `declared` regions carry a "declared" chip; unverified rules a
"heuristic" chip. A region's hex dump is selectable text, never a link or an action that
opens the bytes.

## Test and fuzz plan

Follows [FUZZING-STRATEGY](FUZZING-STRATEGY.md): oracle per target, differential through
two sources, seeds from fixture builders, dictionaries, a harness test on every pull
request, and a finding becomes the fix plus a unit test plus a seed.

- **Fixture builders** in `tests/hidden/*Fixture.ts`: `buildPng({ chunks, tail, badCrc })`,
  `buildJpeg({ segments, scans, trailer })`, `buildMotionPhoto({ padding, items })`,
  `buildMpf({ images })`, `buildGif`, `buildPdf({ revisions, tail, keywords, signature })`,
  `buildZip({ prefix, comment, tail, nested })` (reusing `tests/pkg/zipFixture.ts`). Every
  rule above has a positive case, a negative case and a boundary case (tail of 3 versus 4
  bytes), and a test that asserts each finding's `id` appears in this document.
- **Jazzer targets** in `fuzz/targets/`: `hidden-png`, `hidden-jpeg`, `hidden-gif`,
  `hidden-svg`, `hidden-pdf`, `hidden-zip`, and a catch-all `hidden` for routing. Seeds from
  `scripts/make-fuzz-seeds.ts`; dictionaries `fuzz/dict/hidden.dict` (chunk names, markers,
  `PK\5\6`, `%%EOF`, `/JS`, `#4A`, `caBX`, `SEFT`, `APK Sig Block 42`).
- **Oracles**, per input: the documented error class or a report; time (deadline holds);
  heap plus array buffers; `findings.length <= 200`; every `region` inside `[0, size)`;
  `region.length > 0`; no `NaN` or `[object Object]` in any string; markup only what the
  renderer emits (the existing `binaryOracle.ts`); every `preview` at most 256 bytes.
- **Differential**: the same bytes through `bytesSource` and a short-read `fileSource`, and a
  second read, must give the same report (the `file-source` target gains the hidden walkers).
- **Properties**: appending any bytes after the logical end of a valid fixture changes
  only the tail findings; truncating a fixture never throws; declared plus unaccounted
  equals the tail length.
- **Known traps to seed**: PNG length of 2^31-1; JPEG `FF FF FF D9`; entropy data with `FF 00`
  and `FF D3`; GIF sub-block chain with no terminator; PDF `/Prev` cycle; PDF `/J#53`; a
  zip with 100,000 empty entries; a stored zip inside a zip; EOCD comment length that points
  past EOF.

## False-positive measurement plan

Rule from [AGENTS](../AGENTS.md): record measured results, not assumed coverage. Before the
inspector ships, run it (one run at a time, half the cores, no parallel agents) over real
sets and publish the counts in this file.

| Set                                                                                                                                | What it exercises                                                        | Minimum                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------- |
| Phone photos: Pixel and Samsung motion photos, iPhone HEIC converted to JPEG, Ultra HDR JPEGs                                      | `jpeg.tail-declared`, `jpeg.tail-mpf`, `jpeg.tail-samsung`, MPF, GainMap | 50 photos per vendor        |
| C2PA-signed images (CAI sample set, camera and Adobe exports, PNG and JPEG)                                                        | `png.c2pa`, `jpeg.c2pa`, `png.private`                                   | 20 files                    |
| Screenshots (Windows Snipping Tool, macOS, Linux tools, browser extensions)                                                        | `png.after-iend`, `png.text-size`                                        | 100 files                   |
| Web PNGs and GIFs saved from major sites, CMS exports                                                                              | `png.after-iend`, `gif.after-trailer`, `png.unknown`                     | 200 files                   |
| Apple app-bundle PNGs                                                                                                              | `png.cgbi`, `png.idot`                                                   | 20 files                    |
| PDFs: Word, Acrobat, LibreOffice and Chrome exports, scanned and OCR PDFs, incrementally saved and signed, linearized, form-filled | `pdf.after-eof`, `pdf.revisions`, `pdf.signed-update`, keyword counts    | 200 files, 30 signed        |
| Signed APKs and JARs, Spring Boot fat jars, zipaligned APKs, Office files, self-extracting archives, installers with zip payloads  | `zip.gap`, `zip.multiple`, `zip.prefix`, `zip.comment`                   | 100 files, 10 nested-stored |
| SVG from Inkscape, Illustrator, draw.io, Mermaid, D3 charts, icon sets                                                             | `svg.script`, `svg.event`, `svg.foreign`, `svg.data-uri`                 | 100 files                   |

**What blocks shipping.** A rule ships as `notable` only if, on its sample sets, at most 1% of
files trigger it and every triggering file is explained by a documented cause. Specifically:

- Any `notable` finding on a file that a legitimate tool produced, which no rule can declare
  (for example a vendor trailer seen in over 1% of one vendor's photos), downgrades that rule
  to `info` or adds a `declared: format` rule for the trailer, with a fixture.
- A `zip.multiple` hit on a stored nested archive, a Spring Boot fat jar or an Office embed
  blocks `zip.multiple` entirely.
- Any false "declared" (a trailer called declared that the XMP or MPF index does not
  actually account for, byte for byte) blocks `jpeg.tail-declared`.
- A single crash, hang or over-budget run in the fuzz corpus or the real sets blocks the
  format it occurs in.
- Thresholds marked unverified (64 KiB, 1 MiB, 1 KiB, 4 KiB, the 2-byte EOF allowance) are
  fixed from the measured distributions, and the chosen values and counts are recorded here.

## Phasing

| Phase | Ships                                                                                                                                                                        | Depends on                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 0     | `sliceSource`, `sniffHead`, `Finding` model, `hidden` request kind, panel and command, SECURITY.md section, COPY-MATRIX unaffected (nothing is copied), ARCHITECTURE section | PR #279 merged                                                                                                  |
| 1     | PNG, JPEG (including XMP Container and MPF declaration), zip checks; fixtures, fuzz targets, first measurements                                                              | Phase 0; `feat/encryption-labels` merged (for `openZip` entries) or the zip walker takes its own directory read |
| 2     | GIF and SVG                                                                                                                                                                  | Phase 1                                                                                                         |
| 3     | PDF: tail, revisions, signed-range fact, keyword inventory                                                                                                                   | Phase 1 and a PDF fixture builder                                                                               |

Each phase ships with its fixture tests, fuzz target, seeds, user guide page under
`docs/guide/`, a changelog entry and its measured false-positive table. Nothing later is
announced until its phase is measured.

## Open questions for the maintainer

**Q1. Where does the zip result appear?**
A. A separate "Hidden data" panel opened from a link on the package page (recommended: one
rendering path, and Office files have no package page).
B. A new section on the package page itself.
C. Both.

**Q2. Should opening the panel ask for confirmation?**
A. No: the click on **Inspect file structure** is the confirmation (recommended; the file is
already open in a preview).
B. Yes, reuse the confirm page from `FileInfoEditorProvider` for consistency.

**Q3. Which PDF scope for the first PDF release?**
A. Tail and revisions only, no keyword inventory.
B. Tail, revisions and keyword inventory with the structural skip (recommended).
C. Add the `/ByteRange` signed-range fact as well.

**Q4. May the panel offer "Save tail bytes as..." through a save dialog?**
A. No, show the hex dump only (recommended for v1).
B. Yes, through a save dialog, never opened or run.

**Q5. Notable versus info for `/JavaScript` plus `/OpenAction` in a PDF?**
A. Notable (recommended; matches how such files are triaged).
B. Info only, so the severity never reads as a verdict.

**Q6. Should this wait for PR #279 and the encryption branch to merge?**
A. Yes, build Phase 0 on top of both (recommended).
B. Build now with a local `sniffHead`, then reconcile.

## Corrections to the research notes

| Note said                                                                               | Found                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The text of PNG's security note on data after IEND "was not retrieved" (F.6)            | Retrieved: PNG3 13.3 ("data after the IEND chunk which could contain anything, including malicious code"); F.6 only records its addition                 |
| PNG "No content after IEND" cited loosely                                               | Exact: PNG3 15.3.1 item 3                                                                                                                                |
| Concatenated zips: "WinRAR the second; Explorer only the second"; "16 of 34 AV engines" | BleepingComputer: 7-Zip shows the first, WinRAR shows both, Explorer may fail or show the second after renaming; the 16 of 34 figure is not on that page |
| CgBI and iDOT as background knowledge                                                   | Confirmed only by secondary sources (no Apple spec, not in PNG3); labelled so                                                                            |
| PDF `%PDF-` "within 1,024 bytes" as a spec rule                                         | ISO 32000-1 says first line (7.5.2); the 1,024 window is reader behaviour, unverified. (1,024 bytes is verified only for the linearization dictionary)   |
| `RichMedia` as a counted name                                                           | Not in ISO 32000-1; left unverified                                                                                                                      |
| PDF `/JS` false positives and `#xx` obfuscation both from Stevens                       | Stevens' page covers the first only; `#xx` is from ISO 32000-1 7.3.5                                                                                     |
| MPF offsets "from the file start"                                                       | MPF 5.2.3.3.3: relative to the MP Endian field in the APP2 segment                                                                                       |
