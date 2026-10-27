// Review mode for the video preview (see docs/VIDEO-REVIEW-DESIGN.md, phases 1 to 3).
//
// Called from src/webview/video.ts. Once the host sends its first `review`
// message the native controls give way to a transport, a scrubber carrying the
// notes as markers, and a notes panel with a composer at its foot. Everything here
// is a view of the host's sidecar: an edit is only ever a small message (add, done,
// delete, restore) and the page waits for the host's next `review` to show it.
//
// Layout and seek maths come from src/review/ (ports of Marker's timeline.js and
// timecode.js), so a timecode or a marker position matches what Marker shows.
import type {
  FpsSource,
  ReviewNote,
  ReviewStateMessage,
  ReviewWebviewMessage,
} from '../review/protocol';
import { positionTimecode, secondsToTimecode } from '../review/timecode';
import {
  DOT_HIT,
  bandGeometry,
  cycleTarget,
  fitRect,
  frameIndex,
  frameStartSeconds,
  layoutDots,
  pendingBand,
  pinVisible,
  pointInRect,
  seekMsForFrame,
  seekTarget,
  stepTarget,
  type DotRow,
} from '../review/timeline';
import type { MenuEntry } from './menu';

export interface ReviewDeps {
  video: HTMLVideoElement;
  /** The element holding the video; review mode moves it into its own layout. */
  stage: HTMLDivElement;
  /** Anything the host handles: review messages and `updateSetting`. */
  post(msg: ReviewWebviewMessage | { type: 'updateSetting'; key: string; value: unknown }): void;
  toast(text: string): void;
  /** The webview's saved state (vscode getState/setState), for the sort. */
  viewState?: { get(): unknown; set(value: unknown): void };
}

export interface ReviewController {
  /** Handle a host message; true when it was a review message. */
  onMessage(msg: { type: string }): boolean;
  /** Whether review mode is on screen. */
  active(): boolean;
  /** Step one frame (-1 or 1) at the real rate. */
  step(direction: number): void;
  /** Review-only shortcuts; true when the key was used. */
  onKeydown(e: KeyboardEvent): boolean;
  /**
   * A press on the picture. True when review mode took it (placing a pin, or
   * ignoring a press in the letterbox); false when the caller should toggle play.
   */
  onPicture(e: MouseEvent): boolean;
  /** "Open Video Notes" or "Close Video Notes", and the copy action, for the right-click menu. */
  menuEntries(): MenuEntry[];
}

// Playback rates the speed button walks, and the finer ladder J and L climb.
const SPEED_CYCLE = [0.5, 1, 2];
const SPEED_LADDER = [0.25, 0.5, 1, 1.5, 2];
// The panel's width, and the least the video is given before the panel drops below it.
const PANEL_W = 320;
const MIN_VIDEO_W = 400;

export type NoteSort = 'time' | 'newest';
const SORTS: NoteSort[] = ['time', 'newest'];
const SORT_NAME: Record<NoteSort, string> = { time: 'Time', newest: 'Newest' };
// The pin stud's size, which is also its hit target.
const PIN_SIZE = 44;

function noteNum(id: string): number {
  const digits = [...String(id)].filter((c) => c >= '0' && c <= '9').join('');
  return digits ? parseInt(digits, 10) : 0;
}

/** The notes in a sort's order (Newest: latest `created` first, ties by id number). */
export function arrangeNotes(notes: ReviewNote[], sort: NoteSort): ReviewNote[] {
  return [...notes].sort((a, b) =>
    sort === 'newest'
      ? (a.created < b.created ? 1 : a.created > b.created ? -1 : 0) ||
        noteNum(b.id) - noteNum(a.id)
      : a.at - b.at || noteNum(a.id) - noteNum(b.id),
  );
}

/** "29.97 fps", "30 fps (assumed)", or a placeholder while the host is still probing. */
export function fpsLabel(fps: number, source: FpsSource): string {
  if (source === 'pending') {
    return 'reading frame rate';
  }
  const rate = `${Number(fps.toFixed(3))} fps`;
  return source === 'assumed' ? `${rate} (assumed)` : rate;
}

/** Whether keys typed here belong to a text field, not to the player. */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) {
    return false;
  }
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) {
    return true;
  }
  if (el.tagName !== 'INPUT') {
    return false;
  }
  const type = (el as HTMLInputElement).type;
  return type !== 'range' && type !== 'checkbox' && type !== 'radio' && type !== 'button';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Simple 24-grid glyphs in MarkCopy's inline icon style (see pdf.ts, editMode.ts):
// 16px, stroked in currentColor, so they follow each button's colour in every theme.
const ICONS = {
  play: ['M7 4.5v15l12-7.5z'],
  pause: ['M7 5h3v14H7z', 'M14 5h3v14h-3z'],
  stepBack: ['M19 20L9 12l10-8z', 'M5 19V5'],
  stepForward: ['M5 4l10 8-10 8z', 'M19 5v14'],
  copy: ['M8 8h12v12H8z', 'M16 8V4H4v12h4'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  sort: ['M8 4v16', 'M4 16l4 4 4-4', 'M16 20V4', 'M12 8l4-4 4 4'],
  bracketIn: ['M14 4H9v16h5'],
  bracketOut: ['M10 4h5v16h-5'],
  send: ['M12 19V5', 'M5 12l7-7 7 7'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  pin: [
    'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z',
    'M12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  ],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
} satisfies Record<string, string[]>;
type IconName = keyof typeof ICONS;

function icon(name: IconName, filled = false): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** Put an icon and an optional label in a button, replacing what it held. */
function face(b: HTMLElement, name: IconName | null, text = '', filled = false): void {
  b.textContent = '';
  if (name) {
    b.appendChild(icon(name, filled));
  }
  if (text) {
    b.appendChild(el('span', 'mc-rv-lbl', text));
  }
}

function button(
  className: string,
  text: string,
  label: string,
  run: () => void,
): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.addEventListener('click', run);
  return b;
}

export function createReview(deps: ReviewDeps): ReviewController {
  const { video, stage, post, toast } = deps;

  let state: ReviewStateMessage | undefined;
  let isActive = false;
  // Set when the reader turns review off from the menu: later `review` messages
  // (a sidecar change, fps resolving) must not pull them back in.
  let turnedOff = false;
  let selected = '';
  // The range being set for the next note, in seconds; -1 while unset.
  let pendingIn = -1;
  let pendingOut = -1;
  // Whether playback was running when the note field took focus, so sending can
  // pick it up again. Any other press on the player drops it.
  let resumeAfterNote = false;
  // The pin being placed for the next note: [x, y] of the picture, or null.
  let pendingPoint: [number, number] | null = null;
  // Whether a press on the picture places the pin. Off, it plays and pauses as usual.
  let pinMode = false;
  // The draft handed to the host and not yet acknowledged. It stays in the
  // composer, locked, so a failed save can put it back untouched.
  let sending: {
    text: string;
    in: number;
    out: number;
    point: [number, number] | null;
    pin: boolean;
    resume: boolean;
  } | null = null;
  let sort: NoteSort = 'time';
  // The frame the pins were last drawn for, so playback redraws only on a new one.
  let pinFrame = -1;
  let ui: ReturnType<typeof build> | undefined;

  const saved = (deps.viewState?.get() as { review?: { sort?: unknown } } | undefined)?.review;
  if (saved && SORTS.includes(saved.sort as NoteSort)) {
    sort = saved.sort as NoteSort;
  }
  function saveView(): void {
    const prior = deps.viewState?.get();
    deps.viewState?.set({
      ...(prior && typeof prior === 'object' ? prior : {}),
      review: { sort },
    });
  }

  const fps = (): number => (state && state.fps > 0 ? state.fps : 30);
  const duration = (): number => (Number.isFinite(video.duration) ? video.duration : 0);

  // -------------------------------------------------------------------------
  // Seeking
  // -------------------------------------------------------------------------
  function seekMs(ms: number): void {
    const limit = duration();
    const seconds = ms / 1000;
    video.currentTime = Math.max(0, limit > 0 ? Math.min(seconds, limit) : seconds);
    updateTime();
  }

  /** Where a press on a note goes: half a frame into the frame the note names. */
  function noteSeekMs(note: ReviewNote): number {
    return seekMsForFrame(Math.floor(note.at * fps() + 0.5), fps());
  }

  function step(direction: number): void {
    if (!video.paused) {
      video.pause();
    }
    seekMs(stepTarget(video.currentTime * 1000, direction, fps(), duration()));
  }

  function setRate(rate: number): void {
    video.playbackRate = rate;
    updateTransport();
  }

  function nextCycleRate(): number {
    return SPEED_CYCLE.find((r) => r > video.playbackRate + 1e-6) ?? SPEED_CYCLE[0];
  }

  function ladderRate(direction: number): number {
    const now = video.playbackRate;
    const rates =
      direction > 0
        ? SPEED_LADDER.filter((r) => r > now + 1e-6)
        : [...SPEED_LADDER].reverse().filter((r) => r < now - 1e-6);
    return rates[0] ?? now;
  }

  function togglePlay(): void {
    // A deliberate play or pause while typing is the reader's call, not ours to undo.
    resumeAfterNote = false;
    if (video.paused) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }

  function select(id: string, seek: boolean): void {
    selected = id;
    const note = state?.notes.find((n) => n.id === id);
    if (note && seek) {
      seekMs(noteSeekMs(note));
    }
    renderSelection();
    renderMarkers();
    renderPins(true);
    // The list scrolls inside the panel; keep the selected card (and its Delete) in view.
    scrollCardIntoView(id);
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------
  function build() {
    const root = el('div', 'mc-rv');
    const main = el('div', 'mc-rv-main');

    const transport = el('div', 'mc-rv-transport');
    transport.setAttribute('role', 'group');
    transport.setAttribute('aria-label', 'Playback');
    const play = button('mc-rv-btn mc-rv-hero', '', 'Play', togglePlay);
    play.title = 'Play (Space)';
    face(play, 'play', '', true);
    const back = button('mc-rv-btn mc-rv-ghost', '', 'Back one frame', () => step(-1));
    back.title = 'Back one frame (Left)';
    face(back, 'stepBack');
    const forward = button('mc-rv-btn mc-rv-ghost', '', 'Forward one frame', () => step(1));
    forward.title = 'Forward one frame (Right)';
    face(forward, 'stepForward');
    const speed = button('mc-rv-btn mc-rv-pill', '1x', 'Playback speed', () =>
      setRate(nextCycleRate()),
    );
    speed.title = 'Playback speed (J, L)';
    const readout = el('span', 'mc-rv-time', positionTimecode(0, 30));
    readout.setAttribute('role', 'timer');
    const total = el('span', 'mc-rv-total');
    const rate = el('span', 'mc-rv-rate');
    transport.append(play, back, forward, speed, readout, total, rate);

    const timeline = el('div', 'mc-rv-timeline');
    const markers = el('div', 'mc-rv-markers');
    markers.setAttribute('role', 'group');
    markers.setAttribute('aria-label', 'Notes on the timeline');
    const bands = el('div', 'mc-rv-bands');
    bands.setAttribute('aria-hidden', 'true');
    const slider = el('input', 'mc-rv-slider');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '0';
    slider.step = 'any';
    slider.value = '0';
    slider.setAttribute('aria-label', 'Seek');
    slider.addEventListener('input', () => {
      seekMs(seekTarget(Number(slider.value) * 1000, fps(), duration()));
    });
    // The bands lie over the slider's own track, the full height of it.
    const track = el('div', 'mc-rv-track');
    track.append(slider, bands);
    timeline.append(markers, track);

    main.append(stage, transport, timeline);

    const panel = el('aside', 'mc-rv-panel');
    panel.setAttribute('aria-label', 'Review notes');
    const head = el('div', 'mc-rv-head');
    const count = el('h2', 'mc-rv-count');
    const sortBtn = button('mc-rv-btn mc-rv-ghost mc-rv-tool', '', 'Sort: Time', () => {
      sort = SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length];
      saveView();
      renderPanel();
    });
    face(sortBtn, 'sort', 'Time');
    const copy = button('mc-rv-btn mc-rv-key', '', 'Copy notes as Markdown', copyNotes);
    face(copy, 'copy', 'Copy as Markdown');
    const tools = el('div', 'mc-rv-tools');
    tools.append(sortBtn, copy);
    const close = button(
      'mc-rv-btn mc-rv-ghost mc-rv-tool mc-rv-close',
      '',
      'Close video notes',
      () => setReview(false),
    );
    close.title = 'Close video notes';
    face(close, 'close');
    const titleRow = el('div', 'mc-rv-titlerow');
    titleRow.append(count, close);
    head.append(titleRow, tools);
    const banner = el('div', 'mc-rv-banner');
    banner.setAttribute('role', 'status');
    banner.hidden = true;
    const list = el('div', 'mc-rv-list');
    const restore = button('mc-rv-btn mc-rv-tool', '', '', () => {
      if (state?.restorable) {
        post({ type: 'reviewRestore' });
      }
    });
    restore.hidden = true;

    const composer = el('div', 'mc-rv-composer');
    composer.setAttribute('role', 'group');
    composer.setAttribute('aria-label', 'Write a note');
    const fpsNote = el('p', 'mc-rv-fpsnote', 'Frame rate unknown: notes will be saved at 30 fps');
    fpsNote.hidden = true;
    const inBtn = button('mc-rv-btn mc-rv-key mc-rv-point', '', 'Set In to this frame', setIn);
    inBtn.title = 'Set In (I)';
    face(inBtn, 'bracketIn', 'In');
    const outBtn = button('mc-rv-btn mc-rv-key mc-rv-point', '', 'Set Out to this frame', setOut);
    outBtn.title = 'Set Out (O)';
    face(outBtn, 'bracketOut', 'Out');
    const pinBtn = button('mc-rv-btn mc-rv-key mc-rv-point', '', 'Pin a spot', () =>
      setPinMode(!pinMode),
    );
    pinBtn.title = 'Pin a spot (P)';
    face(pinBtn, 'pin', 'Pin');
    const chip = el('span', 'mc-rv-chip');
    chip.hidden = true;
    const clearBtn = button(
      'mc-rv-btn mc-rv-ghost mc-rv-quiet mc-rv-clear',
      '',
      'Clear range and pin',
      clearRange,
    );
    clearBtn.title = 'Clear range and pin';
    face(clearBtn, 'close');
    clearBtn.hidden = true;
    const cplay = button('mc-rv-btn mc-rv-ghost', '', 'Play', togglePlay);
    cplay.title = 'Play (Space)';
    face(cplay, 'play');
    const field = el('input', 'mc-rv-field');
    field.type = 'text';
    field.maxLength = 10000;
    field.placeholder = 'Write a note';
    field.setAttribute('aria-label', 'Note text');
    const send = button('mc-rv-btn mc-rv-key mc-rv-send', '', 'Add note', sendNote);
    face(send, 'send', 'Send');
    // A press on these must not take focus from the field, or its blur would drop
    // the pending resume.
    for (const b of [inBtn, outBtn, pinBtn, clearBtn, send]) {
      b.addEventListener('mousedown', (e) => e.preventDefault());
    }
    field.addEventListener('focus', () => {
      resumeAfterNote = !video.paused;
      video.pause();
    });
    field.addEventListener('blur', () => {
      resumeAfterNote = false;
    });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        sendNote();
      } else if (e.key === 'Escape') {
        field.blur();
      }
    });
    // The picture never takes focus, so a press on it keeps the note field (and its
    // pending resume) as they are while the pin moves.
    video.addEventListener('mousedown', (e) => {
      if (isActive && state?.readOnly === null) {
        e.preventDefault();
      }
    });
    const pins = el('div', 'mc-rv-pins');
    const ring = button('mc-rv-ring', '+', 'Pending pin, press the picture to move it', () =>
      ui?.field.focus(),
    );
    ring.hidden = true;
    pins.appendChild(ring);
    stage.appendChild(pins);

    // Two rows that never wrap: the range keys with the pending range and Clear, then
    // play, the note field and Send.
    const keys = el('div', 'mc-rv-row');
    keys.append(inBtn, outBtn, pinBtn, chip, clearBtn);
    const write = el('div', 'mc-rv-row');
    write.append(cplay, field, send);
    composer.append(keys, write);
    panel.append(head, banner, restore, list, fpsNote, composer);

    root.append(main, panel);
    document.body.appendChild(root);

    const relayout = (): void => {
      root.classList.toggle(
        'mc-rv--narrow',
        root.clientWidth > 0 && root.clientWidth < PANEL_W + MIN_VIDEO_W,
      );
      renderMarkers();
      renderPins(true);
    };
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(relayout).observe(root);
    }
    window.addEventListener('resize', relayout);

    video.addEventListener('timeupdate', updateTime);
    video.addEventListener('seeked', updateTime);
    video.addEventListener('durationchange', () => {
      updateTransport();
      renderMarkers();
    });
    // Pins laid out before the picture size was known, or before a source switch
    // changed it, need placing again even though the frame has not moved.
    video.addEventListener('loadedmetadata', () => {
      updateTransport();
      renderMarkers();
      renderPins(true);
    });
    video.addEventListener('resize', () => renderPins(true));
    video.addEventListener('play', () => {
      updateTransport();
      tick();
    });
    for (const name of ['pause', 'ended', 'ratechange']) {
      video.addEventListener(name, updateTransport);
    }

    return {
      root,
      main,
      play,
      speed,
      readout,
      total,
      rate,
      slider,
      markers,
      bands,
      pins,
      ring,
      sortBtn,
      count,
      copy,
      banner,
      restore,
      list,
      fpsNote,
      inBtn,
      outBtn,
      pinBtn,
      chip,
      clearBtn,
      cplay,
      field,
      send,
      composer,
    };
  }

  // A timeupdate fires a few times a second; the readout wants every frame while
  // playing. Skipped where there is no animation frame (tests).
  function tick(): void {
    if (!isActive || video.paused || typeof requestAnimationFrame !== 'function') {
      return;
    }
    requestAnimationFrame(() => {
      updateTime();
      tick();
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  function updateTime(): void {
    if (!ui) {
      return;
    }
    const code = positionTimecode(video.currentTime, fps());
    ui.readout.textContent = code;
    ui.slider.value = String(video.currentTime);
    ui.slider.setAttribute('aria-valuetext', code);
    renderPins(false);
  }

  function updateTransport(): void {
    if (!ui) {
      return;
    }
    const playing = !video.paused && !video.ended;
    const verb = playing ? 'Pause' : 'Play';
    face(ui.play, playing ? 'pause' : 'play', '', true);
    face(ui.cplay, playing ? 'pause' : 'play');
    for (const b of [ui.play, ui.cplay]) {
      b.setAttribute('aria-label', verb);
      b.title = `${verb} (Space)`;
    }
    const r = Number(video.playbackRate.toFixed(2));
    ui.speed.textContent = `${r}x`;
    ui.speed.setAttribute('aria-label', `Playback speed ${r}x, press to change`);
    ui.total.textContent = `/ ${secondsToTimecode(duration(), fps())}`;
    ui.rate.textContent = state ? fpsLabel(state.fps, state.fpsSource) : '';
    ui.slider.max = String(duration());
    updateTime();
  }

  function renderMarkers(): void {
    if (!ui || !state) {
      return;
    }
    const { markers, bands } = ui;
    markers.textContent = '';
    bands.textContent = '';
    const width = ui.slider.clientWidth || ui.markers.clientWidth;
    const dur = duration();
    if (!(width > 0) || !(dur > 0)) {
      return;
    }
    const rate = fps();
    const rows: DotRow[] = state.notes.map((n) => ({
      id: n.id,
      at: n.at,
      startMs: noteSeekMs(n),
      tc: secondsToTimecode(n.at, rate),
      done: n.done,
    }));
    for (const dot of layoutDots(rows, dur, width)) {
      const b = el('button', 'mc-rv-marker');
      b.type = 'button';
      b.style.left = `${dot.x}px`;
      b.style.width = `${DOT_HIT}px`;
      // A cluster reads as a count (x3) with a stacked edge; a single note keeps its number.
      const face = el('span', 'mc-rv-dot', dot.count > 1 ? `×${dot.count}` : dot.label);
      face.classList.toggle('mc-rv-dot--cluster', dot.count > 1);
      face.classList.toggle('mc-rv-dot--done', dot.done);
      b.appendChild(face);
      const isSelected = dot.ids.includes(selected);
      b.setAttribute('aria-pressed', String(isSelected));
      b.setAttribute(
        'aria-label',
        dot.count === 1
          ? `Note ${dot.id} at ${dot.tc}${dot.done ? ', done' : ''}`
          : `${dot.count} notes from ${dot.tc}: ${dot.ids.join(', ')}. Press to go to the next one`,
      );
      b.addEventListener('click', () => {
        const id = cycleTarget(dot.ids, selected);
        const member = dot.members.find((m) => m.id === id);
        if (member) {
          select(id, false);
          seekMs(member.startMs);
          scrollCardIntoView(id);
        }
      });
      markers.appendChild(b);
    }
    for (const n of state.notes) {
      if (n.out !== undefined && n.out > n.at) {
        const [x, w] = bandGeometry(n.at, n.out, dur, width);
        const bar = el('div', 'mc-rv-band');
        bar.classList.toggle('mc-rv-band--selected', n.id === selected);
        bar.dataset.id = n.id;
        bar.style.left = `${x}px`;
        bar.style.width = `${w}px`;
        bands.appendChild(bar);
      }
    }
    const pb = pendingBand(pendingIn, pendingOut, dur, width);
    if (pb.visible) {
      const bar = el('div', pb.hasOut ? 'mc-rv-pending' : 'mc-rv-pending mc-rv-pending--point');
      bar.style.left = `${pb.x}px`;
      if (pb.hasOut) {
        bar.style.width = `${pb.width}px`;
      }
      bands.appendChild(bar);
    }
  }

  // -------------------------------------------------------------------------
  // Pins
  // -------------------------------------------------------------------------
  // Pin buttons live across frames, keyed by note id, and are updated in place:
  // replacing one while it is pressed could swallow its click during playback.
  const pinButtons = new Map<string, HTMLButtonElement>();

  interface Picture {
    box: DOMRect;
    stage: DOMRect;
    x: number;
    y: number;
    w: number;
    h: number;
  }

  /** The picture inside the video element's box (letterboxed), plus the box and stage. */
  function pictureRect(): Picture {
    const box = video.getBoundingClientRect();
    const r = fitRect(box.width, box.height, video.videoWidth, video.videoHeight);
    return { box, stage: stage.getBoundingClientRect(), ...r };
  }

  function placeAt(node: HTMLElement, point: [number, number], r: Picture): void {
    const cx = r.box.left - r.stage.left + r.x + point[0] * r.w;
    const cy = r.box.top - r.stage.top + r.y + point[1] * r.h;
    node.style.left = `${cx - PIN_SIZE / 2}px`;
    node.style.top = `${cy - PIN_SIZE / 2}px`;
  }

  function renderPins(force: boolean): void {
    if (!ui) {
      return;
    }
    const frame = frameIndex(video.currentTime * 1000, fps());
    if (!force && frame === pinFrame) {
      return;
    }
    pinFrame = frame;
    const r = pictureRect();
    const live = new Set<string>();
    if (isActive && state) {
      for (const n of state.notes) {
        if (!n.point || !pinVisible(n.at, n.out ?? null, video.currentTime * 1000, fps())) {
          continue;
        }
        live.add(n.id);
        let b = pinButtons.get(n.id);
        if (!b) {
          b = el('button', 'mc-rv-pin');
          b.type = 'button';
          const id = n.id;
          b.addEventListener('click', () => {
            select(id, true);
            scrollCardIntoView(id);
          });
          pinButtons.set(n.id, b);
          ui.pins.insertBefore(b, ui.ring);
        }
        const num = noteNum(n.id);
        b.textContent = num ? String(num) : n.id;
        b.setAttribute('aria-label', `Pin for ${n.id}`);
        b.setAttribute('aria-pressed', String(n.id === selected));
        b.classList.toggle('mc-rv-pin--selected', n.id === selected);
        placeAt(b, n.point, r);
      }
    }
    for (const [id, b] of pinButtons) {
      if (!live.has(id)) {
        b.remove();
        pinButtons.delete(id);
      }
    }
    ui.ring.hidden = !(isActive && pendingPoint);
    if (pendingPoint) {
      placeAt(ui.ring, pendingPoint, r);
    }
  }

  function onPicture(e: MouseEvent): boolean {
    if (!isActive || !ui || !state || state.readOnly !== null || !pinMode) {
      return false;
    }
    if (sending) {
      return true;
    }
    if (!video.videoWidth) {
      return true;
    }
    const r = pictureRect();
    const pt = pointInRect(e.clientX - r.box.left, e.clientY - r.box.top, r);
    if (!pt) {
      return true;
    }
    // Resume after sending if playback was running before the first press. A
    // pending resume survives later presses; a deliberate play or pause clears it.
    const resume = resumeAfterNote || !video.paused;
    pendingPoint = pt;
    video.pause();
    ui.field.focus();
    resumeAfterNote = resume;
    renderPending();
    return true;
  }

  function scrollCardIntoView(id: string): void {
    for (const card of ui?.list.querySelectorAll<HTMLElement>('.mc-rv-card') ?? []) {
      if (card.dataset.id === id) {
        card.scrollIntoView?.({ block: 'nearest' });
      }
    }
  }

  function renderSelection(): void {
    if (!ui) {
      return;
    }
    const locked = state?.readOnly != null;
    for (const item of ui.list.querySelectorAll<HTMLElement>('.mc-rv-item')) {
      const on = item.dataset.id === selected;
      const card = item.querySelector<HTMLElement>('.mc-rv-card')!;
      card.classList.toggle('mc-rv-card--selected', on);
      card.setAttribute('aria-pressed', String(on));
      item.querySelector('.mc-rv-actions')?.remove();
      const note = on ? state?.notes.find((n) => n.id === selected) : undefined;
      if (note) {
        item.appendChild(actions(note, locked));
      }
    }
  }

  /** Delete, shown on the selected card only. */
  function actions(note: ReviewNote, locked: boolean): HTMLElement {
    const row = el('div', 'mc-rv-actions');
    const del = button('mc-rv-btn mc-rv-ghost mc-rv-quiet', '', `Delete ${note.id}`, () =>
      post({ type: 'reviewDelete', id: note.id }),
    );
    del.title = `Delete ${note.id}`;
    face(del, 'trash');
    del.disabled = locked;
    row.append(del);
    return row;
  }

  function card(note: ReviewNote): HTMLElement {
    const rate = fps();
    const start = secondsToTimecode(note.at, rate);
    const when =
      note.out !== undefined && note.out > note.at
        ? `${start} to ${secondsToTimecode(note.out, rate)}`
        : start;
    const item = el('div', 'mc-rv-item');
    item.dataset.id = note.id;
    const b = el('button', 'mc-rv-card');
    b.type = 'button';
    b.dataset.id = note.id;
    const meta = el('span', 'mc-rv-meta');
    meta.append(el('span', 'mc-rv-tc', when), el('span', 'mc-rv-id', note.id));
    if (note.kind !== 'note') {
      meta.appendChild(el('span', 'mc-rv-kind', note.kind));
    }
    if (note.point) {
      meta.appendChild(el('span', 'mc-rv-kind', 'Pin'));
    }
    b.appendChild(meta);
    if (note.text) {
      b.appendChild(el('span', 'mc-rv-text', note.text));
    }
    if (note.done) {
      b.appendChild(el('span', 'mc-rv-done', 'Done'));
    }
    b.addEventListener('click', () => select(note.id, true));
    item.appendChild(b);
    return item;
  }

  // -------------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------------
  /** The start of the frame on screen, which is what a note stores. */
  const here = (): number => frameStartSeconds(video.currentTime * 1000, fps());

  function setIn(): void {
    pendingIn = here();
    // Marker's rule: an In at or past the Out drops the Out.
    if (pendingOut <= pendingIn) {
      pendingOut = -1;
    }
    renderPending();
  }

  function setOut(): void {
    if (pendingIn < 0) {
      toast('Set In first');
      return;
    }
    const out = here();
    if (out <= pendingIn) {
      toast('Out must be after In');
      return;
    }
    pendingOut = out;
    renderPending();
  }

  function clearRange(): void {
    pendingIn = pendingOut = -1;
    pendingPoint = null;
    pinMode = false;
    renderPending();
  }

  /** Turn pin mode on or off; off drops a pending pin. */
  function setPinMode(on: boolean): void {
    if (!ui || !state || state.readOnly !== null || sending) {
      return;
    }
    pinMode = on;
    if (!on) {
      pendingPoint = null;
    }
    renderPending();
  }

  function sendNote(): void {
    if (!ui || !state || state.readOnly !== null || state.fpsSource === 'pending' || sending) {
      return;
    }
    const text = ui.field.value.trim();
    if (!text) {
      toast('Write the note first');
      return;
    }
    const at = pendingIn >= 0 ? pendingIn : here();
    const msg: Extract<ReviewWebviewMessage, { type: 'reviewAdd' }> = {
      type: 'reviewAdd',
      at,
      text,
    };
    if (pendingIn >= 0 && pendingOut > pendingIn) {
      msg.out = pendingOut;
    }
    if (pendingPoint) {
      msg.point = pendingPoint;
    }
    // Keep the draft on screen until the host says the note was saved.
    sending = {
      text,
      in: pendingIn,
      out: pendingOut,
      point: pendingPoint,
      pin: pinMode,
      resume: resumeAfterNote,
    };
    resumeAfterNote = false;
    post(msg);
    // Hand the keyboard back to the player.
    ui.field.blur();
    renderComposer();
  }

  /** The host saved the note: drop the draft and pick playback up where it was. */
  /** The host saved the note. `resumePlayback` is false while review mode is hidden. */
  function sendSucceeded(resumePlayback = true): void {
    if (!ui || !sending) {
      return;
    }
    const resume = sending.resume && resumePlayback;
    sending = null;
    pendingIn = pendingOut = -1;
    pendingPoint = null;
    pinMode = false;
    ui.field.value = '';
    renderComposer();
    if (resume) {
      void video.play().catch(() => toast('Playback was blocked, press play again'));
    }
  }

  /** The host did not save the note: put the whole draft back, playback stays paused. */
  function sendFailed(): void {
    if (!ui || !sending) {
      return;
    }
    ui.field.value = sending.text;
    pendingIn = sending.in;
    pendingOut = sending.out;
    pendingPoint = sending.point;
    pinMode = sending.pin;
    sending = null;
    renderComposer();
  }

  function renderPending(): void {
    if (!ui) {
      return;
    }
    const set = pendingIn >= 0;
    const any = set || pendingPoint !== null;
    const rate = fps();
    ui.inBtn.setAttribute('aria-pressed', String(set));
    ui.outBtn.setAttribute('aria-pressed', String(pendingOut > pendingIn && set));
    ui.pinBtn.setAttribute('aria-pressed', String(pinMode));
    ui.root.classList.toggle('mc-rv--pin', pinMode);
    ui.chip.hidden = !set;
    ui.clearBtn.hidden = !any;
    const range = !set
      ? ''
      : pendingOut > pendingIn
        ? `${secondsToTimecode(pendingIn, rate)} to ${secondsToTimecode(pendingOut, rate)}`
        : secondsToTimecode(pendingIn, rate);
    ui.chip.textContent = range;
    ui.chip.title = range;
    renderMarkers();
    renderPins(true);
  }

  function renderComposer(): void {
    if (!ui || !state) {
      return;
    }
    const locked = state.readOnly !== null;
    // While a note is in flight the draft is frozen, so a failed save restores it as sent.
    if (locked) {
      pinMode = false;
    }
    for (const c of [ui.inBtn, ui.outBtn, ui.pinBtn, ui.clearBtn, ui.field]) {
      c.disabled = locked || sending !== null;
    }
    ui.composer.classList.toggle('mc-rv-composer--busy', sending !== null);
    // Until the host knows the rate, a note would be saved at the wrong one.
    ui.send.disabled = locked || state.fpsSource === 'pending' || sending !== null;
    ui.fpsNote.hidden = !(state.sidecar === null && state.fpsSource === 'assumed');
    ui.restore.hidden = !state.restorable;
    ui.restore.disabled = locked;
    if (state.restorable) {
      ui.restore.textContent = `Restore ${state.restorable}`;
      ui.restore.setAttribute('aria-label', `Restore ${state.restorable}`);
    }
    renderPending();
  }

  function renderPanel(): void {
    if (!ui || !state) {
      return;
    }
    const n = state.notes.length;
    const shown = arrangeNotes(state.notes, sort);
    ui.count.textContent = `${n} ${n === 1 ? 'note' : 'notes'}`;
    face(ui.sortBtn, 'sort', SORT_NAME[sort]);
    ui.sortBtn.setAttribute('aria-label', `Sort: ${SORT_NAME[sort]}`);
    ui.sortBtn.title = `Sort: ${SORT_NAME[sort]}, press to change`;
    ui.copy.disabled = state.sidecar === null;
    ui.copy.title = state.sidecar === null ? 'No notes file for this video yet' : '';
    ui.banner.hidden = state.readOnly === null;
    ui.banner.textContent = state.readOnly === null ? '' : `Read-only: ${state.readOnly}`;

    const scroll = ui.list.scrollTop;
    ui.list.textContent = '';
    if (n === 0) {
      ui.list.appendChild(
        el(
          'p',
          'mc-rv-empty',
          state.sidecar === null
            ? 'No notes yet. This video has no notes file.'
            : `No notes yet in ${state.sidecar}.`,
        ),
      );
    }
    for (const note of shown) {
      ui.list.appendChild(card(note));
    }
    ui.list.scrollTop = scroll;
    renderSelection();
    renderComposer();
  }

  function renderAll(): void {
    updateTransport();
    renderPanel();
    renderMarkers();
    renderPins(true);
  }

  // -------------------------------------------------------------------------
  // Mode
  // -------------------------------------------------------------------------
  function enter(): void {
    ui ??= build();
    ui.root.hidden = false;
    // The stage joins the layout in place of its fixed position over the page.
    ui.main.prepend(stage);
    document.body.classList.add('mc-review');
    video.controls = false;
    isActive = true;
    tick();
  }

  function exit(): void {
    isActive = false;
    document.body.classList.remove('mc-review');
    video.controls = true;
    renderPins(true);
    if (ui) {
      document.body.insertBefore(stage, ui.root);
      ui.root.hidden = true;
    }
  }

  function setReview(on: boolean): void {
    post({ type: 'updateSetting', key: 'video.review', value: on });
    if (on) {
      turnedOff = false;
      if (state) {
        enter();
        renderAll();
      }
      post({ type: 'reviewEnable' });
    } else {
      turnedOff = true;
      exit();
    }
  }

  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  // A copy is waiting for the host: its success toast flashes "Copied" on the
  // button, and a reviewError means it failed, so the button never claims a copy
  // that did not happen.
  let copyPending = false;
  function copyNotes(): void {
    if (state?.sidecar) {
      copyPending = true;
      post({ type: 'reviewCopy' });
    }
  }

  function flashCopied(): void {
    if (ui) {
      face(ui.copy, 'check', 'Copied');
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => ui && face(ui.copy, 'copy', 'Copy as Markdown'), 1500);
    }
  }

  return {
    onMessage(msg) {
      if (msg.type === 'toast' && copyPending) {
        copyPending = false;
        flashCopied();
        // Not consumed: the viewer still shows the toast itself.
        return false;
      }
      if (msg.type === 'reviewError') {
        copyPending = false;
        if ((msg as unknown as { failed?: string }).failed === 'add') {
          sendFailed();
        }
        toast((msg as unknown as { message: string }).message);
        return true;
      }
      if (msg.type !== 'review') {
        return false;
      }
      const next = msg as ReviewStateMessage;
      if (turnedOff) {
        // Hidden, but a save this panel started has still landed: settle the
        // draft so the composer is not left locked when review comes back.
        if (next.added) {
          sendSucceeded(false);
        }
        return true;
      }
      state = next;
      // The note this panel just added is the one to look at.
      if (next.added) {
        selected = next.added;
      }
      if (!next.notes.some((n) => n.id === selected)) {
        selected = '';
      }
      if (!isActive) {
        enter();
      }
      renderAll();
      if (next.added) {
        sendSucceeded();
        scrollCardIntoView(next.added);
      }
      return true;
    },
    active: () => isActive,
    onPicture,
    step,
    onKeydown(e) {
      if (!isActive || isTextEntry(e.target)) {
        return false;
      }
      switch (e.key) {
        case 'ArrowLeft':
        case ',':
          step(-1);
          break;
        case 'ArrowRight':
        case '.':
          step(1);
          break;
        case 'j':
        case 'J':
          setRate(ladderRate(-1));
          break;
        case 'k':
        case 'K':
          video.pause();
          break;
        case 'l':
        case 'L':
          setRate(ladderRate(1));
          break;
        case 'i':
        case 'I':
          if (!state || state.readOnly !== null) {
            return false;
          }
          setIn();
          break;
        case 'o':
        case 'O':
          if (!state || state.readOnly !== null) {
            return false;
          }
          setOut();
          break;
        case 'p':
        case 'P':
          if (!state || state.readOnly !== null) {
            return false;
          }
          setPinMode(!pinMode);
          break;
        default:
          return false;
      }
      e.preventDefault();
      return true;
    },
    menuEntries() {
      return [
        {
          kind: 'item',
          label: isActive ? 'Close Video Notes' : 'Open Video Notes',
          run: () => setReview(!isActive),
        },
      ];
    },
  };
}
