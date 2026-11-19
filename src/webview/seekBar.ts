// Shared behaviour for the video seek sliders: the viewer's control bar
// (src/webview/video.ts) and the review scrubber (src/webview/videoReview.ts).
//
// - A press on the slider pauses playback, and it stays paused after the drag,
//   so the reader lands on the frame they let go on instead of watching it run on.
//   The audio player opts out: there the sound following the drag is the point.
// - The played part of the track is filled: `--mc-seek-frac` (0 to 1) on the
//   slider, which each bar's CSS turns into a gradient stop at the thumb's centre.
// - Hovering shows the time under the pointer in a small tip above the bar, and
//   on a video, the frame at that time over it (a second, muted <video> of the
//   same source seeks there and is drawn to a canvas, so the playing picture is
//   never disturbed).

/** Where a pointer at `x` falls on a range input, 0 to 1, given its thumb width. */
export function seekFraction(x: number, left: number, width: number, thumb: number): number {
  const travel = width - thumb;
  if (!(travel > 0)) {
    return 0;
  }
  return Math.min(1, Math.max(0, (x - left - thumb / 2) / travel));
}

/** Publish how far along the slider is, for the CSS fill. */
export function setSeekFill(slider: HTMLInputElement, time: number, duration: number): void {
  const frac =
    duration > 0 && Number.isFinite(time) ? Math.min(1, Math.max(0, time / duration)) : 0;
  slider.style.setProperty('--mc-seek-frac', String(frac));
}

/** What a press needs of the player: an <audio> or <video>, or the GIF viewer's own. */
export interface Pausable {
  readonly paused: boolean;
  readonly ended?: boolean;
  pause(): void;
}

export interface SeekBarOptions {
  slider: HTMLInputElement;
  media: Pausable;
  /** The thumb's width in px, which sets where the slider's values start and end. */
  thumb: number;
  duration: () => number;
  /** A time as this bar shows it. */
  format: (seconds: number) => string;
  /** Called before a press pauses playback, so the caller can drop pending resumes. */
  onPause?: () => void;
  /** Whether a press pauses. Audio keeps playing, so the reader hears the drag. */
  pauseOnPress?: boolean;
  /** The source to draw hover frames from (a video's `currentSrc`); '' for none. */
  frames?: () => string;
}

/** The box a hover frame fits in, in CSS px. */
const FRAME_WIDTH = 160;
const FRAME_HEIGHT = 90;

/** A hover frame's size in CSS px for a picture of `w` by `h`: within 160 by 90. */
export function frameSize(w: number, h: number): { width: number; height: number } {
  if (!(w > 0) || !(h > 0)) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(FRAME_WIDTH / w, FRAME_HEIGHT / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

export interface FramePeek {
  readonly canvas: HTMLCanvasElement;
  /** Draw the frame at `seconds` when it is ready; a newer request replaces it. */
  request(seconds: number): void;
  /** Blank the canvas, so the next hover does not open on a stale frame. */
  clear(): void;
}

/**
 * Frames for the hover tip, off a hidden video of the same source. One seek is in
 * flight at a time and only the latest wanted time is kept, so a fast sweep over
 * the bar costs a seek per frame drawn rather than one per pointer event.
 */
export function createFramePeek(
  source: () => string,
  onDraw: () => void,
  make: () => HTMLVideoElement = () => document.createElement('video'),
): FramePeek {
  const canvas = document.createElement('canvas');
  canvas.className = 'mc-seek-frame';
  canvas.hidden = true;
  let peek: HTMLVideoElement | undefined;
  let src = '';
  let failed = false;
  let busy = false;
  let want: number | undefined;

  function draw(): void {
    if (!peek || peek.readyState < 2) {
      return;
    }
    const { width, height } = frameSize(peek.videoWidth, peek.videoHeight);
    const ctx = width > 0 ? canvas.getContext('2d') : null;
    if (!ctx) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(width * dpr);
    const ph = Math.round(height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.drawImage(peek, 0, 0, pw, ph);
    canvas.hidden = false;
    onDraw();
  }

  function pump(): void {
    if (!peek || busy || want === undefined || peek.readyState < 1) {
      return;
    }
    const t = want;
    want = undefined;
    if (Math.abs(peek.currentTime - t) < 0.001 && peek.readyState >= 2) {
      draw();
      return;
    }
    busy = true;
    peek.currentTime = t;
  }

  function open(next: string): void {
    if (!peek) {
      peek = make();
      peek.muted = true;
      peek.preload = 'metadata';
      peek.setAttribute('playsinline', '');
      peek.addEventListener('loadedmetadata', pump);
      peek.addEventListener('seeked', () => {
        busy = false;
        draw();
        pump();
      });
      // No frames for a source the page cannot decode: the tip keeps its time.
      peek.addEventListener('error', () => {
        failed = true;
        busy = false;
        want = undefined;
        canvas.hidden = true;
      });
    }
    src = next;
    failed = false;
    busy = false;
    canvas.hidden = true;
    peek.src = next;
  }

  return {
    canvas,
    request(seconds) {
      const next = source();
      if (!next || !Number.isFinite(seconds)) {
        canvas.hidden = true;
        return;
      }
      // A proxy or sound copy replacing the file brings a new source.
      if (next !== src) {
        open(next);
      }
      if (failed) {
        return;
      }
      want = Math.max(0, seconds);
      pump();
    },
    clear() {
      want = undefined;
      canvas.hidden = true;
    },
  };
}

/** Wire the pause-on-press and hover tip onto a seek slider. */
export function attachSeekBar(opts: SeekBarOptions): void {
  const { slider, media, thumb } = opts;
  const tip = document.createElement('div');
  tip.className = 'mc-seek-tip';
  tip.setAttribute('aria-hidden', 'true');
  tip.hidden = true;
  const label = document.createElement('span');
  label.className = 'mc-seek-time';
  // Place again once a frame lands: the tip is wider then, and must stay in the pane.
  const peek = opts.frames ? createFramePeek(opts.frames, () => place()) : undefined;
  if (peek) {
    tip.append(peek.canvas);
  }
  tip.append(label);
  // On the body, fixed: inside a bar it would count among the bar's controls.
  document.body.append(tip);
  let dragging = false;
  let lastX = 0;

  function place(): void {
    if (tip.hidden) {
      return;
    }
    tip.classList.toggle('mc-seek-tip-frame', peek !== undefined && !peek.canvas.hidden);
    const half = tip.offsetWidth / 2;
    const room = document.documentElement.clientWidth;
    const left = room > 0 ? Math.min(Math.max(lastX, half), room - half) : lastX;
    tip.style.left = `${left}px`;
    tip.style.top = `${slider.getBoundingClientRect().top}px`;
  }

  function show(clientX: number, seconds: number): void {
    label.textContent = opts.format(seconds);
    tip.hidden = false;
    lastX = clientX;
    peek?.request(seconds);
    place();
  }

  function hide(): void {
    tip.hidden = true;
    peek?.clear();
  }

  function fromPointer(e: PointerEvent): void {
    const dur = opts.duration();
    if (slider.disabled || !(dur > 0)) {
      hide();
      return;
    }
    const rect = slider.getBoundingClientRect();
    const frac = seekFraction(e.clientX, rect.left, rect.width, thumb);
    // While dragging, the tip names where the thumb is, not where the pointer has
    // strayed past either end.
    slider.style.setProperty('--mc-seek-hover', String(frac));
    const seconds = dragging ? Number(slider.value) : frac * dur;
    const x = dragging ? rect.left + thumb / 2 + (rect.width - thumb) * (seconds / dur) : e.clientX;
    show(x, seconds);
  }

  slider.addEventListener('pointerdown', (e) => {
    if (e.button > 0) {
      return;
    }
    dragging = true;
    slider.classList.add('mc-seek-active');
    if (opts.pauseOnPress !== false && !media.paused && !media.ended) {
      opts.onPause?.();
      media.pause();
    }
  });
  // Let go over the bar, the tip stays for the hover; let go off it, it goes. The
  // document hears a release the slider may not, when the pointer left it mid-drag.
  const end = (e: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    slider.classList.remove('mc-seek-active');
    const r = slider.getBoundingClientRect();
    const over =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!over) {
      hide();
    }
  };
  slider.addEventListener('pointercancel', end);
  document.addEventListener('pointerup', end);
  slider.addEventListener('pointermove', fromPointer);
  slider.addEventListener('pointerenter', fromPointer);
  slider.addEventListener('pointerleave', () => {
    if (!dragging) {
      hide();
    }
  });
  slider.addEventListener('input', () => {
    if (dragging && !tip.hidden) {
      const dur = opts.duration();
      const seconds = Number(slider.value);
      if (dur > 0 && Number.isFinite(seconds)) {
        const rect = slider.getBoundingClientRect();
        show(rect.left + thumb / 2 + (rect.width - thumb) * (seconds / dur), seconds);
      }
    }
  });
}
