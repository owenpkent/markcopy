# Image preview: design note

**Status: implemented.** This is the design note written _before_ the feature was built,
kept as the record of why it is shaped the way it is. It is not maintained as a
description of the current code: see [Image preview](ARCHITECTURE.md#image-preview) for
that, and treat any file or line reference below as of its time of writing (MarkCopy
`a0c7f2a`, 0.19.2).

What changed in the building. The sniffer is stricter than a bare magic-byte check so
a mislabelled file is not misread: BMP needs a plausible DIB header size, ICO needs
type 1 and a sane entry count, and SVG needs `<svg` as the root element after any BOM,
XML declaration, comments or DOCTYPE. There is no separate `imageDimensions` function;
`sniffImage` returns the header dimensions with the format. The host writes the saved
background onto `<body>` and sends it again with `load`, so the first paint is right
without a round trip. The webview styles itself inline with the shared `--mc-*` tokens
rather than adding to `preview.css`. Everything else below shipped as written.

MarkCopy previews ten kinds of document and the one thing it still handed to VS Code
was a plain picture. The built-in image preview shows a PNG and zooms it, and that is all: there
is no way to put the picture on the clipboard, no way to copy a Markdown reference to it,
and an SVG opens as XML text with no picture at all. The extension already has everything
an image viewer needs: the GIF viewer (`src/gifEditor.ts`, `src/webview/gif.ts`) loads a
file into a webview as bytes and copies a canvas as PNG, the video viewer owns a
"save a PNG" helper, and the shared menu, toast, theme and status line are in
`media/preview.css` and `src/webview/menu.ts`. This note plans an image viewer that reuses
them.

## Verdict

Build one viewer, `markcopy.imagePreview`, for the raster formats Chromium decodes
(PNG, JPEG, WebP, BMP, ICO, AVIF) and for SVG. Model it on the GIF viewer, not the
Markdown shell: one `<img>` on a checkerboard, a status line, a right-click menu, no
document to serialize. The value is in the menu, and the menu has five rows worth having:

- **Copy Image as PNG** (any format, converted through a canvas),
- **Save as PNG…** (same, to disk),
- **Copy as** > Markdown image, HTML `<img>`, data URI, file name, full path,
- **Copy SVG Source** (SVG only),
- the usual Open in Default App and Reveal rows.

Everything else (zoom, fit, checkerboard, dimensions) exists so the copy is of the right
picture.

## Principles

- **The host sends bytes, not a URI.** As in the GIF viewer, the file is read on the host
  and posted as base64; the webview wraps it in a `Blob` and an object URL. A `Blob` keeps
  the canvas untainted so `toBlob` works, and it keeps `localResourceRoots` at `media/`
  alone. The same 64 MiB cap applies (`MAX_IMAGE_BYTES`), with the same message instead
  of loading.
- **The format is sniffed, not trusted.** A pure parser, `src/webview/imageInfo.ts`,
  reads the magic bytes and reports the MIME type; the `Blob` is built from that, never
  from the extension. A `.png` that is really a JPEG still displays, and the status line
  says what it is. Unknown bytes show an error rather than being handed to the decoder
  under a guessed type.
- **SVG is drawn only through `<img>`.** The bytes are never parsed into the DOM and
  never inlined. An SVG in an `<img>` element runs no script and loads no external
  resource, and the webview CSP (`img-src ${cspSource} blob: data:`, no `connect-src`)
  backs that up. Copy SVG Source copies the file's text as `text/plain` without
  interpreting it.
- **Copy at the file's own size.** Copy Image as PNG draws the natural size, not the
  zoomed size, like Copy Frame as PNG. SVG has no natural pixel size, so the SVG rows get
  a scale (1x, 2x, 4x of the intrinsic or viewBox size, default 2x) in the Copy as
  submenu, with a 16384 px side cap.
- **Reuse before writing.** `saveFrame` (message and host helper from
  `src/videoEditor.ts`) saves the PNG. `createMenu`, `revealLabel`, the theme submenu,
  the `updateSetting` path through `applyMarkcopySetting`, and `preview.css` are used
  as they are. The GIF message parser `src/messages/gif.ts` is the template for
  `src/messages/image.ts`.
- **Everything the host validates stays pure.** `imageInfo.ts` and
  `messages/image.ts` are vscode-free so they join the fuzz build like `gifInfo`.

## Registration

`contributes.customEditors` gains one entry, `markcopy.imagePreview`, with
`filenamePattern` pairs for each extension (patterns are case-sensitive, so `*.png` and
`*.PNG` are both listed, as the GIF entry does): png, jpg, jpeg, webp, bmp, ico, avif,
svg. No new activation event is needed; custom editors activate through
`onCustomEditor`.

**Priority** is `default` for every pattern, SVG included (decided 2026-10-30). The GIF
viewer set the precedent: it wins over the built-in preview, and **Reopen Editor With…**
still reaches the built-in one. The same escape hatch reaches VS Code's text editor for
an SVG someone wants to edit by hand, and the README says so where it says it for GIF.
The alternative, `option` for raster and SVG so MarkCopy only appears in Reopen Editor
With…, was considered and rejected: a copy menu nobody finds is not a feature.

TIFF, HEIC and PSD are out: Chromium does not decode them and a decoder dependency is
not worth its weight for a copy menu.

## The viewer

**Layout.** One `<img>` centred in a scroll container on a checkerboard (CSS gradient,
two greys that follow the theme), a status line at the bottom in the GIF viewer's style:
`photo.webp · 1.2 MB · 1920 x 1080 · WebP`; for SVG, `viewBox 0 0 24 24` when the file
gives one and no width. ICO shows the largest frame's size as Chromium picks it.

**Zoom.** Fit (default), 100%, and steps from 10% to 800%. `Ctrl`+wheel and
`Ctrl`+`+`/`-`/`0` as in the built-in preview so no one has to relearn; `1` for 100%,
`F` for fit. Zoom is session-only state, not a setting. Pixel art zoomed past 200% is
drawn with `image-rendering: pixelated` so pixels stay square.

**Checkerboard.** A Preferences > Background submenu: Checkerboard (default), Light,
Dark, Theme. Stored as `markcopy.image.background`, validated by the settings
allow-list the way `theme` is. This is the one new setting.

**Menu.** Rows in order: Copy Image as PNG, Save as PNG…, Copy as (File Name, Full
Path, Markdown Image, HTML Image, Data URI), Copy SVG Source (SVG only), View (Fit,
100%, Zoom In, Zoom Out), Preferences (Theme, Background), Open in Default App,
Reveal. The menu closes on outside click, Escape and blur through the shared `createMenu`.

The Markdown Image row writes `![alt](path)`. `alt` is the file stem. `path` is relative
to the workspace folder containing the file, with forward slashes and spaces
percent-encoded, which is what pastes into a Markdown file in the same workspace and
resolves; outside any workspace it is the file name alone. HTML Image is
`<img src="path" alt="alt" width="W" height="H">` with the same path. Data URI is
`data:<mime>;base64,…` and is greyed out above 4 MiB with a "Too large for a data URI"
label, since a 60 MB string on the clipboard helps no one.

## Messages

Webview to host, validated by `parseImageMessage` in `src/messages/image.ts`:

| Type            | Payload                 | Host action                                 |
| --------------- | ----------------------- | ------------------------------------------- |
| `ready`         |                         | `fs.stat`, size cap, `fs.readFile`, `load`  |
| `saveFrame`     | `data` (base64), `name` | `saveFrame()` save dialog, PNG filter       |
| `copyText`      | not needed              | clipboard writes happen in the webview      |
| `revealInOS`    |                         | `revealInOs()`                              |
| `openExternal`  |                         | `openExternal` of the document's own URI    |
| `updateSetting` | `key`, `value`          | `applyMarkcopySetting`, allow-listed by key |

Host to webview: `load` (`name`, `path`, `relativePath`, `size`, `data`), `error`
(`message`), `setTheme`. `relativePath` is computed on the host with
`vscode.workspace.asRelativePath`, so the webview never sees workspace layout beyond
that one string.

Clipboard writes stay in the webview as elsewhere: `ClipboardItem` with `image/png` for
pictures, `execCommand('copy')` with a `writeText` fallback for text.

## Code layout

| File                            | Role                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `src/imageEditor.ts`            | `ImageEditorProvider`, HTML, CSP, message dispatch (from gif) |
| `src/messages/image.ts`         | `parseImageMessage`, pure                                     |
| `src/messages/settings.ts`      | `isImageSetting`: theme plus `markcopy.image.background`      |
| `src/webview/imageInfo.ts`      | magic-byte sniff, PNG/JPEG/WebP/BMP/ICO/AVIF/SVG dimensions   |
| `src/webview/image.ts`          | viewer: load, zoom, checkerboard, menu, copy actions          |
| `esbuild.web.js`                | sibling `run()` block, output `media/image.js`                |
| `eslint.config.mjs`             | ignore `media/image.js`; `src/imageEditor.ts` in Node globals |
| `fuzz/targets/image.fuzz.ts`    | feeds `sniffImage` and `imageDimensions`                      |
| `fuzz/build.js`                 | add `imageInfo` to `pureWebview`                              |
| `fuzz/targets/messages.fuzz.ts` | add the image surface and its type list                       |
| `package.json`                  | custom editor, setting, displayName, description, keywords    |

`imageInfo.ts` parses only what the header gives cheaply: PNG `IHDR`, JPEG `SOF0..SOF15`
markers, WebP `VP8 `/`VP8L`/`VP8X`, BMP `DIB`, ICO directory, AVIF `ispe` box, and for
SVG a bounded regex over the first 4 KiB for `width`, `height` and `viewBox`. Where the
header gives nothing the webview falls back to `naturalWidth`/`naturalHeight` after
load. The parser never allocates proportional to a declared size.

## Phases

1. **Parser.** `imageInfo.ts` with `tests/imageInfo.test.ts` (one fixture per format,
   truncated and mislabelled files, a 4 KiB SVG with the viewBox past the window) and the
   fuzz target. No UI yet.
2. **Host.** `imageEditor.ts`, `messages/image.ts`, the `isImageSetting` allow-list,
   `package.json` registration, esbuild and eslint entries. `tests/imageEditor.test.ts`
   mirrors `tests/gifEditor.test.ts`: CSP, size cap, base64 load, `relativePath`,
   `saveFrame`, setting allow-list. `tests/messages.test.ts` gains the image cases.
   `test-integration/customEditors.test.ts` opens a PNG and an SVG and checks which
   editor owns the tab.
3. **Webview.** `image.ts`: load and status, fit and zoom, checkerboard, the menu with
   Copy Image as PNG, Save as PNG…, Copy as rows, Copy SVG Source. `tests/imageWebview.test.ts`
   on `tests/webview/harness.ts`: menu rows per format, Markdown path encoding, data URI
   cap, SVG scale, that the SVG bytes never reach `innerHTML`.
4. **Docs.** README (title, comparison table, feature bullet, a "## Image preview"
   section after GIF), COPY-MATRIX (an "Image" section with the table and notes),
   ARCHITECTURE (eleven kinds through six webviews, file table, messages list, a viewer
   section), TESTING (manual checks: paste the PNG into Word and Slack, SVG at each
   scale, checkerboard in each theme, a mislabelled file), AGENTS.md's viewer list,
   CHANGELOG under Unreleased, `package.json` `displayName`, `description`, keywords.
5. **Validation.** `npm run lint`, `npm run format:check`, `npm test`,
   `npm run compile`, `npm run test:integration`, `npm audit` unchanged (no new
   dependency), and a manual run on the TESTING checklist.

## Risks

- **Taking over PNG, JPEG and SVG surprises people.** Mitigated by **Reopen Editor
  With…**, and by saying so in the README as the GIF section does. SVG is the sharper
  case, since the built-in editor for it is a text editor; the README names the route back.
- **Large images.** A 64 MiB PNG decodes to far more in memory; the GIF viewer has the
  same exposure and the same cap, and the viewer holds one `<img>` and one transient
  canvas. The data URI row is capped separately.
- **SVG as a script carrier.** Handled by principle: `<img>` only, no DOM parse, CSP
  without `connect-src`. The webview test asserts the bytes never reach `innerHTML`.
- **Clipboard image support** is the same dependency as every other PNG copy in the
  matrix and is documented there.
- **ICO and AVIF dimensions** are the fiddliest headers; if they prove unreliable the
  fallback to `naturalWidth` covers them and the parser can report "unknown" honestly.

## Out of scope

- Editing of any kind (crop, resize, rotate, format conversion to disk other than PNG).
- TIFF, HEIC, PSD, RAW.
- Changing how the Markdown preview copies an image it contains; that path
  (`html-to-image` and `ClipboardItem`) stays as it is.
- A thumbnail or gallery view of a folder.
- Animated WebP or APNG controls; they play as the browser plays them.

## Open questions

None open. The priority decision above was the one.
