# Media

Images, GIFs, video, and 3D models open in viewers with real copy actions.

## Image preview

MarkCopy registers as the editor for `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.ico`, `.avif`, and `.svg` (in upper or lower case), so a picture opens in a viewer with a copy menu instead of VS Code's built-in image preview, which can zoom and nothing else. For an SVG the difference is larger: the built-in route is a text editor full of XML, and here you see the drawing. **Reopen Editor With...** still reaches the built-in preview, and for an SVG it also reaches the text editor when you want to edit the markup by hand.

The file is read whole and its kind is decided from its first bytes, not from its extension, so a `.png` that is really a JPEG still opens and the status line says what it is. A file that is not a recognised image shows "Not a recognised image" rather than a blank pane. The status line gives the file name, size, dimensions, and format (`photo.webp · 1.2 MB · 1920 x 1080 · WebP`); an SVG with a `viewBox` and no pixel width shows the `viewBox` instead. An SVG is only ever drawn through an image element: it is never parsed into the page, so a script inside it does not run. An SVG saved as UTF-16 opens too, and an SVG that uses `<foreignObject>` still exports to PNG. A JPEG that carries an EXIF rotation shows, and copies, the way it is meant to be seen (the status line reports the decoded size). A file whose header is recognised but which will not decode shows "Could not decode name".

**Ctrl**+wheel zooms, as do **Ctrl**+**+** and **Ctrl**+**-**; **Ctrl**+**0** or **F** fits the picture to the pane, and **1** shows it at 100%. Zoom runs from 10% to 800% and is not saved. Above 200% pixels are drawn square rather than smoothed, so pixel art stays crisp.

**Back** and **Next** step through the other images in the same folder like a slideshow, in the Explorer's order (names compared case-insensitively, with numbers by value, so `photo2` comes before `photo10`), wrapping round at either end. They sit at the left of the toolbar with a counter between them (`3 / 12`), and the **Left** and **Right** arrow keys, or **Page Up** and **Page Down**, do the same. The arrows scroll instead while the picture is wider than the pane. The next image replaces the current one in the same tab, and the buttons are hidden when the folder holds only this image.

A floating toolbar at the bottom right, above the status line and like the PDF viewer's, has Back, the counter and Next, then zoom out, a percentage label (click it and type a percentage from 10 to 800; **Enter** applies and **Escape** cancels), zoom in, **Fit to window** (lit while fit is on; click it while lit to go to 100%), a **Hand Tool** toggle, and a **Transparency grid** toggle. The hand tool is on by default: drag the picture to pan when it is larger than the pane. **View** > **Hand Tool** in the right-click menu toggles the same thing, and neither choice is saved. **View** > **Transparency Grid** toggles the grid and does save: it changes `markcopy.image.background` between checkerboard and theme, the same as the toolbar button.

The viewer watches the file, so saving it from an image editor reloads the picture without reopening the tab. If the file is deleted or can no longer be read, the pane says so and the picture is dropped, so the right-click menu offers only **File Name**, **Full Path**, **Open in Default App**, and **Reveal**; restoring the file brings the picture back.

Right-click for the actions:

- **Copy Image as PNG** puts the picture on the clipboard at its own size, whatever the zoom, whatever the source format.
- **Save as PNG…** writes it to disk through a save dialog, defaulting to `<name>.png` beside the file.
- **Copy as** gives the **File Name**, **Full Path**, a **Markdown Image** (`![name](path)`), an **HTML Image** (`<img src alt width height>`), or a **Data URI**. The Markdown and HTML paths are relative to the workspace folder, with spaces and reserved characters percent-encoded, so they resolve when pasted into a Markdown file in the same workspace; outside a workspace they are the bare file name. The data URI is greyed out above 4 MiB with the label "Too large for a data URI".
- **SVG Scale** (SVG only, inside **Copy as**) picks 1x, 2x (the default), or 4x for **Copy Image as PNG** and **Save as PNG…**, since a vector drawing has no pixel size of its own. It lasts for the session, and a side is capped at 16384 px.
- **Copy SVG Source** (SVG only) copies the file's text, in whichever encoding (UTF-8 or UTF-16) the file uses.
- **View** has **Fit**, **100%**, **Zoom In**, **Zoom Out**, a **Hand Tool** checkbox, and a **Transparency Grid** checkbox (absent for a JPEG) that changes the saved default.
- **Preferences** has **Theme**, shared with every other MarkCopy preview, and **Background**: **Checkerboard** (the default: the theme backdrop around the picture, with two mid grey squares under the picture only, the same on every theme so both black and white artwork stay visible, and never for a JPEG, which has no transparency), **Light**, **Dark**, or **Theme** (the MarkCopy theme's own background, not VS Code's editor background), stored as `markcopy.image.background`.
- The toolbar's **Transparency grid** button, after the hand tool, shows or hides the checkerboard under the picture. It switches the setting between Checkerboard and Theme, so it persists like the menu, and it is disabled (tooltip "No transparency in a JPEG") for a JPEG. The setting applies per resource, so a workspace or folder can have its own.
- **Open Image Notes** turns Image Notes on (it reads **Close Image Notes** while it is on).
- **Open in Default App** and **Reveal** hand the file to the operating system.

**Image Notes.** Write notes on a picture, each pinned to an area, a spot or the whole image. An image with a notes file beside it (`photo.png.review.yaml` for `photo.png`: the whole file name, then `.review.yaml`) opens with notes on. So does every image when `markcopy.image.review` is on, and any image after choosing **Open Image Notes** in the right-click menu. The file is in the OK Studio review format that the [okstudio-video-kit](https://github.com/owenpkent/okstudio-video-kit/pull/4) defines for images, with `media: image` and no time on a note. MarkCopy reloads the panel when another tool changes the file.

The notes panel sits beside the picture, or below it when the editor is narrower than 720 px, with the toolbar and status line still in view. It has one card per note, showing its number, where it is (`Area 10%, 21%, 30% x 40%`, `Pin 42%, 30%` or `Whole image`) and its text. Pressing a card selects it and brings its shape into view when the picture is zoomed past the window. The selected card has **Delete**; after a delete, **Restore nN** at the top of the panel brings the note back under its old id (one level, this panel only). A note from another tool keeps its kind (`keep`, `reject`), author and done mark, shown but never changed.

At the foot of the panel is a composer with **Area** and **Pin** toggles, a **Note text** field and **Send**. Both toggles are off by default, so a drag pans the picture as before. Turn on **Area** (or press **A**) and drag across the picture to outline a rectangle; turn on **Pin** (or press **P**) and press a spot to drop a pin. The cursor becomes a crosshair, a chip shows the pending anchor with **Clear**, and the note field takes focus. A drag shorter than 4 pixels is ignored, a drag may leave the picture or the window and still ends where you let go, and a press on the margin around the picture places no pin. The field wraps and grows to six lines as you type, then scrolls. **Enter** sends; with no area or pin the note covers the whole image. A sent note, **Clear** and **Escape** leave Area and Pin mode, and the field keeps focus so the next note can follow: **Escape** in the field hands the keyboard back to the viewer. **A**, **P** and the viewer's own keys do nothing while you type in the field. Shapes are drawn over the picture in percentages, so they follow zoom and pan. A **×** at the top right of the panel closes Image Notes, the same as **Close Image Notes**.

The first note on an image with no notes file creates `photo.png.review.yaml`. Every change is written to it in the kit's layout, and `photo.png.review.md` is rewritten after each one. An area is stored as `region: [x, y, w, h]` and a pin as `point: [x, y]`, each number from 0 to 1 of the picture (the area's x and y are its top-left corner from the left and the top). **Copy notes as Markdown** (on the panel, disabled while there is no notes file) saves that Markdown beside the image and puts it on the clipboard.

A notes file MarkCopy cannot use still shows its notes, under a read-only banner, and is never written. That covers broken YAML, another version, and a file for the other kind of media: a video's notes file renamed `photo.png.review.yaml` (no `media: image`) is read-only in the image panel, and an image's notes file is read-only in the video panel.

On a file that fails to decode, **Copy Image as PNG** and **Save as PNG…** are greyed out. A file above 64 MiB shows a message instead of loading. Copying the picture as PNG needs clipboard image support in VS Code, as every PNG copy in MarkCopy does.

## GIF preview

MarkCopy registers as the editor for `.gif`, so an animation opens on a canvas you can control instead of VS Code's built-in image preview, which plays it with no way to pause or step. (**Reopen Editor With...** still reaches the built-in one.)

Each frame is decoded on demand and drawn at the delay the file gives it, so playback is paced by the GIF itself. Like browsers, the viewer plays a delay of 0 or 10 ms or less as 100 ms. The file's loop count is respected: a GIF with no loop block plays once and stops on its last frame, one marked to repeat forever repeats forever.

A control bar under the picture has a play and pause button, the time, a seek slider over the length of one pass, and the time left (`0:01.2` and `-0:02.3`). Pressing the slider pauses, and the GIF stays paused on the frame you let go on. Hovering it shows the time under the pointer, and with the slider focused the arrow keys step one frame. The bar is hidden for a one-frame GIF and in the plain-image fallback.

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

The player has its own control bar under the picture: a play and pause button, a speaker button with a volume slider beside it, the time (`1:05`) and the time left (`-2:15`) at the two ends of a seek slider, and a full screen button. The seek slider is filled in the accent colour up to the playhead; hovering it shows the frame and the time under the pointer, and pressing or dragging it pauses the video, which stays paused where you let go (press play or space to carry on). Fullscreen takes the whole page, so the bar stays usable there. In a narrow pane the seek slider and its two times move to a row of their own above the buttons, and in a very narrow one the volume slider makes way, so play, the speaker, and full screen always fit; both times always show. It does not use the browser's built-in controls, so those controls' picture-in-picture and download entries are not offered; the right-click menu and **Open in Default App** cover saving and opening elsewhere. A few shortcuts go with it: **space** plays and pauses (unless a button has the focus, which then takes the space as a click), **`,`** and **`.`** step back and forward roughly a frame, **m** mutes, **f** goes fullscreen, **Left** and **Right** seek 5 seconds, and **Up** and **Down** raise and lower the volume by 10%. The speaker button mutes and unmutes, and the slider beside it sets the level; the mouse wheel over the picture or the speaker changes it too, 5% a notch. The level is remembered for the next video (`markcopy.video.volume`, 100 by default), whichever control set it. A readout under the video gives the file name, pixel dimensions, duration, and size.

Right-click for the copy actions:

- **Copy Frame as PNG** puts the frame currently on screen on the clipboard at the video's true resolution, not the on-screen size, so a still from a screen recording goes straight into a bug report.
- **Save Frame as PNG…** writes it to disk, defaulting to the video's own folder with the timecode in the name (`clip-1m23.400s.png`), so successive grabs never overwrite each other.
- **Copy as** gives the file name or full path.
- **Playback** sets looping (persisted to `markcopy.video.loop`), speed from 0.25x to 2x, and autoplay.
- **Volume** shows the current level, mutes, and sets 100%, 75%, 50% or 25%. It works in review mode too, where the speaker and its slider move into the notes transport beside its play button.
- **Open Video Notes** turns review mode on (it reads **Close Video Notes** while it is on).
- **Preferences → Theme** shares the setting with every other MarkCopy preview.

**Review mode.** A video with a `<stem>.review.yaml` file beside it (`clip.review.yaml` for `clip.mp4`), the notes file written by [Marker](https://github.com/owenpkent/Marker) and the okstudio-video-kit, opens in review mode. So does every video when `markcopy.video.review` is on, and any video after choosing **Open Video Notes** in the right-click menu. MarkCopy reloads the panel when another tool changes the file. A notes file MarkCopy cannot validate (broken YAML, another version) still shows its notes, under a read-only banner, and is never written.

**Transport and timeline.** The control bar gives way to a transport (with the speaker and its volume slider right after the play button): play, step a frame back or forward at the video's real frame rate, speed 0.5x, 1x or 2x, and a timecode readout that says which frame rate it is using and where it came from. The frame rate comes from the notes file, else from ffprobe's average rate (needs ffmpeg), else 30, marked as assumed. **Left** and **Right** step a frame; **J**, **K** and **L** slow, pause and speed up; **I** and **O** set In and Out. The scrubber carries a marker for each note (close ones merge into one ×N badge at the first of them, with a faint bracket running to the last), every note also has a tick on the bar at its exact frame, and a range note draws a translucent band over the track with bracket end caps, brighter when selected. Pressing a marker or a card jumps to that note. The timecode sits at the scrubber's left end and the time left at its right (on a row under it in a narrow pane). The played part is filled in the accent colour, hovering it shows the frame and the timecode under the pointer, and pressing or dragging it pauses the video, which stays paused on the frame where you let go. A press puts the playhead right under the pointer, even a few px from where it was. A note whose `target` is `render` is timed on the rendered output, which the panel cannot map back to the source, so its card says "Output time", selecting it does not seek, and it gets no marker, tick, band, or pin.

**Notes panel.** The panel sits beside the video, or below it when the editor is narrower than 720 px (600 px for a vertical video, which needs height more than width), with one card per note. A sort control at the top orders them by **Time** or **Newest** (by when the note was created); the choice is remembered for that panel, not in settings. There is no filter and no way to mark a note done from MarkCopy: a note that Marker marked done is still shown as done, read-only, and its `done: true` is left untouched by every edit. The selected card has **Delete**; after a delete, **Restore nN** at the top of the panel brings the note back under its old id (one level, this panel only).

**Writing notes.** The foot of the panel is a composer: **[ In** and **Out ]** set the start and end from the playhead, a chip shows the pending range with **Clear**, then a **Pin** toggle, a play/pause button, a **Note text** field and **Send**. With no range set, the note is a point at the playhead. The field wraps and grows to six lines as you type, then scrolls; a note is one line, so a pasted line break becomes a space. **Enter** sends and **Escape** leaves the field. Clicking into the field pauses the video, and sending resumes it if it was playing. The field keeps focus after a send, so you can write the next note straight away: typing pauses the video again. Press **Escape** to hand the keyboard back to the player shortcuts. To pin a note to a spot, turn on **Pin** (or press **P**; the picture then shows a crosshair) and press the picture: a ring with a plus marks the spot, the video pauses and the note field takes focus. Press again to move it; a press in the letterbox does nothing, and **Clear** drops the range and the pin. A sent note, **Clear** and turning **Pin** off all leave pin mode. The chip reads "Pin" or "00:00:01:00 + Pin". Send stores the spot as `point` (0 to 1 across and down the picture). A pinned note shows a numbered stud on the picture while the playhead is on its frame or inside its range; pressing it goes to the note, and its card says "Pin". With **Pin** off (the default), outside review mode, or when the panel is read-only, a press on the picture plays and pauses. A **×** at the top right of the panel closes review mode, the same as **Close Video Notes** in the right-click menu.

The first note on a video with no notes file creates `<stem>.review.yaml`, at the video's frame rate, or at 30 fps with a line above the composer saying so when the rate is unknown. Every change is written to the notes file in the same layout the okstudio-video-kit uses, so Marker opens it, and `<stem>.review.md` is rewritten after each one.

**Copy as Markdown** (on the notes panel, disabled while there is no notes file) builds the same Markdown Marker writes, saves it as `<stem>.review.md` beside the video, and puts it on the clipboard, so you can paste it into a chat or leave it for an agent working in the folder. A pinned note reads "Pin: 42% from left, 30% from top". The video preview writes the notes file and this Markdown file without asking where, and never touches the video.

**Working alongside Marker.** Marker desktop does not re-read its notes before saving, so a note MarkCopy writes while Marker has the same video open is lost at Marker's next save. The panel then says "Notes were replaced by another program". Do not edit one video in both at once; the fix belongs in Marker (owenpkent/Marker#14).

Unlike the PDF and STL viewers, the file is streamed rather than read: the webview is handed a resource URI and the player pulls ranges off disk as it plays, so a multi-gigabyte clip opens as fast as a small one and costs no more memory. Nothing is fetched over the network (the page reads the file only through its own local webview address).

**On codecs.** QuickTime is a container, not a codec. VS Code's Chromium decodes H.264 video, which covers screen recordings, phone footage, and most `.mov` files you are handed, but it has no AAC decoder: an ordinary H.264/AAC file plays its picture in silence, with no error to say why. It also cannot decode ProRes, DNxHD, or (on most builds) HEVC, which is what a `.mov` straight out of a professional camera or editor usually holds.

**Silent video gets a sound copy, if you have ffmpeg.** When a file plays but its audio is something VS Code cannot decode, MarkCopy builds a copy with MP3 sound (the picture stream is copied untouched, so it takes seconds) and swaps it in at the same position, still playing. A slim notice above the status line shows the progress without hiding the video; under `ask` the notice offers a **Build Copy with Sound** button instead, and **Dismiss** hides it. Without ffmpeg nothing is shown. The status line says `ffmpeg copy · sound re-encoded to MP3` while the copy is on screen.

**A video in the wrong container is repackaged in seconds.** A `.mkv` or `.webm` holding H.264, VP9, or AV1 fails only because of its wrapper, so with ffmpeg MarkCopy copies the picture into an MP4 without re-encoding it (the audio becomes MP3). The offer says so ("VS Code's player cannot open .mkv files. MarkCopy can repackage clip.mkv as MP4 with ffmpeg in a few seconds") and the status line reads `ffmpeg copy · repackaged as MP4`. WMV, MPEG-2, VP8, and the like take the full re-encode below; without ffmpeg the message names the container and offers your default player.

**Those play anyway, if you have ffmpeg.** When a file turns out to be undecodable, MarkCopy looks for `ffmpeg` (on `PATH`, then the usual install locations, or wherever `markcopy.video.ffmpegPath` points) and encodes a throwaway H.264 copy to a temp folder, with a progress bar and a **Cancel** button while it runs. The copy is what plays; your original is never touched, and the copy is deleted when you close the tab. The status line says `ffmpeg preview copy` for as long as one is on screen.

A clip with an **alpha channel** (a ProRes 4444 lower third, say) is laid over a transparency checkerboard rather than flattened onto black, because a 99%-transparent graphic composited onto black looks exactly like a clip that renders nothing. The status line says `alpha on checkerboard` in that case, which also tells you the board is baked into any frame you grab.

Set `markcopy.video.transcode` to `ask` if you work with long 4K masters and would rather press a button than have an encode start on its own, or to `off` to keep the old behaviour: a message naming the likely cause and an **Open in Default App** button. With no ffmpeg installed you get that same message, plus a note that installing one would let MarkCopy play the file here.

## Audio preview

MarkCopy registers as the editor for `.mp3`, `.wav`, `.ogg`, `.oga`, `.opus`, `.flac`, `.m4a`, and `.aac`, so an audio file opens as a player. The page shows the file name and a line with its format, size, and duration, over one toolbar: Previous file, Back 5 s, Play or Pause, Forward 5 s, Next file, a seek slider with the time on its left end and the time left on its right (`h:mm:ss` from one hour), and the playback speed. Hovering the slider shows the time under the pointer; dragging it keeps playing, so you hear where you are. The buttons are 32 px or larger.

**Waveform.** Below the file name is a 120 px waveform of the whole file, one lane for mono and two for stereo (more channels show the first two). The part already played is in the accent colour, the rest is dimmer, and a line marks the playhead. Click anywhere on it to jump there, or drag to scrub; moving the pointer over it shows the time it would jump to. With Audio Notes on, the In to Out range you are setting is shaded, saved range notes are tinted, and each note has a small marker at the top that you click to select the note and jump to it. The waveform is a pointer control only: the keyboard seeks with the arrow keys and the toolbar slider, as below.

MarkCopy decodes the file once in the page to find the peaks (the sound is not played or sent anywhere). Files over 150 MB are not decoded, and neither are files that would take more than about 1 GiB of memory once decoded (roughly 46 minutes of 48 kHz stereo, whatever the file size); the waveform area says so instead. A file the page cannot decode, such as an AAC `.m4a` without a decoder, simply has no waveform, and the player carries on. While it decodes you see "Drawing waveform...".

**Details.** A compact panel lists Format, Codec, Sample rate, Channels (with the layout, such as stereo), Bit depth (lossless files), Bitrate, Duration to the millisecond, File size, and three levels measured from the decoded audio: Peak and RMS in dBFS (a silent file reads "silent"), and Clipping, the count of samples at or above 0.999 of full scale. With **Show Tags** on (off by default, see the right-click menu below), any tags the file carries are listed below them: title, artist, album, album artist, date, track, genre, and comment. Long values wrap. **Copy details** puts the panel on the clipboard as Markdown.

The codec, bit depth, bitrate, layout and tags come from `ffprobe`, found the same way as for video (`markcopy.video.ffmpegPath`, then your PATH and the usual install folders). Without ffmpeg installed the panel still shows what the page itself knows (format from the extension, size, duration, channels, and the levels) and leaves the other rows out, with no error.

Keys work wherever the focus is, except in a text field:

- **Space** or **K** plays and pauses.
- **Left** and **Right** seek 5 s back and forward; hold **Shift** for 30 s. With the seek slider focused they seek by the same amounts.
- **Home** and **End** go to the start and the end.
- **Page Up** and **Page Down** open the previous and next audio file in the same folder, in Explorer order, wrapping round at either end. The folder buttons and the Page keys are hidden or inactive when the folder holds only one audio file.
- **J** and **L** step the speed down and up through 0.5x, 0.75x, 1x, 1.25x, 1.5x and 2x. The speed button cycles the same ladder.

The file is streamed, not read: the player pulls ranges off disk as it plays, so a long recording costs no more memory than a short one, and a file outside the workspace plays as well. Nothing is fetched over the network. `markcopy.audio.autoplay` and `markcopy.audio.loop` (both off by default) start playback when a file opens and repeat it at the end.

### Right-click menu

Right-click the player for **Copy** (Details, File Name, Full Path), **Playback** (Loop, Autoplay, and the speed ladder), **Open Audio Notes** or **Close Audio Notes**, **View > Show Tags**, **Preferences > Theme**, **Open in Default App** and **Reveal in File Explorer**. The menu does not open over a text field, so a note's text keeps the native cut and paste menu.

The file's tags (title, artist, album and the rest) are hidden by default. **Show Tags** adds them to the details panel and to **Copy details**, and saves `markcopy.audio.showTags`. Loop and Autoplay save `markcopy.audio.loop` and `markcopy.audio.autoplay` the same way.

### Audio notes

The **Notes** button on the toolbar opens a notes panel beside the page (below it in a narrow pane), and a timeline in place of the toolbar's seek bar with a marker for each note and the time and time left at its ends. Dragging it keeps playing, as the toolbar's slider does. Notes are saved in a review file beside the audio, named after the whole file name (`song.mp3.review.yaml`) so `song.mp3` and `song.mp4` never share one; it is the same OK Studio review format the video notes use, so the other tools that read it see these notes too. A file that already has one opens with notes on, and `markcopy.audio.review` turns them on for every file.

- **Add note** saves the text in the field at the playhead, or over the range if you set one. **In** and **Out** mark the range from the playhead; **Clear** drops it.
- Press a marker or a note in the list to jump there. Each note shows its time as `HH:MM:SS.mmm`.
- **Delete** (on the selected note) removes a note, and **Restore** brings the last deleted one back.
- **Copy as Markdown** copies the notes and saves them as `song.mp3.review.md` beside the file, with headings like `## n1  00:01:12.500 to 00:01:15.000  note`.
- Keys, when the focus is not in the note field: **I** sets In, **O** sets Out, **N** goes to the note field. The player's keys (Space, arrows, Page Up and Page Down, and the rest) work as before.

Audio notes have a time and an optional end, and nothing else: no pin, area or drawing.

**On codecs.** VS Code's Chromium decodes MP3, WAV, Ogg Vorbis, Opus, and FLAC, but it has no AAC decoder. A `.m4a` or `.aac` file usually holds AAC, so it may not play; the preview then says which extension VS Code cannot decode and offers **Open in default player**. There is no ffmpeg conversion for audio.

## 3D preview (STL, 3MF, GLB, STEP)

MarkCopy registers as the editor for `.stl`, `.3mf`, `.glb`, `.step` and `.stp` files, so opening one renders the model inline in a Three.js viewer. Controls are mouse-only, no keyboard required: **left-drag** to orbit, **right-drag** to pan, **scroll wheel** to zoom. The camera fits itself to the model on load, and the toolbar in the top-left offers **Fit view**, a **wireframe** toggle, a **grid** toggle and a **section** button. An overlay in the bottom-left reports the triangle count, the bounding box as the file's own X x Y x Z, and the grid spacing. The viewport background follows `markcopy.theme` along with the other previews; `markcopy.stl.meshColor` sets the mesh color.

Both binary and ASCII STL are handled. Corrupt and hostile files are rejected rather than loaded: a binary STL whose header claims more triangles than the file can hold, any model above ~5.4 million triangles, or any file above 256 MiB shows a message in the panel instead of hanging the viewer on a multi-gigabyte allocation. The size is checked before the file is read, not after. As with the PDF viewer, the file is read by the extension host and handed to the webview as bytes, so nothing is fetched over the network, and **Reopen Editor With...** opens the raw bytes instead.

### Orientation and up axis

An STL does not say which way is up. Z is what slicers, Blender and most CAD exports use, so by default (`markcopy.stl.upAxis` = `z`) an STL stands the way it prints instead of lying on its side. If a file was made Y-up, choose **View > Up Axis > Y** in the right-click menu (shown for an STL and a STEP file); the choice is saved to the setting. A STEP file does not fix its up axis either, so it follows the setting too, Z by default. A 3MF and a sliced print are always Z-up, as those formats require, and a GLB is always Y-up, as glTF requires: it is turned upright when it loads, so it stands on the grid whatever the setting says. Dimensions, the overlay and **Copy as > Dimensions** are always the file's own X x Y x Z, whichever axis is up. The model is centered over the origin and rested on the floor, so the grid sits directly under it.

### Grid and print bed

The grid is ruled in the file's own units at a round spacing (1, 5, 10, 50, 100 ..., or 0.5, 0.1 ... for a tiny part) chosen so there are at most 40 lines, with a heavier line every tenth. Lines fall on the file's whole numbers, so the file's origin sits on a crossing. The overlay says the spacing: `Grid 1` for an STL (which has no unit) or `Grid 10 mm` for a 3MF. `markcopy.stl.showGrid` sets whether the grid starts on.

**View > Print Bed** (or `markcopy.stl.showBed`) draws the bed as an outline at true size on the floor, plus a faint box to its height. The size is `markcopy.stl.bedSize`, width x depth x height in millimetres, `256x256x256` (a Bambu Lab X1C) by default. A model has no position on a bed yet, so the bed is centered under it, the overlay adds a line such as `Bed 256 × 256 × 256 mm: fits` or `does not fit`, and the outline turns from blue to red when it does not fit. The check allows a quarter turn about the vertical axis and uses the orientation the up axis gives. An STL is taken as millimetres, as slicers do; a 3MF's declared unit is converted. A bed size that does not parse shows no bed.

### Section: cut and measure

The **Section** button (the fourth in the toolbar, or **View > Section**) opens a panel on the right 46% of the window and gives the 3D view the rest. The cut is a plane across one of the file's axes: pick **X**, **Y** or **Z** (it opens across the up axis at mid height) and set the position with the slider, the minus and plus buttons (a round step, 0.1 on a 20 mm part and 1 on a 250 mm one), or by typing an exact value in the number box.

The 3D view clips the model at the plane, hiding everything beyond the cut and drawing the inside faces, and traces the cut outline in yellow. The panel draws the cut flat, to scale, on a grid, in the two remaining axes (cutting Z shows X to the right and Y up).

To measure, point at the flat drawing. A crosshair appears; the horizontal and vertical lines through the pointer are intersected with the outline, and every stretch between crossings is labelled with its length, material (heavy stroke, bold in the readout) and gaps such as pockets and slots alike. Where the parts of an assembly overlap, the overlap reads as one wall and not as a gap: material is judged by which way each surface faces, and a mesh whose faces do not agree on that is measured by counting crossings. The same numbers are listed as text under the drawing, for example `Y = 0.00: 2.50 | 12.70 | 2.50`. Click pins the crosshair; click again releases it. **Copy as > Section Measurements** copies the numbers as text in the layout of a slicing script (see [COPY-MATRIX](../COPY-MATRIX.md#3d-models-stl-3mf-glb-step-stp)), and **Copy Section as PNG**, at the top of the menu while the section is open, copies the flat drawing.

A section is not available for a sliced print (the button is disabled).

### Parts and assemblies

A model with two or more parts opens with a **Parts** panel on the left, and the 3D view takes the rest. A STEP file brings its assembly tree, a GLB its node hierarchy (copies placed by `EXT_mesh_gpu_instancing` are parts of one node), a 3MF its build items, objects and components, and an ASCII STL with several `solid <name>` blocks one part per solid. Any other STL is one part, and a sliced `.gcode.3mf` has no model, so neither shows the panel. Unnamed nodes are called `Part 1`, `Assembly 1` and so on.

Every control is a visible button or checkbox at least 44 px square, so nothing needs a double-click or the keyboard (though a double-click on a row, the arrow keys, Enter and Space work as shortcuts):

- **The arrow** at the left of a row opens or closes an assembly.
- **The checkbox** shows or hides the part. An assembly's checkbox does the same for everything under it, and shows a mixed state when only some of its parts are shown.
- **Click a row** to select it: that part is tinted in the 3D view and the rest is left as it is. Click it again to clear. A row shows its name, its triangle count, and `x2` when siblings with the same name and the same triangle count repeat under one assembly: they are one row with a quantity, and the arrow opens it onto the instances (the triangle count of a quantity row is one instance's).
- **Isolate** shows only that part and moves the camera, from where it is, to frame the part.
- **Show all** in the header shows every part again. The header also counts the parts (`12 parts`, or `3 of 12 shown`).
- **Click a part in the 3D view** (a click, not a drag, so orbiting never selects) to select its row: its assemblies open and the row scrolls into view. Click empty space to clear the selection. A hidden part cannot be picked, and neither can the part of a model a section has cut away.

The panel opens by itself for two or more parts. The toolbar button (the one after Section) and **View > Parts** open and close it, and so does the close button in its header; with one part the button is hidden and **View > Parts** is greyed out. Hiding a part leaves the 3D view and the section cut (its outline and measurements), so a section across an assembly shows only the parts that are shown. It does not change the model's bounds: the grid, the print bed fit check, the dimensions, the triangle count and the section's range stay those of the whole file, and Compare with still overlays the other model on the whole one.

Right-click > **Copy parts list** puts a Markdown table on the clipboard, `| Part | Assembly | Qty | Triangles |`, one row per distinct part with the path of assemblies above it joined by `/`, and a pipe or backslash in a name escaped. It lists every part whether or not it is shown.

A file's names are cut to 200 characters with control and direction-override characters removed. A model with more than 20,000 nodes keeps the first 20,000 and gathers the rest under one `More parts` row, which hides, isolates and selects as a unit; nesting deeper than 64 levels is flattened into the 64th.

### Comparing versions

Right-click > **Compare with** lists up to 12 other `.stl`, `.3mf`, `.glb`, `.step` and `.stp` files found near the open one: the same folder, its `versions` subfolder, and the parent folder when the open file is itself inside a `versions` folder. They are ordered by how much of the name they share with the open file (numbers compared as numbers, a `_current` suffix ignored), so the previous version is at the top. **Browse…** opens a file picker for anything else.

The second model is drawn in orange over the first, in the same file coordinates, so two versions of one design line up where they agree; where both share a surface the first shows. The overlay lists both with a color swatch, triangle count and dimensions, and the menu then offers **Show** and **Hide** for each model and **Stop Comparing**. With the section open, both outlines are drawn in the flat panel in their colors, and the readout and **Copy as > Section Measurements** give a row per model: the way to see a difference inside a part. The second file goes through the same size cap and checks as the first; if it is refused, a message appears and the first model stays. A sliced print cannot be compared.

### Sliced print files

A sliced `.gcode.3mf` from Bambu Studio or OrcaSlicer holds G-code and no mesh. The viewer draws the first plate's toolpaths: every extrusion move as a line, colored by the slicer's feature (outer wall, inner wall, infill, support, bridge, top and bottom surfaces ...), in bed coordinates, with the print bed outline shown automatically at its true position. A layer bar at the bottom has a slider and minus and plus buttons, a label such as `Layer 12 / 280 · Z 2.40 mm`, and a **This layer only** checkbox.

The overlay shows the slicer's summary from the file, for example `Sliced print`, `1h 3m · 16.92 g · PETG`, `280 layers, 87,372 moves`, the toolpath's extents, and the grid and bed lines. **Copy as > Print Summary** copies those lines with the file name. Wireframe, Section and Compare with do not apply. The reader handles G0/G1 moves, G2/G3 arcs, absolute and relative extrusion and positioning, and the layer markers of Bambu/Orca, PrusaSlicer and Cura. At most 4,000,000 segments are kept, and the overlay says when a file had more.

Limits: only plate 1 is drawn for a multi-plate file (the overlay says `plate 1 of N`); travel moves are not drawn; lines are one pixel wide, with no extrusion width; plain `.gcode` files are not opened by MarkCopy.

### 3MF models

A `.3mf` opens in the same viewer. MarkCopy reads the model's meshes, the way components and build items place them (with their transforms), and the files that slicers such as Bambu Studio, PrusaSlicer and OrcaSlicer split a project into. Colors come from the 3MF materials: base materials and color groups, on a whole object or on single faces, are drawn; faces with no color (and any texture, composite or multi-property material, which is not drawn) take `markcopy.stl.meshColor`. Paint data that is specific to one slicer (Bambu paint colors, PrusaSlicer multi-material segmentation) is not read. The overlay and **Copy as > Dimensions** add the file's unit, for example `25.00 × 10.00 × 10.00 mm`. A file that is not a zip archive, that claims more than the STL triangle limit once its components are expanded (a repeated-instance bomb is refused, not built), or that is above 256 MiB shows a message instead of loading. Textures, beam lattices, plate thumbnails and choosing a plate are not supported.

### GLB models

A `.glb` (binary glTF 2.0) opens in the same viewer. Every mesh in the scene is placed by its node transforms and drawn in its material's base color, multiplied by the vertex colors when it has them; a mesh with no material takes `markcopy.stl.meshColor`. Textures, lights, cameras, animation and skinning are ignored, and points and lines are not drawn. glTF has no real unit (it says metres, files rarely mean it), so the readout has none and the grid is unitless like an STL's. A `.gltf` with separate files is not opened, and neither is a GLB that uses Draco or meshopt compression: MarkCopy does not decode them, and says so. Re-export without compression to preview it.

### STEP models

A `.step` or `.stp` (ISO 10303-21, any AP) opens in the same viewer. Solids are tessellated in millimetres by an Open CASCADE engine compiled to WebAssembly, and face and solid colors are kept; anything uncolored takes `markcopy.stl.meshColor`. The engine is 3.1 MB (gzipped) and loads the first time a STEP file opens in a window (the overlay says `Loading STEP engine...`), then stays loaded; it is never fetched for any other file and needs no network. Large assemblies can take seconds to tessellate, on the viewer's main thread, and are refused above ~5.4 million triangles. A file with no solids (for example only surfaces or wireframes) says it holds no solid geometry.

### The right-click menu

**Right-click** (not drag) for the menu; a right-drag pans and does not open it. Everything in it is reachable with the pointer.

- **Copy View as PNG** and **Save View as PNG…** capture the model from the current camera angle. **Copy Section as PNG** is added at the top while a section is open.
- **Copy as** gives the file name, full path, dimensions, and triangle count (or the print summary for a sliced print), plus the section measurements while a section is open. **Copy parts list** (top level) copies the parts as a Markdown table.
- **View** has Fit View, the Front, Back, Left, Right, Top, Bottom and Isometric presets, and Wireframe, Section, Parts, Grid and Print Bed checkboxes (Wireframe, Section, Parts and Grid match the toolbar), plus **Up Axis > Z / Y** for an STL (not shown for the formats that fix their own).
- **Compare with** lists nearby models to overlay (above), then Show, Hide and Stop Comparing.
- **Preferences > Theme** sets `markcopy.theme`.
- **Open in Default App** and **Reveal in File Explorer** act on the file.

See [COPY-MATRIX](../COPY-MATRIX.md#3d-models-stl-3mf-glb-step-stp).

[Back to the user guide](README.md)
