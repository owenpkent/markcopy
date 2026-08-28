// Browser-side code for the video preview (media/video.js), the viewer behind
// src/videoEditor.ts.
//
// Unlike the PDF and STL previews, the file itself never travels through
// postMessage: a video is far too large to base64 into a JSON message, and it
// does not need to be. The <video> element is handed a webview-resource URI and
// streams the file straight off disk, seeking with range requests, so a 2 GB
// clip costs the same in memory as a 2 MB one.
import { createMenu, type MenuEntry } from './menu';
import { describeMediaError, formatBytes, formatDuration, frameFileName } from './videoInfo';

// Minimal VS Code webview API surface we use.
interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const video = document.getElementById('mc-video') as HTMLVideoElement;
const stage = document.getElementById('mc-stage') as HTMLDivElement;
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
let sourceUri = '';

/**
 * Whether the frame grabs are off the table for this file.
 *
 * The video is served from a `vscode-resource` origin, which is not the
 * webview document's own, so drawing it into a canvas taints that canvas and
 * `toBlob` throws. Requesting the file with CORS keeps the canvas clean (VS
 * Code serves webview resources with `Access-Control-Allow-Origin: *`), so that
 * is the first attempt; the retry in the `error` handler below is the safety net
 * for a host where that header is absent, and it costs the frame actions rather
 * than the video.
 */
let frameCopyBlocked = false;
let corsRetried = false;

// The active markcopy.theme, seeded from the host and changed via the menu.
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

/** The one-line readout under the video: dimensions, duration, size. */
function updateStatus(): void {
  const parts: string[] = [fileName];
  if (video.videoWidth > 0) {
    parts.push(`${video.videoWidth}x${video.videoHeight}`);
  }
  if (video.duration > 0) {
    parts.push(formatDuration(video.duration));
  }
  const size = formatBytes(fileBytes);
  if (size) {
    parts.push(size);
  }
  statusEl.textContent = parts.join('  ·  ');
}

/** Replace the viewport with a message the reader can act on. */
function showError(message: string): void {
  stage.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = '';

  const text = document.createElement('p');
  text.className = 'mc-video-error-text';
  text.textContent = message;
  errorEl.appendChild(text);

  // The message above says the OS player can probably open it; this is that
  // door, rather than an instruction to go find the file in Explorer.
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'mc-video-button';
  open.textContent = 'Open in Default App';
  open.addEventListener('click', () => vscode.postMessage({ type: 'openExternal' }));
  errorEl.appendChild(open);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
interface LoadMessage {
  type: 'load';
  src: string;
  name: string;
  path: string;
  size: number;
  autoplay: boolean;
  loop: boolean;
}

function load(msg: LoadMessage): void {
  fileName = msg.name;
  filePath = msg.path;
  fileBytes = msg.size;
  sourceUri = msg.src;

  video.loop = msg.loop;
  // Chromium only honours autoplay without a user gesture while muted, so an
  // unmuted autoplay request would reject and leave a still frame with no
  // explanation. Muting is the honest reading of "start playing on open".
  video.autoplay = msg.autoplay;
  video.muted = msg.autoplay;
  video.crossOrigin = 'anonymous';
  video.src = sourceUri;
  updateStatus();
}

video.addEventListener('loadedmetadata', () => {
  stage.hidden = false;
  errorEl.hidden = true;
  updateStatus();
});

video.addEventListener('error', () => {
  // A CORS-related refusal and an unplayable codec are indistinguishable here:
  // both surface as MEDIA_ERR_SRC_NOT_SUPPORTED. So retry once without the
  // credentials-free CORS request before concluding anything about the codec.
  // If that plays, the only thing lost is the frame grab.
  if (!corsRetried && sourceUri) {
    corsRetried = true;
    frameCopyBlocked = true;
    video.removeAttribute('crossorigin');
    video.src = sourceUri;
    video.load();
    return;
  }
  showError(describeMediaError(video.error?.code, fileName));
});

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------
/** The frame on screen right now, at the video's true pixel dimensions. */
function frameCanvas(): HTMLCanvasElement | null {
  if (!video.videoWidth || !video.videoHeight) {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** Why a frame action just failed, in terms of what the reader can do about it. */
function frameFailure(): string {
  return frameCopyBlocked
    ? 'Frames cannot be copied from this file'
    : 'Could not read the current frame';
}

async function copyFramePng(): Promise<void> {
  const canvas = frameCanvas();
  if (!canvas) {
    toast('No frame to copy yet');
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
    toast(frameFailure());
  }
}

async function saveFramePng(): Promise<void> {
  const canvas = frameCanvas();
  if (!canvas) {
    toast('No frame to save yet');
    return;
  }
  try {
    // The host owns the save dialog and the write, so the frame crosses as a
    // base64 payload. A single PNG frame is small enough for postMessage in a
    // way the video itself never is.
    const data = canvas.toDataURL('image/png');
    vscode.postMessage({
      type: 'saveFrame',
      data: data.slice(data.indexOf(',') + 1),
      name: frameFileName(fileName, video.currentTime),
    });
  } catch {
    toast(frameFailure());
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
// Playback
// ---------------------------------------------------------------------------
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

function setSpeed(rate: number): void {
  video.playbackRate = rate;
  toast(rate === 1 ? 'Normal speed' : `${rate}x speed`);
}

function toggleLoop(): void {
  video.loop = !video.loop;
  // Persisted, not session-only: someone who loops one clip is looking at a
  // folder of them, and a per-tab toggle would have to be set again each time.
  vscode.postMessage({ type: 'updateSetting', key: 'video.loop', value: video.loop });
  toast(video.loop ? 'Looping' : 'Looping off');
}

function togglePlay(): void {
  if (video.paused) {
    void video.play().catch(() => undefined);
  } else {
    video.pause();
  }
}

function nudge(seconds: number): void {
  if (!Number.isFinite(video.duration)) {
    return;
  }
  video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), video.duration);
}

stage.addEventListener('click', (e) => {
  // Clicks on the native control bar are the browser's; only the picture itself
  // is a play/pause target.
  if (e.target === video) {
    togglePlay();
  }
});

document.addEventListener('keydown', (e) => {
  if (contextMenu.isOpen() || e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }
  switch (e.key) {
    case ' ':
      // The native controls already bind Space, but only while one of their
      // buttons has focus; this covers the far more common case of the page.
      e.preventDefault();
      togglePlay();
      break;
    case ',':
      // A frame-ish step at 30fps, for lining up a frame grab.
      nudge(-1 / 30);
      break;
    case '.':
      nudge(1 / 30);
      break;
    case 'm':
      video.muted = !video.muted;
      break;
    case 'f':
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void video.requestFullscreen?.().catch(() => undefined);
      }
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();

  const entries: MenuEntry[] = [
    { kind: 'item', label: 'Copy Frame as PNG', run: () => void copyFramePng() },
    { kind: 'item', label: 'Save Frame as PNG…', run: () => void saveFramePng() },
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
      entries: [
        { kind: 'checkbox', label: 'Loop', checked: video.loop, run: toggleLoop },
        { kind: 'divider' },
        { kind: 'label', label: 'Speed' },
        ...SPEEDS.map((rate): MenuEntry => ({
          kind: 'radio',
          label: rate === 1 ? 'Normal' : `${rate}x`,
          checked: Math.abs(video.playbackRate - rate) < 1e-6,
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
  ];

  contextMenu.show(e.pageX, e.pageY, entries);
});

// The Auto/Light/Dark/Green radio group, identical to the Markdown, PDF, and
// STL previews' Theme submenu; picking one persists the shared markcopy.theme.
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
  const msg = event.data as
    | LoadMessage
    | { type: 'error'; message: string }
    | { type: 'setTheme'; value: string }
    | { type: 'toast'; message: string };
  if (!msg) {
    return;
  }
  if (msg.type === 'load') {
    load(msg);
  } else if (msg.type === 'error') {
    showError(msg.message);
  } else if (msg.type === 'setTheme') {
    applyTheme(msg.value);
  } else if (msg.type === 'toast') {
    toast(msg.message);
  }
});

vscode.postMessage({ type: 'ready' });
