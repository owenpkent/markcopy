// Browser-side code for the audio preview (media/audio.js), the viewer behind
// src/audioEditor.ts.
//
// Like the video preview, the file never travels through postMessage: the host
// sends a webview-resource URI and the <audio> element streams it off disk. The
// element has no native controls; the toolbar below is the player, built with the
// same ids and classes as the image and PDF viewers' so media/preview.css styles it.
import { createMenu, revealLabel, type MenuEntry } from './menu';
import {
  AUDIO_SPEEDS,
  SEEK_STEP,
  SEEK_STEP_LONG,
  WAVEFORM_DECODE_BUDGET,
  WAVEFORM_SIZE_CAP,
  analyzeChannels,
  cycleSpeed,
  decodedBytes,
  describeAudioError,
  detailRows,
  detailsMarkdown,
  formatPreciseDuration,
  infoLine,
  parseDetails,
  positionReadout,
  seekTarget,
  stepSpeed,
  tagRows,
  timeAtX,
  waveformSkipped,
  waveformTooLong,
  type DecodedFacts,
  type DetailRow,
} from './audioInfo';
import type { AudioDetails } from '../messages/audioDetails';
import { createReview, isTextEntry } from './videoReview';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// The file's webview URI, written into the page by the host at render time. It is
// read once here and never from a message, so no message can redirect the player.
const mediaSrc = document.body.dataset.mcSrc ?? '';

// ---------------------------------------------------------------------------
// DOM. The host provides only #app; everything else is built here.
// ---------------------------------------------------------------------------
const app = document.getElementById('app') as HTMLDivElement;

function box<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  id: string,
  css: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.id = id;
  el.style.cssText = css;
  return el;
}

const audio = box('audio', 'mc-audio', 'display:none;');
audio.preload = 'metadata';

// Laid out by media/preview.css: Audio Notes moves it into the review's column.
const stage = box('div', 'mc-audio-stage', '');
const nameEl = box('div', 'mc-audio-name', 'font-size:18px;font-weight:600;word-break:break-all;');
const infoEl = box('div', 'mc-audio-info', 'font-size:12px;opacity:0.75;');
const errorEl = box(
  'div',
  'mc-audio-error',
  'display:none;max-width:44em;font-size:13px;line-height:1.5;color:var(--mc-error-fg);',
);
errorEl.setAttribute('role', 'alert');
const openEl = document.createElement('button');
openEl.type = 'button';
openEl.id = 'mc-audio-open';
openEl.className = 'mc-audio-open';
openEl.textContent = 'Open in default player';
openEl.style.display = 'none';

// The waveform: a pointer-only seek surface (see the Waveform section below).
const waveEl = box('div', 'mc-wave', '');
waveEl.hidden = true;
const waveCanvas = document.createElement('canvas');
waveCanvas.id = 'mc-wave-canvas';
waveCanvas.setAttribute('aria-hidden', 'true');
waveCanvas.hidden = true;
const waveStatus = box('div', 'mc-wave-status', '');
waveStatus.setAttribute('role', 'status');
waveStatus.hidden = true;
waveEl.append(waveCanvas, waveStatus);

// The details panel: a two-column grid of rows, then the tags. textContent only.
const detailsEl = box('section', 'mc-audio-details', '');
detailsEl.setAttribute('aria-label', 'Audio details');
detailsEl.hidden = true;
const detailsHead = document.createElement('div');
detailsHead.className = 'mc-audio-details-head';
const detailsTitle = document.createElement('h2');
detailsTitle.textContent = 'Details';
const copyDetailsBtn = document.createElement('button');
copyDetailsBtn.type = 'button';
copyDetailsBtn.id = 'mc-audio-copy-details';
copyDetailsBtn.className = 'mc-audio-open';
copyDetailsBtn.textContent = 'Copy details';
detailsHead.append(detailsTitle, copyDetailsBtn);
const detailsGrid = document.createElement('dl');
detailsGrid.className = 'mc-audio-grid';
const tagsHead = document.createElement('h2');
tagsHead.textContent = 'Tags';
tagsHead.hidden = true;
const tagsGrid = document.createElement('dl');
tagsGrid.className = 'mc-audio-grid';
tagsGrid.hidden = true;
detailsEl.append(detailsHead, detailsGrid, tagsHead, tagsGrid);

stage.append(nameEl, infoEl, waveEl, detailsEl, errorEl, openEl);

const toolbarEl = box('div', 'mc-toolbar', 'bottom:18px;');
toolbarEl.setAttribute('role', 'toolbar');
toolbarEl.setAttribute('aria-label', 'Audio controls');
const toastEl = box('div', 'mc-toast', '');
toastEl.className = 'mc-toast';
toastEl.hidden = true;
const menuEl = box('div', 'mc-menu', '');
menuEl.className = 'mc-menu';
menuEl.setAttribute('role', 'menu');
menuEl.hidden = true;
app.append(audio, stage, toolbarEl, toastEl, menuEl);
const contextMenu = createMenu(menuEl);

document.body.style.cssText +=
  ';height:100%;margin:0;overflow:hidden;background:var(--mc-bg);color:var(--mc-fg);';

let toastTimer: number | undefined;
function toast(text: string, ms = 1400): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
const svg = (path: string) =>
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
  `focusable="false">${path}</svg>`;
const PREV_ICON = svg('<path d="M15 5l-7 7 7 7" />');
const NEXT_ICON = svg('<path d="M9 5l7 7-7 7" />');
const PLAY_ICON = svg('<path d="M8 5l11 7-11 7z" fill="currentColor" />');
const PAUSE_ICON = svg(
  '<rect x="6" y="5" width="4" height="14" fill="currentColor" /><rect x="14" y="5" width="4" height="14" fill="currentColor" />',
);
const ICON_BUTTON_CSS = 'display:inline-flex;align-items:center;justify-content:center;padding:0;';

toolbarEl.innerHTML =
  `<button type="button" id="mc-prev" data-act="prev" aria-label="Previous audio file" title="Previous audio file in folder (Page Up)" style="${ICON_BUTTON_CSS}">${PREV_ICON}</button>` +
  `<button type="button" id="mc-back" data-act="back" aria-label="Back ${SEEK_STEP} seconds" title="Back ${SEEK_STEP} s (Left arrow)">−${SEEK_STEP}s</button>` +
  `<button type="button" id="mc-play" data-act="play" aria-label="Play" title="Play (Space)" style="${ICON_BUTTON_CSS}">${PLAY_ICON}</button>` +
  `<button type="button" id="mc-fwd" data-act="fwd" aria-label="Forward ${SEEK_STEP} seconds" title="Forward ${SEEK_STEP} s (Right arrow)">+${SEEK_STEP}s</button>` +
  `<button type="button" id="mc-next" data-act="next" aria-label="Next audio file" title="Next audio file in folder (Page Down)" style="${ICON_BUTTON_CSS}">${NEXT_ICON}</button>` +
  '<span id="mc-nav-sep" class="mc-toolbar-sep" aria-hidden="true"></span>' +
  '<span id="mc-audio-time" style="padding:0 6px;font-size:12px;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;">--:-- / --:--</span>' +
  '<input type="range" id="mc-seek" min="0" max="0" step="0.1" value="0" aria-label="Seek" />' +
  `<button type="button" id="mc-speed" data-act="speed" aria-label="Playback speed 1x, press to change" title="Playback speed (J slower, L faster)">1x</button>` +
  '<button type="button" id="mc-notes" data-act="notes" aria-pressed="false" aria-label="Audio notes" title="Timestamped notes: add at the playhead, set In and Out, copy as Markdown">Notes</button>';

const playBtn = document.getElementById('mc-play') as HTMLButtonElement;
const backBtn = document.getElementById('mc-back') as HTMLButtonElement;
const fwdBtn = document.getElementById('mc-fwd') as HTMLButtonElement;
const speedBtn = document.getElementById('mc-speed') as HTMLButtonElement;
const timeEl = document.getElementById('mc-audio-time') as HTMLSpanElement;
const seekEl = document.getElementById('mc-seek') as HTMLInputElement;
const notesBtn = document.getElementById('mc-notes') as HTMLButtonElement;

// Audio Notes: the video review's panel and timeline in clock mode, over this
// <audio> element. Nothing is built until the host's first `review` message, so a
// plain player costs nothing. This toolbar stays the transport.
const review = createReview({
  video: audio,
  clock: true,
  settingKey: 'audio.review',
  stage,
  post: (msg) => vscode.postMessage(msg),
  toast,
  viewState: { get: () => vscode.getState(), set: (value) => vscode.setState(value) },
  onChange: () => drawWave(),
  onModeChange: (on) => {
    notesBtn.setAttribute('aria-pressed', String(on));
    refreshDuration();
  },
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let fileName = '';
let filePath = '';
let fileBytes = 0;
// The markcopy.audio.autoplay and markcopy.audio.showTags settings as the reader last
// saw or toggled them, seeded from every load message.
let autoplay = false;
let showTags = false;
let currentTheme = document.body.getAttribute('data-mc-theme') || 'auto';
let fileCount = 1;
let fileIndex = 1;
let failed = false;
let scrubbing = false;

const NAV_IDS = ['mc-prev', 'mc-next', 'mc-nav-sep'];

function updateNav(): void {
  const show = fileCount > 1;
  for (const id of NAV_IDS) {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = show ? '' : 'none';
    }
  }
  const prev = document.getElementById('mc-prev');
  const next = document.getElementById('mc-next');
  prev?.setAttribute('aria-label', `Previous audio file (${fileIndex} of ${fileCount})`);
  next?.setAttribute('aria-label', `Next audio file (${fileIndex} of ${fileCount})`);
}

function applyPosition(position: { index?: unknown; count?: unknown } | undefined): void {
  const index = Number(position?.index);
  const count = Number(position?.count);
  fileCount = Number.isInteger(count) && count > 0 ? count : 1;
  fileIndex = Number.isInteger(index) && index > 0 && index <= fileCount ? index : 1;
  updateNav();
}

function navigate(step: 1 | -1): void {
  if (fileCount > 1) {
    vscode.postMessage({ type: 'navigate', step });
  }
}

function duration(): number {
  return audio.duration;
}

function refreshTime(): void {
  const dur = duration();
  const time = audio.currentTime;
  timeEl.textContent = positionReadout(time, dur);
  if (!scrubbing) {
    seekEl.value = String(time);
  }
  seekEl.setAttribute('aria-valuetext', positionReadout(time, dur));
}

function refreshDuration(): void {
  const dur = duration();
  const known = Number.isFinite(dur) && dur > 0;
  seekEl.max = known ? String(dur) : '0';
  seekEl.disabled = !known || failed;
  infoEl.textContent = infoLine(fileName, fileBytes, dur);
  refreshTime();
}

function refreshPlayButton(): void {
  const playing = !audio.paused && !audio.ended;
  playBtn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  playBtn.title = playing ? 'Pause (Space)' : 'Play (Space)';
}

function refreshSpeed(): void {
  const rate = audio.playbackRate;
  speedBtn.textContent = `${rate}x`;
  speedBtn.setAttribute('aria-label', `Playback speed ${rate}x, press to change`);
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
function togglePlay(): void {
  if (failed) {
    return;
  }
  if (audio.paused || audio.ended) {
    // A blocked or interrupted play() is not an error worth showing; the button
    // simply stays on Play.
    void Promise.resolve(audio.play()).catch(() => undefined);
  } else {
    audio.pause();
  }
}

function seekBy(delta: number): void {
  if (failed) {
    return;
  }
  audio.currentTime = seekTarget(audio.currentTime, delta, duration());
  refreshTime();
}

function seekTo(time: number): void {
  if (failed) {
    return;
  }
  audio.currentTime = seekTarget(0, time, duration());
  refreshTime();
}

function setSpeed(rate: number): void {
  audio.playbackRate = rate;
  refreshSpeed();
  toast(rate === 1 ? 'Normal speed' : `${rate}x speed`);
}

audio.addEventListener('play', refreshPlayButton);
audio.addEventListener('pause', refreshPlayButton);
audio.addEventListener('ended', refreshPlayButton);
audio.addEventListener('timeupdate', refreshTime);
// Metadata can arrive after the first render (a file over the waveform cap, no
// ffprobe), so the Details panel follows it too; the render is cheap and idempotent.
const onDuration = (): void => {
  refreshDuration();
  renderDetails();
};
audio.addEventListener('durationchange', onDuration);
audio.addEventListener('loadedmetadata', onDuration);
audio.addEventListener('ratechange', refreshSpeed);
audio.addEventListener('error', () => {
  failed = true;
  errorEl.textContent = describeAudioError(fileName);
  errorEl.style.display = '';
  openEl.style.display = '';
  for (const btn of [playBtn, backBtn, fwdBtn, speedBtn]) {
    btn.disabled = true;
  }
  seekEl.disabled = true;
  refreshPlayButton();
});

// The slider seeks as it is dragged; its own arrow keys are taken over in the
// keydown handler below so they move by the same 5 and 30 s as everywhere else.
seekEl.addEventListener('pointerdown', () => (scrubbing = true));
seekEl.addEventListener('pointerup', () => {
  scrubbing = false;
  refreshTime();
});
seekEl.addEventListener('input', () => {
  const time = Number(seekEl.value);
  if (Number.isFinite(time)) {
    audio.currentTime = time;
    timeEl.textContent = positionReadout(time, duration());
  }
});

toolbarEl.addEventListener('pointerdown', (e) => e.stopPropagation());
toolbarEl.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('button');
  switch (target?.dataset.act) {
    case 'prev':
      navigate(-1);
      break;
    case 'next':
      navigate(1);
      break;
    case 'back':
      seekBy(-SEEK_STEP);
      break;
    case 'fwd':
      seekBy(SEEK_STEP);
      break;
    case 'play':
      togglePlay();
      break;
    case 'speed':
      setSpeed(cycleSpeed(audio.playbackRate));
      break;
    case 'notes':
      review.toggle();
      break;
  }
});
openEl.addEventListener('click', () => vscode.postMessage({ type: 'openExternal' }));

// ---------------------------------------------------------------------------
// Waveform and details
// ---------------------------------------------------------------------------
// The file is fetched by its webview URI (the CSP's connect-src allows exactly that
// origin) and decoded once with Web Audio. Only the peaks and levels are kept: the
// AudioContext is closed and the decoded buffer dropped as soon as they are computed.
// The canvas is a pointer-only seek surface; keyboard users have the toolbar slider
// and the document-level arrow keys, so the canvas takes no focus and no keys.
const WAVE_HEIGHT = 120;
// A note marker is this wide to press, and this tall from the top of the canvas.
const MARKER_HIT = 8;
const MARKER_ZONE = 24;

interface Analysis {
  peaks: Float32Array[];
  buckets: number;
}

let probe: AudioDetails | undefined;
let analysis: Analysis | undefined;
let decoded: DecodedFacts | undefined;
let decodeRun = 0;
let hoverX = -1;
let dragging = false;
let waveRaf = 0;

function cssColor(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

/** Seconds the wave maps onto its width: the element's duration, else the decode's. */
function waveDuration(): number {
  const dur = duration();
  return Number.isFinite(dur) && dur > 0 ? dur : (decoded?.duration ?? 0);
}

function sizeCanvas(): { width: number; ctx: CanvasRenderingContext2D } | undefined {
  const ctx = waveCanvas.getContext('2d');
  const width = Math.floor(waveEl.getBoundingClientRect().width || waveEl.clientWidth);
  if (!ctx || width <= 0) {
    return undefined;
  }
  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.round(width * dpr);
  const pxH = Math.round(WAVE_HEIGHT * dpr);
  if (waveCanvas.width !== pxW || waveCanvas.height !== pxH) {
    waveCanvas.width = pxW;
    waveCanvas.height = pxH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, ctx };
}

function drawWave(): void {
  if (!analysis || waveEl.hidden) {
    return;
  }
  const sized = sizeCanvas();
  if (!sized) {
    return;
  }
  const { width, ctx } = sized;
  const fg = cssColor('--mc-fg');
  const accent = cssColor('--mc-accent');
  const border = cssColor('--mc-border');
  const bg = cssColor('--mc-bg');
  const total = waveDuration();
  const xOf = (seconds: number): number =>
    total > 0 ? Math.min(width, Math.max(0, (seconds / total) * width)) : 0;
  const playX = xOf(audio.currentTime);

  ctx.clearRect(0, 0, width, WAVE_HEIGHT);

  // In and Out, and the ranges of saved notes, behind the wave.
  const overlay = review.overlay();
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.1;
  for (const n of overlay.notes) {
    if (n.out !== undefined) {
      ctx.fillRect(xOf(n.at), 0, Math.max(1, xOf(n.out) - xOf(n.at)), WAVE_HEIGHT);
    }
  }
  if (overlay.pendingIn >= 0) {
    const from = xOf(overlay.pendingIn);
    const to = overlay.pendingOut > overlay.pendingIn ? xOf(overlay.pendingOut) : from;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(from, 0, Math.max(0, to - from), WAVE_HEIGHT);
    ctx.globalAlpha = 1;
    ctx.fillRect(from, 0, 2, WAVE_HEIGHT);
    if (to > from) {
      ctx.fillRect(to - 2, 0, 2, WAVE_HEIGHT);
    }
  }

  // One or two lanes; a file with more channels shows its first two.
  const lanes = Math.min(2, analysis.peaks.length);
  const laneH = WAVE_HEIGHT / lanes;
  const buckets = analysis.buckets;
  for (let lane = 0; lane < lanes; lane++) {
    const peaks = analysis.peaks[lane];
    const mid = lane * laneH + laneH / 2;
    const half = laneH / 2 - 2;
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = border;
    ctx.fillRect(0, mid, width, 1);
    for (let x = 0; x < width; x++) {
      const from = Math.floor((x * buckets) / width);
      const to = Math.max(from + 1, Math.ceil(((x + 1) * buckets) / width));
      let lo = 0;
      let hi = 0;
      for (let b = from; b < to && b < buckets; b++) {
        lo = Math.min(lo, peaks[b * 2]);
        hi = Math.max(hi, peaks[b * 2 + 1]);
      }
      const top = mid - Math.min(1, hi) * half;
      const bottom = mid - Math.max(-1, lo) * half;
      const played = x + 1 <= playX;
      ctx.fillStyle = played ? accent : fg;
      ctx.globalAlpha = played ? 1 : 0.45;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }

  // Note markers: a triangle at the top for each, larger and in the foreground colour when selected.
  ctx.globalAlpha = 1;
  for (const n of overlay.notes) {
    const x = xOf(n.at);
    const on = n.id === overlay.selected;
    const size = on ? 7 : 5;
    ctx.fillStyle = on ? fg : accent;
    ctx.beginPath();
    ctx.moveTo(x - size, 0);
    ctx.lineTo(x + size, 0);
    ctx.lineTo(x, size * 1.6);
    ctx.closePath();
    ctx.fill();
  }

  // Playhead.
  ctx.fillStyle = fg;
  ctx.fillRect(Math.min(width - 2, Math.max(0, playX - 1)), 0, 2, WAVE_HEIGHT);

  // Hover: a hairline and the time it would seek to.
  if (hoverX >= 0 && total > 0) {
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = fg;
    ctx.fillRect(Math.min(width - 1, hoverX), 0, 1, WAVE_HEIGHT);
    ctx.globalAlpha = 1;
    const label = formatPreciseDuration(timeAtX(hoverX, width, total));
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const textW = ctx.measureText(label).width + 10;
    const boxX = Math.min(width - textW, Math.max(0, hoverX + 6));
    ctx.fillStyle = bg;
    ctx.fillRect(boxX, WAVE_HEIGHT - 20, textW, 18);
    ctx.strokeStyle = border;
    ctx.strokeRect(boxX + 0.5, WAVE_HEIGHT - 19.5, textW - 1, 17);
    ctx.fillStyle = fg;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, boxX + 5, WAVE_HEIGHT - 11);
  }
  ctx.globalAlpha = 1;
}

function setWaveStatus(text: string): void {
  waveStatus.textContent = text;
  waveStatus.hidden = text === '';
}

function stopWaveLoop(): void {
  if (waveRaf) {
    window.cancelAnimationFrame?.(waveRaf);
    waveRaf = 0;
  }
}

/** Redraw every frame while playing, so the playhead glides rather than hopping at timeupdate. */
function waveLoop(): void {
  stopWaveLoop();
  if (audio.paused || audio.ended || !window.requestAnimationFrame) {
    return;
  }
  waveRaf = window.requestAnimationFrame(() => {
    waveRaf = 0;
    drawWave();
    waveLoop();
  });
}

function pointerX(e: MouseEvent): { x: number; width: number; y: number } {
  const rect = waveEl.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top, width: rect.width };
}

/** The note whose marker is under a press near the top of the wave, if any. */
function markerAt(x: number, y: number, width: number): string | undefined {
  const total = waveDuration();
  if (y > MARKER_ZONE || total <= 0) {
    return undefined;
  }
  let best: { id: string; dist: number } | undefined;
  for (const n of review.overlay().notes) {
    const dist = Math.abs((n.at / total) * width - x);
    if (dist <= MARKER_HIT && (!best || dist < best.dist)) {
      best = { id: n.id, dist };
    }
  }
  return best?.id;
}

function seekFromPointer(e: MouseEvent): void {
  const { x, width } = pointerX(e);
  seekTo(timeAtX(x, width, waveDuration()));
  drawWave();
}

waveEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || analysis === undefined) {
    return;
  }
  const { x, y, width } = pointerX(e);
  const note = markerAt(x, y, width);
  if (note !== undefined) {
    review.selectNote(note);
    drawWave();
    return;
  }
  dragging = true;
  try {
    waveEl.setPointerCapture?.(e.pointerId);
  } catch {
    // A synthetic event has no pointer to capture; the drag still works inside the box.
  }
  seekFromPointer(e);
});
waveEl.addEventListener('pointermove', (e) => {
  hoverX = pointerX(e).x;
  if (dragging) {
    seekFromPointer(e);
  } else {
    drawWave();
  }
});
const endDrag = (): void => {
  dragging = false;
};
waveEl.addEventListener('pointerup', endDrag);
waveEl.addEventListener('pointercancel', endDrag);
waveEl.addEventListener('pointerleave', () => {
  hoverX = -1;
  drawWave();
});

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => drawWave()).observe(waveEl);
}
// A theme change moves the --mc-* tokens: the markcopy.theme setting sets
// data-mc-theme, and VS Code flips its own theme class on <body>.
if (typeof MutationObserver !== 'undefined') {
  new MutationObserver(() => drawWave()).observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-mc-theme'],
  });
}
audio.addEventListener('play', waveLoop);
audio.addEventListener('pause', () => {
  stopWaveLoop();
  drawWave();
});
audio.addEventListener('seeked', drawWave);
audio.addEventListener('timeupdate', drawWave);
audio.addEventListener('durationchange', drawWave);

/** Resolve with the element's duration once it is finite, or NaN if it errors first. */
function whenDuration(): Promise<number> {
  if (Number.isFinite(audio.duration)) {
    return Promise.resolve(audio.duration);
  }
  return new Promise((resolve) => {
    const done = (): void => {
      // durationchange also fires for Infinity: a stream never gets a length.
      if (Number.isFinite(audio.duration) || audio.duration === Infinity) {
        finish(audio.duration);
      }
    };
    const finish = (value: number): void => {
      audio.removeEventListener('loadedmetadata', done);
      audio.removeEventListener('durationchange', done);
      audio.removeEventListener('error', onError);
      resolve(value);
    };
    const onError = (): void => finish(NaN);
    audio.addEventListener('loadedmetadata', done);
    audio.addEventListener('durationchange', done);
    audio.addEventListener('error', onError);
  });
}

/** Decode `src`, keep the peaks and levels, and let the rest go. */
async function buildWaveform(src: string, bytes: number): Promise<void> {
  const run = ++decodeRun;
  analysis = undefined;
  decoded = undefined;
  hoverX = -1;
  waveEl.hidden = true;
  setWaveStatus('');
  renderDetails();
  if (bytes > WAVEFORM_SIZE_CAP) {
    waveEl.hidden = false;
    waveCanvas.hidden = true;
    setWaveStatus(waveformSkipped(bytes));
    return;
  }
  waveEl.hidden = false;
  waveCanvas.hidden = true;
  setWaveStatus('Drawing waveform...');
  // The decoded PCM is bounded by duration, not by the encoded size: wait for it.
  const length = await whenDuration();
  if (run !== decodeRun) {
    return;
  }
  const estimate = decodedBytes(length, probe?.sampleRate, probe?.channels);
  if (!(estimate <= WAVEFORM_DECODE_BUDGET)) {
    waveCanvas.hidden = true;
    setWaveStatus(waveformTooLong(length));
    return;
  }
  let ctx: AudioContext | undefined;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      throw new Error('no Web Audio');
    }
    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const bytesIn = await response.arrayBuffer();
    if (run !== decodeRun) {
      return;
    }
    ctx = new Ctor();
    let buffer: AudioBuffer | null = await ctx.decodeAudioData(bytesIn);
    if (run !== decodeRun) {
      return;
    }
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(buffer.getChannelData(c));
    }
    const facts: DecodedFacts = { duration: buffer.duration, channels: buffer.numberOfChannels };
    const result = await analyzeChannels(channels);
    // The decoded PCM is the big allocation: drop it before anything else happens.
    channels.length = 0;
    buffer = null;
    if (run !== decodeRun) {
      return;
    }
    analysis = { peaks: result.peaks, buckets: result.buckets };
    decoded = {
      ...facts,
      peak: result.peak,
      rms: result.rms,
      clipped: result.clipped,
      length: result.length,
    };
    waveCanvas.hidden = false;
    setWaveStatus('');
    renderDetails();
    drawWave();
  } catch {
    // Undecodable here (AAC without a decoder, a damaged file, a fetch refused): the
    // waveform is simply absent, and the player carries on.
    if (run === decodeRun) {
      waveEl.hidden = true;
      setWaveStatus('');
    }
  } finally {
    void ctx?.close().catch(() => undefined);
  }
}

function currentRows(): DetailRow[] {
  return detailRows(fileName, fileBytes, probe, {
    ...decoded,
    duration: decoded?.duration ?? (Number.isFinite(duration()) ? duration() : undefined),
  });
}

/** The tag rows on screen: none while Show Tags is off, which is the default. */
function visibleTags(): DetailRow[] {
  return showTags ? tagRows(probe) : [];
}

function renderDetails(): void {
  const rows = currentRows();
  const tags = visibleTags();
  detailsGrid.replaceChildren();
  tagsGrid.replaceChildren();
  const fill = (grid: HTMLElement, items: DetailRow[]): void => {
    for (const [label, value] of items) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      grid.append(dt, dd);
    }
  };
  fill(detailsGrid, rows);
  fill(tagsGrid, tags);
  tagsHead.hidden = tags.length === 0;
  tagsGrid.hidden = tags.length === 0;
  detailsEl.hidden = rows.length === 0 && tags.length === 0;
}

// Copies what the panel shows: the tags are in the Markdown only while Show Tags is on.
function copyDetails(): void {
  const text = detailsMarkdown(fileName, currentRows(), visibleTags());
  void Promise.resolve(navigator.clipboard?.writeText(text)).then(
    () => toast('Details copied'),
    () => toast('Could not copy details'),
  );
}
copyDetailsBtn.addEventListener('click', copyDetails);

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
function copyText(text: string, label: string): void {
  if (!text) {
    toast('Nothing to copy');
    return;
  }
  void Promise.resolve(navigator.clipboard?.writeText(text)).then(
    () => toast(label),
    () => toast('Could not copy'),
  );
}

function toggleLoop(): void {
  audio.loop = !audio.loop;
  // Persisted like the video viewer's: someone looping one file is in a folder of them.
  vscode.postMessage({ type: 'updateSetting', key: 'audio.loop', value: audio.loop });
  toast(audio.loop ? 'Looping' : 'Looping off');
}

function toggleAutoplay(): void {
  autoplay = !autoplay;
  // For the next file opened: it neither starts nor stops the one playing now.
  vscode.postMessage({ type: 'updateSetting', key: 'audio.autoplay', value: autoplay });
  toast(autoplay ? 'Autoplay on' : 'Autoplay off');
}

function toggleTags(): void {
  showTags = !showTags;
  vscode.postMessage({ type: 'updateSetting', key: 'audio.showTags', value: showTags });
  renderDetails();
}

function setTheme(value: string): void {
  currentTheme = value;
  document.body.setAttribute('data-mc-theme', value);
  vscode.postMessage({ type: 'updateSetting', key: 'theme', value });
}

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

document.addEventListener('contextmenu', (e) => {
  // The native menu (cut, copy, paste) is wanted over a note's text field.
  if (isTextEntry(e.target)) {
    return;
  }
  e.preventDefault();
  const entries: MenuEntry[] = [
    {
      kind: 'submenu',
      label: 'Copy',
      entries: [
        { kind: 'item', label: 'Details', run: copyDetails },
        { kind: 'item', label: 'File Name', run: () => copyText(fileName, 'Copied file name') },
        { kind: 'item', label: 'Full Path', run: () => copyText(filePath, 'Copied path') },
      ],
    },
    { kind: 'divider' },
    {
      kind: 'submenu',
      label: 'Playback',
      entries: [
        { kind: 'checkbox', label: 'Loop', checked: audio.loop, run: toggleLoop },
        { kind: 'checkbox', label: 'Autoplay', checked: autoplay, run: toggleAutoplay },
        { kind: 'divider' },
        { kind: 'label', label: 'Speed' },
        ...AUDIO_SPEEDS.map((rate): MenuEntry => ({
          kind: 'radio',
          label: rate === 1 ? 'Normal' : `${rate}x`,
          checked: Math.abs(audio.playbackRate - rate) < 1e-6,
          run: () => setSpeed(rate),
        })),
      ],
    },
    { kind: 'divider' },
    ...review.menuEntries(),
    { kind: 'divider' },
    { kind: 'label', label: 'View' },
    { kind: 'checkbox', label: 'Show Tags', checked: showTags, run: toggleTags },
    { kind: 'divider' },
    { kind: 'submenu', label: 'Preferences', entries: themeItems() },
    { kind: 'divider' },
    {
      kind: 'item',
      label: 'Open in Default App',
      run: () => vscode.postMessage({ type: 'openExternal' }),
    },
    { kind: 'item', label: revealLabel(), run: () => vscode.postMessage({ type: 'revealInOS' }) },
  ];
  contextMenu.show(e.pageX, e.pageY, entries);
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (contextMenu.isOpen() || e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) {
    return;
  }
  // Notes mode adds I, O and N; the transport keys below stay as they are.
  if (review.onKeydown(e)) {
    return;
  }
  const onButton = (e.target as HTMLElement | null)?.tagName === 'BUTTON';
  switch (e.key) {
    case ' ':
      // A focused button already toggles on Space; handling it here too would
      // play and pause in the same press.
      if (onButton) {
        return;
      }
      e.preventDefault();
      togglePlay();
      break;
    case 'k':
    case 'K':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
    case 'ArrowRight': {
      // Always taken here, slider focused or not, with preventDefault so the
      // range input's own arrow step cannot seek a second time.
      e.preventDefault();
      const dist = e.shiftKey ? SEEK_STEP_LONG : SEEK_STEP;
      seekBy(e.key === 'ArrowLeft' ? -dist : dist);
      break;
    }
    case 'Home':
      e.preventDefault();
      seekTo(0);
      break;
    case 'End':
      e.preventDefault();
      seekTo(Number.isFinite(duration()) ? duration() : 0);
      break;
    case 'PageUp':
    case 'PageDown':
      if (fileCount > 1) {
        e.preventDefault();
        navigate(e.key === 'PageUp' ? -1 : 1);
      }
      break;
    case 'j':
    case 'J':
      setSpeed(stepSpeed(audio.playbackRate, -1));
      break;
    case 'l':
    case 'L':
      setSpeed(stepSpeed(audio.playbackRate, 1));
      break;
  }
});

// ---------------------------------------------------------------------------
// Host messages
// ---------------------------------------------------------------------------
interface LoadMessage {
  type: 'load';
  name: string;
  path: string;
  size: number;
  position?: { index?: unknown; count?: unknown };
  autoplay?: boolean;
  loop?: boolean;
  showTags?: boolean;
}

function load(msg: LoadMessage): void {
  failed = false;
  fileName = String(msg.name ?? '');
  filePath = String(msg.path ?? '');
  autoplay = msg.autoplay === true;
  showTags = msg.showTags === true;
  fileBytes = Number(msg.size) || 0;
  applyPosition(msg.position);
  nameEl.textContent = fileName;
  document.title = fileName;
  errorEl.style.display = 'none';
  openEl.style.display = 'none';
  for (const btn of [playBtn, backBtn, fwdBtn, speedBtn]) {
    btn.disabled = false;
  }
  audio.loop = msg.loop === true;
  audio.src = mediaSrc;
  probe = undefined;
  void buildWaveform(mediaSrc, fileBytes);
  refreshDuration();
  refreshPlayButton();
  refreshSpeed();
  if (msg.autoplay === true) {
    togglePlay();
  }
}

// Only the extension host talks to this frame; see the same check in image.ts.
function fromHost(event: MessageEvent): boolean {
  return event.origin === window.origin || event.source === window.parent;
}

window.addEventListener('message', (event: MessageEvent) => {
  if (!fromHost(event)) {
    return;
  }
  const msg = event.data as
    LoadMessage | { type: 'setTheme'; value: string } | { type: 'details'; details: unknown };
  if (!msg || review.onMessage(msg)) {
    return;
  }
  if (msg.type === 'load') {
    load(msg);
  } else if (msg.type === 'details') {
    // Checked here as well as shaped on the host: the page renders only what it can verify.
    probe = parseDetails(msg.details);
    renderDetails();
  } else if (msg.type === 'setTheme') {
    currentTheme = String(msg.value);
    document.body.setAttribute('data-mc-theme', currentTheme);
  }
});

updateNav();
vscode.postMessage({ type: 'ready' });
