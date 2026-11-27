// Auto-scroll puck, loop and keys, shared by the PDF viewer (pdf.ts) and the
// Markdown preview (main.ts). A corner puck (play/pause, small - and +) glides
// the scroller at a signed speed in CSS pixels per second. The loop is
// requestAnimationFrame with time-based motion and owns a float position between
// frames. Anything that moves the view by hand (wheel, keys, a zoom, a jump, a
// drag) is adopted rather than fought, and the loop never writes anything but
// scrollTop. The arithmetic is in autoScrollMath.ts.
//
// Speed and puck size live in the webview's own state (getState/setState),
// validated on read. The host page supplies the few things that differ between
// surfaces: which element scrolls, when to hold still, and what to do on a stop.
import type { MenuController } from './menu';
import {
  HOLD_DELAY_MS,
  HOLD_INTERVAL_MS,
  SIZES,
  SPEED_STEP,
  advanceFrame,
  canHoldStep,
  describeSpeed,
  parseSettings,
  speedLabels,
  startingSpeed,
  stepSpeed,
} from './autoScrollMath';

export interface AutoScrollHost {
  /** The element whose scrollTop moves. Read every frame, so it may change. */
  scroller(): HTMLElement;
  getState(): unknown;
  setState(state: unknown): void;
  contextMenu: MenuController;
  /** Reaches a screen reader after the puck hides (a persistent live region). */
  announce(text: string): void;
  /** A brief visible message. */
  toast(text: string): void;
  /**
   * True while the scroll position is only transient (a document being rebuilt,
   * a hand drag): the loop holds still and keeps its position current.
   */
  isHeld?(): boolean;
  /** False when there is nothing to scroll yet, so Start does nothing. */
  canStart?(): boolean;
  /** Auto-scroll just switched off (by the reader, or by reaching an end). */
  onStopped?(): void;
}

export interface AutoScroll {
  isOn(): boolean;
  start(): void;
  stop(message: string): void;
  toggle(): void;
  /** Handle a key while on; returns whether it was taken. */
  key(e: KeyboardEvent): boolean;
  /** Carry on from wherever the view is now (after a rebuild put it back). */
  resync(): void;
  /**
   * The bookkeeping a host needs to tell a key's scroll from the loop's own:
   * where the loop last put the view, how many frames adopted a move the loop did
   * not make, and how many writes the loop has made.
   */
  readonly wroteTop: number | null;
  readonly adoptedMoves: number;
  readonly writes: number;
}

const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />',
  pause:
    '<rect x="6.5" y="5" width="3.8" height="14" rx="1" fill="currentColor" stroke="none" />' +
    '<rect x="13.7" y="5" width="3.8" height="14" rx="1" fill="currentColor" stroke="none" />',
  minus: '<path d="M5 12h14" />',
  plus: '<path d="M5 12h14" /><path d="M12 5v14" />',
  toggle:
    '<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 8v8" /><path d="M9 13l3 3 3-3" />',
} as const;

// Inline currentColor icons: they follow the button's foreground in every theme
// and carry no meaning of their own for a screen reader (every button has an
// aria-label).
export function autoScrollIcon(name: keyof typeof ICONS, size: number): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
    `focusable="false">${ICONS[name]}</svg>`
  );
}

/**
 * A persistent live region outside the puck, so a message still reaches a screen
 * reader after the puck hides itself. The toast div is hidden when idle, which
 * makes it a poor live region, so this is a separate node always in the page.
 */
export function createAnnouncer(): (text: string) => void {
  const statusEl = document.createElement('div');
  statusEl.id = 'mc-status';
  statusEl.className = 'mc-sr-only';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(statusEl);
  let timer = 0;
  return (text) => {
    // Clear first so repeating the same text is announced again.
    statusEl.textContent = '';
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      statusEl.textContent = text;
    }, 30);
  };
}

export function createAutoScroll(host: AutoScrollHost): AutoScroll {
  const readState = (): Record<string, unknown> => {
    const raw = host.getState();
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  };
  let settings = parseSettings(readState().autoScroll);
  let on = false;
  let paused = false;
  let raf = 0;
  let last = 0;
  let pos = 0;
  let holdTimer = 0;
  let puck: HTMLDivElement | null = null;
  // Where the loop last put the view, so a key pressed while it runs is not
  // mistaken for the reader scrolling.
  let wroteTop: number | null = null;
  // Frames that found the view somewhere the loop did not put it (a key such as
  // Home moved it) and carried on from there. Such a move is the reader's even
  // though the loop's next write puts the view back at wroteTop.
  let adoptedMoves = 0;
  // The loop's own writes. A key is only taken for the loop's movement if the
  // loop actually moved the view after it: while paused it writes nothing.
  let writes = 0;

  const saveSettings = (): void => {
    host.setState({ ...readState(), autoScroll: settings });
  };

  const announceInPuck = (text: string): void => {
    const status = puck?.querySelector('.mc-as-status');
    if (status) {
      // Clear first so repeating the same text is announced again.
      status.textContent = '';
      window.setTimeout(() => {
        status.textContent = text;
      }, 30);
    }
  };

  const stopHold = (): void => {
    window.clearTimeout(holdTimer);
    holdTimer = 0;
  };

  // Reflect the speed, the paused state and the size in the puck and the toggle.
  const applyUi = (): void => {
    document.getElementById('mc-autoscroll-toggle')?.setAttribute('aria-pressed', String(on));
    if (!puck) {
      return;
    }
    puck.hidden = !on;
    puck.dataset.size = String(settings.size);
    const { speed } = settings;
    const labels = speedLabels(speed);
    const set = (as: string, label: string, title: string, icon: keyof typeof ICONS) => {
      const btn = puck?.querySelector<HTMLButtonElement>(`[data-as="${as}"]`);
      if (!btn) {
        return;
      }
      btn.setAttribute('aria-label', label);
      btn.title = title;
      btn.innerHTML = autoScrollIcon(icon, as === 'play' ? 40 : 28);
      return btn;
    };
    // The direction has no button of its own: the play name carries it, and each
    // speed announcement says it too.
    const playLabel = `${paused ? 'Play' : 'Pause'} (scrolling ${speed < 0 ? 'up' : 'down'})`;
    set('play', playLabel, `${playLabel} (Space). Right-click for size`, paused ? 'play' : 'pause');
    const minus = set('minus', labels.minus, `${labels.minus} (Down arrow or -)`, 'minus');
    const plus = set('plus', labels.plus, `${labels.plus} (Up arrow or +)`, 'plus');
    // Each disables only at full speed in its own direction.
    if (minus) minus.disabled = stepSpeed(speed, 1 / SPEED_STEP) === speed;
    if (plus) plus.disabled = stepSpeed(speed, SPEED_STEP) === speed;
  };

  const setSpeed = (speed: number): void => {
    settings = { ...settings, speed };
    saveSettings();
    applyUi();
    announceInPuck(`Auto-scroll speed ${describeSpeed(speed)}`);
  };
  const adjustSpeed = (factor: number): void => setSpeed(stepSpeed(settings.speed, factor));

  const togglePause = (): void => {
    paused = !paused;
    applyUi();
    announceInPuck(paused ? 'Auto-scroll paused' : 'Auto-scroll playing');
  };

  const buildPuck = (): HTMLDivElement => {
    const el = document.createElement('div');
    el.id = 'mc-autoscroll';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Auto-scroll controls');
    el.hidden = true;
    el.innerHTML =
      '<button type="button" class="mc-as-btn mc-as-play" data-as="play"></button>' +
      '<div class="mc-as-row">' +
      '<button type="button" class="mc-as-btn mc-as-small" data-as="minus"></button>' +
      '<button type="button" class="mc-as-btn mc-as-small" data-as="plus"></button>' +
      '</div>' +
      '<span class="mc-as-status" role="status" aria-live="polite"></span>';
    let keyRepeating = false;
    el.addEventListener('click', (e) => {
      const which = (e.target as HTMLElement).closest<HTMLElement>('[data-as]')?.dataset.as;
      // A mouse or touch press already stepped on pointerdown; the click that
      // follows has a detail count. A keyboard click (detail 0) steps here.
      if (which === 'play') togglePause();
      else if ((which === 'minus' || which === 'plus') && e.detail === 0) {
        const factor = which === 'plus' ? SPEED_STEP : 1 / SPEED_STEP;
        // A held Enter sends a keyboard click per repeat: like a held key or
        // press it stops at the slowest speed, while a fresh press may reverse.
        if (!keyRepeating || canHoldStep(settings.speed, factor)) {
          adjustSpeed(factor);
        }
      }
    });
    el.addEventListener('keydown', (e) => {
      keyRepeating = e.repeat;
    });
    el.addEventListener('keyup', () => {
      keyRepeating = false;
    });
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-as]');
      const which = btn?.dataset.as;
      if (!btn || e.button !== 0 || (which !== 'minus' && which !== 'plus') || btn.disabled) {
        return;
      }
      const factor = which === 'plus' ? SPEED_STEP : 1 / SPEED_STEP;
      stopHold();
      // Keep receiving pointerup even if the pointer drifts off the button.
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      adjustSpeed(factor);
      // Once on the press, again after the delay, then at the interval. A held
      // press stops at the slowest speed rather than reversing.
      const tick = (delay: number): void => {
        holdTimer = window.setTimeout(() => {
          if (on && canHoldStep(settings.speed, factor)) {
            adjustSpeed(factor);
            tick(HOLD_INTERVAL_MS);
          } else {
            stopHold();
          }
        }, delay);
      };
      tick(HOLD_DELAY_MS);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      el.addEventListener(type, stopHold);
    }
    // Right-click (or Shift+F10 / the Menu key) on the puck picks its size.
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      let { pageX: x, pageY: y } = e;
      if (e.clientX === 0 && e.clientY === 0) {
        const box = (e.target as Element).getBoundingClientRect();
        x = box.left + window.scrollX;
        y = box.top + window.scrollY;
      }
      host.contextMenu.show(
        x,
        y,
        SIZES.map((size, i) => ({
          kind: 'radio' as const,
          label: size.label,
          checked: settings.size === i,
          run: () => {
            settings = { ...settings, size: i };
            saveSettings();
            applyUi();
            announceInPuck(`Auto-scroll controls ${size.label}`);
          },
        })),
      );
    });
    document.body.appendChild(el);
    return el;
  };

  const frame = (ts: number): void => {
    raf = 0;
    if (!on) {
      return;
    }
    const dt = last ? (ts - last) / 1000 : 0;
    last = ts;
    const s = host.scroller();
    const maxTop = s.scrollHeight - s.clientHeight;
    if (paused || host.isHeld?.()) {
      // Hold still (paused, a drag is moving the view, or the content is being
      // rebuilt and the scroll position is only transient) but keep the position
      // current so resuming continues from wherever the view is. A move made
      // meanwhile was seen here, so resuming must not count it as a new one.
      pos = s.scrollTop;
      wroteTop = s.scrollTop;
    } else {
      if (wroteTop !== null && Math.abs(s.scrollTop - wroteTop) > 0.5) {
        adoptedMoves++;
      }
      const result = advanceFrame({
        pos,
        scrollTop: s.scrollTop,
        speed: settings.speed,
        dt,
        maxTop,
      });
      pos = result.pos;
      if (Math.abs(s.scrollTop - pos) > 0.01) {
        s.scrollTop = pos;
        // Read back, since the browser may round the offset it was given.
        wroteTop = s.scrollTop;
        writes++;
      }
      if (result.edge) {
        stop(result.edge === 'end' ? 'Auto-scroll reached the end' : 'Auto-scroll reached the top');
        return;
      }
    }
    raf = requestAnimationFrame(frame);
  };

  function start(): void {
    if (on || host.canStart?.() === false) {
      return;
    }
    puck ??= buildPuck();
    const s = host.scroller();
    settings = {
      ...settings,
      speed: startingSpeed(settings.speed, s.scrollTop, s.scrollHeight - s.clientHeight),
    };
    on = true;
    paused = false;
    pos = s.scrollTop;
    // Start from where the view is: a position written by an earlier run is stale.
    wroteTop = s.scrollTop;
    last = 0;
    applyUi();
    announceInPuck(`Auto-scroll on, ${describeSpeed(settings.speed)}`);
    raf = requestAnimationFrame(frame);
  }

  function stop(message: string): void {
    if (!on) {
      return;
    }
    on = false;
    cancelAnimationFrame(raf);
    raf = 0;
    stopHold();
    saveSettings();
    applyUi();
    // The puck is hidden now, so its own live region would not be read; the
    // persistent status region carries the message, and the toast shows it.
    host.announce(message);
    host.toast(message);
    host.onStopped?.();
  }

  // Keys while on: Space pauses and resumes, the arrows and + / - step the speed.
  // Fields, open menus and modifier chords (Ctrl +/- is zoom) are left alone, and
  // Space on a focused button is that button's own click.
  function key(e: KeyboardEvent): boolean {
    if (!on || e.ctrlKey || e.metaKey || e.altKey || host.contextMenu.isOpen()) {
      return false;
    }
    const el = e.target as Element | null;
    if (el?.closest('input, textarea, select, [contenteditable="true"], [role="menu"]')) {
      return false;
    }
    if (e.key === ' ' && !el?.closest('button, a, [role="button"]')) {
      e.preventDefault();
      // Holding Space repeats keydown: only the first press toggles.
      if (!e.repeat) {
        togglePause();
      }
      return true;
    }
    // A held key repeats, and like a held button it stops at the slowest speed
    // instead of passing through zero into the other direction; a fresh press
    // may reverse.
    const step = (factor: number): void => {
      if (!e.repeat || canHoldStep(settings.speed, factor)) {
        adjustSpeed(factor);
      }
    };
    if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') {
      e.preventDefault();
      step(SPEED_STEP);
      return true;
    }
    if (e.key === 'ArrowDown' || e.key === '-' || e.key === '_') {
      e.preventDefault();
      step(1 / SPEED_STEP);
      return true;
    }
    return false;
  }

  return {
    isOn: () => on,
    start,
    stop,
    toggle: () => (on ? stop('Auto-scroll off') : start()),
    key,
    resync: () => {
      pos = host.scroller().scrollTop;
      last = 0;
    },
    get wroteTop() {
      return wroteTop;
    },
    get adoptedMoves() {
      return adoptedMoves;
    },
    get writes() {
      return writes;
    },
  };
}
