# Media

Images, GIFs, video, and 3D models open in viewers with real copy actions.

## Image preview

MarkCopy registers as the editor for `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.ico`, `.avif`, and `.svg` (in upper or lower case), so a picture opens in a viewer with a copy menu instead of VS Code's built-in image preview, which can zoom and nothing else. For an SVG the difference is larger: the built-in route is a text editor full of XML, and here you see the drawing. **Reopen Editor With...** still reaches the built-in preview, and for an SVG it also reaches the text editor when you want to edit the markup by hand.

The file is read whole and its kind is decided from its first bytes, not from its extension, so a `.png` that is really a JPEG still opens and the status line says what it is. A file that is not a recognised image shows "Not a recognised image" rather than a blank pane. The status line gives the file name, size, dimensions, and format (`photo.webp · 1.2 MB · 1920 x 1080 · WebP`); an SVG with a `viewBox` and no pixel width shows the `viewBox` instead. An SVG is only ever drawn through an image element: it is never parsed into the page, so a script inside it does not run. An SVG saved as UTF-16 opens too, and an SVG that uses `<foreignObject>` still exports to PNG. A JPEG that carries an EXIF rotation shows, and copies, the way it is meant to be seen (the status line reports the decoded size). A file whose header is recognised but which will not decode shows "Could not decode name".

**Ctrl**+wheel zooms, as do **Ctrl**+**+** and **Ctrl**+**-**; **Ctrl**+**0** or **F** fits the picture to the pane, and **1** shows it at 100%. Zoom runs from 10% to 800% and is not saved. Above 200% pixels are drawn square rather than smoothed, so pixel art stays crisp.

A floating toolbar at the bottom right, above the status line and like the PDF viewer's, has zoom out, a percentage label (click it and type a percentage from 10 to 800; **Enter** applies and **Escape** cancels), zoom in, **Fit to window** (lit while fit is on; click it while lit to go to 100%), a **Hand Tool** toggle, and a **Transparency grid** toggle. The hand tool is on by default: drag the picture to pan when it is larger than the pane. **View** > **Hand Tool** in the right-click menu toggles the same thing, and neither choice is saved. **View** > **Transparency Grid** toggles the grid and does save: it changes `markcopy.image.background` between checkerboard and theme, the same as the toolbar button.

The viewer watches the file, so saving it from an image editor reloads the picture without reopening the tab. If the file is deleted or can no longer be read, the pane says so and the picture is dropped, so the right-click menu offers only **File Name**, **Full Path**, **Open in Default App**, and **Reveal**; restoring the file brings the picture back.

Right-click for the actions:

- **Copy Image as PNG** puts the picture on the clipboard at its own size, whatever the zoom, whatever the source format.
- **Save as PNG…** writes it to disk through a save dialog, defaulting to `<name>.png` beside the file.
- **Copy as** gives the **File Name**, **Full Path**, a **Markdown Image** (`![name](path)`), an **HTML Image** (`<img src alt width height>`), or a **Data URI**. The Markdown and HTML paths are relative to the workspace folder, with spaces and reserved characters percent-encoded, so they resolve when pasted into a Markdown file in the same workspace; outside a workspace they are the bare file name. The data URI is greyed out above 4 MiB with the label "Too large for a data URI".
- **SVG Scale** (SVG only, inside **Copy as**) picks 1x, 2x (the default), or 4x for **Copy Image as PNG** and **Save as PNG…**, since a vector drawing has no pixel size of its own. It lasts for the session, and a side is capped at 16384 px.
- **Copy SVG Source** (SVG only) copies the file's text, in whichever encoding (UTF-8 or UTF-16) the file uses.
- **View** has **Fit**, **100%**, **Zoom In**, **Zoom Out**, a **Hand Tool** checkbox, and a **Transparency Grid** checkbox (absent for a JPEG) that changes the saved default.
- **Preferences** has **Theme**, shared with every other MarkCopy preview, and **Background**: **Checkerboard** (the default: the theme backdrop around the picture, with two faint theme-matched greys under the picture only, and never for a JPEG, which has no transparency), **Light**, **Dark**, or **Theme** (the MarkCopy theme's own background, not VS Code's editor background), stored as `markcopy.image.background`.
- The toolbar's **Transparency grid** button, after the hand tool, shows or hides the checkerboard under the picture. It switches the setting between Checkerboard and Theme, so it persists like the menu, and it is disabled (tooltip "No transparency in a JPEG") for a JPEG. The setting applies per resource, so a workspace or folder can have its own.
- **Open in Default App** and **Reveal** hand the file to the operating system.

On a file that fails to decode, **Copy Image as PNG** and **Save as PNG…** are greyed out. A file above 64 MiB shows a message instead of loading. Copying the picture as PNG needs clipboard image support in VS Code, as every PNG copy in MarkCopy does.

## GIF preview

MarkCopy registers as the editor for `.gif`, so an animation opens on a canvas you can control instead of VS Code's built-in image preview, which plays it with no way to pause or step. (**Reopen Editor With...** still reaches the built-in one.)

Each frame is decoded on demand and drawn at the delay the file gives it, so playback is paced by the GIF itself. Like browsers, the viewer plays a delay of 0 or 10 ms or less as 100 ms. The file's loop count is respected: a GIF with no loop block plays once and stops on its last frame, one marked to repeat forever repeats forever.

**Space** or a click on the picture plays and pauses, **`,`** and **`.`** step one frame back and forward (and pause), and **Home** and **End** jump to the first and last frame. The status line gives the file name, size, dimensions, `frame 3 / 24`, the length of one pass, and what the file says about repeating.

Right-click for the actions:

- **Copy Frame as PNG** puts the frame on screen on the clipboard at the GIF's own size.
- **Save Frame as PNG…** writes it to disk, defaulting to the GIF's folder with the frame number in the name (`anim-frame-012.png`).
- **Copy as** gives the file name or full path.
- **Playback** has Play/Pause, a session-only **Loop** (forever) toggle, and speed from 0.25x to 2x.
- **Preferences → Theme** shares the setting with every other MarkCopy preview.

The viewer uses the browser's WebCodecs `ImageDecoder`. Where that is missing, the GIF is shown in a plain image element: it still plays and the status line still reports its size, but the frame actions and playback controls are unavailable. The file is read whole and sent to the viewer, so a GIF above 64 MiB shows a message instead of loading.

## Video preview

MarkCopy registers as the editor for `.mov`, `.mp4`, `.m4v`, `.3gp`, `.mkv`, `.webm`, `.avi`, `.wmv`, `.flv`, `.mpg`, and `.mpeg`, so a video opens as a player instead of as binary. (`.ts`, `.mts`, and `.m2ts` are left alone: `.ts` is TypeScript.) VS Code's own player opens only the MP4 family, and nothing at all opens a QuickTime `.mov`, which is what a Mac screen recording, a phone clip, and most camera footage arrive as. Measured in VS Code's webview, `.webm` does not open either, despite VS Code's documentation: every container outside `.mp4`, `.mov`, `.m4v`, and `.3gp` is refused at once, even when it holds H.264 or VP9 that plays fine inside an MP4.

The player has the standard transport controls plus a few shortcuts: **space** plays and pauses wherever the focus is, **`,`** and **`.`** step back and forward roughly a frame, **m** mutes, **f** goes fullscreen. A readout under the video gives the file name, pixel dimensions, duration, and size.

Right-click for the copy actions:

- **Copy Frame as PNG** puts the frame currently on screen on the clipboard at the video's true resolution, not the on-screen size, so a still from a screen recording goes straight into a bug report.
- **Save Frame as PNG…** writes it to disk, defaulting to the video's own folder with the timecode in the name (`clip-1m23.400s.png`), so successive grabs never overwrite each other.
- **Copy as** gives the file name or full path.
- **Playback** sets looping (persisted to `markcopy.video.loop`), speed from 0.25x to 2x, and autoplay.
- **Open Video Notes** turns review mode on (it reads **Close Video Notes** while it is on).
- **Preferences → Theme** shares the setting with every other MarkCopy preview.

**Review mode.** A video with a `<stem>.review.yaml` file beside it (`clip.review.yaml` for `clip.mp4`), the notes file written by [Marker](https://github.com/owenpkent/Marker) and the okstudio-video-kit, opens in review mode. So does every video when `markcopy.video.review` is on, and any video after choosing **Open Video Notes** in the right-click menu. MarkCopy reloads the panel when another tool changes the file. A notes file MarkCopy cannot validate (broken YAML, another version) still shows its notes, under a read-only banner, and is never written.

**Transport and timeline.** The native controls give way to a transport: play, step a frame back or forward at the video's real frame rate, speed 0.5x, 1x or 2x, and a timecode readout that says which frame rate it is using and where it came from. The frame rate comes from the notes file, else from ffprobe's average rate (needs ffmpeg), else 30, marked as assumed. **Left** and **Right** step a frame; **J**, **K** and **L** slow, pause and speed up; **I** and **O** set In and Out. The scrubber carries a marker for each note (close ones cluster), and a range note draws a translucent band over the track with bracket end caps, brighter when selected. Pressing a marker or a card jumps to that note.

**Notes panel.** The panel sits beside the video, or below it in a narrow editor, with one card per note. A sort control at the top orders them by **Time** or **Newest** (by when the note was created); the choice is remembered for that panel, not in settings. There is no filter and no way to mark a note done from MarkCopy: a note that Marker marked done is still shown as done, read-only, and its `done: true` is left untouched by every edit. The selected card has **Delete**; after a delete, **Restore nN** at the top of the panel brings the note back under its old id (one level, this panel only).

**Writing notes.** The foot of the panel is a composer: **[ In** and **Out ]** set the start and end from the playhead, a chip shows the pending range with **Clear**, then a **Pin** toggle, a play/pause button, a **Note text** field and **Send**. With no range set, the note is a point at the playhead. **Enter** sends and **Escape** leaves the field. Clicking into the field pauses the video, and sending resumes it if it was playing. The field keeps focus after a send, so you can write the next note straight away: typing pauses the video again. Press **Escape** to hand the keyboard back to the player shortcuts. To pin a note to a spot, turn on **Pin** (or press **P**; the picture then shows a crosshair) and press the picture: a ring with a plus marks the spot, the video pauses and the note field takes focus. Press again to move it; a press in the letterbox does nothing, and **Clear** drops the range and the pin. A sent note, **Clear** and turning **Pin** off all leave pin mode. The chip reads "Pin" or "00:00:01:00 + Pin". Send stores the spot as `point` (0 to 1 across and down the picture). A pinned note shows a numbered stud on the picture while the playhead is on its frame or inside its range; pressing it goes to the note, and its card says "Pin". With **Pin** off (the default), outside review mode, or when the panel is read-only, a press on the picture plays and pauses. A **×** at the top right of the panel closes review mode, the same as **Close Video Notes** in the right-click menu.

The first note on a video with no notes file creates `<stem>.review.yaml`, at the video's frame rate, or at 30 fps with a line above the composer saying so when the rate is unknown. Every change is written to the notes file in the same layout the okstudio-video-kit uses, so Marker opens it, and `<stem>.review.md` is rewritten after each one.

**Copy as Markdown** (on the notes panel, disabled while there is no notes file) builds the same Markdown Marker writes, saves it as `<stem>.review.md` beside the video, and puts it on the clipboard, so you can paste it into a chat or leave it for an agent working in the folder. A pinned note reads "Pin: 42% from left, 30% from top". The video preview writes the notes file and this Markdown file without asking where, and never touches the video.

**Working alongside Marker.** Marker desktop does not re-read its notes before saving, so a note MarkCopy writes while Marker has the same video open is lost at Marker's next save. The panel then says "Notes were replaced by another program". Do not edit one video in both at once; the fix belongs in Marker (owenpkent/Marker#14).

Unlike the PDF and STL viewers, the file is streamed rather than read: the webview is handed a resource URI and the player pulls ranges off disk as it plays, so a multi-gigabyte clip opens as fast as a small one and costs no more memory. Nothing is fetched over the network.

**On codecs.** QuickTime is a container, not a codec. VS Code's Chromium decodes H.264 video, which covers screen recordings, phone footage, and most `.mov` files you are handed, but it has no AAC decoder: an ordinary H.264/AAC file plays its picture in silence, with no error to say why. It also cannot decode ProRes, DNxHD, or (on most builds) HEVC, which is what a `.mov` straight out of a professional camera or editor usually holds.

**Silent video gets a sound copy, if you have ffmpeg.** When a file plays but its audio is something VS Code cannot decode, MarkCopy builds a copy with MP3 sound (the picture stream is copied untouched, so it takes seconds) and swaps it in at the same position, still playing. A slim notice above the status line shows the progress without hiding the video; under `ask` the notice offers a **Build Copy with Sound** button instead, and **Dismiss** hides it. Without ffmpeg nothing is shown. The status line says `ffmpeg copy · sound re-encoded to MP3` while the copy is on screen.

**A video in the wrong container is repackaged in seconds.** A `.mkv` or `.webm` holding H.264, VP9, or AV1 fails only because of its wrapper, so with ffmpeg MarkCopy copies the picture into an MP4 without re-encoding it (the audio becomes MP3). The offer says so ("VS Code's player cannot open .mkv files. MarkCopy can repackage clip.mkv as MP4 with ffmpeg in a few seconds") and the status line reads `ffmpeg copy · repackaged as MP4`. WMV, MPEG-2, VP8, and the like take the full re-encode below; without ffmpeg the message names the container and offers your default player.

**Those play anyway, if you have ffmpeg.** When a file turns out to be undecodable, MarkCopy looks for `ffmpeg` (on `PATH`, then the usual install locations, or wherever `markcopy.video.ffmpegPath` points) and encodes a throwaway H.264 copy to a temp folder, with a progress bar and a **Cancel** button while it runs. The copy is what plays; your original is never touched, and the copy is deleted when you close the tab. The status line says `ffmpeg preview copy` for as long as one is on screen.

A clip with an **alpha channel** (a ProRes 4444 lower third, say) is laid over a transparency checkerboard rather than flattened onto black, because a 99%-transparent graphic composited onto black looks exactly like a clip that renders nothing. The status line says `alpha on checkerboard` in that case, which also tells you the board is baked into any frame you grab.

Set `markcopy.video.transcode` to `ask` if you work with long 4K masters and would rather press a button than have an encode start on its own, or to `off` to keep the old behaviour: a message naming the likely cause and an **Open in Default App** button. With no ffmpeg installed you get that same message, plus a note that installing one would let MarkCopy play the file here.

## STL 3D preview

MarkCopy registers as the editor for `.stl` files, so opening one renders the model inline in a Three.js viewer. Controls are mouse-only, no keyboard required: **left-drag** to orbit, **right-drag** to pan, **scroll wheel** to zoom. The camera fits itself to the model on load, and the toolbar in the top-left offers **Fit view**, a **wireframe** toggle, and a **grid** toggle. An overlay in the bottom-left reports the triangle count and the bounding box as X x Y x Z.

Both binary and ASCII STL are handled. The model is centered in X and Z and rested on the y = 0 plane, so the grid always sits directly under it. The viewport background follows `markcopy.theme` along with the other previews; `markcopy.stl.showGrid` and `markcopy.stl.meshColor` set the grid and mesh color.

Corrupt and hostile files are rejected rather than loaded: a binary STL whose header claims more triangles than the file can hold, any model above ~5.4 million triangles, or any file above 256 MiB shows a message in the panel instead of hanging the viewer on a multi-gigabyte allocation. The size is checked before the file is read, not after. As with the PDF viewer, the file is read by the extension host and handed to the webview as bytes, so nothing is fetched over the network, and **Reopen Editor With...** opens the raw bytes instead.

**Right-click** (not drag) for the menu: **Copy View as PNG** and **Save View as PNG…** capture the model from the current camera angle, **Copy as** gives the file name, full path, dimensions, or triangle count, **View** has Fit View, Front, Back, Left, Right, Top, Bottom and Isometric presets plus wireframe and grid checkboxes that match the toolbar, and **Preferences > Theme** sets `markcopy.theme`. A right-drag pans and does not open the menu. See [COPY-MATRIX](../COPY-MATRIX.md#stl-models-stl).

[Back to the user guide](README.md)
