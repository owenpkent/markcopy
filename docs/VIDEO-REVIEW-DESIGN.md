# Video review: design note

**Status: implemented.** This is the design note written _before_ the feature was
built, kept as the record of why it is shaped the way it is. It is not maintained as a
description of the current code: see [Video review](ARCHITECTURE.md#video-review) for
that, and treat any file or line reference below as of its time of writing (MarkCopy
`2905d2c`, Marker `bed7d13`, okstudio-video-kit `467ec02`, whose schema is the
contract). It brings the review loop from [Marker](https://github.com/owenpkent/Marker)
(timecoded notes, In and Out ranges, a markdown hand-off) into the existing video
preview.

What changed in the building. The sidecar is named from the stem (`clip.review.yaml`);
an early draft of this plan had `clip.mp4.review.yaml`, which the kit's `review_path`
does not produce. The host does not parse and stringify the YAML as planned under "YAML
library": it finds each node's range with the `yaml` package, splices the original text,
and ports PyYAML's scalar quoting and wrapping, so an edit is byte-identical to the
kit's own save (19 kit-generated before/after pairs under `tests/fixtures/review/edit/`;
the exceptions are `y`, `n`, `.` and exponent-like strings such as `e2`, which are
quoted where PyYAML leaves them plain). Python's `round()` half-to-even was needed
twice, once for timecodes (`roundHalfEven` in `src/review/timecode.ts`) and once for pin
coordinates (`cleanPoint`, where 0.03125 becomes 0.0312). The copy writes the clipboard
from the host, not the page. And ffprobe was already running on most opens, so the
frame rate reuses that cached probe (`avg_frame_rate`) instead of adding a second run;
only review mode probes when `markcopy.video.transcode` is `off`. The filter and the Done toggle were dropped after hands-on testing (sort was kept, and a note Marker marked done still shows as done, read-only), and the panel was restyled to MarkCopy's own Primer-based tokens with the blue accent after an earlier instrument-panel attempt. The right-click entry became a plain Open Video Notes / Close Video Notes item.

## Verdict

Port Marker's review loop into the video preview in three phases, one PR each. Do not
bundle the Marker desktop app: its Windows build is 148 MB zipped (375 MB unpacked) and
would ship to every MarkCopy user on every platform.

The port is cheap because both halves already exist:

- MarkCopy already has the player, the ffmpeg fallback for codecs the webview cannot
  play, the ffprobe call, clipboard copy, the right-click menu and checked host
  messages ([src/videoEditor.ts](../src/videoEditor.ts),
  [src/webview/video.ts](../src/webview/video.ts), [src/videoProxy.ts](../src/videoProxy.ts)).
- Marker's review service already has the pure logic in browser JavaScript, about 200
  lines under `web/public/js/` (`timecode.js` 26, `timeline.js` 155, `markdown.js`
  18), with tests under `web/test/`. Those move to TypeScript nearly line for line.
  The rest of that folder (`player.js`, the API client) is DOM and transport glue and
  is not ported. Marker is MIT licensed and has the same owner; each ported file names
  its source path and commit.

## Principles

- **One notes file.** Read and write the same `<stem>.review.yaml` sidecar as Marker
  and cutline (`clip.review.yaml` for `clip.mp4`, from the kit's `review_path`), so
  notes made in either tool open in the other.
- **Never damage what MarkCopy does not edit.** The sidecar schema has fields MarkCopy
  will not touch (`asset`, `kind`, `target`, `drawing`, `applied_op`, `checkpoint`,
  `point`, `author`, `color`). They round-trip unchanged.
- **The host owns the file.** The webview sends small edit operations, never a whole
  document or a path. The host derives the sidecar path from the open document,
  allocates ids, validates every operation and writes.
- **The plain preview stays as it is.** Review is a mode. Opening a video without a
  sidecar looks and behaves exactly as today unless the user turns review on.
- **Pointer first.** Marker's accessibility contract carries over: every action works
  with a single click, 44 px hit targets, 8 px between neighbours, 14 px text, and
  keyboard shortcuts only as extras. The styling follows VS Code theme colors, not
  Marker's Obsidian look.

## The sidecar

The schema is `okstudio_video/schema/review.schema.json` in `okstudio-video-kit`, and
the reference code is `okstudio_video/review.py` (`Review`). The parts MarkCopy needs:

- Top level: `version` (1), `source` (the video's file name), `fps`, optional `id`,
  `next_note_id`, `asset`, `notes`.
- Note: `id` (`n1`, `n2`, ...), `target`, `at` (seconds), optional `out` (seconds,
  greater than `at`), `kind`, `done`, `created` (ISO string), optional `text`.
- `next_note_id` is a high-water mark. Ids are never reused, which is what lets a
  deleted note be restored under its old id.
- `additionalProperties` is false everywhere, so MarkCopy must not add fields of its
  own.
- A file without `next_note_id` makes the kit start again at `n1`, which can collide
  with ids already present (`review.py:163`). MarkCopy takes the larger of
  `next_note_id` and one past the highest `n<k>` id in the file.

MarkCopy writes exactly what `Review.new` and `Review.add_note` write
(`review.py:87-96`, `194-205`), so a file made by either tool is indistinguishable:

- A new sidecar: `version: 1`, `id` (12 hex characters), `source` (the video's file
  name), `fps`, `next_note_id`, the default `asset` block (rating 0, status `none`,
  empty keywords and notes) and `notes`.
- A new note: `id`, `target: source`, `at`, `out` when a range is set, `kind: note`,
  `done: false`, `text`, `applied_op: null`, `checkpoint: null`, `drawing: []`, and
  `created` as local time without a zone, `YYYY-MM-DDTHH:MM:SS`, as Python's
  `datetime.now().isoformat(timespec="seconds")` writes it.

A note with another kind (keep or reject, from cutline) is listed like any other and
keeps its kind. Validation on load also applies the kit's cross-field rules: `out`
greater than `at`, and keep or reject only with `target: source`.

**YAML library.** _(As built, the document is spliced, not stringified; see the status
paragraph above.)_ Add [`yaml`](https://www.npmjs.com/package/yaml) as a runtime
dependency of the host bundle (no dependencies of its own, types included). Parse to a
`Document`, apply edits to it and stringify, so key order and untouched fields survive.
Manifest and lockfile change together, and `npm audit` is checked after. Measured
cost: 115 KB minified in the host bundle, 36 KB zipped, about one percent of the
3.7 MB VSIX. A hand-written YAML subset is not a better trade, because preserving
untouched fields and key order is exactly what the library buys.

**Location.** Next to the video only. Marker's "notes in a folder" mode is listed under
Out of scope. Because the name comes from the stem, `clip.mp4` and `clip.mov` in one
folder share a sidecar, exactly as they do in Marker.

## Frame rate

A webview `<video>` cannot report a frame rate. Resolve it on the host, in this order:

1. `fps` from an existing sidecar.
2. ffprobe's `avg_frame_rate`, which is what the kit reads (`okstudio_video/media.py`,
   line 35). Add it to the `-show_entries` list in `src/videoProxy.ts` (line 263)
   beside `r_frame_rate`, which stays for the transcode. The two differ on
   variable-rate phone footage (`r_frame_rate` is often 60 or 120 where the average
   is 29.97), and a sidecar at the wrong one puts every timecode out in Marker.
3. 30, shown in the panel as "30 fps (assumed)".

Read it from the probe the host already runs: after the webview reports `playable`,
`offerSound()` probes the file and caches the result in `this.probed`
(`src/videoEditor.ts:98-102`, `413`, `463-476`), so adding `avg_frame_rate` to that
probe costs nothing extra. That probe is skipped when ffmpeg is missing or
`video.transcode` is `off`. In review mode only, the host then runs it anyway if ffmpeg
exists, and otherwise falls through to the assumed 30.

A new sidecar is only created on the first note, and it records the resolved fps. When
the fps is the assumed 30, the panel says so before the first note is saved, since
Marker would then read every timecode at that rate.

Timecode is non-drop-frame: the frame count is taken at the real rate,
`round(seconds * fps)`, and labelled at the nominal integer rate, `round(fps)`,
matching `okstudio_video/timecode.py`. Marker's `timecode.js` has the exact rule to
port. Seeks land half a frame into the target frame
(`seekMsForFrame`), so the picture matches the label. This also replaces today's
hardcoded `1/30` second frame step.

## Messages

Webview to host, each with an exported pure validator in the style of
`isViewerSetting` (`src/videoEditor.ts:36`):

| Message         | Fields                                | Checks                                                                                                                                                                                |
| --------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviewAdd`     | `at`, optional `out`, optional `text` | finite numbers, `0 <= at`, `out > at`, both within the duration plus one frame when a probe gave a duration (without ffmpeg the host has none), text a string up to 10,000 characters |
| `reviewDelete`  | `id`                                  | id exists                                                                                                                                                                             |
| `reviewRestore` | none                                  | a deleted note is held                                                                                                                                                                |
| `reviewEnable`  | none                                  | none                                                                                                                                                                                  |
| `reviewCopy`    | none                                  | none; the host builds the markdown from the sidecar, writes the markdown file (below) and puts the text on the clipboard with `vscode.env.clipboard.writeText`                        |

Host to webview: `review` (fps, fps source, notes, whether a restore is available) after
every load and write, and `reviewError` with a message for the toast.

**External edits.** A `FileSystemWatcher` on the sidecar reloads it when Marker or
another tool writes it. The watcher takes a `RelativePattern` on the video's
directory, so a video opened from outside the workspace is covered too, and the host
ignores the change event its own write raises. Every write re-reads the file first,
applies the single operation to the fresh content, and writes to a temporary file in
the same folder before renaming it over the sidecar, so Marker never reads half a file.
A sidecar that fails to parse or validate is never overwritten: the panel shows it as
read-only with the reason. A reload caused by another tool never rewrites the markdown
file, so the two tools do not take turns rewriting it.

**Marker open on the same video.** Marker desktop loads the sidecar once and saves its
whole in-memory copy on every change, without re-reading the file
(`marker/controllers.py:675`, `1029-1087`). Any note MarkCopy writes while Marker has
the same video open is therefore lost at Marker's next save. MarkCopy cannot prevent
that. When a reload shows that a note MarkCopy wrote in this session has disappeared,
the panel says "Notes were replaced by another program", and TESTING covers the case.
The fix belongs in Marker (re-read before save) and is listed as a follow-up there.

**Shortcuts.** Extras only, as in Marker. `m` is already mute in the viewer
(`src/webview/video.ts:754`), so Marker's M for a note is not carried over; Enter in the
note field sends. In review mode: I and O set In and Out, J K L slow, pause and speed
up, and Left and Right step one frame alongside the existing `,` and `.`.

## Code layout

- `src/review/timecode.ts`, `src/review/timeline.ts`: pure ports of Marker's
  `web/public/js` modules, imported by the webview bundle and, for timecodes in the
  markdown, the host. `tsconfig.json` includes all of `src`, and the two esbuild
  configs bundle separately, so both can import from `src/review/`.
- `src/review/markdown.ts`: a port of the kit's `export_markdown`, used by the host
  only. The webview never builds markdown, so there is one builder and the clipboard
  text always matches the file.
- `src/videoReview.ts`: host side. Sidecar path, load, validate, apply operation, write,
  watch, fps resolution. Beside `videoEditor.ts`, which calls it.
- `src/webview/videoReview.ts`: the panel, transport and timeline, called from
  `video.ts`, which is already 897 lines.
- Styles in `media/preview.css`, which the video viewer already loads.

The markdown export follows the kit's `Review.export_markdown` (ids as headings, a
status line), not the web service's numbered variant, so the output matches what Marker
desktop writes:

```
# Review notes: clip.mp4

fps 30, status none

## n1  00:00:01:00 to 00:00:03:00  note

Soft focus through the whole pan.
```

The port follows `export_markdown` line by line, minus transcript cues, so fields
MarkCopy never writes still render when present: `Target: render (output time)`,
`By <author>`, `Pin: x% from left, y% from top` (`floor(v * 100 + 0.5)`, not
`round`), `rating n/5` and `keywords` on the status line, and the asset `notes`
paragraph after it. The example above is the minimal case; the golden fixture covers
the full one.

**The markdown file.** As in Marker, the markdown lives as a file next to the sidecar:
`<stem>.review.md` (`clip.review.md`, the default path of `export_markdown`), written
without a dialog. Copy
writes it as well as putting the text on the clipboard, and from phase 2 the host
rewrites it after every note change, so an AI agent working in the same folder can
always read the current notes from disk. The sidecar stays the source of truth; the
markdown file is derived output and is never read back.

## Phases

### Phase 1: read and copy

- Resolve fps on the host and send it with `review`.
- Review mode turns on automatically when a sidecar exists, and from a right-click menu
  item ("Review notes") otherwise. The choice is remembered as a `video.review` viewer
  setting through `isViewerSetting`, like loop and autoplay. In review mode the native controls are replaced by a
  custom transport: play, frame back, frame forward, speed cycle (0.5x, 1x, 2x), the
  timecode readout and the scrubber.
- Note markers on the scrubber, one per note, clustered when closer than one target
  pitch (`layoutDots`). A press seeks to the note.
- A notes panel beside the video lists the notes read-only: timecode, id, text, done.
  A press on a card seeks to it.
- "Copy notes as Markdown" in the panel and the right-click menu sends `reviewCopy`;
  the host writes the markdown file and the clipboard, and the webview shows the
  existing toast. The action is disabled while there is no sidecar, so it never
  creates a file for a video without notes. Because this writes a file, the
  SECURITY, ARCHITECTURE and CHANGELOG notes on silent writes land in this phase.
- Tests: port `web/test/timeline.test.ts`. Marker's `markdown.test.ts` asserts the web
  variant (numbered headings, no status line) and is not ported; the markdown tests
  are written against the kit format. Host tests for fps resolution and sidecar
  parsing; a golden markdown test against a fixture sidecar and
  its export, both generated by `okstudio-video-kit` and checked in under
  `tests/fixtures/`. A short script beside them regenerates the pair; it needs Python
  and the kit, so CI only compares and never regenerates.

### Phase 2: write

- The composer at the foot of the panel: `[` (In), `]` (Out), Clear range, play/pause,
  the text field and a send button. Enter also sends. Focusing the field pauses;
  sending resumes if playback was running.
- Card actions on the selected card: Done and Delete. Delete shows "Restore nN" at the
  top of the panel, one level deep.
- All writes through the messages above. After each one the host rewrites
  `<stem>.review.md`.
- Tests: validators reject bad input (non-finite times, unknown ids, oversized text,
  extra fields); a round trip of a sidecar carrying every schema field leaves the
  untouched fields byte-identical; restore reuses the old id and leaves
  `next_note_id` alone.

### Phase 3: polish

- Filter (All, Pending, Done) and sort (Time, Newest).
- Range bands on the scrubber with bracket end caps, and the pending range drawn as it
  is set.
- Pins (`point`): show existing pins on the picture when their note is in view
  (`pinVisible`), then optionally let a press on the picture set one.

## Documentation per phase

- [README](../README.md) and [CHANGELOG](../CHANGELOG.md).
- [ARCHITECTURE](ARCHITECTURE.md), "Video review" (planned as part of "Video preview"): the review mode, messages, sidecar
  ownership and the watcher.
- [COPY-MATRIX](COPY-MATRIX.md), video section: it says the frame is the only thing
  worth copying. Add notes as Markdown.
- [TESTING](TESTING.md): manual checks for the transport, markers, a sidecar edited in
  Marker while open in MarkCopy, theme legibility of the panel in all four themes, and
  pasting the markdown into a chat.
- [SECURITY](../.github/SECURITY.md): the new file writes and their validation. Line 91
  ("One file is written, where you chose it") describes PDF export and stays true,
  but the video section gains the sidecar and markdown writes.
- ARCHITECTURE lines 100, 152 and 179 say the video editor only writes a frame through
  a save dialog and that previews never write the document. The sidecar is a separate
  file, but those lines gain the exception.

## Risks

- **Wrong fps.** A new sidecar written at the assumed 30 fps when the video is 25 or
  24 makes every timecode wrong in Marker. Mitigated by probing first and labelling the
  assumption; a fps choice in the panel is a fallback if this proves common.
- **Silent writes.** Today the only file the video viewer writes goes through a save
  dialog. The sidecar and the markdown file are written without one, only after the
  user's explicit note or copy action, at paths the host derives from the open
  document. The PDF preview's comment sidecar (`<file>.pdf.mccomments.json`,
  ARCHITECTURE line 262) is the precedent. Note this in the changelog and SECURITY.
- **Lost notes with Marker open.** See "Marker open on the same video" above.
- **Schema drift.** If the kit's schema changes, MarkCopy can reject valid files.
  MarkCopy's own rule, since the kit's `load` checks neither: only `version: 1` is
  editable, and any other version opens read-only.
- **Seek accuracy.** Chromium's `currentTime` seeks may not need Qt's half-frame nudge,
  but it costs nothing and keeps labels matching across tools. Verify by stepping
  through a frame-numbered test clip.
- **Layout in a narrow editor.** The panel moves below the video when the editor is
  narrower than the video plus a 320 px panel.

## Out of scope

- Bundling or launching the Marker desktop app.
- The Marker review service (push, pull, guest links).
- Transcription, drawings, and the asset fields (rating, status, keywords).
- Notes in a folder instead of next to the video.

## Open questions

- Should the Marker desktop app eventually be retired in favour of this, which would
  make the review service's `share.py` worth porting too?
