// Image Notes: review mode for the image preview. Called from src/webview/image.ts.
//
// Notes on a still picture, each anchored to a rectangle (Area), a point (Pin) or
// the whole image. Once the host sends its first `review` message, or the reader
// opens notes from the right-click menu, a notes panel with a composer at its foot
// appears beside the picture. Everything here is a view of the host's sidecar: an
// edit is only ever a small message (add, delete, restore) and the page waits for
// the host's next `review` to show it. The messages are in src/review/imageProtocol.ts.
//
// The shapes live in an overlay inside the picture's frame, which is exactly the
// picture's rendered size at any zoom, so placing them in percentages makes them
// follow zoom and pan with no further work.
import type {
  ImageNote,
  ImagePoint,
  ImageRegion,
  ImageReviewStateMessage,
  ImageReviewWebviewMessage,
} from '../review/imageProtocol';
import type { MenuEntry } from './menu';

export interface ImageReviewDeps {
  /** The picture's frame: exactly the rendered picture, the overlay's parent. */
  frame: HTMLElement;
  /** The scrolling viewport around the frame. Its right or bottom inset makes room for the panel. */
  scroller: HTMLElement;
  /** The floating toolbar, moved clear of the panel. */
  toolbar: HTMLElement;
  /** Anything the host handles: review messages and `updateSetting`. */
  post(
    msg: ImageReviewWebviewMessage | { type: 'updateSetting'; key: string; value: unknown },
  ): void;
  toast(text: string): void;
  /** The scroller's size changed (the panel came or went): fit-zoom needs measuring again. */
  onLayout?(): void;
}

export interface ImageReviewController {
  /** Handle a host message; true when it was a review message. */
  onMessage(msg: { type: string }): boolean;
  /** Whether notes mode is on screen. */
  active(): boolean;
  /** Notes-only shortcuts (A, P, Escape); true when the key was used. */
  onKeydown(e: KeyboardEvent): boolean;
  /** A press on the picture area. True when notes mode took it (Area drag or Pin), so the hand tool must not pan. */
  onPointerDown(e: PointerEvent): boolean;
  /** "Open Image Notes" or "Close Image Notes", for the right-click menu. */
  menuEntries(): MenuEntry[];
}

// The panel's width, and the least the picture is given before the panel drops below it
// (the same thresholds as the video's).
const PANEL_W = 320;
const MIN_PICTURE_W = 400;
// The pin stud's size, which is also its hit target.
const PIN_SIZE = 44;
// A drag shorter than this, in screen pixels, in either direction is not an area.
const MIN_DRAG_PX = 4;
// The status line's height, which the panel sits above.
const STATUS_H = 30;
const NARROW_SHARE = 0.4;

function noteNum(id: string): number {
  const digits = [...String(id)].filter((c) => c >= '0' && c <= '9').join('');
  return digits ? parseInt(digits, 10) : 0;
}

/** Whether keys typed here belong to a text field, not to the viewer. */
function isTextEntry(target: EventTarget | null): boolean {
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

/** Half-up whole percent of a 0..1 fraction. */
export function pct(v: number): number {
  return Math.floor(v * 100 + 0.5);
}

/** "Area 10%, 21%, 30% x 40%", "Pin 42%, 30%" or "Whole image". */
export function anchorLabel(note: { point?: ImagePoint; region?: ImageRegion }): string {
  if (note.region) {
    const [x, y, w, h] = note.region;
    return `Area ${pct(x)}%, ${pct(y)}%, ${pct(w)}% x ${pct(h)}%`;
  }
  if (note.point) {
    return `Pin ${pct(note.point[0])}%, ${pct(note.point[1])}%`;
  }
  return 'Whole image';
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/** Fraction in whole 1/10000ths. */
const units = (v: number): number => Math.round(clamp01(v) * 10000);

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

// 24-grid glyphs in MarkCopy's inline icon style (see videoReview.ts, pdf.ts).
const ICONS = {
  copy: ['M8 8h12v12H8z', 'M16 8V4H4v12h4'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  send: ['M12 19V5', 'M5 12l7-7 7 7'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  area: ['M4 5h16v14H4z'],
  pin: [
    'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z',
    'M12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  ],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
} satisfies Record<string, string[]>;
type IconName = keyof typeof ICONS;

function icon(name: IconName): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
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
function face(b: HTMLElement, name: IconName | null, text = ''): void {
  b.textContent = '';
  if (name) {
    b.appendChild(icon(name));
  }
  if (text) {
    b.appendChild(el('span', 'mc-rv-lbl', text));
  }
}

function button(
  className: string,
  label: string,
  run: () => void,
  title = label,
): HTMLButtonElement {
  const b = el('button', className);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = title;
  b.addEventListener('click', run);
  return b;
}

type Mode = 'none' | 'area' | 'pin';
type Anchor = { region: ImageRegion } | { point: ImagePoint } | null;

export function createImageReview(deps: ImageReviewDeps): ImageReviewController {
  const { frame, scroller, toolbar, post, toast } = deps;

  let state: ImageReviewStateMessage | undefined;
  let isActive = false;
  // Set when the reader turns notes off from the menu or the close button: later
  // `review` messages (a sidecar change) must not pull them back in.
  let turnedOff = false;
  let selected = '';
  let mode: Mode = 'none';
  let pending: Anchor = null;
  // The last draft handed to the host and not yet acknowledged, so a failed save
  // can put it back.
  let sent: { text: string; anchor: Anchor; mode: Mode } | null = null;
  let ui: ReturnType<typeof build> | undefined;
  // The Area drag in progress, in client pixels.
  let drag: { id: number; x0: number; y0: number; x1: number; y1: number } | null = null;

  const readOnly = (): boolean => state?.readOnly != null;

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------
  function build() {
    // The root only carries the theme variables and lays the panel out; it lets
    // every press through to the picture.
    const root = el('div', 'mc-rv mc-rv--image');
    const panel = el('aside', 'mc-rv-panel');
    panel.setAttribute('aria-label', 'Image notes');

    const head = el('div', 'mc-rv-head');
    const count = el('h2', 'mc-rv-count');
    const copy = button('mc-rv-btn mc-rv-key', 'Copy notes as Markdown', copyNotes, '');
    face(copy, 'copy', 'Copy as Markdown');
    const tools = el('div', 'mc-rv-tools');
    tools.append(copy);
    const close = button('mc-rv-btn mc-rv-ghost mc-rv-tool mc-rv-close', 'Close image notes', () =>
      setReview(false),
    );
    face(close, 'close');
    const titleRow = el('div', 'mc-rv-titlerow');
    titleRow.append(count, close);
    head.append(titleRow, tools);

    const banner = el('div', 'mc-rv-banner');
    banner.setAttribute('role', 'status');
    banner.hidden = true;
    const list = el('div', 'mc-rv-list');
    const restore = button('mc-rv-btn mc-rv-tool', '', () => {
      if (state?.restorable) {
        post({ type: 'reviewRestore' });
      }
    });
    restore.removeAttribute('aria-label');
    restore.title = '';
    restore.hidden = true;

    const composer = el('div', 'mc-rv-composer');
    composer.setAttribute('role', 'group');
    composer.setAttribute('aria-label', 'Write a note');
    const areaBtn = button(
      'mc-rv-btn mc-rv-key mc-rv-point',
      'Area',
      () => setMode(mode === 'area' ? 'none' : 'area'),
      'Draw an area on the picture (A)',
    );
    face(areaBtn, 'area', 'Area');
    const pinBtn = button(
      'mc-rv-btn mc-rv-key mc-rv-point',
      'Pin',
      () => setMode(mode === 'pin' ? 'none' : 'pin'),
      'Pin a spot on the picture (P)',
    );
    face(pinBtn, 'pin', 'Pin');
    const chip = el('span', 'mc-rv-chip');
    chip.hidden = true;
    const clearBtn = button(
      'mc-rv-btn mc-rv-ghost mc-rv-quiet mc-rv-clear',
      'Clear',
      clearAnchor,
      'Clear the area or pin',
    );
    face(clearBtn, 'close');
    clearBtn.hidden = true;
    const field = el('input', 'mc-rv-field');
    field.type = 'text';
    field.maxLength = 10000;
    field.placeholder = 'Write a note';
    field.setAttribute('aria-label', 'Note text');
    const send = button('mc-rv-btn mc-rv-key mc-rv-send', 'Send', sendNote, 'Add note (Enter)');
    face(send, 'send', 'Send');
    // A press on these must not take focus from the field.
    for (const b of [areaBtn, pinBtn, clearBtn, send]) {
      b.addEventListener('mousedown', (e) => e.preventDefault());
    }
    field.addEventListener('keydown', (e) => {
      // Typing belongs to the field: no viewer shortcut (1, F, arrows, paging) may fire.
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        sendNote();
      } else if (e.key === 'Escape') {
        field.blur();
      }
    });

    const keys = el('div', 'mc-rv-row');
    keys.append(areaBtn, pinBtn, clearBtn);
    const write = el('div', 'mc-rv-row');
    write.append(field, send);
    composer.append(keys, chip, write);
    panel.append(head, banner, restore, list, composer);
    root.append(panel);
    document.body.appendChild(root);

    // The overlay: inside the frame, on top of the picture, letting presses through
    // except on the shapes themselves.
    const layer = el('div', 'mc-rv-pins');
    const draft = el('div', 'mc-rv-draft');
    draft.hidden = true;
    draft.setAttribute('aria-hidden', 'true');
    const ring = button(
      'mc-rv-ring',
      'Pending pin, press the picture to move it',
      () => ui?.field.focus(),
      '',
    );
    ring.textContent = '+';
    ring.hidden = true;
    layer.append(draft, ring);
    frame.appendChild(layer);

    window.addEventListener('resize', relayout);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(relayout).observe(root);
    }

    return {
      root,
      count,
      copy,
      banner,
      restore,
      list,
      areaBtn,
      pinBtn,
      chip,
      clearBtn,
      field,
      send,
      composer,
      layer,
      draft,
      ring,
    };
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------
  /** Make room for the panel: beside the picture, or under it when narrow. */
  function relayout(): void {
    if (!ui) {
      return;
    }
    const width = ui.root.clientWidth || window.innerWidth;
    const narrow = isActive && width > 0 && width < PANEL_W + MIN_PICTURE_W;
    ui.root.classList.toggle('mc-rv--narrow', narrow);
    const s = scroller.style;
    const t = toolbar.style;
    const below = `calc(${STATUS_H}px + (100vh - ${STATUS_H}px) * ${NARROW_SHARE})`;
    const toolsBelow = `calc(${STATUS_H + 12}px + (100vh - ${STATUS_H}px) * ${NARROW_SHARE})`;
    if (!isActive) {
      s.right = '0';
      s.bottom = `${STATUS_H}px`;
      t.right = '18px';
      t.bottom = '42px';
    } else if (narrow) {
      s.right = '0';
      s.bottom = below;
      t.right = '18px';
      t.bottom = toolsBelow;
    } else {
      s.right = `${PANEL_W}px`;
      s.bottom = `${STATUS_H}px`;
      t.right = `${PANEL_W + 18}px`;
      t.bottom = '42px';
    }
    deps.onLayout?.();
  }

  // -------------------------------------------------------------------------
  // Overlay
  // -------------------------------------------------------------------------
  // Shapes live across renders, keyed by note id, and are updated in place.
  const shapes = new Map<string, { node: HTMLButtonElement; kind: 'region' | 'pin' }>();

  function place(node: HTMLElement, r: ImageRegion): void {
    node.style.left = `${r[0] * 100}%`;
    node.style.top = `${r[1] * 100}%`;
    node.style.width = `${r[2] * 100}%`;
    node.style.height = `${r[3] * 100}%`;
  }

  /** A stud centred on the point, held inside the frame so it never adds a scrollbar. */
  function placePin(node: HTMLElement, p: ImagePoint): void {
    node.dataset.x = String(p[0]);
    node.dataset.y = String(p[1]);
    const half = PIN_SIZE / 2;
    node.style.left = `clamp(0px, calc(${p[0] * 100}% - ${half}px), calc(100% - ${PIN_SIZE}px))`;
    node.style.top = `clamp(0px, calc(${p[1] * 100}% - ${half}px), calc(100% - ${PIN_SIZE}px))`;
  }

  function renderOverlay(): void {
    if (!ui) {
      return;
    }
    const live = new Set<string>();
    if (isActive && state) {
      for (const n of state.notes) {
        const kind = n.region ? 'region' : n.point ? 'pin' : null;
        if (!kind) {
          continue;
        }
        live.add(n.id);
        let entry = shapes.get(n.id);
        if (entry && entry.kind !== kind) {
          entry.node.remove();
          shapes.delete(n.id);
          entry = undefined;
        }
        if (!entry) {
          const node = el('button', kind === 'region' ? 'mc-rv-region' : 'mc-rv-pin');
          node.type = 'button';
          const id = n.id;
          node.addEventListener('click', () => {
            select(id, false);
            scrollCardIntoView(id);
          });
          // Regions go before the studs so a stud is never hidden under a box.
          ui.layer.insertBefore(node, kind === 'region' ? ui.layer.firstChild : ui.ring);
          entry = { node, kind };
          shapes.set(n.id, entry);
        }
        const node = entry.node;
        const num = noteNum(n.id);
        const label = num ? String(num) : n.id;
        if (n.region) {
          if (node.dataset.num !== label) {
            node.textContent = '';
            node.appendChild(el('span', 'mc-rv-region-num', label));
            node.dataset.num = label;
          }
          place(node, n.region);
          node.dataset.region = n.region.join(',');
          node.setAttribute('aria-label', `Area for ${n.id}`);
        } else if (n.point) {
          node.textContent = label;
          placePin(node, n.point);
          node.setAttribute('aria-label', `Pin for ${n.id}`);
        }
        node.dataset.id = n.id;
        node.setAttribute('aria-pressed', String(n.id === selected));
        node.classList.toggle(
          kind === 'region' ? 'mc-rv-region--selected' : 'mc-rv-pin--selected',
          n.id === selected,
        );
        node.classList.toggle('mc-rv-shape--done', n.done);
      }
    }
    for (const [id, entry] of shapes) {
      if (!live.has(id)) {
        entry.node.remove();
        shapes.delete(id);
      }
    }
    renderPendingShape();
  }

  /** The pending anchor on the picture: a dashed box or the ring. A drag in progress wins. */
  function renderPendingShape(): void {
    if (!ui) {
      return;
    }
    const { draft, ring } = ui;
    let box: ImageRegion | null = null;
    if (drag) {
      box = dragRegionFractions();
    } else if (pending && 'region' in pending) {
      box = pending.region;
    }
    draft.hidden = !(isActive && box);
    if (box) {
      place(draft, box);
    }
    const point = pending && 'point' in pending ? pending.point : null;
    ring.hidden = !(isActive && point);
    if (point) {
      placePin(ring, point);
    }
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------
  function frameBox(): DOMRect | null {
    const r = frame.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }

  function fraction(clientX: number, clientY: number, r: DOMRect): [number, number] {
    return [clamp01((clientX - r.left) / r.width), clamp01((clientY - r.top) / r.height)];
  }

  /** The drag as a region in fractions, unrounded, for the live preview. */
  function dragRegionFractions(): ImageRegion | null {
    const r = frameBox();
    if (!drag || !r) {
      return null;
    }
    const [ax, ay] = fraction(drag.x0, drag.y0, r);
    const [bx, by] = fraction(drag.x1, drag.y1, r);
    return [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
  }

  /** The finished drag as a stored region (4 decimals, inside the picture), or null when too small. */
  function finishRegion(): ImageRegion | null {
    const r = frameBox();
    if (!drag || !r) {
      return null;
    }
    // Clamped to the picture, so the size that counts is the part on the picture.
    const [ax, ay] = fraction(drag.x0, drag.y0, r);
    const [bx, by] = fraction(drag.x1, drag.y1, r);
    if (Math.abs(bx - ax) * r.width < MIN_DRAG_PX || Math.abs(by - ay) * r.height < MIN_DRAG_PX) {
      return null;
    }
    // Whole 1/10000ths, so x + w and y + h can never run past 1.
    const x0 = units(Math.min(ax, bx));
    const x1 = units(Math.max(ax, bx));
    const y0 = units(Math.min(ay, by));
    const y1 = units(Math.max(ay, by));
    if (x1 <= x0 || y1 <= y0) {
      return null;
    }
    return [x0 / 10000, y0 / 10000, (x1 - x0) / 10000, (y1 - y0) / 10000];
  }

  function onMove(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.id) {
      return;
    }
    drag.x1 = e.clientX;
    drag.y1 = e.clientY;
    renderPendingShape();
  }

  function endDrag(e: PointerEvent, commit: boolean): void {
    if (!drag || e.pointerId !== drag.id) {
      return;
    }
    drag.x1 = e.clientX;
    drag.y1 = e.clientY;
    const region = commit ? finishRegion() : null;
    try {
      scroller.releasePointerCapture?.(drag.id);
    } catch {
      /* best-effort */
    }
    drag = null;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    document.body.classList.remove('mc-rv-drawing');
    if (region) {
      pending = { region };
      renderComposer();
      ui?.field.focus();
    } else {
      renderPendingShape();
    }
  }
  const onUp = (e: PointerEvent): void => endDrag(e, true);
  const onCancel = (e: PointerEvent): void => endDrag(e, false);

  function onPointerDown(e: PointerEvent): boolean {
    if (!isActive || !ui || !state || readOnly() || mode === 'none' || e.button !== 0) {
      return false;
    }
    const target = e.target as HTMLElement | null;
    if (!target || !scroller.contains(target) || target.closest('.mc-menu, #mc-toolbar')) {
      return false;
    }
    const r = frameBox();
    if (mode === 'pin') {
      // A press on the margin around the picture is no pin, as in the video's letterbox.
      const onPicture =
        r &&
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom;
      if (r && onPicture) {
        const [fx, fy] = fraction(e.clientX, e.clientY, r);
        pending = { point: [units(fx) / 10000, units(fy) / 10000] };
        renderComposer();
        ui.field.focus();
      }
      return true;
    }
    if (!r) {
      return true;
    }
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    try {
      // So a drag that leaves the frame (or the window) still ends.
      scroller.setPointerCapture?.(e.pointerId);
    } catch {
      /* best-effort */
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.body.classList.add('mc-rv-drawing');
    // A fresh drag replaces any region already pending.
    pending = null;
    renderComposer();
    e.preventDefault();
    return true;
  }

  // -------------------------------------------------------------------------
  // Panel
  // -------------------------------------------------------------------------
  function scrollCardIntoView(id: string): void {
    for (const card of ui?.list.querySelectorAll<HTMLElement>('.mc-rv-card') ?? []) {
      if (card.dataset.id === id) {
        card.scrollIntoView?.({ block: 'nearest' });
      }
    }
  }

  /** Bring a shape into view when the picture is zoomed past the window. */
  function scrollShapeIntoView(id: string): void {
    shapes.get(id)?.node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function select(id: string, scrollShape: boolean): void {
    selected = id;
    renderSelection();
    renderOverlay();
    scrollCardIntoView(id);
    if (scrollShape) {
      scrollShapeIntoView(id);
    }
  }

  function renderSelection(): void {
    if (!ui) {
      return;
    }
    const locked = readOnly();
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
  function actions(note: ImageNote, locked: boolean): HTMLElement {
    const row = el('div', 'mc-rv-actions');
    const del = button('mc-rv-btn mc-rv-ghost mc-rv-quiet', `Delete ${note.id}`, () =>
      post({ type: 'reviewDelete', id: note.id }),
    );
    face(del, 'trash');
    del.disabled = locked;
    row.append(del);
    return row;
  }

  function card(note: ImageNote): HTMLElement {
    const item = el('div', 'mc-rv-item');
    item.dataset.id = note.id;
    const b = el('button', 'mc-rv-card');
    b.type = 'button';
    b.dataset.id = note.id;
    const meta = el('span', 'mc-rv-meta');
    meta.append(el('span', 'mc-rv-tc', note.id), el('span', 'mc-rv-id', anchorLabel(note)));
    if (note.kind !== 'note') {
      meta.appendChild(el('span', 'mc-rv-kind', note.kind));
    }
    if (note.author) {
      meta.appendChild(el('span', 'mc-rv-kind', note.author));
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

  function renderPanel(): void {
    if (!ui || !state) {
      return;
    }
    const n = state.notes.length;
    ui.count.textContent = `${n} ${n === 1 ? 'note' : 'notes'}`;
    ui.copy.disabled = state.sidecar === null;
    ui.copy.title = state.sidecar === null ? 'No notes file for this image yet' : '';
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
            ? 'No notes yet. This image has no notes file.'
            : `No notes yet in ${state.sidecar}.`,
        ),
      );
    }
    for (const note of state.notes) {
      ui.list.appendChild(card(note));
    }
    ui.list.scrollTop = scroll;
    renderSelection();
    renderComposer();
  }

  function renderAll(): void {
    renderPanel();
    renderOverlay();
  }

  // -------------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------------
  function chipText(): string {
    return pending ? anchorLabel(pending) : '';
  }

  function renderComposer(): void {
    if (!ui || !state) {
      return;
    }
    const locked = readOnly();
    if (locked) {
      mode = 'none';
      pending = null;
    }
    for (const c of [ui.areaBtn, ui.pinBtn, ui.clearBtn, ui.send]) {
      c.disabled = locked;
    }
    ui.field.disabled = locked;
    ui.areaBtn.setAttribute('aria-pressed', String(mode === 'area'));
    ui.pinBtn.setAttribute('aria-pressed', String(mode === 'pin'));
    document.body.classList.toggle('mc-image-aim', isActive && mode !== 'none');
    const text = chipText();
    ui.chip.hidden = !text;
    ui.chip.textContent = text;
    ui.chip.title = text;
    ui.clearBtn.hidden = !(pending || mode !== 'none');
    ui.restore.hidden = !state.restorable;
    ui.restore.disabled = locked;
    if (state.restorable) {
      ui.restore.textContent = `Restore ${state.restorable}`;
      ui.restore.setAttribute('aria-label', `Restore ${state.restorable}`);
    }
    renderPendingShape();
  }

  /** Turn Area or Pin on (they are exclusive) or off; changing the mode drops a pending anchor of the other kind. */
  function setMode(next: Mode): void {
    if (!ui || !state || readOnly()) {
      return;
    }
    mode = next;
    if (pending && (next === 'none' || ('region' in pending ? next !== 'area' : next !== 'pin'))) {
      pending = null;
    }
    renderComposer();
  }

  function clearAnchor(): void {
    mode = 'none';
    pending = null;
    renderComposer();
  }

  function sendNote(): void {
    if (!ui || !state || readOnly()) {
      return;
    }
    const text = ui.field.value.trim();
    if (!text && !pending) {
      return;
    }
    const msg: Extract<ImageReviewWebviewMessage, { type: 'reviewAdd' }> = {
      type: 'reviewAdd',
      text,
    };
    if (pending && 'region' in pending) {
      msg.region = pending.region;
    } else if (pending && 'point' in pending) {
      msg.point = pending.point;
    }
    sent = { text, anchor: pending, mode };
    post(msg);
    // The field keeps focus so the next note can follow; Escape hands the keyboard back.
    ui.field.value = '';
    mode = 'none';
    pending = null;
    renderComposer();
  }

  /** The host did not save the note: give the draft back, unless the reader has started another. */
  function sendFailed(): void {
    if (!ui || !sent) {
      return;
    }
    const draft = sent;
    sent = null;
    if (ui.field.value === '' && !pending && mode === 'none') {
      ui.field.value = draft.text;
      pending = draft.anchor;
      mode = draft.mode;
      renderComposer();
    }
  }

  // -------------------------------------------------------------------------
  // Mode
  // -------------------------------------------------------------------------
  function enter(): void {
    ui ??= build();
    ui.root.hidden = false;
    document.body.classList.add('mc-image-review');
    isActive = true;
    relayout();
  }

  function exit(): void {
    isActive = false;
    document.body.classList.remove('mc-image-review', 'mc-image-aim', 'mc-rv-drawing');
    mode = 'none';
    pending = null;
    if (ui) {
      ui.root.hidden = true;
      renderOverlay();
      relayout();
    }
  }

  function setReview(on: boolean): void {
    post({ type: 'updateSetting', key: 'image.review', value: on });
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
        if ((msg as { failed?: string }).failed === 'add') {
          sendFailed();
        }
        toast((msg as unknown as { message: string }).message);
        return true;
      }
      if (msg.type !== 'review') {
        return false;
      }
      const next = msg as ImageReviewStateMessage;
      if (turnedOff) {
        return true;
      }
      state = next;
      if (next.added) {
        selected = next.added;
        sent = null;
      }
      if (!next.notes.some((n) => n.id === selected)) {
        selected = '';
      }
      if (!isActive) {
        enter();
      }
      renderAll();
      if (next.added) {
        scrollCardIntoView(next.added);
      }
      return true;
    },
    active: () => isActive,
    onPointerDown,
    onKeydown(e) {
      if (!isActive || isTextEntry(e.target) || e.ctrlKey || e.metaKey || e.altKey) {
        return false;
      }
      switch (e.key) {
        case 'a':
        case 'A':
          if (!state || readOnly()) {
            return false;
          }
          setMode(mode === 'area' ? 'none' : 'area');
          break;
        case 'p':
        case 'P':
          if (!state || readOnly()) {
            return false;
          }
          setMode(mode === 'pin' ? 'none' : 'pin');
          break;
        case 'Escape':
          if (mode === 'none' && !pending) {
            return false;
          }
          clearAnchor();
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
          label: isActive ? 'Close Image Notes' : 'Open Image Notes',
          run: () => setReview(!isActive),
        },
      ];
    },
  };
}
