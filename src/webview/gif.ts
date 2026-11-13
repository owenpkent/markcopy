// Browser-side code for the GIF preview (media/gif.js), the viewer behind
// src/gifEditor.ts.
//
// The host sends the file's bytes as base64 (like the PDF and STL previews).
// Frames are decoded on demand with the WebCodecs ImageDecoder and painted to a
// canvas on a timer driven by each frame's own delay, which is what makes pause,
// single-frame stepping and a clean frame copy possible: an <img> offers none
// of those. Where ImageDecoder is missing the file is shown in a plain <img>
// and only the actions that do not need a frame are left.
import { createMenu, revealLabel, type MenuEntry } from './menu';
import { fromHost } from './fromHost';
import {
  base64ToBytes,
  formatTimeline,
  frameAtTime,
  frameFileName,
  frameStartTimes,
  parseGif,
  statusLine,
  totalSeconds,
  type GifInfo,
} from './gifInfo';
import { attachSeekBar, setSeekFill } from './seekBar';

// Minimal VS Code webview API surface we use.
interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const stage = document.getElementById('mc-stage') as HTMLDivElement;
const canvas = document.getElementById('mc-canvas') as HTMLCanvasElement;
const img = document.getElementById('mc-img') as HTMLImageElement;
const statusEl = document.getElementById('mc-status') as HTMLDivElement;
const errorEl = document.getElementById('mc-error') as HTMLDivElement;
const menuEl = document.getElementById('mc-menu') as HTMLDivElement;
const toastEl = document.getElementById('mc-toast') as HTMLDivElement;

const contextMenu = createMenu(menuEl);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let fileName = '';
let filePath = '';
let fileBytes = 0;
let info: GifInfo | null = null;

// Undefined in the fallback path, where nothing below the "Playback" section of
// the menu applies.
let decoder: ImageDecoder | undefined;
let frameCount = 0;
let frameIndex = 0;
let playing = false;
let speed = 1;
// Session-only, deliberately not a setting: the file's own loop count is what a
// GIF means, and forcing it is a look-at-this-longer convenience.
let loopForever = false;
// Completed passes through the frames since play last started from the top.
let passes = 0;
// Bumped by anything that moves the playhead or reloads, so a decode that was
// in flight when that happened lands on nothing.
let generation = 0;
let timer = 0;
let shownAt = 0;
let blobUrl = '';

let currentTheme = document.body.getAttribute('data-mc-theme') || 'auto';

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------
let toastTimer = 0;
function toast(text: string, ms = 1600): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms);
}

function updateStatus(): void {
  statusEl.textContent = statusLine({
    name: fileName,
    bytes: fileBytes,
    info,
    frame: decoder ? frameIndex : null,
    loop: loopForever,
  });
  refreshBar();
}

function showError(message: string): void {
  stopTimer();
  playing = false;
  generation += 1;
  decoder?.close();
  decoder = undefined;
  refreshBar();
  stage.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = message;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
interface LoadMessage {
  type: 'load';
  name: string;
  path: string;
  size: number;
  data: string;
}

function resetPlayer(): void {
  generation += 1;
  stopTimer();
  playing = false;
  starts = [];
  controlBar.hidden = true;
  passes = 0;
  frameIndex = 0;
  frameCount = 0;
  decoder?.close();
  decoder = undefined;
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = '';
  }
}

async function load(msg: LoadMessage): Promise<void> {
  resetPlayer();
  fileName = msg.name;
  filePath = msg.path;
  fileBytes = msg.size;
  errorEl.hidden = true;

  const bytes = base64ToBytes(msg.data);
  info = parseGif(bytes);
  if (!info) {
    showError(`${fileName} is not a GIF MarkCopy can read.`);
    return;
  }

  stage.hidden = false;
  if (typeof ImageDecoder === 'undefined') {
    showFallback(bytes);
    return;
  }

  const mine = generation;
  try {
    const d = new ImageDecoder({ data: bytes, type: 'image/gif' });
    await d.tracks.ready;
    if (mine !== generation) {
      d.close();
      return;
    }
    decoder = d;
    // The decoder's count wins when it disagrees with the header scan: it is
    // what can actually be decoded.
    frameCount = d.tracks.selectedTrack?.frameCount || info.frameCount;
    canvas.width = info.width;
    canvas.height = info.height;
    canvas.hidden = false;
    img.hidden = true;
    starts = frameStartTimes(info.delays);
    seekSlider.max = String(totalSeconds(info.delays));
    await show(0, mine);
    if (mine === generation) {
      play();
    }
  } catch {
    // A GIF the decoder rejects but the scan accepted: the browser may still
    // manage it as an image, so degrade rather than fail.
    decoder?.close();
    decoder = undefined;
    starts = [];
    showFallback(bytes);
  }
}

function showFallback(bytes: Uint8Array): void {
  canvas.hidden = true;
  img.hidden = false;
  blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/gif' }));
  img.src = blobUrl;
  updateStatus();
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
function stopTimer(): void {
  window.clearTimeout(timer);
  timer = 0;
}

/** Decode frame `index` and paint it. A stale call (generation moved on) paints nothing. */
async function show(index: number, mine: number): Promise<boolean> {
  if (!decoder) {
    return false;
  }
  try {
    const { image } = await decoder.decode({ frameIndex: index });
    if (mine !== generation) {
      image.close();
      return false;
    }
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // The canvas keeps the GIF's own size even when a frame is smaller; the
      // decoder hands back fully composited frames, so one clear is enough.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);
    }
    image.close();
    frameIndex = index;
    shownAt = performance.now();
    updateStatus();
    return true;
  } catch {
    if (mine === generation) {
      playing = false;
      refreshBar();
      toast('Could not decode this frame');
    }
    return false;
  }
}

function frameDelay(index: number): number {
  return (info?.delays[index] ?? 100) / speed;
}

function scheduleNext(): void {
  stopTimer();
  if (!playing) {
    return;
  }
  const wait = Math.max(0, shownAt + frameDelay(frameIndex) - performance.now());
  const mine = generation;
  timer = window.setTimeout(() => void advance(mine), wait);
}

async function advance(mine: number): Promise<void> {
  if (mine !== generation || !playing) {
    return;
  }
  let next = frameIndex + 1;
  if (next >= frameCount) {
    passes += 1;
    // loopCount is repeats after the first play, so the file asks for
    // loopCount + 1 passes in all; absent asks for one.
    const total = (info?.loopCount ?? 0) + 1;
    const forever = loopForever || info?.loopCount === 0;
    if (!forever && passes >= total) {
      playing = false;
      updateStatus();
      return;
    }
    next = 0;
  }
  if (await show(next, mine)) {
    scheduleNext();
  }
}

function play(): void {
  // A still GIF has nothing to play, and one marked to loop forever would
  // otherwise redecode its only frame every 100 ms for as long as it is open.
  if (!decoder || frameCount < 2) {
    return;
  }
  if (frameIndex >= frameCount - 1 && !loopForever && info?.loopCount !== 0) {
    // Play from the end means play again, not sit on the last frame.
    passes = 0;
    generation += 1;
    void show(0, generation).then((ok) => ok && scheduleNext());
    playing = true;
    refreshBar();
    return;
  }
  playing = true;
  scheduleNext();
  refreshBar();
}

function pause(): void {
  playing = false;
  // A playback decode may already be awaiting; moving the generation keeps it
  // from painting a frame after playback has stopped.
  generation += 1;
  stopTimer();
  refreshBar();
}

function togglePlay(): void {
  if (!decoder) {
    return;
  }
  if (playing) {
    pause();
  } else {
    play();
  }
}

/** Move the playhead to `index` and stop there, for stepping and jumping. */
async function seek(index: number): Promise<void> {
  if (!decoder || frameCount === 0) {
    return;
  }
  pause();
  generation += 1;
  passes = 0;
  await show(Math.min(Math.max(0, index), frameCount - 1), generation);
}

function setSpeed(rate: number): void {
  speed = rate;
  // Re-time the frame on screen so the change is felt at once, not after the
  // long delay it may be sitting in.
  scheduleNext();
  toast(rate === 1 ? 'Normal speed' : `${rate}x speed`);
}

function toggleLoop(): void {
  if (info?.loopCount === 0) {
    toast('This GIF already loops forever');
    return;
  }
  loopForever = !loopForever;
  updateStatus();
  toast(loopForever ? 'Looping' : 'Looping off');
}

// ---------------------------------------------------------------------------
// Control bar
// ---------------------------------------------------------------------------
// Below the picture: play and pause, then the time, a slider over the clip's
// time (not its frames) and the time left. Hidden until a multi-frame GIF is
// decoded, so a still, the <img> fallback and an error never show a dead bar.
const PLAY_PATHS = ['M7 4.5v15l12-7.5z'];
const PAUSE_PATHS = ['M7 5h3v14H7z', 'M14 5h3v14h-3z'];
const SVG_NS = 'http://www.w3.org/2000/svg';
// The seek thumb's width in px, matching `.mc-range` in media/preview.css.
const SEEK_THUMB = 12;

// Start time in seconds of each frame at speed 1; empty without a decoder.
let starts: number[] = [];

function icon(paths: string[]): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [name, value] of Object.entries({
    viewBox: '0 0 24 24',
    width: '18',
    height: '18',
    fill: 'currentColor',
    'aria-hidden': 'true',
    focusable: 'false',
  })) {
    svg.setAttribute(name, value);
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const controlBar = document.createElement('div');
controlBar.id = 'mc-controls';
controlBar.hidden = true;
controlBar.setAttribute('role', 'toolbar');
controlBar.setAttribute('aria-label', 'GIF controls');
const playBtn = document.createElement('button');
playBtn.type = 'button';
playBtn.className = 'mc-gif-ctl';
const timeEl = document.createElement('span');
timeEl.className = 'mc-gif-time';
const seekSlider = document.createElement('input');
seekSlider.type = 'range';
seekSlider.className = 'mc-gif-seek mc-range';
seekSlider.min = '0';
seekSlider.max = '0';
seekSlider.step = 'any';
seekSlider.value = '0';
seekSlider.setAttribute('aria-label', 'Seek');
const remainEl = document.createElement('span');
remainEl.className = 'mc-gif-time mc-gif-remain';
remainEl.title = 'Time left';
const scrubBox = document.createElement('div');
scrubBox.className = 'mc-gif-scrub';
scrubBox.append(timeEl, seekSlider, remainEl);
controlBar.append(playBtn, scrubBox);
document.body.insertBefore(controlBar, statusEl);

/** Run `action` on a press, and after a pointer click let go of focus so Space still toggles once. */
function onPress(button: HTMLButtonElement, action: () => void): void {
  button.addEventListener('click', (e) => {
    action();
    if (e.detail > 0) {
      button.blur();
    }
  });
}

// True while the reader drags the slider, so the shown frame does not pull the
// thumb out from under the pointer.
let scrubbing = false;

function showTimes(seconds: number): void {
  const total = totalSeconds(info?.delays ?? []);
  timeEl.textContent = formatTimeline(seconds);
  remainEl.textContent = `-${formatTimeline(Math.max(0, total - seconds))}`;
  setSeekFill(seekSlider, seconds, total);
  seekSlider.setAttribute(
    'aria-valuetext',
    `${formatTimeline(seconds)} of ${formatTimeline(total)}`,
  );
}

/** Bring the bar in line with the player: visibility, button, thumb and times. */
function refreshBar(): void {
  const usable = Boolean(decoder) && frameCount > 1 && starts.length > 1 && errorEl.hidden;
  controlBar.hidden = !usable;
  stage.classList.toggle('mc-has-bar', usable);
  const label = playing ? 'Pause (space)' : 'Play (space)';
  playBtn.replaceChildren(icon(playing ? PAUSE_PATHS : PLAY_PATHS));
  playBtn.title = label;
  playBtn.setAttribute('aria-label', label);
  if (!usable) {
    return;
  }
  const at = starts[Math.min(frameIndex, starts.length - 1)] ?? 0;
  if (!scrubbing) {
    seekSlider.value = String(at);
    showTimes(at);
  }
}

onPress(playBtn, togglePlay);
seekSlider.addEventListener('pointerdown', () => (scrubbing = true));
const endScrub = (): void => {
  scrubbing = false;
  refreshBar();
};
seekSlider.addEventListener('pointerup', endScrub);
seekSlider.addEventListener('pointercancel', endScrub);
seekSlider.addEventListener('input', () => {
  const time = Number(seekSlider.value);
  if (!Number.isFinite(time)) {
    return;
  }
  showTimes(time);
  void seek(frameAtTime(starts, time));
});
// A press pauses, and the GIF stays paused on the frame the drag ends on. The
// adapter answers for the viewer: `playing` is its state, `pause()` its own.
attachSeekBar({
  slider: seekSlider,
  media: {
    get paused() {
      return !playing;
    },
    pause,
  },
  thumb: SEEK_THUMB,
  duration: () => totalSeconds(info?.delays ?? []),
  format: formatTimeline,
});

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

// A click that only dismisses the context menu shouldn't also play or pause.
// Read at press time: the menu has already closed by the time the click lands.
let pressClosedMenu = false;
stage.addEventListener('pointerdown', (e) => {
  pressClosedMenu = contextMenu.isOpen() && !contextMenu.owns(e.target);
});

stage.addEventListener('click', (e) => {
  if (pressClosedMenu) {
    pressClosedMenu = false;
    return;
  }
  if (e.target === canvas) {
    togglePlay();
  }
});

document.addEventListener('keydown', (e) => {
  if (contextMenu.isOpen() || e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }
  switch (e.key) {
    case ' ': {
      // A focused button takes Space as a click of its own; toggling on top of
      // that would undo it. Everything else, the page itself included, is ours.
      if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') {
        break;
      }
      e.preventDefault();
      togglePlay();
      break;
    }
    case ',':
      void seek(frameIndex - 1);
      break;
    case '.':
      void seek(frameIndex + 1);
      break;
    case 'Home':
      e.preventDefault();
      void seek(0);
      break;
    case 'End':
      e.preventDefault();
      void seek(frameCount - 1);
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Frame actions
// ---------------------------------------------------------------------------
function toBlob(source: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => source.toBlob(resolve, 'image/png'));
}

async function copyFramePng(): Promise<void> {
  if (!decoder) {
    toast('No frame to copy');
    return;
  }
  try {
    const blob = await toBlob(canvas);
    if (blob && navigator.clipboard && 'write' in navigator.clipboard) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Copied frame as PNG');
    } else {
      toast('PNG copy not supported here');
    }
  } catch {
    toast('Could not read the current frame');
  }
}

function saveFramePng(): void {
  if (!decoder) {
    toast('No frame to save');
    return;
  }
  try {
    // The host owns the save dialog and the write, so the frame crosses as a
    // base64 payload; one PNG frame is small enough for postMessage.
    const data = canvas.toDataURL('image/png');
    vscode.postMessage({
      type: 'saveFrame',
      data: data.slice(data.indexOf(',') + 1),
      name: frameFileName(fileName, frameIndex + 1),
    });
  } catch {
    toast('Could not read the current frame');
  }
}

function copyText(text: string, label: string): void {
  if (!text) {
    toast('Nothing to copy');
    return;
  }
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', text);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  if (!ok) {
    void navigator.clipboard?.writeText(text);
  }
  toast(label);
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();

  const noFrames = !decoder;
  const entries: MenuEntry[] = [
    ...(noFrames
      ? [{ kind: 'label', label: 'Frames unavailable in this viewer' } as MenuEntry]
      : []),
    {
      kind: 'item',
      label: 'Copy Frame as PNG',
      run: () => void copyFramePng(),
      disabled: noFrames,
    },
    {
      kind: 'item',
      label: 'Save Frame as PNG…',
      run: saveFramePng,
      disabled: noFrames,
    },
    { kind: 'divider' },
    {
      kind: 'submenu',
      label: 'Copy as',
      entries: [
        { kind: 'item', label: 'File Name', run: () => copyText(fileName, 'Copied file name') },
        { kind: 'item', label: 'Full Path', run: () => copyText(filePath, 'Copied path') },
      ],
    },
    { kind: 'divider' },
    {
      kind: 'submenu',
      label: 'Playback',
      entries: noFrames
        ? [{ kind: 'label', label: 'Playback controls unavailable' }]
        : [
            {
              kind: 'item',
              label: playing ? 'Pause' : 'Play',
              run: togglePlay,
            },
            { kind: 'divider' },
            {
              kind: 'checkbox',
              label: 'Loop',
              checked: loopForever || info?.loopCount === 0,
              run: toggleLoop,
            },
            { kind: 'divider' },
            { kind: 'label', label: 'Speed' },
            ...SPEEDS.map((rate): MenuEntry => ({
              kind: 'radio',
              label: rate === 1 ? 'Normal' : `${rate}x`,
              checked: speed === rate,
              run: () => setSpeed(rate),
            })),
          ],
    },
    { kind: 'divider' },
    { kind: 'submenu', label: 'Preferences', entries: themeItems() },
    { kind: 'divider' },
    {
      kind: 'item',
      label: 'Open in Default App',
      run: () => vscode.postMessage({ type: 'openExternal' }),
    },
    {
      kind: 'item',
      label: revealLabel(),
      run: () => vscode.postMessage({ type: 'revealInOS' }),
    },
  ];

  contextMenu.show(e.pageX, e.pageY, entries);
});

// The Auto/Light/Dark/Green radio group, identical to the other previews'
// Theme submenu; picking one persists the shared markcopy.theme.
function themeItems(): MenuEntry[] {
  const entry = (label: string, value: string): MenuEntry => ({
    kind: 'radio',
    label,
    checked: currentTheme === value,
    run: () => setTheme(value),
  });
  return [
    {
      kind: 'submenu',
      label: 'Theme',
      entries: [
        entry('Auto', 'auto'),
        entry('Light', 'light'),
        entry('Dark', 'dark'),
        entry('Green on black', 'green'),
      ],
    },
  ];
}

function setTheme(value: string): void {
  applyTheme(value);
  vscode.postMessage({ type: 'updateSetting', key: 'theme', value });
}

function applyTheme(value: string): void {
  currentTheme = value;
  document.body.setAttribute('data-mc-theme', value);
}

// ---------------------------------------------------------------------------
// Host messages
// ---------------------------------------------------------------------------
window.addEventListener('message', (event: MessageEvent) => {
  if (!fromHost(event)) {
    return;
  }
  const msg = event.data as
    | LoadMessage
    | { type: 'error'; message: string }
    | { type: 'setTheme'; value: string }
    | { type: 'toast'; message: string };
  if (!msg) {
    return;
  }
  if (msg.type === 'load') {
    void load(msg);
  } else if (msg.type === 'error') {
    showError(msg.message);
  } else if (msg.type === 'setTheme') {
    applyTheme(msg.value);
  } else if (msg.type === 'toast') {
    toast(msg.message);
  }
});

vscode.postMessage({ type: 'ready' });
