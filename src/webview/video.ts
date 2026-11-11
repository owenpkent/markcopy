// Browser-side code for the video preview (media/video.js), the viewer behind
// src/videoEditor.ts.
//
// Unlike the PDF and STL previews, the file itself never travels through
// postMessage: a video is far too large to base64 into a JSON message, and it
// does not need to be. The <video> element is handed a webview-resource URI and
// streams the file straight off disk, seeking with range requests, so a 2 GB
// clip costs the same in memory as a 2 MB one.
import { positionReadout } from './audioInfo';
import { createMenu, revealLabel, type MenuEntry } from './menu';
import {
  describeMediaError,
  formatBytes,
  formatDuration,
  frameFileName,
  proxyDisabled,
  proxyFailed,
  proxyOffer,
  proxyProgress,
  proxyUnavailable,
  soundFailed,
  soundOffer,
  soundProgress,
} from './videoInfo';
import { createReview, isTextEntry } from './videoReview';
import { fromHost } from './fromHost';

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
const noticeEl = document.getElementById('mc-notice') as HTMLDivElement;

const contextMenu = createMenu(menuEl);

// The speaker: a button that mutes and a slider for the level. It is built here
// and placed by the control bar further down (and, in review mode, moved into the
// review transport beside its play button), so the sound is always one click away.
const volumeBox = document.createElement('div');
volumeBox.className = 'mc-video-volume';
const speakerBtn = document.createElement('button');
speakerBtn.type = 'button';
speakerBtn.className = 'mc-video-ctl mc-video-speaker';
const volumeSlider = document.createElement('input');
volumeSlider.type = 'range';
volumeSlider.className = 'mc-video-volume-slider';
volumeSlider.min = '0';
volumeSlider.max = '100';
volumeSlider.step = '1';
volumeSlider.setAttribute('aria-label', 'Volume');
volumeBox.append(speakerBtn, volumeSlider);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let fileName = '';
let filePath = '';
let fileBytes = 0;
let sourceUri = '';
// The only two addresses this page ever plays, written by the host into the
// page itself (src/videoEditor.ts html()). A load message picks one by name;
// no URL from a message reaches the element.
const fileSrc = document.body.dataset.mcSrc ?? '';
const proxySrc = document.body.dataset.mcProxySrc ?? '';

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

// How the status line should describe the thing actually on screen, when it is
// not the file itself but an ffmpeg-built copy of it. Empty while playing the
// original. A reader grabbing a frame has to know it came from a re-encode.
let proxyNote = '';
// Whether the host has already been asked about a proxy for this file, so a
// second `error` (the proxy's own, or a retry) does not start the conversation
// over from the top.
let proxyAsked = false;
// Whether the host has been told that the original loaded, so the report is made
// once per source however many times the element re-reads its metadata. Reset on
// every load.
let playableReported = false;
// Where the reader was when a sound copy replaced the original, applied once the
// new source has metadata to seek in. Undefined for an ordinary load. The rate
// is part of it because assigning `src` runs the media load algorithm, which
// puts `playbackRate` back to `defaultPlaybackRate`: a 2x clip would otherwise
// drop to normal speed the moment its sound arrived.
let resumeAt: { time: number; playing: boolean; rate: number } | undefined;

// The markcopy.video.autoplay setting as the reader last saw or toggled it,
// seeded from every load message. The menu flips it for the next video opened;
// it never starts or stops the one on screen.
let autoplay = false;
// Set by an ordinary (non-swap) load that should start playing, and consumed by
// the `loadedmetadata` handler: the attempt waits for metadata so `play()` has a
// source to start, and a swap or a later reload must not repeat it.
let autoplayPending = false;
// Our own pending `video.muted` write and the value it set, so the
// `volumechange` listener can tell that echo from the reader pressing the
// control's mute button.
let mutedEchoPending = false;
let mutedWritten = false;
// Armed when autoplay had to fall back to muted: the first click or key press
// anywhere in the preview turns the sound on, unless the reader got there first.
let unmuteArmed = false;

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
  if (proxyNote) {
    parts.push(proxyNote);
  }
  statusEl.textContent = parts.join('  ·  ');
}

interface OverlayAction {
  label: string;
  run: () => void;
}

// The message paragraph and progress bar of the overlay currently on screen, so
// a transcode ticking twice a second can rewrite them in place. Rebuilding the
// overlay on every tick would drop the focus ring off the Cancel button between
// one frame and the next, making it unclickable by keyboard for the whole encode.
let overlayText: HTMLParagraphElement | undefined;
let overlayFill: HTMLDivElement | undefined;

/** The door the messages point at: hand the file to the player that can read it. */
function openExternalAction(): OverlayAction {
  return {
    label: 'Open in Default App',
    run: () => vscode.postMessage({ type: 'openExternal' }),
  };
}

/**
 * Replace the viewport with a message the reader can act on.
 *
 * `progress` draws a bar under the message: a fraction for a transcode whose
 * total is known, or -1 for one whose is not, which animates rather than
 * claiming a position it cannot compute.
 */
function showOverlay(message: string, actions: OverlayAction[], progress?: number): void {
  stage.hidden = true;
  controlBar.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = '';
  overlayText = undefined;
  overlayFill = undefined;

  const text = document.createElement('p');
  text.className = 'mc-video-error-text';
  text.textContent = message;
  errorEl.appendChild(text);
  overlayText = text;

  if (progress !== undefined) {
    const { track, fill } = progressBar();
    errorEl.appendChild(track);
    overlayFill = fill;
    setProgress(progress);
  }

  if (actions.length > 0) {
    errorEl.appendChild(actionRow(actions));
  }
}

/** Size a progress bar's fill; a negative fraction paces instead of claiming a position. */
function setFill(fill: HTMLDivElement | undefined, fraction: number): void {
  if (!fill) {
    return;
  }
  const indeterminate = fraction < 0;
  fill.classList.toggle('mc-video-progress-fill--waiting', indeterminate);
  fill.style.width = indeterminate
    ? ''
    : `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

function setProgress(fraction: number): void {
  setFill(overlayFill, fraction);
}

/** A row of buttons, shared by the overlay and the notice. */
function actionRow(actions: OverlayAction[]): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'mc-video-actions';
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mc-video-button';
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    row.appendChild(button);
  }
  return row;
}

/** A progress track with its fill, which the caller keeps to update in place. */
function progressBar(): { track: HTMLDivElement; fill: HTMLDivElement } {
  const track = document.createElement('div');
  track.className = 'mc-video-progress';
  const fill = document.createElement('div');
  fill.className = 'mc-video-progress-fill';
  track.appendChild(fill);
  return { track, fill };
}

/** Retitle the overlay already on screen, or draw a fresh one if there is none. */
function updateOverlay(message: string, fraction: number, actions: OverlayAction[]): void {
  if (overlayText && overlayFill) {
    overlayText.textContent = message;
    setProgress(fraction);
    return;
  }
  showOverlay(message, actions, fraction);
}

// The notice bar: the overlay's quieter sibling, for news about a file that is
// already playing. It never hides the stage, so the sound copy's offer, progress
// and failure can all arrive while the reader is watching the picture.
let noticeText: HTMLParagraphElement | undefined;
let noticeFill: HTMLDivElement | undefined;

// The notice sits just above the status line, between it and the control bar, so
// the stage gives up exactly the notice's height while it is up. Observed rather than
// measured once, because the text wraps differently as the panel is resized.
new ResizeObserver(() => {
  const height = noticeEl.hidden ? 0 : noticeEl.offsetHeight;
  document.body.style.setProperty('--mc-notice-h', `${height}px`);
}).observe(noticeEl);

function hideNotice(): void {
  noticeEl.hidden = true;
  noticeEl.textContent = '';
  noticeText = undefined;
  noticeFill = undefined;
}

const dismissAction: OverlayAction = { label: 'Dismiss', run: hideNotice };

function showNotice(message: string, actions: OverlayAction[], progress?: number): void {
  noticeEl.hidden = false;
  noticeEl.textContent = '';
  noticeText = undefined;
  noticeFill = undefined;

  const text = document.createElement('p');
  text.className = 'mc-video-notice-text';
  text.textContent = message;
  noticeEl.appendChild(text);
  noticeText = text;

  if (progress !== undefined) {
    const { track, fill } = progressBar();
    noticeEl.appendChild(track);
    noticeFill = fill;
    setFill(fill, progress);
  }
  if (actions.length > 0) {
    noticeEl.appendChild(actionRow(actions));
  }
}

/** Same in-place rule as `updateOverlay`: ticks must not rebuild the Cancel button. */
function updateNotice(message: string, fraction: number, actions: OverlayAction[]): void {
  if (noticeText && noticeFill) {
    noticeText.textContent = message;
    setFill(noticeFill, fraction);
    return;
  }
  showNotice(message, actions, fraction);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
interface LoadMessage {
  type: 'load';
  /** Which of the page's two addresses to play. */
  source: 'file' | 'proxy';
  name: string;
  path: string;
  size: number;
  autoplay: boolean;
  loop: boolean;
  /** The markcopy.video.volume setting, a whole percentage already clamped by the host. */
  volume: number;
  /** Set when `src` is an ffmpeg-built copy rather than the file itself. */
  proxyNote?: string;
}

function load(msg: LoadMessage): void {
  fileName = msg.name;
  filePath = msg.path;
  fileBytes = msg.size;
  sourceUri = msg.source === 'proxy' ? proxySrc : fileSrc;
  proxyNote = msg.proxyNote ?? '';
  playableReported = false;
  // A copy replacing the original under the reader's feet (the sound copy) must
  // not throw them back to 0:00 and a stopped picture. The initial load has
  // nothing to preserve, and neither has a swap from a source that never loaded.
  const swap = proxyNote !== '' && video.readyState >= 1 && video.src !== '';
  resumeAt = swap
    ? { time: video.currentTime, playing: !video.paused, rate: video.playbackRate }
    : undefined;
  hideNotice();
  // A second source means a second chance at both: the CORS probe is per-file,
  // and a proxy that fails to load is a different failure from the original's.
  corsRetried = false;
  frameCopyBlocked = false;

  video.loop = msg.loop;
  autoplay = msg.autoplay;
  // A new file ends a pending "unmute on first gesture": it belonged to the
  // previous source's autoplay. A swap does not, because the sound copy of a
  // muted autoplay is exactly where the promised click has to work, and the swap
  // keeps the muted state that click is meant to undo.
  if (!swap) {
    unmuteArmed = false;
  }
  // An unmuted `play()` without a user gesture rejects with NotAllowedError in a
  // webview while a muted one succeeds, so the `autoplay` attribute (which would
  // silently stay a still frame) is not used. The attempt is made unmuted in the
  // `loadedmetadata` handler and only falls back to muted if it is refused. A
  // swap is not an open: it keeps whatever mute state the reader has chosen, and
  // resumes by itself below.
  video.autoplay = false;
  autoplayPending = !swap && msg.autoplay;
  if (!swap) {
    setMuted(false);
    // The swap keeps the level the reader is listening at; an open starts from
    // the remembered one. Recorded first, so the `volumechange` this write
    // queues is not mistaken for a change worth saving.
    // An older host sends no level, and `video.volume` throws outside 0 to 1.
    savedVolume = Number.isFinite(msg.volume) ? Math.min(100, Math.max(0, msg.volume)) : 100;
    video.volume = savedVolume / 100;
  }
  video.crossOrigin = 'anonymous';
  video.src = sourceUri;
  updateStatus();
}

/** Write `video.muted` in a way the `volumechange` listener can recognise as ours. */
function setMuted(value: boolean): void {
  if (video.muted === value) {
    return;
  }
  // `volumechange` is queued as a task rather than fired inline, so a flag
  // cleared right after the write would never be seen set. The echo is matched
  // by value instead: an event that finds the element in a state we did not
  // write is the reader's.
  mutedEchoPending = true;
  mutedWritten = value;
  video.muted = value;
}

video.addEventListener('volumechange', () => {
  if (mutedEchoPending && video.muted === mutedWritten) {
    mutedEchoPending = false;
    return;
  }
  // The reader used the control (or a key) themselves: whatever they chose is
  // not ours to undo on their next click.
  mutedEchoPending = false;
  unmuteArmed = false;
});

/**
 * Autoplay with sound when the browser allows it, muted when it does not.
 * Fallback on the first refusal rather than guessing: whether a gesture counts
 * depends on the host, so the attempt is the only reliable test.
 */
function startAutoplay(): void {
  const source = sourceUri;
  void video.play().catch((err: unknown) => {
    // Only a policy refusal earns the muted retry. The same promise also rejects,
    // with AbortError, when the reader pauses before the first frame arrives or a
    // new source replaces this one, and retrying then would undo their pause or
    // start a stale attempt on the wrong file.
    if ((err as { name?: unknown } | null)?.name !== 'NotAllowedError' || source !== sourceUri) {
      return;
    }
    setMuted(true);
    video.play().catch(() => undefined);
    toast('Playing muted · click anywhere for sound', 4000);
    unmuteArmed = true;
  });
}

// Unmute on the first gesture, capture phase so nothing in the preview can stop
// it. The unmute is deferred a tick and re-checked: a click on the speaker
// button would otherwise be unmuted on pointerdown and then re-muted by the
// button itself. By the time the timeout runs its `volumechange` has
// disarmed us, so the reader's choice stands.
function onFirstGesture(event: Event): void {
  if (!unmuteArmed) {
    return;
  }
  if (event instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
    return;
  }
  window.setTimeout(() => {
    if (unmuteArmed && video.muted) {
      unmuteArmed = false;
      setMuted(false);
    }
  }, 0);
}
document.addEventListener('click', onFirstGesture, true);
document.addEventListener('keydown', onFirstGesture, true);

video.addEventListener('loadedmetadata', () => {
  stage.hidden = false;
  controlBar.hidden = false;
  errorEl.hidden = true;
  // The overlay's nodes go with it; leaving the handles set would let a late
  // progress tick write into a box nobody can see.
  overlayText = undefined;
  overlayFill = undefined;
  updateStatus();

  if (resumeAt) {
    const { time, playing, rate } = resumeAt;
    resumeAt = undefined;
    video.playbackRate = rate;
    // Clamped, because the copy's duration can differ by a frame or two from the
    // original's and a seek past the end would land on the last frame, ended.
    video.currentTime = Number.isFinite(video.duration) ? Math.min(time, video.duration) : time;
    if (playing) {
      // A rejection (the browser declining to start without a gesture) leaves the
      // reader at the right place, paused, which is the right failure.
      void video.play().catch(() => undefined);
    }
  }

  if (autoplayPending) {
    autoplayPending = false;
    startAutoplay();
  }

  // The original opened, which is the host's cue to check the soundtrack: a file
  // whose picture plays can still be silent, and only ffprobe can say. Metadata
  // rather than `loadeddata`, because under `preload="metadata"` the element may
  // fetch no frames until the reader presses play, and the copy should be under
  // way by then, not starting.
  if (!proxyNote && !playableReported) {
    playableReported = true;
    vscode.postMessage({ type: 'playable' });
  }
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

  const code = video.error?.code;
  // A codec this engine has no decoder for is the one failure ffmpeg can undo.
  // A cancelled load or an unreadable file is not, and asking the host to spend
  // a transcode on either would trade a clear message for a slow one.
  const transcodable = code === 3 || code === 4 || code === undefined;
  if (transcodable && !proxyNote && !proxyAsked) {
    proxyAsked = true;
    showOverlay('Checking whether this file can be previewed…', [openExternalAction()]);
    vscode.postMessage({ type: 'proxyRequest' });
    return;
  }
  showOverlay(describeMediaError(code, fileName), [openExternalAction()]);
});

// ---------------------------------------------------------------------------
// The ffmpeg proxy
// ---------------------------------------------------------------------------
/**
 * What the host has to say about building a playable copy of this file.
 *
 * The viewer drives none of this: it reports that the element gave up and then
 * renders whatever comes back, because every input to the decision (is ffmpeg
 * installed, what codec is this really, has the reader turned transcoding off)
 * lives on the host side of the postMessage boundary.
 */
interface ProxyMessage {
  type: 'proxy';
  state: 'unavailable' | 'ask' | 'running' | 'failed' | 'soundAsk';
  /** `sound` for the background sound copy, which belongs in the notice bar. */
  scope?: 'sound';
  /** Why there will be no proxy: no ffmpeg to run, or the reader said not to. */
  reason?: 'missing' | 'disabled';
  /** The source codec as ffprobe named it, when a probe got that far. */
  codec?: string;
  /** The build will copy the picture into an MP4 instead of re-encoding it. */
  remux?: boolean;
  /** Seconds encoded so far, and the total to measure them against. */
  seconds?: number;
  durationSec?: number;
  /** ffmpeg's own account of a failure. */
  detail?: string;
}

const buildAction: OverlayAction = {
  label: 'Build Playable Copy',
  run: () => vscode.postMessage({ type: 'proxyStart' }),
};
const buildSoundAction: OverlayAction = {
  label: 'Build Copy with Sound',
  run: () => vscode.postMessage({ type: 'proxyStart', kind: 'sound' }),
};
const cancelAction: OverlayAction = {
  label: 'Cancel',
  run: () => vscode.postMessage({ type: 'proxyCancel' }),
};

/** The sound copy's side of the conversation, which never touches the overlay. */
function onSoundMessage(msg: ProxyMessage): void {
  switch (msg.state) {
    case 'soundAsk':
      showNotice(soundOffer(fileName, msg.codec ?? ''), [
        buildSoundAction,
        openExternalAction(),
        dismissAction,
      ]);
      break;
    case 'running': {
      const duration = msg.durationSec ?? 0;
      const seconds = msg.seconds ?? 0;
      updateNotice(soundProgress(seconds, duration), duration > 0 ? seconds / duration : -1, [
        cancelAction,
      ]);
      break;
    }
    case 'failed':
      showNotice(soundFailed(fileName, msg.detail ?? ''), [dismissAction]);
      break;
    default:
      break;
  }
}

function onProxyMessage(msg: ProxyMessage): void {
  if (msg.scope === 'sound') {
    onSoundMessage(msg);
    return;
  }
  switch (msg.state) {
    case 'unavailable':
      showOverlay(
        msg.reason === 'disabled' ? proxyDisabled(fileName) : proxyUnavailable(fileName),
        [openExternalAction()],
      );
      break;
    case 'ask':
      showOverlay(proxyOffer(fileName, msg.codec ?? '', msg.remux === true), [
        buildAction,
        openExternalAction(),
      ]);
      break;
    case 'running': {
      const duration = msg.durationSec ?? 0;
      const seconds = msg.seconds ?? 0;
      updateOverlay(proxyProgress(seconds, duration), duration > 0 ? seconds / duration : -1, [
        cancelAction,
      ]);
      break;
    }
    case 'failed':
      showOverlay(proxyFailed(fileName, msg.detail ?? ''), [openExternalAction()]);
      break;
  }
}

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

// The markcopy.video.volume setting as last written or loaded, as a whole
// percentage, so a `volumechange` that leaves it where it was writes nothing.
let savedVolume = 100;
let volumeSaveTimer = 0;

const volumePercent = (): number => Math.round(video.volume * 100);

/**
 * Remember the level for the next video, whichever control set it: the menu,
 * the wheel, the arrow keys or the volume slider. Debounced, because a wheel
 * spin or a slider drag is dozens of changes and each write lands in
 * settings.json. Muting is not saved: it is the autoplay fallback's state as
 * often as the reader's.
 */
function saveVolumeSoon(): void {
  window.clearTimeout(volumeSaveTimer);
  volumeSaveTimer = window.setTimeout(() => {
    const value = volumePercent();
    if (value !== savedVolume) {
      savedVolume = value;
      vscode.postMessage({ type: 'updateSetting', key: 'video.volume', value });
    }
  }, 500);
}
video.addEventListener('volumechange', saveVolumeSoon);

// The speaker glyph on the 24 grid, stroked in currentColor like the review
// transport's icons: the cone, then no waves when muted or silent (a cross
// instead), one below half volume, two from half up.
const SPEAKER_CONE = 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z';
const SPEAKER_PATHS = {
  muted: [SPEAKER_CONE, 'M16 9.5l5 5', 'M21 9.5l-5 5'],
  low: [SPEAKER_CONE, 'M15.5 9.5a3.5 3.5 0 0 1 0 5'],
  high: [SPEAKER_CONE, 'M15.5 9.5a3.5 3.5 0 0 1 0 5', 'M18 7a7 7 0 0 1 0 10'],
};
const SVG_NS = 'http://www.w3.org/2000/svg';
let speakerShown = '';

/**
 * A 24-grid glyph, stroked in currentColor so it follows the button's colour in
 * every theme. `filled` is for the solid play and pause shapes.
 */
function svgIcon(paths: string[], filled = false): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [name, value] of Object.entries({
    viewBox: '0 0 24 24',
    width: '18',
    height: '18',
    fill: filled ? 'currentColor' : 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  })) {
    svg.setAttribute(name, value);
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** Bring the speaker button and slider in line with the element. */
function renderVolume(): void {
  const silent = video.muted || video.volume === 0;
  const glyph = silent ? 'muted' : video.volume < 0.5 ? 'low' : 'high';
  if (glyph !== speakerShown) {
    speakerShown = glyph;
    speakerBtn.replaceChildren(svgIcon(SPEAKER_PATHS[glyph]));
  }
  const label = video.muted ? 'Unmute (m)' : 'Mute (m)';
  speakerBtn.title = label;
  speakerBtn.setAttribute('aria-label', label);
  speakerBtn.setAttribute('aria-pressed', String(video.muted));
  const level = video.muted ? 0 : volumePercent();
  volumeSlider.value = String(level);
  volumeSlider.title = `Volume ${level}%`;
  volumeSlider.style.setProperty('--mc-volume', `${level}%`);
}
video.addEventListener('volumechange', renderVolume);
renderVolume();

onPress(speakerBtn, toggleMute);

volumeSlider.addEventListener('input', () => {
  video.volume = Number(volumeSlider.value) / 100;
  if (video.muted && video.volume > 0) {
    video.muted = false;
  }
});

function volumeToast(): void {
  toast(video.muted ? 'Muted' : `Volume ${volumePercent()}%`);
}

/** Set the level from 0 to 1. Any change of level is a request to hear it, so it unmutes. */
function setVolume(level: number): void {
  video.volume = Math.min(1, Math.max(0, level));
  if (video.muted && video.volume > 0) {
    video.muted = false;
  }
  volumeToast();
}

function toggleMute(): void {
  video.muted = !video.muted;
  volumeToast();
}

const VOLUMES = [100, 75, 50, 25];

function volumeEntries(): MenuEntry[] {
  const current = volumePercent();
  return [
    { kind: 'label', label: video.muted ? 'Muted' : `Volume ${current}%` },
    { kind: 'checkbox', label: 'Mute', checked: video.muted, run: toggleMute },
    { kind: 'divider' },
    ...VOLUMES.map((level): MenuEntry => ({
      kind: 'radio',
      label: `${level}%`,
      checked: !video.muted && current === level,
      run: () => setVolume(level / 100),
    })),
  ];
}

function toggleLoop(): void {
  video.loop = !video.loop;
  // Persisted, not session-only: someone who loops one clip is looking at a
  // folder of them, and a per-tab toggle would have to be set again each time.
  vscode.postMessage({ type: 'updateSetting', key: 'video.loop', value: video.loop });
  toast(video.loop ? 'Looping' : 'Looping off');
}

function toggleAutoplay(): void {
  autoplay = !autoplay;
  // Persisted like Loop, and for the next video opened: flipping it mid-clip
  // neither starts nor stops the one the reader is watching.
  vscode.postMessage({ type: 'updateSetting', key: 'video.autoplay', value: autoplay });
  toast(autoplay ? 'Autoplay on' : 'Autoplay off');
}

function togglePlay(): void {
  if (video.paused) {
    void video.play().catch(() => undefined);
  } else {
    video.pause();
  }
}

// ---------------------------------------------------------------------------
// Control bar
// ---------------------------------------------------------------------------
// The native controls are off: the <video> element's bar cannot be extended, and
// the speaker belongs next to Play. This bar replaces it, left to right: play, the
// speaker, the time, the seek slider and fullscreen. It stays hidden with the stage
// (before metadata, on an error) and under review mode, whose transport takes over.
const PLAY_PATHS = ['M7 4.5v15l12-7.5z'];
const PAUSE_PATHS = ['M7 5h3v14H7z', 'M14 5h3v14h-3z'];
const FULLSCREEN_PATHS = ['M4 9V4h5', 'M15 4h5v5', 'M20 15v5h-5', 'M9 20H4v-5'];
const EXIT_FULLSCREEN_PATHS = ['M9 4v5H4', 'M20 9h-5V4', 'M15 20v-5h5', 'M4 15h5v5'];

/**
 * Run `action` when the button is pressed, and after a pointer click let go of
 * focus. A button that kept it would take the next Space as a press of itself
 * instead of playing and pausing; a keyboard press (`detail` 0) keeps focus where
 * the reader put it.
 */
function onPress(button: HTMLButtonElement, action: () => void): void {
  button.addEventListener('click', (e) => {
    action();
    if (e.detail > 0) {
      button.blur();
    }
  });
}

const controlBar = document.createElement('div');
controlBar.id = 'mc-controls';
controlBar.hidden = true;
controlBar.setAttribute('role', 'toolbar');
controlBar.setAttribute('aria-label', 'Video controls');
const playBtn = document.createElement('button');
playBtn.type = 'button';
playBtn.className = 'mc-video-ctl';
const timeEl = document.createElement('span');
timeEl.className = 'mc-video-time';
const seekSlider = document.createElement('input');
seekSlider.type = 'range';
seekSlider.className = 'mc-video-seek';
seekSlider.min = '0';
seekSlider.max = '0';
seekSlider.step = 'any';
seekSlider.value = '0';
seekSlider.disabled = true;
seekSlider.setAttribute('aria-label', 'Seek');
const fullscreenBtn = document.createElement('button');
fullscreenBtn.type = 'button';
fullscreenBtn.className = 'mc-video-ctl';
controlBar.append(playBtn, volumeBox, timeEl, seekSlider, fullscreenBtn);
document.body.insertBefore(controlBar, statusEl);

// True while the reader drags the seek slider, so a `timeupdate` does not pull the
// thumb back out from under the pointer.
let scrubbing = false;

function refreshPlay(): void {
  const playing = !video.paused && !video.ended;
  const label = playing ? 'Pause (space)' : 'Play (space)';
  playBtn.replaceChildren(svgIcon(playing ? PAUSE_PATHS : PLAY_PATHS, true));
  playBtn.title = label;
  playBtn.setAttribute('aria-label', label);
}

function refreshTime(): void {
  const known = Number.isFinite(video.duration) && video.duration > 0;
  const text = positionReadout(video.currentTime, video.duration);
  timeEl.textContent = text;
  seekSlider.max = known ? String(video.duration) : '0';
  seekSlider.disabled = !known;
  if (!scrubbing) {
    seekSlider.value = String(video.currentTime);
  }
  seekSlider.setAttribute('aria-valuetext', text);
}

/** Fullscreen the whole page, not the <video>: the control bar has to come along. */
function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void Promise.resolve(document.exitFullscreen?.()).catch(() => undefined);
  } else {
    void Promise.resolve(document.documentElement.requestFullscreen?.()).catch(() => undefined);
  }
}

function refreshFullscreen(): void {
  const on = Boolean(document.fullscreenElement);
  // The status line steps aside in fullscreen, and the layout follows this class.
  document.body.classList.toggle('mc-fullscreen', on);
  const label = on ? 'Exit full screen (f)' : 'Full screen (f)';
  fullscreenBtn.replaceChildren(svgIcon(on ? EXIT_FULLSCREEN_PATHS : FULLSCREEN_PATHS));
  fullscreenBtn.title = label;
  fullscreenBtn.setAttribute('aria-label', label);
}

onPress(playBtn, togglePlay);
onPress(fullscreenBtn, toggleFullscreen);
for (const name of ['play', 'pause', 'ended']) {
  video.addEventListener(name, refreshPlay);
}
for (const name of ['timeupdate', 'seeked', 'durationchange', 'loadedmetadata']) {
  video.addEventListener(name, refreshTime);
}
document.addEventListener('fullscreenchange', refreshFullscreen);
seekSlider.addEventListener('pointerdown', () => (scrubbing = true));
const endScrub = (): void => {
  scrubbing = false;
  refreshTime();
};
seekSlider.addEventListener('pointerup', endScrub);
seekSlider.addEventListener('pointercancel', endScrub);
seekSlider.addEventListener('input', () => {
  const time = Number(seekSlider.value);
  if (Number.isFinite(time)) {
    video.currentTime = time;
    timeEl.textContent = positionReadout(time, video.duration);
  }
});
refreshPlay();
refreshTime();
refreshFullscreen();

const review = createReview({
  video,
  stage,
  // Review mode moves the speaker into its transport beside play, and back.
  volume: volumeBox,
  post: (msg) => vscode.postMessage(msg),
  toast,
  viewState: { get: () => vscode.getState(), set: (value) => vscode.setState(value) },
});

function nudge(seconds: number): void {
  if (!Number.isFinite(video.duration)) {
    return;
  }
  video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), video.duration);
}

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
  // Only the picture itself is a play/pause target: the control bar is outside
  // the stage and has its own buttons.
  // In review mode a press on the picture places a pin instead.
  if (e.target === video && !review.onPicture(e)) {
    togglePlay();
  }
});

// The wheel over the picture sets the level, as in most desktop players: 5% a
// notch on a mouse, finer on a touchpad, whose deltas are smaller. There is
// nothing to scroll in the stage, so the wheel has no other job here.
// The same holds over the speaker and its slider.
function onVolumeWheel(e: WheelEvent): void {
  if (e.ctrlKey || e.deltaY === 0) {
    return;
  }
  e.preventDefault();
  const pixels = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 33 : e.deltaY;
  setVolume(video.volume - (pixels / 100) * 0.05);
}
stage.addEventListener(
  'wheel',
  (e) => {
    if (e.target === video) {
      onVolumeWheel(e);
    }
  },
  { passive: false },
);
volumeBox.addEventListener('wheel', onVolumeWheel, { passive: false });

document.addEventListener('keydown', (e) => {
  if (contextMenu.isOpen() || e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) {
    return;
  }
  // A focused slider takes the arrows itself (the level, or the position), and
  // review mode's Left and Right frame step or our own Up and Down volume would
  // otherwise ride along with them.
  if ((e.target === volumeSlider || e.target === seekSlider) && e.key.startsWith('Arrow')) {
    return;
  }
  // Review mode adds Left and Right, J K L, and steps `,` and `.` at the real
  // frame rate; everything else falls through to the keys below.
  if (review.onKeydown(e)) {
    return;
  }
  switch (e.key) {
    case ' ': {
      // A focused button takes Space as a press of itself, and toggling here as
      // well would double it (the speaker would mute and the video play at once).
      // Everything else, the picture and the sliders included, has no use for
      // Space, so it plays and pauses. Buttons let go of focus after a pointer
      // click (see `onPress`), so the key keeps working after the mouse.
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'BUTTON') {
        break;
      }
      e.preventDefault();
      togglePlay();
      break;
    }
    case ',':
      // A frame-ish step at 30fps, for lining up a frame grab.
      nudge(-1 / 30);
      break;
    case '.':
      nudge(1 / 30);
      break;
    case 'm':
      toggleMute();
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
      // Five seconds, as in the audio player. Review mode has taken these keys
      // for its frame step above, so this is the plain player only.
      e.preventDefault();
      nudge(e.key === 'ArrowRight' ? 5 : -5);
      break;
    case 'ArrowUp':
    case 'ArrowDown':
      // Prevented so the page does not scroll or move a focused control with it.
      e.preventDefault();
      setVolume(video.volume + (e.key === 'ArrowUp' ? 0.1 : -0.1));
      break;
    case 'f':
      toggleFullscreen();
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

  // Once the CORS retry has run, the canvas is tainted for the rest of this
  // file's life and no frame will ever come off it. Say so on the rows
  // themselves rather than letting each attempt fail into the same toast.
  const entries: MenuEntry[] = [
    ...(frameCopyBlocked
      ? [{ kind: 'label', label: 'Frames unavailable for this file' } as MenuEntry]
      : []),
    {
      kind: 'item',
      label: 'Copy Frame as PNG',
      run: () => void copyFramePng(),
      disabled: frameCopyBlocked,
    },
    {
      kind: 'item',
      label: 'Save Frame as PNG…',
      run: () => void saveFramePng(),
      disabled: frameCopyBlocked,
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
      entries: [
        { kind: 'checkbox', label: 'Loop', checked: video.loop, run: toggleLoop },
        { kind: 'checkbox', label: 'Autoplay', checked: autoplay, run: toggleAutoplay },
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
    { kind: 'submenu', label: 'Volume', entries: volumeEntries() },
    { kind: 'divider' },
    ...review.menuEntries(),
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
  if (!fromHost(event)) {
    return;
  }
  const msg = event.data as
    | LoadMessage
    | ProxyMessage
    | { type: 'error'; message: string }
    | { type: 'setTheme'; value: string }
    | { type: 'toast'; message: string };
  if (!msg || review.onMessage(msg)) {
    return;
  }
  if (msg.type === 'load') {
    load(msg);
  } else if (msg.type === 'proxy') {
    onProxyMessage(msg);
  } else if (msg.type === 'error') {
    showOverlay(msg.message, [openExternalAction()]);
  } else if (msg.type === 'setTheme') {
    applyTheme(msg.value);
  } else if (msg.type === 'toast') {
    toast(msg.message);
  }
});

vscode.postMessage({ type: 'ready' });
