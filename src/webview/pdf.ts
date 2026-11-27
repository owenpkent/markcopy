import * as pdfjsLib from 'pdfjs-dist';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from 'pdfjs-dist';
import { createMenu, revealLabel, type MenuEntry } from './menu';
import { fromHost } from './fromHost';
import { MAX_COMMENT_COUNT, MAX_COMMENT_TEXT, MAX_COMMENT_TOTAL_TEXT } from '../pdfComments';
import { validatePosition, type PdfPosition } from '../pdfPosition';
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
} from './pdfAutoScroll';
import { hasImageOps, imageCoverageOps, recolourKeepingImages } from './pdfRecolour';
import {
  destinationOffsetY,
  linkRegions,
  linkTargetOf,
  linkText,
  regionsContain,
  unionBox,
  namedActionPage,
  resolveDestination,
  type Destination,
  type LinkAnnotation,
  type LinkTarget,
  type PercentBox,
} from './pdfLinks';

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
// the loading task rather than on the document proxy.
let loadingTask: PDFDocumentLoadingTask | null = null;
// The worker backing the current document, plus the blob URL it was started
// from. `PDFWorker` only owns (and terminates) a worker it constructed itself;
// handed a ready-made one through `workerPort`, as `load` does below, it calls
// `#initializeFromPort` instead and its own `destroy()` never touches that
// worker at all. Left to `loadingTask.destroy()` alone, the worker (and the
// blob URL) this load is about to replace would simply leak -- fine for the
// PDF preview, which loads once, but the LaTeX preview reloads on every save,
// so 50 saves would mean 50 live worker threads each holding the full pdf.js
// bundle. Tracked here so `resetViewer` can terminate and revoke them by hand.
let currentWorker: Worker | null = null;
let currentWorkerUrl: string | null = null;
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
const PHOSPHOR_GREEN_RGB = [0, 255, 0] as const;

// The parts of a page's pdf.js operator list the dark-page recolour reads.
interface PageOps {
  fnArray: number[];
  argsArray: unknown[];
}

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
  if (!fromHost(e)) {
    return;
  }
  const msg = e.data;
  if (msg?.type === 'load') {
    const editing = noteEl && noteComment ? noteComment : null;
    comments = Array.isArray(msg.comments) ? (msg.comments as Comment[]) : [];
    commentSeq = comments.length;
    if (editing) {
      // An open editor holds the user's draft in its textarea. Bind it to the
      // refreshed comment so Save persists the draft; a comment the fresh data
      // lacks (new, never saved) is kept so the draft is not lost.
      const fresh = comments.find((x) => x.id === editing.id);
      if (fresh) {
        noteComment = fresh;
      } else {
        comments.push(editing);
      }
    }
    if ('resume' in msg) {
      // The PDF preview's host sends where the reader was (or null); the LaTeX
      // preview's does not, and keeps its own place across recompiles.
      reportPosition = true;
      pendingResume = validatePosition(msg.resume) ?? null;
    }
    load(base64ToBytes(msg.data as string)).catch(showFatal);
  } else if (msg?.type === 'loadError' && typeof msg.message === 'string') {
    showFatal(msg.message);
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

// A persistent live region outside the auto-scroll puck, so a message still
// reaches a screen reader after the puck hides itself (at the top or end of the
// document). The toast div is hidden when idle, which makes it a poor live
// region, so this one is a separate node that is always in the page.
const statusEl = document.createElement('div');
statusEl.id = 'mc-status';
statusEl.className = 'mc-sr-only';
statusEl.setAttribute('role', 'status');
statusEl.setAttribute('aria-live', 'polite');
document.body.appendChild(statusEl);
let statusTimer = 0;
function announce(text: string): void {
  // Clear first so repeating the same text is announced again.
  statusEl.textContent = '';
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    statusEl.textContent = text;
  }, 30);
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
// True while a document is being (re)built: the pages are placeholders in the
// making and the scroll position is not the reader's, so auto-scroll holds still.
let loadingDoc = false;
async function load(data: Uint8Array): Promise<void> {
  loadingDoc = true;
  try {
    await loadDocument(data);
  } finally {
    loadingDoc = false;
    // Restoration moved the page; carry on from where it landed.
    autoPos = scroller().scrollTop;
    autoLast = 0;
  }
}

async function loadDocument(data: Uint8Array): Promise<void> {
  // Where the reader was, so a recompile can put them back. Only meaningful on a
  // reload, and `resetViewer` is about to throw the page list away, so it has to
  // be read first.
  const wasAt = wrappers.length ? pageAtViewportCenter() : 0;
  resetViewer();
  jumpedWhileLoading = false;

  // Run pdf.js off the main thread. The worker script is a webview-resource URI
  // (cross-origin to the vscode-webview:// document), so `new Worker(workerSrc)`
  // would throw a SecurityError; fetch it and start from a same-origin blob URL.
  // Its address is written into the page by the host (`data-worker-src` on
  // <body>) rather than carried by the load message, so the one URL this page
  // fetches is never a value a message could supply.
  // Three hosts write this page (the PDF editor, the LaTeX preview and the
  // screenshot harness); one that forgets the attribute should fail in words.
  const workerSrc = document.body.dataset.workerSrc ?? '';
  if (!workerSrc) {
    root.innerHTML = `<pre class="mc-error">Failed to start PDF worker: the page has no data-worker-src</pre>`;
    return;
  }
  try {
    const res = await fetch(workerSrc);
    const code = await res.text();
    const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    currentWorker = new Worker(blobUrl, { type: 'module' });
    currentWorkerUrl = blobUrl;
    pdfjsLib.GlobalWorkerOptions.workerPort = currentWorker;
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
      '<div class="mc-link-layer"></div><div class="mc-annot-layer"></div>';
    root.appendChild(wrap);
    wrappers.push(wrap);
    layoutPage(n);
    observer.observe(wrap);
    if (pendingJump && wrappers.length >= pendingJump.page) {
      const job = pendingJump;
      pendingJump = null;
      job.run();
      jumpedWhileLoading = true;
    }
    applyPendingOffset();
  }

  updateZoomLabel();
  updatePageLabel();
  const resume = pendingResume;
  pendingResume = null;
  const jumped = jumpedWhileLoading;
  jumpedWhileLoading = false;
  if (jumped) {
    // The reader followed a link while the pages were still being laid out; that
    // is where they asked to be.
  } else if (resume && wasAt === 0) {
    resumeAt(resume);
  } else if (wasAt > 1) {
    // A LaTeX preview reloads on every save. Landing back at page 1 each time
    // would make the preview unusable for anything longer than a page, so hold
    // the reader's place. Clamped by goToPage, since the document may have got
    // shorter since they were last looking at it.
    goToPage(wasAt);
  }
  // Report only from here: the viewer sits at page 1 while it is laid out and
  // that must not overwrite the position that was just read back.
  positionTracked = reportPosition;
  toast(`Loaded ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`);
}

// ---------------------------------------------------------------------------
// Reading position
// ---------------------------------------------------------------------------
// Reopening a PDF returns to the page, the spot on it and the zoom. The host keeps
// the positions (src/pdfPosition.ts); this reports the current one when scrolling
// or zooming settles and when the view hides, and applies the saved one once the
// page placeholders exist (they are sized without rasterising, so the scroll
// offset is exact and the lazy renderer simply follows).
let reportPosition = false;
let positionTracked = false;
let pendingResume: PdfPosition | null = null;
let positionTimer = 0;
const POSITION_DEBOUNCE_MS = 600;
// While the view keeps moving (a long drag, auto-scroll) the debounce never
// fires, so a checkpoint goes out at most this often as well. Closing the editor
// then loses at most this much reading.
const POSITION_CHECKPOINT_MS = 2000;
let positionMoving = false;
let lastCheckpoint = 0;

function resumeAt(p: PdfPosition): void {
  // A page past the end means the file is a different one now: ignore, do not clamp.
  if (!doc || p.page > doc.numPages) {
    return;
  }
  currentPage = p.page;
  if (p.fitWidth) {
    applyFitWidth();
  } else {
    setScale(p.zoom);
  }
  const rect = wrappers[p.page - 1].getBoundingClientRect();
  const s = scroller();
  const before = s.scrollTop;
  s.scrollTop += rect.top + p.y * rect.height;
  pageJumpScrollPending = s.scrollTop !== before;
  updatePageLabel();
}

// The page at the top of the view and how far down it the top edge sits.
function currentPosition(): PdfPosition | null {
  if (!doc || !wrappers.length) {
    return null;
  }
  for (let i = 0; i < wrappers.length; i++) {
    const rect = wrappers[i].getBoundingClientRect();
    if (rect.bottom > 0 || i === wrappers.length - 1) {
      const y = rect.height > 0 ? Math.min(1, Math.max(0, -rect.top / rect.height)) : 0;
      return { page: i + 1, y, zoom: scale, fitWidth };
    }
  }
  return null;
}

function postPosition(): void {
  const position = positionTracked ? currentPosition() : null;
  if (position) {
    lastCheckpoint = Date.now();
    vscode.postMessage({ type: 'savePosition', ...position });
  }
}

function flushPosition(): void {
  window.clearTimeout(positionTimer);
  positionTimer = 0;
  positionMoving = false;
  postPosition();
}

function queuePosition(): void {
  if (!positionTracked) {
    return;
  }
  // One update on the first movement, a checkpoint every couple of seconds while
  // it goes on, and the settled position once it stops.
  if (!positionMoving || Date.now() - lastCheckpoint >= POSITION_CHECKPOINT_MS) {
    positionMoving = true;
    postPosition();
  }
  window.clearTimeout(positionTimer);
  positionTimer = window.setTimeout(flushPosition, POSITION_DEBOUNCE_MS);
}

window.addEventListener('scroll', queuePosition, { passive: true });
window.addEventListener('pagehide', flushPosition);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushPosition();
  }
});

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
  positionTracked = false;
  // Anything still waiting belongs to the document being replaced: a link offset
  // must not land on the next one, and a lookup in flight must not run on it.
  navGeneration++;
  pendingJump = null;
  pendingOffset = null;
  observer?.disconnect();
  observer = null;
  // The worker holds the old document open until this resolves; a long editing
  // session is a lot of abandoned documents otherwise. `destroy()` does NOT
  // also stop the worker (see the comment on `currentWorker` above), so that
  // is done explicitly here, along with the blob URL it was started from.
  void loadingTask?.destroy();
  loadingTask = null;
  currentWorker?.terminate();
  currentWorker = null;
  if (currentWorkerUrl) {
    URL.revokeObjectURL(currentWorkerUrl);
    currentWorkerUrl = null;
  }
  doc = null;
  pages.length = 0;
  baseSize.length = 0;
  wrappers.length = 0;
  renderedScale.clear();
  inFlight.clear();
  visible.clear();
  pageText.clear();
  pageLinks.clear();
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
  // The filter keeps every operation; it is only there to hand back the page's
  // operator list, which tells us whether the page paints any images.
  let opList: PageOps | undefined;
  const task = page.render({
    canvas,
    canvasContext: ctx,
    viewport,
    transform,
    operationsFilter: (_i, list) => {
      opList = list;
      return true;
    },
  });
  renderTasks.set(n, task);
  await task.promise;

  // Dark/green pages: recolour the rasterised pixels here rather than with a CSS
  // filter. A CSS filter forces the browser to re-rasterise the layer at CSS
  // resolution (blurry on HiDPI); baking it into the bitmap keeps it crisp.
  const appearance = pageAppearance();
  if (appearance === 'normal' || !opList || !hasImageOps(opList.fnArray)) {
    tintCanvas(ctx, canvas, appearance);
  } else {
    await tintKeepingImages(n, ctx, canvas, appearance, viewport, transform, opList);
  }

  // Text layer: transparent, selectable spans over the canvas.
  const textContent = await page.getTextContent();
  if (!pageText.has(n)) {
    pageText.set(n, flattenText(textContent));
  }
  const textLayerDiv = wrap.querySelector('.textLayer') as HTMLElement;
  textLayerDiv.innerHTML = '';
  await new pdfjsLib.TextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport,
  }).render();

  await placeLinks(n, page);
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
  (wrap.querySelector('.mc-link-layer') as HTMLElement).textContent = '';
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------
// Each rendered page carries one box per link annotation, placed in percent of
// the page so a zoom step needs no re-layout and the boxes cannot drift from
// the canvas. They live in their own layer (the annotation layer is rebuilt for
// comment pins on every render). Clicks are resolved by geometry in one
// document listener rather than by each box's own handler, so a link still
// follows a click in pointer mode, where the boxes let events through to the
// selectable text; a drag or a selection is never taken for a click.
const MAX_LINKS_PER_PAGE = 500;
const CLICK_SLOP = 4; // px of pointer travel after which a press was a drag
interface PageLink {
  target: LinkTarget;
  /** Every region that reacts to a click. */
  regions: PercentBox[];
  /** The keyboard stop: one box around all the regions. */
  box: PercentBox;
  label: string;
}
const pageLinks = new Map<number, PageLink[]>();
const linkTargets = new WeakMap<HTMLElement, LinkTarget>();
const linkRegionsOf = new WeakMap<HTMLElement, PercentBox[]>();

// A jump to a page whose placeholder does not exist yet (a link followed while a
// long document is still being laid out) waits here, and runs as soon as it does.
let pendingJump: { page: number; run: () => void } | null = null;
let jumpedWhileLoading = false;
// A link offset that did not fit in the scroll range yet (the pages below the
// destination are still being laid out): applied again as pages arrive.
let pendingOffset: { page: number; px: number } | null = null;
function whenPageExists(page: number, run: () => void): void {
  if (wrappers.length >= page) {
    run();
  } else {
    pendingJump = { page, run };
  }
}

// The reader chose where to be (a scroll, a page entered, a link, a zoom). While
// a document is still opening that choice beats everything automatic that is
// still waiting: an older link, the offset inside a link's page, and the saved
// position. Called before the navigation itself, so a link that queues its own
// jump afterwards is not cancelled by it.
// A counter makes that cancellation reach work that has not queued anything yet,
// such as a destination lookup still waiting on pdf.js: it records the count when
// it starts and drops its result if the count has moved.
let navGeneration = 0;
function readerNavigated(): void {
  navGeneration++;
  pendingJump = null;
  pendingOffset = null;
  if (loadingDoc) {
    jumpedWhileLoading = true;
  }
}
for (const type of ['wheel', 'touchmove']) {
  window.addEventListener(
    type,
    (e) => {
      // Ctrl + wheel is zoom, which announces itself.
      if (!(e as WheelEvent).ctrlKey && !(e as WheelEvent).metaKey) {
        readerNavigated();
      }
    },
    { passive: true },
  );
}
document.addEventListener('pointerdown', (e) => {
  // A press on the page background or the scrollbar (the root element) is a drag
  // or a scrollbar jump, not a click on a control.
  if (e.target === document.documentElement) {
    readerNavigated();
  }
});

async function placeLinks(n: number, page: PDFPageProxy): Promise<void> {
  const layer = wrappers[n - 1]?.querySelector('.mc-link-layer') as HTMLElement | null;
  if (!layer) {
    return;
  }
  let entries = pageLinks.get(n);
  if (!entries) {
    try {
      const viewport = page.getViewport({ scale: 1 });
      const annots = (await page.getAnnotations({ intent: 'display' })) as LinkAnnotation[];
      const pending: Promise<PageLink>[] = [];
      for (const annot of annots) {
        const target = linkTargetOf(annot);
        const regions = target ? linkRegions(viewport, annot) : [];
        if (target && regions.length > 0 && pending.length < MAX_LINKS_PER_PAGE) {
          pending.push(
            linkLabel(target, annot).then((label) => ({
              target,
              regions,
              box: unionBox(regions),
              label,
            })),
          );
        }
      }
      entries = await Promise.all(pending);
    } catch {
      entries = []; // no links beats no page
    }
    if (pages[n - 1] !== page) {
      return; // the document was replaced while the annotations loaded
    }
    pageLinks.set(n, entries);
  }
  layer.textContent = '';
  for (const { target, regions, box, label } of entries) {
    const el = document.createElement('div');
    el.className = 'mc-link';
    el.setAttribute('role', 'link');
    el.tabIndex = 0;
    el.style.left = `${box.left}%`;
    el.style.top = `${box.top}%`;
    el.style.width = `${box.width}%`;
    el.style.height = `${box.height}%`;
    // The tooltip previews where an external link goes; the accessible name stays
    // the text it covers (or the fallback description).
    el.title = target.kind === 'url' ? boundedTitle(target.url) : label;
    el.setAttribute('aria-label', label);
    linkTargets.set(el, target);
    linkRegionsOf.set(el, regions);
    layer.appendChild(el);
  }
}

const MAX_LINK_TITLE = 200;
function boundedTitle(url: string): string {
  return url.length > MAX_LINK_TITLE ? `${url.slice(0, MAX_LINK_TITLE - 1)}\u2026` : url;
}

// What a screen reader announces for a link: the text it covers when pdf.js has
// it (the visible text sits in another layer with no tie to these boxes), else
// the page an internal link leads to, else a plain description.
async function linkLabel(target: LinkTarget, annot: LinkAnnotation): Promise<string> {
  const text = linkText(annot.overlaidText);
  if (text) {
    return text;
  }
  if (target.kind === 'url') {
    return target.url;
  }
  if (target.kind === 'named') {
    return {
      NextPage: 'Go to next page',
      PrevPage: 'Go to previous page',
      FirstPage: 'Go to first page',
      LastPage: 'Go to last page',
    }[target.action];
  }
  const current = doc;
  if (current) {
    const d = await resolveDestination(current, target.dest, current.numPages);
    if (d) {
      return `Go to page ${d.pageIndex + 1}`;
    }
  }
  return 'Go to destination';
}

function linkAt(x: number, y: number): LinkTarget | null {
  for (const el of document.querySelectorAll<HTMLElement>('.mc-link')) {
    const r = el.closest('.mc-page')?.getBoundingClientRect();
    const regions = linkRegionsOf.get(el);
    if (r && regions && r.width > 0 && r.height > 0) {
      const px = ((x - r.left) / r.width) * 100;
      const py = ((y - r.top) / r.height) * 100;
      if (regionsContain(regions, px, py)) {
        return linkTargets.get(el) ?? null;
      }
    }
  }
  return null;
}

function followLink(target: LinkTarget): void {
  if (target.kind === 'url') {
    // The host validates the address and opens it; the webview never navigates.
    vscode.postMessage({ type: 'openLink', url: target.url });
  } else if (target.kind === 'named') {
    if (doc) {
      // A navigation like any link: it supersedes an older lookup still in flight,
      // which would otherwise land first and drop this jump while it waits.
      const page = namedActionPage(target.action, currentPage, doc.numPages);
      readerNavigated();
      const token = navGeneration;
      whenPageExists(page, () => {
        if (token === navGeneration) {
          goToPage(page);
        }
      });
    }
  } else {
    // Activating a link is a navigation: it supersedes older ones and takes the
    // token its own lookup is checked against (the newest selection wins).
    readerNavigated();
    void goToDestination(target.dest, navGeneration);
  }
}

async function goToDestination(dest: string | unknown[], generation: number): Promise<void> {
  const current = doc;
  if (!current) {
    return;
  }
  const d: Destination | null = await resolveDestination(current, dest, current.numPages);
  // A newer navigation (another link, a scroll, a drag, a zoom) beats this lookup.
  if (!d || doc !== current || generation !== navGeneration) {
    return;
  }
  whenPageExists(d.pageIndex + 1, () => {
    if (doc !== current) {
      return;
    }
    goToPage(d.pageIndex + 1);
    // Land on the destination's top edge, not only its page. The page was just
    // scrolled to the top of the view, so its offset is the page-space point.
    const y = destinationOffsetY(pages[d.pageIndex].getViewport({ scale: 1 }), d.left, d.top);
    if (y === null) {
      return;
    }
    pendingOffset = {
      page: d.pageIndex + 1,
      px: Math.max(0, Math.min(y, baseSize[d.pageIndex].h)) * scale,
    };
    applyPendingOffset();
  });
}

// Put the top of the pending offset at the top of the view. The scroll range only
// reaches that far once enough pages below are laid out, so while the document is
// still opening the offset is kept and tried again as each page arrives.
function applyPendingOffset(): void {
  const job = pendingOffset;
  const wrap = job ? wrappers[job.page - 1] : undefined;
  if (!job || !wrap) {
    return;
  }
  const s = scroller();
  const before = s.scrollTop;
  const miss = wrap.getBoundingClientRect().top + job.px;
  if (Math.abs(miss) > 0.5) {
    s.scrollTop += miss;
    pageJumpScrollPending = pageJumpScrollPending || s.scrollTop !== before;
  }
  const left = wrap.getBoundingClientRect().top + job.px;
  if (Math.abs(left) <= 0.5 || !doc || wrappers.length >= doc.numPages) {
    pendingOffset = null;
  }
}

const VIEWER_CONTROLS = '.mc-menu, .mc-pin, .mc-note, #mc-toolbar, #mc-autoscroll, .mc-tex-card';
let pressX = 0;
let pressY = 0;
document.addEventListener(
  'pointerdown',
  (e) => {
    pressX = e.clientX;
    pressY = e.clientY;
  },
  true,
);
document.addEventListener('click', (e) => {
  if (
    e.button !== 0 ||
    Math.hypot(e.clientX - pressX, e.clientY - pressY) > CLICK_SLOP ||
    !(window.getSelection()?.isCollapsed ?? true)
  ) {
    return;
  }
  const target = linkAt(e.clientX, e.clientY);
  if (!target) {
    return;
  }
  // A control stacked over the page (toolbar, menu, comment pin or note) wins.
  // Judge it by where the click started as well as by what is under the pointer
  // now: Save and Delete remove their note before the click reaches here, which
  // uncovers the link beneath.
  const top = document.elementFromPoint?.(e.clientX, e.clientY) ?? e.target;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
  if ([top, ...path].some((n) => n instanceof Element && n.closest(VIEWER_CONTROLS) !== null)) {
    return;
  }
  e.preventDefault();
  followLink(target);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.target instanceof HTMLElement)) {
    return;
  }
  const target = linkTargets.get(e.target);
  if (target) {
    e.preventDefault();
    followLink(target);
  }
});

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
  for (let n = 1; n <= wrappers.length; n++) {
    renderTasks.get(n)?.cancel();
    layoutPage(n);
  }
  restoreZoomAnchor(anchor);
  // Only now do the scale, the fit mode and the scroll anchor all agree, so this
  // (the leading checkpoint after an idle spell) is the finished change.
  queuePosition();
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
  readerNavigated();
  setFitWidth(false);
  setScale(ZOOM_LEVELS.find((z) => z > scale + SCALE_EPSILON) ?? MAX_SCALE);
  queuePosition();
}
function zoomOut(): void {
  readerNavigated();
  setFitWidth(false);
  const below = ZOOM_LEVELS.filter((z) => z < scale - SCALE_EPSILON);
  setScale(below.length ? below[below.length - 1] : MIN_SCALE);
  queuePosition();
}
function zoomReset(): void {
  readerNavigated();
  setFitWidth(false);
  setScale(1);
  queuePosition();
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
  queuePosition();
}

// Turning the mode off leaves the pages at the size they already have and just
// stops them chasing the pane, which is what the pressed state describes.
function toggleFitWidth(): void {
  readerNavigated();
  if (fitWidth) {
    setFitWidth(false);
    queuePosition();
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
    // Escape closes an open menu or note first; only a bare Escape stops auto-scroll.
    const closesOverlay = contextMenu.isOpen() || noteEl !== null;
    contextMenu.hide();
    closeNote();
    if (autoOn && !closesOverlay) {
      stopAutoScroll('Auto-scroll off');
    }
    return;
  }
  if (autoOn && autoKey(e)) {
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
  if (comments.length >= MAX_COMMENT_COUNT) {
    toast(`A document can hold ${MAX_COMMENT_COUNT} comments. Delete one to add another.`, 3500);
    return;
  }
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
  textarea.maxLength = MAX_COMMENT_TEXT;
  textarea.value = c.text;

  const rect = anchor.getBoundingClientRect();
  el.style.left = `${Math.min(window.innerWidth - 280, Math.max(8, rect.left))}px`;
  el.style.top = `${Math.min(window.innerHeight - 170, rect.bottom + 6)}px`;

  // A reload swaps in fresh comment objects; `noteComment` is rebound to the
  // current one, so act on that rather than the object this editor opened with.
  const current = () => noteComment ?? c;
  const save = () => {
    const target = current();
    const previous = target.text;
    target.text = textarea.value.trim();
    if (!target.text) {
      remove();
      return;
    }
    const total = comments.reduce((sum, x) => sum + x.text.length, 0);
    if (total > MAX_COMMENT_TOTAL_TEXT) {
      target.text = previous;
      toast('Comments in this document are too long to save. Shorten some notes.', 3500);
      return;
    }
    saveComments();
    placePins(target.page);
    closeNote();
  };
  const remove = () => {
    const target = current();
    comments = comments.filter((x) => x.id !== target.id);
    saveComments();
    placePins(target.page);
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
        if (!textarea.value.trim() && noteComment?.id === c.id) {
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
// True once a compile has finished and its PDF is on screen, so there is a file
// for "Open PDF in Default App" to open.
let texHasPdf = false;

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
  if (msg.state === 'ok') {
    texHasPdf = true;
  }
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
      run: async () => copyText(await textOfPage(n)),
    });
  }

  variants.push({ kind: 'item', label: 'All Text', run: async () => copyText(await allText()) });
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

  entries.push({ kind: 'divider' });
  entries.push({
    kind: 'item',
    label: autoOn ? 'Stop Auto-scroll' : 'Start Auto-scroll',
    disabled: !doc,
    run: toggleAutoScroll,
  });

  if (texMode) {
    entries.push({ kind: 'divider' });
    entries.push({
      kind: 'item',
      label: 'Recompile LaTeX',
      run: () => vscode.postMessage({ type: 'texRecompile' }),
    });
  }

  entries.push({ kind: 'divider' });
  entries.push({
    kind: 'item',
    label: texMode ? 'Open PDF in Default App' : 'Open in Default App',
    disabled: texMode && !texHasPdf,
    run: () => vscode.postMessage({ type: 'openExternal' }),
  });
  entries.push({
    kind: 'item',
    label: revealLabel(),
    run: () => vscode.postMessage({ type: 'revealInOS' }),
  });
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

// Recolour a page that paints images without turning them into negatives: render
// its images alone onto a transparent canvas (see pdfRecolour) and keep true
// colours wherever that coverage lands. A scan, where an image covers nearly the
// whole page, and a page whose clips the coverage render cannot reproduce fall
// back to plain inversion.
async function tintKeepingImages(
  n: number,
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  appearance: 'inverted' | 'green',
  viewport: PageViewport,
  transform: number[] | undefined,
  opList: PageOps,
): Promise<void> {
  const keep = imageCoverageOps(opList.fnArray, opList.argsArray);
  const coverage = keep && (await renderOps(n, keep, canvas, viewport, transform));
  if (!coverage) {
    tintCanvas(ctx, canvas, appearance);
    return;
  }
  const page = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (recolourKeepingImages(page.data, coverage, appearance, PHOSPHOR_GREEN_RGB)) {
    ctx.putImageData(page, 0, 0);
  } else {
    tintCanvas(ctx, canvas, appearance);
  }
}

// Render the operations `keep` selects onto a transparent scratch canvas the size
// of `like`, and return its pixels.
async function renderOps(
  n: number,
  keep: boolean[],
  like: HTMLCanvasElement,
  viewport: PageViewport,
  transform: number[] | undefined,
): Promise<Uint8ClampedArray | null> {
  const scratch = document.createElement('canvas');
  scratch.width = like.width;
  scratch.height = like.height;
  // Create the context here, with alpha, before pdf.js sees the canvas: given a
  // `canvas`, pdf.js asks for an opaque one (`alpha: false`), but a canvas hands
  // back the context it already has whatever options a later call passes, so
  // this one stays transparent where nothing lands.
  const sctx = scratch.getContext('2d', { alpha: true, willReadFrequently: true });
  if (!sctx) {
    return null;
  }
  const task = pages[n - 1].render({
    canvas: scratch,
    canvasContext: sctx,
    viewport,
    transform,
    background: 'rgba(0,0,0,0)',
    operationsFilter: (i) => keep[i] ?? true,
  });
  renderTasks.set(n, task);
  await task.promise;
  const data = sctx.getImageData(0, 0, scratch.width, scratch.height).data;
  scratch.width = 0;
  scratch.height = 0;
  return data;
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

// ---------------------------------------------------------------------------
// Hand tool (drag to scroll): active only in hand mode
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
    // The LaTeX card's Compile button included: capturing the pointer for a pan
    // would move the click off the button, so it would do nothing.
    (e.target as HTMLElement).closest(
      '.mc-menu, .mc-pin, .mc-note, #mc-toolbar, #mc-autoscroll, .mc-tex-card',
    )
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
  const before = { x: s.scrollLeft, y: s.scrollTop };
  s.scrollLeft = startScrollX - (e.clientX - startX);
  s.scrollTop = startScrollY - (e.clientY - startY);
  if (s.scrollLeft !== before.x || s.scrollTop !== before.y) {
    readerNavigated();
  }
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
  if (!wrappers[clamped - 1]) {
    return; // the page is not laid out yet
  }
  readerNavigated();
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
// Auto-scroll
// ---------------------------------------------------------------------------
// Ported from folio. A corner puck (play/pause, small - and +) glides
// the page at a signed speed in CSS pixels per second. The loop is
// requestAnimationFrame with time-based motion, so the pace does not depend on
// the frame rate, and it owns a float position between frames. Anything that
// moves the page by hand (wheel, keys, a zoom, a page jump, a drag in hand mode)
// is adopted rather than fought, so lazy rendering, zoom anchoring and the
// reading-position reports all keep working untouched: the loop never writes
// anything but scrollTop. The speed and the puck's size live in the webview's
// own state (getState/setState), validated on read.
interface WebviewState {
  [key: string]: unknown;
}
function readWebviewState(): WebviewState {
  const raw = vscode.getState();
  return raw && typeof raw === 'object' ? (raw as WebviewState) : {};
}
let autoSettings = parseSettings(readWebviewState().autoScroll);
let autoOn = false;
let autoPaused = false;
let autoRaf = 0;
let autoLast = 0;
let autoPos = 0;
let autoHoldTimer = 0;
let puck: HTMLDivElement | null = null;

const AS_ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />',
  pause:
    '<rect x="6.5" y="5" width="3.8" height="14" rx="1" fill="currentColor" stroke="none" />' +
    '<rect x="13.7" y="5" width="3.8" height="14" rx="1" fill="currentColor" stroke="none" />',
  minus: '<path d="M5 12h14" />',
  plus: '<path d="M5 12h14" /><path d="M12 5v14" />',
  toggle:
    '<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 8v8" /><path d="M9 13l3 3 3-3" />',
} as const;

// Inline currentColor icons, like the fit-width one: they follow the button's
// foreground in every theme and carry no meaning of their own for a screen
// reader (every button has an aria-label).
function autoScrollIcon(name: keyof typeof AS_ICONS, size: number): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
    `focusable="false">${AS_ICONS[name]}</svg>`
  );
}

function saveAutoSettings(): void {
  vscode.setState({ ...readWebviewState(), autoScroll: autoSettings });
}

function announceAuto(text: string): void {
  const status = puck?.querySelector('.mc-as-status');
  if (status) {
    // Clear first so repeating the same text is announced again.
    status.textContent = '';
    window.setTimeout(() => {
      status.textContent = text;
    }, 30);
  }
}

function buildPuck(): HTMLDivElement {
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
  el.addEventListener('click', (e) => {
    const which = (e.target as HTMLElement).closest<HTMLElement>('[data-as]')?.dataset.as;
    // A mouse or touch press already stepped on pointerdown; the click that
    // follows has a detail count. A keyboard click (detail 0) steps here.
    if (which === 'play') toggleAutoPause();
    else if ((which === 'minus' || which === 'plus') && e.detail === 0) {
      const factor = which === 'plus' ? SPEED_STEP : 1 / SPEED_STEP;
      // A held Enter sends a keyboard click per repeat: like a held key or
      // press it stops at the slowest speed, while a fresh press may reverse.
      if (!keyRepeating || canHoldStep(autoSettings.speed, factor)) {
        adjustAutoSpeed(factor);
      }
    }
  });
  let keyRepeating = false;
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
    adjustAutoSpeed(factor);
    // Once on the press, again after the delay, then at the interval. A held
    // press stops at the slowest speed rather than reversing.
    const tick = (delay: number): void => {
      autoHoldTimer = window.setTimeout(() => {
        if (autoOn && canHoldStep(autoSettings.speed, factor)) {
          adjustAutoSpeed(factor);
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
    contextMenu.show(
      x,
      y,
      SIZES.map((size, i) => ({
        kind: 'radio' as const,
        label: size.label,
        checked: autoSettings.size === i,
        run: () => {
          autoSettings = { ...autoSettings, size: i };
          saveAutoSettings();
          applyAutoUi();
          announceAuto(`Auto-scroll controls ${size.label}`);
        },
      })),
    );
  });
  document.body.appendChild(el);
  return el;
}

function stopHold(): void {
  window.clearTimeout(autoHoldTimer);
  autoHoldTimer = 0;
}

// Reflect the speed, the paused state and the size in the puck and the toolbar.
function applyAutoUi(): void {
  document.getElementById('mc-autoscroll-toggle')?.setAttribute('aria-pressed', String(autoOn));
  if (!puck) {
    return;
  }
  puck.hidden = !autoOn;
  puck.dataset.size = String(autoSettings.size);
  const { speed } = autoSettings;
  const labels = speedLabels(speed);
  const set = (
    as: string,
    label: string,
    title: string,
    icon: Parameters<typeof autoScrollIcon>[0],
  ) => {
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
  const playLabel = `${autoPaused ? 'Play' : 'Pause'} (scrolling ${speed < 0 ? 'up' : 'down'})`;
  set(
    'play',
    playLabel,
    `${playLabel} (Space). Right-click for size`,
    autoPaused ? 'play' : 'pause',
  );
  const minus = set('minus', labels.minus, `${labels.minus} (Down arrow or -)`, 'minus');
  const plus = set('plus', labels.plus, `${labels.plus} (Up arrow or +)`, 'plus');
  // Each disables only at full speed in its own direction.
  if (minus) minus.disabled = stepSpeed(speed, 1 / SPEED_STEP) === speed;
  if (plus) plus.disabled = stepSpeed(speed, SPEED_STEP) === speed;
}

function setAutoSpeed(speed: number): void {
  autoSettings = { ...autoSettings, speed };
  saveAutoSettings();
  applyAutoUi();
  announceAuto(`Auto-scroll speed ${describeSpeed(speed)}`);
}

function adjustAutoSpeed(factor: number): void {
  setAutoSpeed(stepSpeed(autoSettings.speed, factor));
}

function toggleAutoPause(): void {
  autoPaused = !autoPaused;
  applyAutoUi();
  announceAuto(autoPaused ? 'Auto-scroll paused' : 'Auto-scroll playing');
}

function toggleAutoScroll(): void {
  if (autoOn) {
    stopAutoScroll('Auto-scroll off');
  } else {
    startAutoScroll();
  }
}

function startAutoScroll(): void {
  if (!doc || autoOn) {
    return;
  }
  puck ??= buildPuck();
  const s = scroller();
  autoSettings = {
    ...autoSettings,
    speed: startingSpeed(autoSettings.speed, s.scrollTop, s.scrollHeight - s.clientHeight),
  };
  autoOn = true;
  autoPaused = false;
  autoPos = s.scrollTop;
  // Start from where the view is: a position written by an earlier run is stale.
  autoWroteTop = s.scrollTop;
  autoLast = 0;
  applyAutoUi();
  announceAuto(`Auto-scroll on, ${describeSpeed(autoSettings.speed)}`);
  autoRaf = requestAnimationFrame(autoFrame);
}

function stopAutoScroll(message: string): void {
  if (!autoOn) {
    return;
  }
  autoOn = false;
  cancelAnimationFrame(autoRaf);
  autoRaf = 0;
  stopHold();
  saveAutoSettings();
  applyAutoUi();
  // The puck is hidden now, so its own live region would not be read; the
  // persistent status region carries the message, and the toast shows it.
  announce(message);
  toast(message);
  // The reading position is only reported once scrolling settles; do it now.
  flushPosition();
}

// Where auto-scroll last put the view, so a key pressed while it runs is not
// mistaken for the reader scrolling (see the key listener at the end of the file).
let autoWroteTop: number | null = null;
// Counts the frames that found the view somewhere auto-scroll did not put it (a key
// such as Home moved it) and carried on from there. Such a move is the reader's even
// though auto-scroll's next write then puts the view at autoWroteTop again.
let autoAdoptedMoves = 0;
// Counts auto-scroll's own writes. A key is only taken for auto-scroll's movement if
// auto-scroll actually moved the view after it: while paused it writes nothing, so a
// key that moved the view then (Home, Page Down) is the reader's.
let autoWrites = 0;

function autoFrame(ts: number): void {
  autoRaf = 0;
  if (!autoOn) {
    return;
  }
  const dt = autoLast ? (ts - autoLast) / 1000 : 0;
  autoLast = ts;
  const s = scroller();
  const maxTop = s.scrollHeight - s.clientHeight;
  if (autoPaused || panning || loadingDoc) {
    // Hold still (paused, a hand drag is moving the page, or the pages are being
    // rebuilt and the scroll position is only transient) but keep the
    // position current so resuming continues from wherever the page is. A move
    // made meanwhile was seen here, so resuming must not count it as a new one.
    autoPos = s.scrollTop;
    autoWroteTop = s.scrollTop;
  } else {
    if (autoWroteTop !== null && Math.abs(s.scrollTop - autoWroteTop) > 0.5) {
      autoAdoptedMoves++;
    }
    const result = advanceFrame({
      pos: autoPos,
      scrollTop: s.scrollTop,
      speed: autoSettings.speed,
      dt,
      maxTop,
    });
    autoPos = result.pos;
    if (Math.abs(s.scrollTop - autoPos) > 0.01) {
      s.scrollTop = autoPos;
      // Read back, since the browser may round the offset it was given.
      autoWroteTop = s.scrollTop;
      autoWrites++;
    }
    if (result.edge) {
      stopAutoScroll(
        result.edge === 'end' ? 'Auto-scroll reached the end' : 'Auto-scroll reached the top',
      );
      return;
    }
  }
  autoRaf = requestAnimationFrame(autoFrame);
}

// Keys while auto-scroll is on: Space pauses and resumes, the arrows and + / -
// step the speed. Returns whether the key was taken. Fields, open menus and
// modifier chords (Ctrl +/- is zoom) are left alone, and Space on a focused
// button is that button's own click.
function autoKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || contextMenu.isOpen()) {
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
      toggleAutoPause();
    }
    return true;
  }
  // A held key repeats, and like a held button it stops at the slowest speed
  // instead of passing through zero into the other direction; a fresh press
  // may reverse.
  const step = (factor: number): void => {
    if (!e.repeat || canHoldStep(autoSettings.speed, factor)) {
      adjustAutoSpeed(factor);
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
    '<button type="button" id="mc-autoscroll-toggle" data-act="autoscroll" aria-pressed="false" ' +
    'aria-label="Auto-scroll" title="Auto-scroll (right-click the page for the same)">' +
    autoScrollIcon('toggle', 16) +
    '</button>' +
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
    else if (act === 'autoscroll') toggleAutoScroll();
  });
  document.body.appendChild(bar);
}
buildToolbar();

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------
function flattenText(textContent: { items: Array<unknown> }): string {
  return textContent.items
    .map((it) => {
      const item = it as { str?: string; hasEOL?: boolean };
      return typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '';
    })
    .join('')
    .trim();
}

// `pageText` only fills as pages are rasterised, so it is an accelerator: a page
// that has not been rendered yet is read straight from pdf.js.
async function textOfPage(n: number): Promise<string> {
  const cached = pageText.get(n);
  if (cached !== undefined) return cached;
  const source = doc;
  if (!source) return '';
  const page = pages[n - 1] ?? (await source.getPage(n));
  const text = flattenText(await page.getTextContent());
  if (doc === source) pageText.set(n, text);
  return text;
}

async function allText(): Promise<string> {
  const count = doc?.numPages ?? 0;
  const parts: string[] = [];
  for (let n = 1; n <= count; n++) {
    parts.push(await textOfPage(n));
  }
  return parts.join('\n\n').trim();
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

// A canvas holding the page in its original colours. The on-screen bitmap of a
// dark or green page is not reversible (green's multiply loses information, and
// images keep their true colours under either), so re-rasterise it clean.
async function truePageCanvas(n: number): Promise<HTMLCanvasElement> {
  const appearance = pageAppearance();
  const onscreen = wrappers[n - 1].querySelector('canvas') as HTMLCanvasElement;

  if (appearance !== 'normal') {
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

  return onscreen;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

vscode.postMessage({ type: 'ready' });

// Keys that scroll the page are the reader's own navigation. Registered last so
// the auto-scroll and focused-control handlers have already taken the keys that
// only adjust a speed or press a button; a key that moves nothing must not cancel
// the saved position.
// Whether a key scrolls depends on the focused control, so judge it by what the
// browser did: only a key that actually moved the view counts as navigation. While
// auto-scroll runs the view moves on its own, so a view sitting exactly where
// auto-scroll last put it has not been moved by the key (Space on a focused speed
// button, for one, presses the button and scrolls nothing).
let keyScrollCheck = 0;
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey) {
    return;
  }
  const s = scroller();
  const { scrollTop, scrollLeft } = s;
  const adopted = autoAdoptedMoves;
  const writes = autoWrites;
  const token = ++keyScrollCheck;
  let frames = 0;
  const check = (): void => {
    if (token !== keyScrollCheck) {
      return;
    }
    const moved = s.scrollTop !== scrollTop || s.scrollLeft !== scrollLeft;
    const byAutoScroll =
      autoOn &&
      autoAdoptedMoves === adopted &&
      autoWrites !== writes &&
      s.scrollLeft === scrollLeft &&
      s.scrollTop === autoWroteTop;
    if (moved && !byAutoScroll) {
      readerNavigated();
    } else if (++frames < 3) {
      requestAnimationFrame(check);
    }
  };
  requestAnimationFrame(check);
});
