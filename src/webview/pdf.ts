import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';

// Minimal VS Code webview API surface we use.
interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById('pdf-root') as HTMLDivElement;
const menu = document.getElementById('mc-menu') as HTMLDivElement;
const toastEl = document.getElementById('mc-toast') as HTMLDivElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let doc: PDFDocumentProxy | null = null;
const pages: PDFPageProxy[] = []; // 1-based via index+1
const baseSize: { w: number; h: number }[] = []; // page size at scale 1 (CSS px)
const wrappers: HTMLDivElement[] = [];
const renderTasks = new Map<number, RenderTask>();
const renderedScale = new Map<number, number>(); // scale a page's canvas was rasterised at
const inFlight = new Set<number>();
const visible = new Set<number>(); // pages currently near the viewport
const pageText = new Map<number, string>();

// Zoom is stepped through fixed levels so the label reads cleanly (100 %, 125 %…)
// and never runs away.
const ZOOM_LEVELS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
let zoomIndex = ZOOM_LEVELS.indexOf(1);
let scale = ZOOM_LEVELS[zoomIndex];

// Cap the rasterised canvas so it never exceeds the browser's limit (past which
// it gets downscaled -> blurry) or exhausts memory. Roughly 4096x4096.
const MAX_CANVAS_PIXELS = 16_777_216;

// Phosphor green for the green theme's inverted pages. Matches the Markdown
// preview's `--mc-fg` in the green palette (media/preview.css).
const PHOSPHOR_GREEN = '#4bf07a';

let observer: IntersectionObserver | null = null;
let zoomTimer = 0;

type Mode = 'hand' | 'pointer';
let mode: Mode = 'hand';

interface Comment {
  id: string;
  page: number;
  xPct: number; // fraction of page width/height, so pins survive zoom
  yPct: number;
  text: string;
}
let comments: Comment[] = [];
let commentSeq = 0;

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type === 'load') {
    comments = Array.isArray(msg.comments) ? (msg.comments as Comment[]) : [];
    commentSeq = comments.length;
    load(base64ToBytes(msg.data as string), msg.workerSrc as string).catch(showFatal);
  }
});

// The host sends the PDF as base64 (a Uint8Array does not survive postMessage
// serialisation intact). Decode it back to bytes for pdf.js.
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function saveComments(): void {
  vscode.postMessage({ type: 'saveComments', comments });
}

// Never fail silently: surface any uncaught error/rejection in the panel.
window.addEventListener('error', (e) => showFatal(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));

function showFatal(err: unknown): void {
  if (String(err).includes('Rendering cancelled')) {
    return; // expected when zooming/scrolling supersedes a render
  }
  root.innerHTML = `<pre class="mc-error">PDF preview error: ${escapeHtml(String(err))}</pre>`;
}

let toastTimer = 0;
function toast(text: string, ms = 1600): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
async function load(data: Uint8Array, workerSrc: string): Promise<void> {
  root.textContent = '';

  // Run pdf.js off the main thread. The worker script is a webview-resource URI
  // (cross-origin to the vscode-webview:// document), so `new Worker(workerSrc)`
  // would throw a SecurityError; fetch it and start from a same-origin blob URL.
  try {
    const res = await fetch(workerSrc);
    const code = await res.text();
    const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(blobUrl, { type: 'module' });
  } catch (err) {
    root.innerHTML = `<pre class="mc-error">Failed to start PDF worker: ${escapeHtml(String(err))}</pre>`;
    return;
  }

  try {
    doc = await pdfjsLib.getDocument({ data }).promise;
  } catch (err) {
    root.innerHTML = `<pre class="mc-error">Failed to open PDF: ${escapeHtml(String(err))}</pre>`;
    return;
  }

  // Build a placeholder per page, sized to the page, but do NOT rasterise yet.
  // The IntersectionObserver rasterises pages as they approach the viewport.
  observer = new IntersectionObserver(onIntersect, { root: null, rootMargin: '150% 0px' });
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    pages.push(page);
    const vp = page.getViewport({ scale: 1 });
    baseSize.push({ w: vp.width, h: vp.height });

    const wrap = document.createElement('div');
    wrap.className = 'mc-page';
    wrap.dataset.page = String(n);
    wrap.innerHTML =
      '<canvas class="mc-canvas"></canvas><div class="textLayer"></div>' +
      '<div class="mc-annot-layer"></div>';
    root.appendChild(wrap);
    wrappers.push(wrap);
    layoutPage(n);
    observer.observe(wrap);
  }

  updateZoomLabel();
  toast(`Loaded ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`);
}

// ---------------------------------------------------------------------------
// Virtualised rendering
// ---------------------------------------------------------------------------
// Size a page's placeholder (and its layers) for the current scale, without
// rasterising. Cheap enough to run for every page on each zoom step.
function layoutPage(n: number): void {
  const { w, h } = baseSize[n - 1];
  const wrap = wrappers[n - 1];
  const pw = Math.floor(w * scale);
  const ph = Math.floor(h * scale);
  wrap.style.width = `${pw}px`;
  wrap.style.height = `${ph}px`;
  wrap.style.setProperty('--scale-factor', String(scale));
  // Keep the canvas's CSS box in lockstep with the wrapper on every zoom, so a
  // not-yet-re-rasterised (or torn-down) canvas can't sit at a stale, larger
  // size than its page. The clip on .mc-page is the backstop; this keeps the
  // transient correct instead of merely hidden.
  const canvas = wrap.querySelector('canvas') as HTMLCanvasElement;
  canvas.style.width = `${pw}px`;
  canvas.style.height = `${ph}px`;
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const n = Number((entry.target as HTMLElement).dataset.page);
    if (entry.isIntersecting) {
      visible.add(n);
    } else {
      visible.delete(n);
    }
  }
  refresh();
}

// Rasterise every visible page at the current scale and free canvases that have
// scrolled away, so memory stays bounded no matter how many pages the PDF has.
function refresh(): void {
  for (const n of visible) {
    void ensureRendered(n);
  }
  for (const n of Array.from(renderedScale.keys())) {
    if (!visible.has(n)) {
      teardown(n);
    }
  }
}

async function ensureRendered(n: number): Promise<void> {
  if (inFlight.has(n) || renderedScale.get(n) === scale) {
    return;
  }
  inFlight.add(n);
  try {
    await renderPage(n);
    renderedScale.set(n, scale);
  } catch {
    renderedScale.delete(n); // cancelled or failed; a later pass will retry
  } finally {
    inFlight.delete(n);
  }
}

// Render ABOVE the display resolution and let the browser downsample: this
// supersamples the text so it stays sharp even where the webview under-reports
// devicePixelRatio. Use at least 2x, or the real device ratio when higher,
// clamped so the canvas never exceeds MAX_CANVAS_PIXELS (past which the browser
// itself downscales the page -> the fuzziness we are fixing).
function outputScaleFor(viewport: { width: number; height: number }): number {
  const dpr = window.devicePixelRatio || 1;
  const cap = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
  return Math.min(cap, Math.max(dpr, 2));
}

async function renderPage(n: number): Promise<void> {
  const page = pages[n - 1];
  const wrap = wrappers[n - 1];
  const viewport = page.getViewport({ scale });

  const outputScale = outputScaleFor(viewport);

  const canvas = wrap.querySelector('canvas') as HTMLCanvasElement;
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  renderTasks.get(n)?.cancel();
  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
  const task = page.render({ canvas, canvasContext: ctx, viewport, transform });
  renderTasks.set(n, task);
  await task.promise;

  // Dark/green pages: recolour the rasterised pixels here rather than with a CSS
  // filter. A CSS filter forces the browser to re-rasterise the layer at CSS
  // resolution (blurry on HiDPI); baking it into the bitmap keeps it crisp.
  tintCanvas(ctx, canvas, pageAppearance());

  // Text layer: transparent, selectable spans over the canvas.
  const textContent = await page.getTextContent();
  if (!pageText.has(n)) {
    pageText.set(
      n,
      textContent.items
        .map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .trim(),
    );
  }
  const textLayerDiv = wrap.querySelector('.textLayer') as HTMLElement;
  textLayerDiv.innerHTML = '';
  await new pdfjsLib.TextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport,
  }).render();

  placePins(n);
}

// Free a page's raster + text layer when it scrolls out of view.
function teardown(n: number): void {
  renderTasks.get(n)?.cancel();
  renderTasks.delete(n);
  renderedScale.delete(n);
  const wrap = wrappers[n - 1];
  const canvas = wrap.querySelector('canvas') as HTMLCanvasElement;
  canvas.width = 0;
  canvas.height = 0;
  (wrap.querySelector('.textLayer') as HTMLElement).innerHTML = '';
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------
function setZoomIndex(i: number): void {
  const clamped = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, i));
  if (clamped === zoomIndex) {
    return;
  }
  zoomIndex = clamped;
  scale = ZOOM_LEVELS[zoomIndex];
  updateZoomLabel();

  // Resize placeholders immediately (keeps scroll layout correct), then
  // re-rasterise the visible pages once zooming settles.
  for (let n = 1; n <= (doc?.numPages ?? 0); n++) {
    renderTasks.get(n)?.cancel();
    layoutPage(n);
  }
  renderedScale.clear();
  inFlight.clear();
  window.clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(refresh, 120);
}

function zoomIn(): void {
  setZoomIndex(zoomIndex + 1);
}
function zoomOut(): void {
  setZoomIndex(zoomIndex - 1);
}
function zoomReset(): void {
  setZoomIndex(ZOOM_LEVELS.indexOf(1));
}

function updateZoomLabel(): void {
  const label = document.getElementById('mc-zoom-label');
  if (label) {
    label.textContent = `${Math.round(scale * 100)}%`;
  }
}

// Ctrl/Cmd + wheel zooms one level per notch. preventDefault stops the browser's
// own page zoom; the debounce in setZoomIndex keeps rapid notches cheap.
document.addEventListener(
  'wheel',
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) {
      return;
    }
    e.preventDefault();
    if (e.deltaY < 0) {
      zoomIn();
    } else if (e.deltaY > 0) {
      zoomOut();
    }
  },
  { passive: false },
);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    menu.hidden = true;
    closeNote();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      zoomIn();
    } else if (e.key === '-') {
      e.preventDefault();
      zoomOut();
    } else if (e.key === '0') {
      e.preventDefault();
      zoomReset();
    }
  }
});

// ---------------------------------------------------------------------------
// Interaction mode (hand vs pointer)
// ---------------------------------------------------------------------------
function setMode(next: Mode): void {
  mode = next;
  document.body.classList.toggle('mc-mode-hand', mode === 'hand');
  document.body.classList.toggle('mc-mode-pointer', mode === 'pointer');
}
setMode('hand');

// ---------------------------------------------------------------------------
// Comments (pin notes)
// ---------------------------------------------------------------------------
function placePins(n: number): void {
  const layer = wrappers[n - 1].querySelector('.mc-annot-layer') as HTMLElement;
  layer.innerHTML = '';
  comments
    .filter((c) => c.page === n)
    .forEach((c) => {
      const pin = document.createElement('button');
      pin.className = 'mc-pin';
      pin.type = 'button';
      pin.dataset.id = c.id;
      pin.style.left = `${c.xPct * 100}%`;
      pin.style.top = `${c.yPct * 100}%`;
      pin.title = c.text || 'Comment';
      pin.setAttribute('aria-label', 'Comment');
      pin.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      pin.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openNote(c, pin);
      });
      layer.appendChild(pin);
    });
}

function addCommentAt(pageEl: HTMLElement, clientX: number, clientY: number): void {
  const n = Number(pageEl.dataset.page);
  const rect = pageEl.getBoundingClientRect();
  const xPct = clamp01((clientX - rect.left) / rect.width);
  const yPct = clamp01((clientY - rect.top) / rect.height);
  const c: Comment = { id: `c${Date.now()}_${++commentSeq}`, page: n, xPct, yPct, text: '' };
  comments.push(c);
  placePins(n);
  const pin = pageEl.querySelector(`.mc-pin[data-id="${c.id}"]`) as HTMLElement | null;
  openNote(c, pin ?? pageEl, true);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

let noteEl: HTMLDivElement | null = null;
let noteComment: Comment | null = null;

function openNote(c: Comment, anchor: HTMLElement, isNew = false): void {
  closeNote();
  noteComment = c;
  const el = document.createElement('div');
  el.className = 'mc-note';
  el.innerHTML =
    '<textarea class="mc-note-text" placeholder="Add a comment…"></textarea>' +
    '<div class="mc-note-actions">' +
    '<button type="button" class="mc-note-delete">Delete</button>' +
    '<button type="button" class="mc-note-save">Save</button>' +
    '</div>';
  document.body.appendChild(el);
  noteEl = el;

  const textarea = el.querySelector('.mc-note-text') as HTMLTextAreaElement;
  textarea.value = c.text;

  const rect = anchor.getBoundingClientRect();
  el.style.left = `${Math.min(window.innerWidth - 280, Math.max(8, rect.left))}px`;
  el.style.top = `${Math.min(window.innerHeight - 170, rect.bottom + 6)}px`;

  const save = () => {
    c.text = textarea.value.trim();
    if (!c.text) {
      remove();
      return;
    }
    saveComments();
    placePins(c.page);
    closeNote();
  };
  const remove = () => {
    comments = comments.filter((x) => x.id !== c.id);
    saveComments();
    placePins(c.page);
    closeNote();
  };

  (el.querySelector('.mc-note-save') as HTMLButtonElement).addEventListener('click', save);
  (el.querySelector('.mc-note-delete') as HTMLButtonElement).addEventListener('click', remove);
  el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  textarea.focus();
  if (isNew) {
    // Discard a brand-new empty pin unless the user types and saves.
    textarea.addEventListener(
      'blur',
      () => {
        if (!textarea.value.trim() && noteComment === c) {
          remove();
        }
      },
      { once: true },
    );
  }
}

function closeNote(): void {
  noteEl?.remove();
  noteEl = null;
  noteComment = null;
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
interface MenuItem {
  label: string;
  run: () => void | Promise<void>;
}

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const target = e.target as HTMLElement;
  const pageEl = target.closest<HTMLElement>('.mc-page');
  const items: MenuItem[] = [];

  const selection = window.getSelection()?.toString().trim();
  if (selection) {
    items.push({ label: 'Copy Selected Text', run: () => copyText(selection) });
  }

  if (pageEl) {
    const n = Number(pageEl.dataset.page);
    const canvas = pageEl.querySelector('canvas');
    if (canvas && canvas.width > 0) {
      items.push({ label: `Copy Page ${n} as PNG`, run: () => copyPagePng(n) });
    }
    items.push({ label: `Copy Page ${n} Text`, run: () => copyText(pageText.get(n) ?? '') });
    const cx = e.clientX;
    const cy = e.clientY;
    items.push({ label: 'Add Comment Here', run: () => addCommentAt(pageEl, cx, cy) });
  }

  items.push({ label: 'Copy All Text', run: () => copyText(allText()) });
  items.push({
    label: mode === 'hand' ? 'Pointer Tool (Select Text)' : 'Hand Tool (Drag to Scroll)',
    run: () => setMode(mode === 'hand' ? 'pointer' : 'hand'),
  });
  items.push({
    label: pageAppearance() === 'normal' ? 'Dark Pages' : 'Light Pages',
    run: () => togglePages(),
  });

  showMenu(e.pageX, e.pageY, items);
});

// ---------------------------------------------------------------------------
// Dark / green pages
// ---------------------------------------------------------------------------
type PageMode = 'auto' | 'normal' | 'inverted';
let pageMode: PageMode = 'auto';

// How a page's pixels are recoloured: true colours, inverted (dark), or the
// green-theme phosphor variant of the inverted look.
type Appearance = 'normal' | 'inverted' | 'green';

function themeIsGreen(): boolean {
  return document.body.getAttribute('data-mc-theme') === 'green';
}

function isDarkTheme(): boolean {
  const t = document.body.getAttribute('data-mc-theme');
  if (t === 'dark') return true;
  // 'light' and 'green' are handled explicitly elsewhere, never as auto-dark.
  if (t === 'light' || t === 'green') return false;
  return (
    document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast')
  );
}

// The session Dark/Light Pages toggle (pageMode) overrides everything; otherwise
// the appearance follows markcopy.theme, where `green` yields the phosphor look
// and `dark` (or auto over a dark editor theme) yields plain inversion.
function pageAppearance(): Appearance {
  if (pageMode === 'inverted') return 'inverted';
  if (pageMode === 'normal') return 'normal';
  if (themeIsGreen()) return 'green';
  return isDarkTheme() ? 'inverted' : 'normal';
}

// Recolour a freshly rendered canvas in place. `difference` against white is an
// exact colour inversion (dark pages); green then multiplies that white-on-black
// by the phosphor green so the page reads green-on-black. Multiply leaves black
// black and turns white into the fill colour.
function tintCanvas(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  appearance: Appearance,
): void {
  if (appearance === 'normal') {
    return;
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (appearance === 'green') {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = PHOSPHOR_GREEN;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.restore();
}

function togglePages(): void {
  // The toggle only ever flips between true colours and dark inversion; green is
  // reached through the theme setting, not this menu item.
  pageMode = pageAppearance() === 'normal' ? 'inverted' : 'normal';
  document.body.classList.toggle('mc-pages-inverted', pageMode === 'inverted');
  document.body.classList.toggle('mc-pages-normal', pageMode === 'normal');
  // The recolour is baked into the bitmap now, so re-rasterise the visible pages.
  for (const t of renderTasks.values()) {
    t.cancel();
  }
  renderTasks.clear();
  renderedScale.clear();
  inFlight.clear();
  refresh();
}

document.addEventListener('click', () => (menu.hidden = true));

// ---------------------------------------------------------------------------
// Hand tool (drag to scroll) — active only in hand mode
// ---------------------------------------------------------------------------
let panning = false;
let panPointer = -1;
let startX = 0;
let startY = 0;
let startScrollX = 0;
let startScrollY = 0;

function scroller(): HTMLElement {
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

document.addEventListener('pointerdown', (e) => {
  if (
    e.button !== 0 ||
    mode !== 'hand' ||
    (e.target as HTMLElement).closest('#mc-menu, .mc-pin, .mc-note, #mc-toolbar')
  ) {
    return;
  }
  panning = true;
  panPointer = e.pointerId;
  startX = e.clientX;
  startY = e.clientY;
  const s = scroller();
  startScrollX = s.scrollLeft;
  startScrollY = s.scrollTop;
  document.body.classList.add('mc-grabbing');
  try {
    s.setPointerCapture(e.pointerId);
  } catch {
    /* best-effort */
  }
});

document.addEventListener('pointermove', (e) => {
  if (!panning || e.pointerId !== panPointer) {
    return;
  }
  const s = scroller();
  s.scrollLeft = startScrollX - (e.clientX - startX);
  s.scrollTop = startScrollY - (e.clientY - startY);
});

function endPan(): void {
  panning = false;
  panPointer = -1;
  document.body.classList.remove('mc-grabbing');
}
document.addEventListener('pointerup', endPan);
document.addEventListener('pointercancel', endPan);

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
function buildToolbar(): void {
  const bar = document.createElement('div');
  bar.id = 'mc-toolbar';
  bar.innerHTML =
    '<button type="button" data-act="out" title="Zoom out (Ctrl -)">−</button>' +
    '<span id="mc-zoom-label" title="Reset zoom (Ctrl 0)">100%</span>' +
    '<button type="button" data-act="in" title="Zoom in (Ctrl +)">+</button>';
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  bar.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.id === 'mc-zoom-label') {
      zoomReset();
      return;
    }
    const act = target.closest('button')?.dataset.act;
    if (act === 'in') zoomIn();
    else if (act === 'out') zoomOut();
  });
  document.body.appendChild(bar);
}
buildToolbar();

function showMenu(x: number, y: number, items: MenuItem[]): void {
  menu.innerHTML = '';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'mc-menu-item';
    el.setAttribute('role', 'menuitem');
    el.tabIndex = 0;
    el.textContent = item.label;
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      menu.hidden = true;
      void item.run();
    });
    menu.appendChild(el);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------
function allText(): string {
  return Array.from(pageText.keys())
    .sort((a, b) => a - b)
    .map((n) => pageText.get(n) ?? '')
    .join('\n\n')
    .trim();
}

function copyText(text: string): void {
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
  if (!ok) void navigator.clipboard?.writeText(text);
  toast('Copied');
}

// Copy a page as PNG in its true colours, whatever the on-screen appearance.
async function copyPagePng(n: number): Promise<void> {
  try {
    const source = await truePageCanvas(n);
    const blob: Blob | null = await new Promise((resolve) => source.toBlob(resolve, 'image/png'));
    if (blob && navigator.clipboard && 'write' in navigator.clipboard) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Copied page as PNG');
    } else {
      toast('PNG copy not supported here');
    }
  } catch {
    toast('PNG copy failed');
  }
}

// A canvas holding the page in its original colours. For `inverted` the on-screen
// bitmap is an exact inversion, so we invert a throwaway copy back (fast). For
// `green` the phosphor multiply is not exactly reversible, so re-rasterise the
// page clean from pdf.js instead.
async function truePageCanvas(n: number): Promise<HTMLCanvasElement> {
  const appearance = pageAppearance();
  const onscreen = wrappers[n - 1].querySelector('canvas') as HTMLCanvasElement;

  if (appearance === 'green') {
    const page = pages[n - 1];
    const viewport = page.getViewport({ scale });
    const outputScale = outputScaleFor(viewport);
    const off = document.createElement('canvas');
    off.width = Math.floor(viewport.width * outputScale);
    off.height = Math.floor(viewport.height * outputScale);
    const octx = off.getContext('2d');
    if (octx) {
      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
      await page.render({ canvas: off, canvasContext: octx, viewport, transform }).promise;
      return off;
    }
    return onscreen;
  }

  if (appearance === 'inverted') {
    const off = document.createElement('canvas');
    off.width = onscreen.width;
    off.height = onscreen.height;
    const octx = off.getContext('2d');
    if (octx) {
      octx.drawImage(onscreen, 0, 0);
      octx.globalCompositeOperation = 'difference';
      octx.fillStyle = '#fff';
      octx.fillRect(0, 0, off.width, off.height);
      return off;
    }
  }
  return onscreen;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

vscode.postMessage({ type: 'ready' });
