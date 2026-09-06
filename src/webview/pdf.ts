import * as pdfjsLib from 'pdfjs-dist';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';
import { createMenu, type MenuEntry } from './menu';

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
// Held only so a reload can tear the previous document down. `destroy` lives on
// the loading task rather than on the document proxy, and it is also what
// terminates the worker this load is about to replace.
let loadingTask: PDFDocumentLoadingTask | null = null;
const pages: PDFPageProxy[] = []; // 1-based via index+1
const baseSize: { w: number; h: number }[] = []; // page size at scale 1 (CSS px)
const wrappers: HTMLDivElement[] = [];
const renderTasks = new Map<number, RenderTask>();
const renderedScale = new Map<number, number>(); // scale a page's canvas was rasterised at
const inFlight = new Set<number>();
const visible = new Set<number>(); // pages currently near the viewport
const pageText = new Map<number, string>();

// Zoom steps through fixed levels so the label reads cleanly (100 %, 125 %…)
// and never runs away. Fit width can land between two levels, so the source of
// truth is `scale` itself rather than an index into this list, and a step from a
// fitted scale moves to the neighbouring level by value.
const ZOOM_LEVELS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const MIN_SCALE = ZOOM_LEVELS[0];
const MAX_SCALE = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
// Slack for the by-value level search: a fitted scale can sit a rounding error
// away from a preset, and stepping should then move past it, not back onto it.
const SCALE_EPSILON = 1e-4;
let scale = 1;

// Cap the rasterised canvas so it never exceeds the browser's limit (past which
// it gets downscaled -> blurry) or exhausts memory. Roughly 4096x4096.
const MAX_CANVAS_PIXELS = 16_777_216;

// Phosphor green for the green theme's inverted pages: pure green, the same
// value as GNOME Terminal's "Green on black" profile. Matches the Markdown
// preview's `--mc-fg` in the green palette (media/preview.css).
const PHOSPHOR_GREEN = '#00ff00';

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
  } else if (msg?.type === 'setTheme' && typeof msg.value === 'string') {
    // markcopy.theme changed elsewhere (another surface or settings.json). Re-tint
    // to match, without persisting again.
    applyTheme(msg.value as string);
  } else if (msg?.type === 'texState') {
    handleTexState(msg as TexStateMessage);
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
  // Where the reader was, so a recompile can put them back. Only meaningful on a
  // reload, and `resetViewer` is about to throw the page list away, so it has to
  // be read first.
  const wasAt = wrappers.length ? pageAtViewportCenter() : 0;
  resetViewer();

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
    loadingTask = pdfjsLib.getDocument({ data });
    doc = await loadingTask.promise;
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
  updatePageLabel();
  if (wasAt > 1) {
    // A LaTeX preview reloads on every save. Landing back at page 1 each time
    // would make the preview unusable for anything longer than a page, so hold
    // the reader's place. Clamped by goToPage, since the document may have got
    // shorter since they were last looking at it.
    goToPage(wasAt);
  }
  toast(`Loaded ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`);
}

/**
 * Drop everything belonging to the document currently on screen.
 *
 * The PDF preview only ever loads once, so for years this did not need to exist.
 * The LaTeX preview reloads on every recompile, and without it each reload
 * appended to `pages` and `wrappers` while the DOM was rebuilt from scratch, so
 * every page-indexed feature (page navigation, copy page as PNG, annotations)
 * silently addressed detached elements belonging to the previous compile.
 */
function resetViewer(): void {
  // Rasterisation already in flight is writing into canvases that are about to
  // be detached. Cancelling first also stops pdf.js complaining about render
  // tasks whose page proxy is destroyed underneath them.
  for (const task of renderTasks.values()) {
    task.cancel();
  }
  renderTasks.clear();
  observer?.disconnect();
  observer = null;
  // The worker holds the old document open until this resolves; a long editing
  // session is a lot of abandoned documents otherwise.
  void loadingTask?.destroy();
  loadingTask = null;
  doc = null;
  pages.length = 0;
  baseSize.length = 0;
  wrappers.length = 0;
  renderedScale.clear();
  inFlight.clear();
  visible.clear();
  pageText.clear();
  root.textContent = '';
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
// Where the viewport centre sits inside a page, held as fractions of that page's
// box so the point survives a resize.
interface ZoomAnchor {
  page: number;
  yFrac: number;
  xFrac: number;
}

// Record the point the reader is looking at, before the pages change size.
function captureZoomAnchor(): ZoomAnchor | null {
  if (!wrappers.length) {
    return null;
  }
  const page = pageAtViewportCenter();
  const rect = wrappers[page - 1].getBoundingClientRect();
  if (!rect.height || !rect.width) {
    return null;
  }
  // The centre can land in the gap between two pages, and gaps are fixed
  // padding that does not scale. Clamping anchors to the page edge instead, so
  // the gap stays a gap rather than being stretched by the zoom factor.
  const frac = (v: number): number => Math.min(1, Math.max(0, v));
  return {
    page,
    yFrac: frac((window.innerHeight / 2 - rect.top) / rect.height),
    xFrac: frac((window.innerWidth / 2 - rect.left) / rect.width),
  };
}

// Put the anchored point back under the viewport centre. Without this the scroll
// offset keeps its pixel value while every page above it grows or shrinks, so a
// zoom silently carries the reader to a different page. Reading the rect flushes
// the pending layout, so the deltas are measured against the new page sizes.
function restoreZoomAnchor(anchor: ZoomAnchor | null): void {
  if (!anchor) {
    return;
  }
  const rect = wrappers[anchor.page - 1].getBoundingClientRect();
  const s = scroller();
  s.scrollTop += rect.top + anchor.yFrac * rect.height - window.innerHeight / 2;
  s.scrollLeft += rect.left + anchor.xFrac * rect.width - window.innerWidth / 2;
}

function setScale(next: number): void {
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  if (clamped === scale) {
    return;
  }
  const anchor = captureZoomAnchor();
  scale = clamped;
  updateZoomLabel();

  // Resize placeholders immediately (keeps scroll layout correct), then
  // re-rasterise the visible pages once zooming settles.
  for (let n = 1; n <= (doc?.numPages ?? 0); n++) {
    renderTasks.get(n)?.cancel();
    layoutPage(n);
  }
  restoreZoomAnchor(anchor);
  renderedScale.clear();
  inFlight.clear();
  window.clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(() => {
    refresh();
    // The anchor holds the page in place, but at the very top or bottom of the
    // document the browser clamps the scroll offset and the midline can still
    // shift; resync the label with wherever the view actually ended up.
    currentPage = pageAtViewportCenter();
    updatePageLabel();
  }, 120);
}

// The three manual controls drop fit width: the user has asked for a specific
// size, so the pages should stop chasing the pane's width.
function zoomIn(): void {
  setFitWidth(false);
  setScale(ZOOM_LEVELS.find((z) => z > scale + SCALE_EPSILON) ?? MAX_SCALE);
}
function zoomOut(): void {
  setFitWidth(false);
  const below = ZOOM_LEVELS.filter((z) => z < scale - SCALE_EPSILON);
  setScale(below.length ? below[below.length - 1] : MIN_SCALE);
}
function zoomReset(): void {
  setFitWidth(false);
  setScale(1);
}

// ---------------------------------------------------------------------------
// Fit width
// ---------------------------------------------------------------------------
// Fit width is a mode, not a one-shot: while it is on, resizing the editor pane
// re-fits instead of leaving the pages at a size that no longer matches. Any
// manual zoom turns it off again.
let fitWidth = false;
let fitTimer = 0;
// Base width of the page the live fit was computed from. Pages within one PDF
// can differ in size, so a scroll onto a differently sized page has to re-fit;
// comparing widths keeps the usual uniform document from re-fitting at all.
let fittedBaseWidth = 0;
// Breathing room either side of the paper, so a fitted page does not butt
// against the pane edges or trip a horizontal scrollbar on a rounding error.
const FIT_WIDTH_MARGIN = 32;

// Pages within one PDF can differ in size, so fit whichever page is being read
// (the one under the midline) rather than the first or the widest.
function fitWidthScale(): number | null {
  const base = baseSize[currentPage - 1];
  if (!base?.w) {
    return null;
  }
  // clientWidth excludes the vertical scrollbar, so the fitted page accounts for
  // the gutter the scrollbar already occupies.
  const avail = scroller().clientWidth - FIT_WIDTH_MARGIN;
  return avail > 0 ? avail / base.w : null;
}

function setFitWidth(on: boolean): void {
  if (fitWidth === on) {
    return;
  }
  fitWidth = on;
  // A queued re-fit must not outlive the mode. Its callback is applyFitWidth,
  // which turns fit width straight back on, so a manual zoom landing inside the
  // debounce window would otherwise be undone and the button would relight.
  window.clearTimeout(fitTimer);
  document.getElementById('mc-fit-width')?.setAttribute('aria-pressed', String(on));
}

function applyFitWidth(): void {
  const next = fitWidthScale();
  if (next === null) {
    return;
  }
  setFitWidth(true);
  fittedBaseWidth = baseSize[currentPage - 1].w;
  setScale(next);
}

// Turning the mode off leaves the pages at the size they already have and just
// stops them chasing the pane, which is what the pressed state describes.
function toggleFitWidth(): void {
  if (fitWidth) {
    setFitWidth(false);
  } else {
    applyFitWidth();
  }
}

// Debounced: a pane drag fires resize continuously, and each fit re-lays out
// every page.
function queueFitWidth(): void {
  window.clearTimeout(fitTimer);
  fitTimer = window.setTimeout(applyFitWidth, 120);
}

// Called when the midline moves onto another page. The fit is computed from the
// page being read, so a mixed portrait/landscape document has to re-fit as the
// reader crosses between the two; an equal width means there is nothing to do.
function refitForCurrentPage(): void {
  if (!fitWidth || baseSize[currentPage - 1]?.w === fittedBaseWidth) {
    return;
  }
  queueFitWidth();
}

window.addEventListener('resize', () => {
  if (!fitWidth) {
    return;
  }
  queueFitWidth();
});

function updateZoomLabel(): void {
  const label = document.getElementById('mc-zoom-label');
  if (label) {
    label.textContent = `${Math.round(scale * 100)}%`;
  }
}

// Ctrl/Cmd + wheel zooms one level per notch. preventDefault stops the browser's
// own page zoom; the debounce in setScale keeps rapid notches cheap.
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
    contextMenu.hide();
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
// TeX compile-status overlay
// ---------------------------------------------------------------------------
// Set once any texState message arrives. A plain .pdf's host (src/pdfEditor.ts)
// never sends one, so this stays false and the "Recompile LaTeX" menu entry
// never appears there.
let texMode = false;

/**
 * Compile status pushed by the host's tex editor provider (src/texEditor.ts,
 * owned separately). This webview does not know or care what a compile is: it
 * just lays out whatever text/detail/action the host hands it.
 */
interface TexStateMessage {
  type: 'texState';
  state: 'compiling' | 'failed' | 'unavailable' | 'ok';
  text?: string;
  /** Compiler output, shown in a smaller monospace block when present. */
  detail?: string;
  /** Label for the recompile button; no button at all when this is absent, since
   * some states are dead ends (compiling switched off in settings, no LaTeX
   * engine installed) and a button that cannot help is worse than no button. */
  action?: string;
}

interface TexOverlay {
  root: HTMLDivElement;
  spinner: HTMLDivElement;
  text: HTMLParagraphElement;
  detail: HTMLPreElement;
  actions: HTMLDivElement;
  button: HTMLButtonElement;
}
let texOverlay: TexOverlay | null = null;

// Built lazily on the first texState message rather than up front. A plain PDF
// never sends that message, so for it this function is simply never called and
// nothing tex-related ever touches the DOM.
function ensureTexOverlay(): TexOverlay {
  if (texOverlay) {
    return texOverlay;
  }
  const root = document.createElement('div');
  root.className = 'mc-tex-overlay';
  root.hidden = true;

  const card = document.createElement('div');
  card.className = 'mc-tex-card';

  const spinner = document.createElement('div');
  spinner.className = 'mc-tex-spinner';
  spinner.setAttribute('aria-hidden', 'true');

  const text = document.createElement('p');
  text.className = 'mc-tex-text';

  const detail = document.createElement('pre');
  detail.className = 'mc-tex-detail';
  detail.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'mc-tex-actions';
  actions.hidden = true;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mc-tex-button';
  button.addEventListener('click', () => vscode.postMessage({ type: 'texRecompile' }));
  actions.appendChild(button);

  card.append(spinner, text, detail, actions);
  root.appendChild(card);
  document.body.appendChild(root);

  texOverlay = { root, spinner, text, detail, actions, button };
  return texOverlay;
}

function handleTexState(msg: TexStateMessage): void {
  texMode = true; // gates the "Recompile LaTeX" context-menu entry, from here on
  const overlay = ensureTexOverlay();

  if (msg.state === 'ok') {
    overlay.root.hidden = true;
    return;
  }

  // No pages rendered yet means the overlay IS the whole viewer, so centre it in
  // the full viewport rather than pin it near the top like a banner over content
  // that doesn't exist. Once pages exist (a recompile), keep them on screen
  // underneath instead of blanking the view: losing the reader's scroll position
  // on every save would be miserable.
  overlay.root.classList.toggle('mc-tex-overlay--empty', wrappers.length === 0);

  overlay.spinner.hidden = msg.state !== 'compiling';
  overlay.text.textContent = msg.text ?? '';
  overlay.detail.hidden = !msg.detail;
  overlay.detail.textContent = msg.detail ?? '';
  overlay.actions.hidden = !msg.action;
  overlay.button.textContent = msg.action ?? '';
  // Nothing is clickable while compiling, and a recompile runs over a document
  // that's already on screen, so every pointer event (scroll, right-click, the
  // works) has to fall straight through the overlay instead of landing on it.
  overlay.root.classList.toggle('mc-tex-overlay--inert', msg.state === 'compiling');
  overlay.root.hidden = false;
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
const contextMenu = createMenu(menu);

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const target = e.target as HTMLElement;
  const pageEl = target.closest<HTMLElement>('.mc-page');
  const entries: MenuEntry[] = [];
  // The remaining copy formats, one level down under "Copy as".
  const variants: MenuEntry[] = [];

  const selection = window.getSelection()?.toString().trim();
  if (selection) {
    entries.push({ kind: 'item', label: 'Copy Selection', run: () => copyText(selection) });
  }

  if (pageEl) {
    const n = Number(pageEl.dataset.page);
    const canvas = pageEl.querySelector('canvas');
    // A page's image is the headline action, so it stays at the top level when
    // it's available; its text drops into "Copy as" alongside the document's.
    if (canvas && canvas.width > 0) {
      entries.push({ kind: 'item', label: `Copy Page ${n} as PNG`, run: () => copyPagePng(n) });
    }
    variants.push({
      kind: 'item',
      label: `Page ${n} Text`,
      run: () => copyText(pageText.get(n) ?? ''),
    });
  }

  variants.push({ kind: 'item', label: 'All Text', run: () => copyText(allText()) });
  entries.push({ kind: 'submenu', label: 'Copy as', entries: variants });

  if (pageEl) {
    const cx = e.clientX;
    const cy = e.clientY;
    entries.push({ kind: 'divider' });
    entries.push({
      kind: 'item',
      label: 'Add Comment Here',
      run: () => addCommentAt(pageEl, cx, cy),
    });
  }

  if (texMode) {
    entries.push({ kind: 'divider' });
    entries.push({
      kind: 'item',
      label: 'Recompile LaTeX',
      run: () => vscode.postMessage({ type: 'texRecompile' }),
    });
  }

  entries.push({ kind: 'divider' });
  entries.push({ kind: 'submenu', label: 'Preferences', entries: preferenceEntries() });

  contextMenu.show(e.pageX, e.pageY, entries);
});

// View settings, mirroring the Markdown preview's "Preferences" submenu
// (buildSettingsEntries in main.ts). Picking a theme persists markcopy.theme,
// which both surfaces share, and re-tints the pages.
function preferenceEntries(): MenuEntry[] {
  return [
    {
      kind: 'item',
      label: mode === 'hand' ? 'Pointer Tool (Select Text)' : 'Hand Tool (Drag to Scroll)',
      run: () => setMode(mode === 'hand' ? 'pointer' : 'hand'),
    },
    {
      kind: 'item',
      label: pageAppearance() === 'normal' ? 'Dark Pages' : 'Light Pages',
      run: () => togglePages(),
    },
    { kind: 'divider' },
    { kind: 'submenu', label: 'Theme', entries: themeItems() },
  ];
}

// The Auto/Light/Dark/Green radio group, identical in labels and behavior to the
// Markdown preview's Theme submenu.
function themeItems(): MenuEntry[] {
  const entry = (label: string, value: string): MenuEntry => ({
    kind: 'radio',
    label,
    checked: currentTheme === value,
    run: () => setTheme(value),
  });
  return [
    entry('Auto', 'auto'),
    entry('Light', 'light'),
    entry('Dark', 'dark'),
    entry('Green on black', 'green'),
  ];
}

// ---------------------------------------------------------------------------
// Dark / green pages
// ---------------------------------------------------------------------------
type PageMode = 'auto' | 'normal' | 'inverted';
let pageMode: PageMode = 'auto';

// The active markcopy.theme, seeded from the host's data-mc-theme attribute and
// changed via the Theme menu.
let currentTheme = document.body.getAttribute('data-mc-theme') || 'auto';

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

// Session-only quick invert (does not touch the persisted theme): flips between
// true colours and dark inversion for the current view. The Theme menu is the
// persistent, cross-surface control; this stays for a one-off "invert this PDF".
function togglePages(): void {
  pageMode = pageAppearance() === 'normal' ? 'inverted' : 'normal';
  document.body.classList.toggle('mc-pages-inverted', pageMode === 'inverted');
  document.body.classList.toggle('mc-pages-normal', pageMode === 'normal');
  rerenderPages();
}

// Apply a theme visually: update the attribute the appearance logic keys off,
// clear any session Dark/Light override so the theme drives the look, and re-tint.
// Does NOT persist, so it is safe to call from a host-pushed theme change. No-ops
// when the theme already matches and there is no session override to clear, so
// the host echoing back our own change costs nothing.
function applyTheme(value: string): void {
  if (value === currentTheme && pageMode === 'auto') {
    return;
  }
  currentTheme = value;
  document.body.setAttribute('data-mc-theme', value);
  pageMode = 'auto';
  document.body.classList.remove('mc-pages-inverted', 'mc-pages-normal');
  rerenderPages();
}

// Apply a theme picked from the Theme menu, then persist markcopy.theme (shared
// with the Markdown preview and any other open PDF viewers) and confirm with a
// toast.
function setTheme(value: string): void {
  applyTheme(value);
  vscode.postMessage({ type: 'updateSetting', key: 'theme', value });
  const labels: Record<string, string> = {
    auto: 'Auto',
    light: 'Light',
    dark: 'Dark',
    green: 'Green on black',
  };
  toast(`Theme: ${labels[value] ?? value}`);
}

// Drop every rendered page and re-rasterise the visible ones. Used whenever the
// page recolour changes (the tint is baked into the bitmap, not a live filter).
function rerenderPages(): void {
  for (const t of renderTasks.values()) {
    t.cancel();
  }
  renderTasks.clear();
  renderedScale.clear();
  inFlight.clear();
  refresh();
}

document.addEventListener('click', () => contextMenu.hide());

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
    (e.target as HTMLElement).closest('.mc-menu, .mc-pin, .mc-note, #mc-toolbar')
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
// Page indicator
// ---------------------------------------------------------------------------
let currentPage = 1;
let pageScrollRaf = 0;
// Set by goToPage when its scrollIntoView actually moved the view: the scroll
// event that lands next is the jump itself, not the user scrolling away, so the
// midline scan skips once and the label keeps the page the user asked for (a
// target shorter than half the viewport can never reach the midline).
let pageJumpScrollPending = false;

// The page under the vertical middle of the viewport. Wrappers are in document
// order, so once a page starts below the midline no later page can match; bail
// out there to keep the scan cheap on long documents.
function pageAtViewportCenter(): number {
  const mid = window.innerHeight / 2;
  let best = currentPage;
  let bestDist = Infinity;
  for (let i = 0; i < wrappers.length; i++) {
    const rect = wrappers[i].getBoundingClientRect();
    if (rect.top <= mid && rect.bottom >= mid) {
      return i + 1;
    }
    if (rect.top > mid) {
      // First page fully below the midline: it (or the previous one) is the
      // nearest; nothing further down can be closer.
      if (rect.top - mid < bestDist) {
        best = i + 1;
      }
      break;
    }
    const dist = mid - rect.bottom; // page is fully above the midline
    if (dist < bestDist) {
      bestDist = dist;
      best = i + 1;
    }
  }
  return best;
}

function updatePageLabel(): void {
  const label = document.getElementById('mc-page-label');
  if (label) {
    label.textContent = doc ? `${currentPage} / ${doc.numPages}` : '';
  }
}

window.addEventListener(
  'scroll',
  () => {
    if (pageScrollRaf) {
      return;
    }
    pageScrollRaf = requestAnimationFrame(() => {
      pageScrollRaf = 0;
      if (pageJumpScrollPending) {
        pageJumpScrollPending = false;
        return; // the label already shows the page goToPage jumped to
      }
      const n = pageAtViewportCenter();
      if (n !== currentPage) {
        currentPage = n;
        updatePageLabel();
        refitForCurrentPage();
      }
    });
  },
  { passive: true },
);

function goToPage(n: number): void {
  if (!doc) {
    return;
  }
  const clamped = Math.min(doc.numPages, Math.max(1, n));
  const s = scroller();
  const { scrollTop, scrollLeft } = s;
  wrappers[clamped - 1].scrollIntoView({ block: 'start' });
  // Instant scrollIntoView updates the scroll position synchronously; arm the
  // one-shot scan suppression only when it actually moved, so a no-op jump
  // (already there) does not swallow the next real scroll's recompute.
  pageJumpScrollPending = s.scrollTop !== scrollTop || s.scrollLeft !== scrollLeft;
  currentPage = clamped;
  updatePageLabel();
  refitForCurrentPage();
}

// Swap the "3 / 12" label for a number input; Enter jumps, Escape/blur cancels.
function beginPageJump(): void {
  if (!doc) {
    return;
  }
  const label = document.getElementById('mc-page-label');
  if (!label || label.hidden) {
    return;
  }
  const input = document.createElement('input');
  input.id = 'mc-page-input';
  input.type = 'number';
  input.min = '1';
  input.max = String(doc.numPages);
  input.value = String(currentPage);
  input.setAttribute('aria-label', 'Go to page');
  label.hidden = true;
  label.insertAdjacentElement('afterend', input);

  // Removing the input fires its blur handler mid-removal, which would re-enter
  // done() and throw; run it once only.
  let closed = false;
  const done = () => {
    if (closed) {
      return;
    }
    closed = true;
    input.remove();
    label.hidden = false;
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep viewer shortcuts (Escape, Ctrl+0…) out of the input
    if (e.key === 'Enter') {
      // valueAsNumber, not parseInt: number inputs accept scientific notation,
      // and parseInt would read "1e3" as page 1 instead of 1000. Round because
      // the value can still be fractional and wrappers is integer-indexed.
      const n = Math.round(input.valueAsNumber);
      done();
      label.focus(); // hand focus back for keyboard users (blur-away cancels skip this)
      if (Number.isFinite(n)) {
        goToPage(n);
      }
    } else if (e.key === 'Escape') {
      done();
      label.focus();
    }
  });
  input.addEventListener('blur', done);
  input.focus();
  input.select();
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
function buildToolbar(): void {
  const bar = document.createElement('div');
  bar.id = 'mc-toolbar';
  // The page and zoom labels are real <button>s (not spans) so they are
  // keyboard-focusable and Enter/Space activates them like a click.
  bar.innerHTML =
    '<button type="button" id="mc-page-label" title="Go to page…"></button>' +
    '<span class="mc-toolbar-sep" aria-hidden="true"></span>' +
    '<button type="button" data-act="out" title="Zoom out (Ctrl -)">−</button>' +
    '<button type="button" id="mc-zoom-label" title="Reset zoom (Ctrl 0)">100%</button>' +
    '<button type="button" data-act="in" title="Zoom in (Ctrl +)">+</button>' +
    '<span class="mc-toolbar-sep" aria-hidden="true"></span>' +
    // Folio's fit-width icon (src/components/common/Icon.tsx there): a page with
    // a double-headed arrow across it, stroked in currentColor so it follows the
    // toolbar's foreground in every theme. The icon carries no meaning to a
    // screen reader, so the button gets an explicit label; the title is the
    // sighted equivalent.
    '<button type="button" id="mc-fit-width" data-act="fit" aria-pressed="false" ' +
    'aria-label="Fit page width" title="Fit page width">' +
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
    'focusable="false">' +
    '<rect x="3" y="5" width="18" height="14" rx="2" />' +
    '<path d="M8 12h8" /><path d="M10 9l-3 3 3 3" /><path d="M14 9l3 3-3 3" />' +
    '</svg></button>';
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  bar.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.id === 'mc-zoom-label') {
      zoomReset();
      return;
    }
    if (target.id === 'mc-page-label') {
      beginPageJump();
      return;
    }
    const act = target.closest('button')?.dataset.act;
    if (act === 'in') zoomIn();
    else if (act === 'out') zoomOut();
    else if (act === 'fit') toggleFitWidth();
  });
  document.body.appendChild(bar);
}
buildToolbar();

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
