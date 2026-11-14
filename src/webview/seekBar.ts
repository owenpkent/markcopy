// Shared behaviour for the video seek sliders: the viewer's control bar
// (src/webview/video.ts) and the review scrubber (src/webview/videoReview.ts).
//
// - A press on the slider pauses playback, and it stays paused after the drag,
//   so the reader lands on the frame they let go on instead of watching it run on.
//   The audio player opts out: there the sound following the drag is the point.
// - The played part of the track is filled: `--mc-seek-frac` (0 to 1) on the
//   slider, which each bar's CSS turns into a gradient stop at the thumb's centre.
// - Hovering shows the time under the pointer in a small tip above the bar.

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
}

/** Wire the pause-on-press and hover tip onto a seek slider. */
export function attachSeekBar(opts: SeekBarOptions): void {
  const { slider, media, thumb } = opts;
  const tip = document.createElement('div');
  tip.className = 'mc-seek-tip';
  tip.setAttribute('aria-hidden', 'true');
  tip.hidden = true;
  // On the body, fixed: inside a bar it would count among the bar's controls.
  document.body.append(tip);
  let dragging = false;

  function show(clientX: number, seconds: number): void {
    tip.textContent = opts.format(seconds);
    tip.hidden = false;
    const half = tip.offsetWidth / 2;
    const room = document.documentElement.clientWidth;
    const left = room > 0 ? Math.min(Math.max(clientX, half), room - half) : clientX;
    tip.style.left = `${left}px`;
    tip.style.top = `${slider.getBoundingClientRect().top}px`;
  }

  function fromPointer(e: PointerEvent): void {
    const dur = opts.duration();
    if (slider.disabled || !(dur > 0)) {
      tip.hidden = true;
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
      tip.hidden = true;
    }
  };
  slider.addEventListener('pointercancel', end);
  document.addEventListener('pointerup', end);
  slider.addEventListener('pointermove', fromPointer);
  slider.addEventListener('pointerenter', fromPointer);
  slider.addEventListener('pointerleave', () => {
    if (!dragging) {
      tip.hidden = true;
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
