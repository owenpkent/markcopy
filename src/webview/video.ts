// Browser-side code for the video preview (media/video.js), the viewer behind
// src/videoEditor.ts.
//
// Unlike the PDF and STL previews, the file itself never travels through
// postMessage: a video is far too large to base64 into a JSON message, and it
// does not need to be. The <video> element is handed a webview-resource URI and
// streams the file straight off disk, seeking with range requests, so a 2 GB
// clip costs the same in memory as a 2 MB one.
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

// The notice sits where the <video> element draws its controls, so the stage
// gives up exactly the notice's height while it is up. Observed rather than
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
  src: string;
  name: string;
  path: string;
  size: number;
  autoplay: boolean;
  loop: boolean;
  /** Set when `src` is an ffmpeg-built copy rather than the file itself. */
  proxyNote?: string;
}

function load(msg: LoadMessage): void {
  fileName = msg.name;
  filePath = msg.path;
  fileBytes = msg.size;
  sourceUri = msg.src;
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
// it. The unmute is deferred a tick and re-checked: a click on the native mute
// button would otherwise be unmuted on pointerdown and then re-muted by the
// control itself. By the time the timeout runs the control's `volumechange` has
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

const review = createReview({
  video,
  stage,
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
  // Clicks on the native control bar are the browser's; only the picture itself
  // is a play/pause target.
  // In review mode a press on the picture places a pin instead.
  if (e.target === video && !review.onPicture(e)) {
    togglePlay();
  }
});

document.addEventListener('keydown', (e) => {
  if (contextMenu.isOpen() || e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) {
    return;
  }
  // Review mode adds Left and Right, J K L, and steps `,` and `.` at the real
  // frame rate; everything else falls through to the keys below.
  if (review.onKeydown(e)) {
    return;
  }
  switch (e.key) {
    case ' ': {
      // Space is the browser's whenever it has somewhere of its own to go: the
      // native controls bind it while the video element has focus (which a click
      // on the picture hands them), and a button takes it as a click. Toggling
      // on top of either would undo the first and double the second, so this
      // covers only the case nothing else does, which is also the common one:
      // the page itself holding focus.
      const target = e.target as HTMLElement | null;
      if (target === video || target?.tagName === 'BUTTON') {
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
