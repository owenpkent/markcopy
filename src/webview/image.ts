// Browser-side code for the image preview (media/image.js), the viewer behind
// src/imageEditor.ts.
//
// The host sends the file's bytes as base64. The format is sniffed from the
// magic bytes and the Blob is built from that, never from the extension. The
// picture is drawn by one <img>; SVG in particular is never parsed into the DOM
// or inlined, so it can run no script and load no external resource.
import { createMenu, revealLabel, type MenuEntry } from './menu';
import {
  MAX_DATA_URI_BYTES,
  MAX_SVG_RASTER_SIDE,
  base64ToBytes,
  dataUri,
  decodeSvgText,
  htmlImage,
  markdownImage,
  pngFileName,
  sniffImage,
  statusLine,
  stemOf,
  type ImageInfo,
} from './imageInfo';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// ---------------------------------------------------------------------------
// DOM. The host provides only #app; everything else is built here, with inline
// styles so nothing depends on the host's CSS beyond media/preview.css.
// ---------------------------------------------------------------------------
const app = document.getElementById('app') as HTMLDivElement;

function box<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  id: string,
  css: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.id = id;
  el.style.cssText = css;
  return el;
}

const scroller = box(
  'div',
  'mc-image-scroll',
  'position:fixed;inset:0 0 30px 0;overflow:auto;display:flex;box-sizing:border-box;padding:12px;',
);
// The frame is exactly the picture's rendered size; the transparency checkerboard
// lives on it, never on the scroller.
const frame = box('div', 'mc-image-frame', 'margin:auto;flex:none;display:block;');
const img = box('img', 'mc-image', 'display:block;outline:none;');
img.alt = '';
img.draggable = false;
img.addEventListener('dragstart', (e) => e.preventDefault());
frame.append(img);
scroller.append(frame);
const errorEl = box(
  'div',
  'mc-image-error',
  'position:fixed;inset:0 0 30px 0;display:none;align-items:center;justify-content:center;padding:32px;text-align:center;font-size:13px;line-height:1.5;',
);
const statusEl = box(
  'div',
  'mc-image-status',
  'position:fixed;left:0;right:0;bottom:0;height:30px;display:flex;align-items:center;padding:0 12px;box-sizing:border-box;font-size:11px;opacity:0.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
);
// The bar sits above the 30px status line so it never covers the status text.
const toolbarEl = box('div', 'mc-toolbar', 'bottom:42px;');
const menuEl = box('div', 'mc-menu', '');
menuEl.className = 'mc-menu';
menuEl.setAttribute('role', 'menu');
menuEl.hidden = true;
const toastEl = box('div', 'mc-toast', '');
toastEl.className = 'mc-toast';
toastEl.hidden = true;

document.documentElement.style.height = '100%';
document.body.style.cssText +=
  ';height:100%;margin:0;overflow:hidden;background:var(--mc-bg);color:var(--mc-fg);';
app.append(scroller, errorEl, statusEl, toolbarEl, menuEl, toastEl);

const contextMenu = createMenu(menuEl);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
type Background = 'checkerboard' | 'light' | 'dark' | 'theme';
const BACKGROUNDS: Background[] = ['checkerboard', 'light', 'dark', 'theme'];

const CHECKER_LIGHT = 'color-mix(in srgb, var(--mc-bg) 94%, var(--mc-fg))';
const CHECKER_DARK = 'color-mix(in srgb, var(--mc-bg) 88%, var(--mc-fg))';
const ZOOM_STEPS = [10, 25, 50, 75, 100, 150, 200, 300, 400, 600, 800];
const SVG_SCALES = [1, 2, 4];

let fileName = '';
let filePath = '';
let relativePath = '';
let fileBytes = 0;
let base64 = '';
let bytes: Uint8Array = new Uint8Array(0);
let info: ImageInfo | undefined;
let blobUrl = '';
let loaded = false;
// True once the <img> reported a decode error for the current file.
let failed = false;
// 'fit' or a percentage. Session-only.
let zoom: 'fit' | number = 'fit';
let svgScale = 2;
// Hand tool (drag to pan). Session-only, on by default like the PDF viewer.
let hand = true;
let background: Background = 'checkerboard';
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

function dims(): { width?: number; height?: number } {
  // A raster's decoded size wins once loaded: it honours EXIF orientation, which
  // the header dimensions do not. The header is the pre-load fallback.
  if (loaded && info && info.format !== 'svg' && img.naturalWidth && img.naturalHeight) {
    return { width: img.naturalWidth, height: img.naturalHeight };
  }
  const width = info?.width ?? (img.naturalWidth || undefined);
  const height = info?.height ?? (img.naturalHeight || undefined);
  return { width, height };
}

function updateStatus(): void {
  if (!info) {
    statusEl.textContent = fileName;
    return;
  }
  if (failed) {
    statusEl.textContent = statusLine(fileName, fileBytes, {
      ...info,
      width: undefined,
      height: undefined,
      viewBox: undefined,
    });
    return;
  }
  const { width, height } = dims();
  statusEl.textContent = statusLine(fileName, fileBytes, info, width, height);
}

function showError(message: string): void {
  scroller.style.display = 'none';
  toolbarEl.style.display = 'none';
  errorEl.style.display = 'flex';
  errorEl.textContent = message;
}

// JPEG never carries an alpha channel; BMP can, so it keeps the grid.
function checkerAllowed(): boolean {
  return info?.format !== 'jpeg';
}

function checkerVisible(): boolean {
  return background === 'checkerboard' && checkerAllowed();
}

function paintFrame(): void {
  const s = frame.style;
  s.backgroundImage = '';
  s.backgroundSize = '';
  s.backgroundColor = '';
  if (checkerVisible()) {
    // Two close greys mixed from the theme tokens: a faint texture, not a grid.
    s.backgroundColor = CHECKER_LIGHT;
    s.backgroundImage = `conic-gradient(${CHECKER_DARK} 25%, transparent 0 50%, ${CHECKER_DARK} 0 75%, transparent 0)`;
    s.backgroundSize = '12px 12px';
  }
  const grid = document.getElementById('mc-grid') as HTMLButtonElement | null;
  if (grid) {
    const allowed = checkerAllowed();
    grid.disabled = !allowed;
    grid.setAttribute('aria-pressed', String(checkerVisible()));
    grid.title = !allowed
      ? 'No transparency in a JPEG'
      : checkerVisible()
        ? 'Transparency grid (click to hide)'
        : 'Transparency grid (click to show)';
  }
}

function applyBackground(value: unknown): void {
  background = BACKGROUNDS.includes(value as Background) ? (value as Background) : 'checkerboard';
  for (const b of BACKGROUNDS) {
    scroller.classList.toggle(`mc-image-bg-${b}`, b === background);
  }
  // The scroller is always a plain backdrop; the checkerboard is only under the picture.
  scroller.style.backgroundImage = '';
  scroller.style.backgroundSize = '';
  scroller.style.backgroundColor =
    background === 'light' ? '#ffffff' : background === 'dark' ? '#1e1e1e' : 'var(--mc-bg)';
  paintFrame();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
interface LoadMessage {
  type: 'load';
  name: string;
  path: string;
  relativePath: string;
  size: number;
  data: string;
  background?: unknown;
}

function resetImage(): void {
  loaded = false;
  failed = false;
  img.removeAttribute('src');
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = '';
  }
}

function load(msg: LoadMessage): void {
  resetImage();
  fileName = String(msg.name ?? '');
  filePath = String(msg.path ?? '');
  relativePath = String(msg.relativePath ?? fileName);
  fileBytes = Number(msg.size) || 0;
  base64 = typeof msg.data === 'string' ? msg.data : '';
  if (msg.background !== undefined) {
    applyBackground(msg.background);
  }
  bytes = base64ToBytes(base64);
  errorEl.style.display = 'none';

  info = sniffImage(bytes);
  if (!info) {
    showError('Not a recognised image');
    statusEl.textContent = fileName;
    return;
  }
  scroller.style.display = 'flex';
  toolbarEl.style.display = '';
  if (info.format === 'svg') {
    // A data URL, not a Blob URL: an SVG with <foreignObject> taints the canvas
    // when loaded from a Blob URL, which would break PNG export. It still only
    // ever enters an <img>.
    img.src = `data:image/svg+xml;base64,${base64}`;
  } else {
    // The sniffed type, never the extension.
    blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: info.mime }));
    img.src = blobUrl;
  }
  paintFrame();
  updateStatus();
  applyZoom();
}

img.addEventListener('load', () => {
  failed = false;
  loaded = true;
  errorEl.style.display = 'none';
  scroller.style.display = 'flex';
  toolbarEl.style.display = '';
  updateStatus();
  applyZoom();
});

img.addEventListener('error', () => {
  if (!info || !img.hasAttribute('src')) {
    return;
  }
  loaded = false;
  failed = true;
  showError(`Could not decode ${fileName}`);
  updateStatus();
});

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------
function naturalSize(): { w: number; h: number } {
  const { width, height } = dims();
  return { w: img.naturalWidth || width || 0, h: img.naturalHeight || height || 0 };
}

function sizeImage(width: string, height: string): void {
  img.style.width = width;
  img.style.height = height;
  frame.style.width = width;
  frame.style.height = height;
}

function applyZoom(): void {
  const { w, h } = naturalSize();
  img.style.imageRendering = '';
  if (zoom === 'fit') {
    // Padding is 12px a side. Without a measurable pane or size the image keeps its own size.
    // Measure with scrollbars out of the way: whatever is laid out right now (the
    // zoomed size, or the natural size once that is cleared) can overflow the pane,
    // and its scrollbars would eat into clientWidth/Height and leave Fit a scrollbar
    // short. Forcing overflow hidden for the read gives the pane's true inner size.
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';
    const overflow = scroller.style.overflow;
    scroller.style.overflow = 'hidden';
    const availW = scroller.clientWidth - 24;
    const availH = scroller.clientHeight - 24;
    scroller.style.overflow = overflow;
    if (w && h && availW > 0 && availH > 0) {
      const scale = Math.min(1, availW / w, availH / h);
      sizeImage(`${w * scale}px`, `${h * scale}px`);
    } else {
      sizeImage('', '');
    }
    updateToolbar();
    return;
  }
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  if (w && h) {
    sizeImage(`${(w * zoom) / 100}px`, `${(h * zoom) / 100}px`);
  }
  img.style.imageRendering = zoom > 200 ? 'pixelated' : '';
  updateToolbar();
}

function currentPercent(): number {
  if (zoom !== 'fit') {
    return zoom;
  }
  const { w } = naturalSize();
  const shown = img.clientWidth;
  return w && shown ? (shown / w) * 100 : 100;
}

function updateToolbar(): void {
  const label = document.getElementById('mc-zoom-label');
  if (label) {
    label.textContent = `${Math.round(currentPercent())}%`;
  }
  document.getElementById('mc-fit')?.setAttribute('aria-pressed', String(zoom === 'fit'));
}

window.addEventListener('resize', () => {
  if (zoom === 'fit') {
    applyZoom();
  }
});

function setZoom(value: 'fit' | number): void {
  zoom = value;
  applyZoom();
  toast(value === 'fit' ? 'Fit' : `${value}%`, 900);
}

function stepZoom(direction: 1 | -1): void {
  const now = currentPercent();
  let next: number | undefined;
  if (direction > 0) {
    next = ZOOM_STEPS.find((s) => s > now + 0.5);
  } else {
    next = [...ZOOM_STEPS].reverse().find((s) => s < now - 0.5);
  }
  const limit = direction > 0 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[0];
  setZoom(next ?? limit);
}

// Click the percentage to type a zoom, after the PDF viewer's go-to-page input.
function parseZoomInput(text: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(text);
  if (!m) {
    return undefined;
  }
  return Math.min(800, Math.max(10, Math.round(Number(m[1]))));
}

function beginZoomInput(): void {
  const label = document.getElementById('mc-zoom-label');
  if (!label || label.hidden) {
    return;
  }
  const start = String(Math.round(currentPercent()));
  const input = document.createElement('input');
  input.id = 'mc-zoom-input';
  input.type = 'text';
  input.setAttribute('inputmode', 'numeric');
  input.value = start;
  input.setAttribute('aria-label', 'Zoom percentage');
  label.hidden = true;
  label.insertAdjacentElement('afterend', input);

  // Removing the input fires blur mid-removal; run the teardown once only.
  let closed = false;
  const done = (mode: 'enter' | 'blur' | 'cancel') => {
    if (closed) {
      return;
    }
    closed = true;
    const n = parseZoomInput(input.value);
    const changed = input.value !== start;
    input.remove();
    label.hidden = false;
    if (mode !== 'blur') {
      label.focus(); // hand focus back for keyboard users
    }
    if (n !== undefined && (mode === 'enter' || (mode === 'blur' && changed))) {
      setZoom(n);
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep viewer shortcuts out of the input
    if (e.key === 'Enter') {
      done('enter');
    } else if (e.key === 'Escape') {
      done('cancel');
    }
  });
  input.addEventListener('blur', () => done('blur'));
  input.focus();
  input.select();
}

document.addEventListener('keydown', (e) => {
  if (contextMenu.isOpen() || e.altKey) {
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      stepZoom(1);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      stepZoom(-1);
    } else if (e.key === '0') {
      e.preventDefault();
      setZoom('fit');
    }
    return;
  }
  if (e.key === '1') {
    setZoom(100);
  } else if (e.key === 'f' || e.key === 'F') {
    setZoom('fit');
  }
});

scroller.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) {
      return;
    }
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Copy actions
// ---------------------------------------------------------------------------
function isSvg(): boolean {
  return info?.format === 'svg';
}

function viewBoxSize(): { w: number; h: number } | undefined {
  const parts = (info?.viewBox ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
    return { w: parts[2], h: parts[3] };
  }
  return undefined;
}

/** The pixel size the PNG is drawn at: natural, or the SVG's intrinsic size times the scale. */
function rasterSize(): { w: number; h: number } | undefined {
  const nat = naturalSize();
  if (!isSvg()) {
    return nat.w && nat.h ? nat : undefined;
  }
  // An intrinsic size (any CSS length, resolved by the browser) wins, then the
  // viewBox, then whatever the <img> reports.
  const vb = viewBoxSize();
  let w: number;
  let h: number;
  if (info?.intrinsicSize && nat.w && nat.h) {
    w = nat.w;
    h = nat.h;
  } else if (vb) {
    w = vb.w;
    h = vb.h;
  } else {
    w = nat.w;
    h = nat.h;
  }
  if (!w || !h) {
    return undefined;
  }
  w *= svgScale;
  h *= svgScale;
  const biggest = Math.max(w, h);
  if (biggest > MAX_SVG_RASTER_SIDE) {
    const k = MAX_SVG_RASTER_SIDE / biggest;
    w *= k;
    h *= k;
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

function renderPng(): Promise<Blob | null> {
  const size = rasterSize();
  if (!loaded || !size) {
    return Promise.resolve(null);
  }
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return Promise.resolve(null);
  }
  ctx.drawImage(img, 0, 0, size.w, size.h);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

async function copyImagePng(): Promise<void> {
  try {
    const blob = await renderPng();
    if (!blob) {
      toast('No image to copy');
    } else if (navigator.clipboard && 'write' in navigator.clipboard) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Copied image as PNG');
    } else {
      toast('PNG copy not supported here');
    }
  } catch {
    toast('Could not read the image');
  }
}

async function savePng(): Promise<void> {
  try {
    const blob = await renderPng();
    if (!blob) {
      toast('No image to save');
      return;
    }
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    }
    vscode.postMessage({ type: 'saveFrame', data: btoa(binary), name: pngFileName(fileName) });
  } catch {
    toast('Could not read the image');
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

function copySvgSource(): void {
  copyText(decodeSvgText(bytes), 'Copied SVG source');
}

// ---------------------------------------------------------------------------
// Toolbar (same ids and classes as the PDF viewer's, so media/preview.css styles it)
// ---------------------------------------------------------------------------
const FIT_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
  'focusable="false"><rect x="3" y="5" width="18" height="14" rx="2" />' +
  '<path d="M8 12h8" /><path d="M10 9l-3 3 3 3" /><path d="M14 9l3 3-3 3" /></svg>';
const HAND_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
  'focusable="false"><path d="M12 3v18" /><path d="M3 12h18" /><path d="M9 6l3-3 3 3" />' +
  '<path d="M9 18l3 3 3-3" /><path d="M6 9l-3 3 3 3" /><path d="M18 9l3 3-3 3" /></svg>';
const GRID_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<rect x="3" y="3" width="18" height="18" rx="2" /><rect x="3" y="3" width="9" height="9" fill="currentColor" />' +
  '<rect x="12" y="12" width="9" height="9" fill="currentColor" /></svg>';
const ICON_BUTTON_CSS = 'display:inline-flex;align-items:center;justify-content:center;padding:0;';
toolbarEl.innerHTML =
  '<button type="button" data-act="out" aria-label="Zoom out" title="Zoom out (Ctrl -)">\u2212</button>' +
  '<button type="button" id="mc-zoom-label" aria-label="Zoom level" title="Zoom level (click to type)">100%</button>' +
  '<button type="button" data-act="in" aria-label="Zoom in" title="Zoom in (Ctrl +)">+</button>' +
  '<span class="mc-toolbar-sep" aria-hidden="true"></span>' +
  `<button type="button" id="mc-fit" data-act="fit" aria-pressed="true" aria-label="Fit to window" title="Fit to window" style="${ICON_BUTTON_CSS}">${FIT_ICON}</button>` +
  '<span class="mc-toolbar-sep" aria-hidden="true"></span>' +
  `<button type="button" id="mc-hand" data-act="hand" aria-pressed="true" aria-label="Hand tool" title="Hand Tool (Drag to Pan)" style="${ICON_BUTTON_CSS}">${HAND_ICON}</button>` +
  '<span class="mc-toolbar-sep" aria-hidden="true"></span>' +
  `<button type="button" id="mc-grid" data-act="grid" aria-pressed="true" aria-label="Transparency grid" title="Transparency grid (click to hide)" style="${ICON_BUTTON_CSS}">${GRID_ICON}</button>`;
toolbarEl.addEventListener('pointerdown', (e) => e.stopPropagation());
toolbarEl.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('button');
  if (!target) {
    return;
  }
  if (target.id === 'mc-zoom-label') {
    beginZoomInput();
    return;
  }
  const act = target.dataset.act;
  if (act === 'in') {
    stepZoom(1);
  } else if (act === 'out') {
    stepZoom(-1);
  } else if (act === 'fit') {
    setZoom(zoom === 'fit' ? 100 : 'fit');
  } else if (act === 'hand') {
    setHand(!hand);
  } else if (act === 'grid') {
    toggleGrid();
  }
});

// The grid toggle changes the saved default (markcopy.image.background), so the
// toolbar button, the View menu row and Preferences > Background all agree and
// the choice holds for the next image.
function toggleGrid(): void {
  if (!checkerAllowed()) {
    return;
  }
  const value = checkerVisible() ? 'theme' : 'checkerboard';
  applyBackground(value);
  vscode.postMessage({ type: 'updateSetting', key: 'image.background', value });
}

// ---------------------------------------------------------------------------
// Hand tool (drag to pan), after the PDF viewer's
// ---------------------------------------------------------------------------
function setHand(next: boolean): void {
  hand = next;
  document.body.classList.toggle('mc-mode-hand', hand);
  document.body.classList.toggle('mc-mode-pointer', !hand);
  document.getElementById('mc-hand')?.setAttribute('aria-pressed', String(hand));
}
setHand(true);

let panning = false;
let panPointer = -1;
let startX = 0;
let startY = 0;
let startScrollX = 0;
let startScrollY = 0;

document.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement | null;
  if (
    e.button !== 0 ||
    !hand ||
    !target ||
    !scroller.contains(target) ||
    target.closest('.mc-menu, #mc-toolbar')
  ) {
    return;
  }
  panning = true;
  panPointer = e.pointerId;
  startX = e.clientX;
  startY = e.clientY;
  startScrollX = scroller.scrollLeft;
  startScrollY = scroller.scrollTop;
  document.body.classList.add('mc-grabbing');
  try {
    scroller.setPointerCapture(e.pointerId);
  } catch {
    /* best-effort */
  }
});

document.addEventListener('pointermove', (e) => {
  if (!panning || e.pointerId !== panPointer) {
    return;
  }
  scroller.scrollLeft = startScrollX - (e.clientX - startX);
  scroller.scrollTop = startScrollY - (e.clientY - startY);
});

function endPan(): void {
  panning = false;
  panPointer = -1;
  document.body.classList.remove('mc-grabbing');
}
document.addEventListener('pointerup', endPan);
document.addEventListener('pointercancel', endPan);

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();

  const tail: MenuEntry[] = [
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
  const nameRows: MenuEntry[] = [
    { kind: 'item', label: 'File Name', run: () => copyText(fileName, 'Copied file name') },
    { kind: 'item', label: 'Full Path', run: () => copyText(filePath, 'Copied path') },
  ];

  let entries: MenuEntry[];
  if (!info) {
    entries = [{ kind: 'submenu', label: 'Copy as', entries: nameRows }, ...tail];
  } else {
    const alt = stemOf(fileName);
    const { width, height } = failed ? { width: undefined, height: undefined } : dims();
    const tooBig = fileBytes > MAX_DATA_URI_BYTES;
    const mime = info.mime;
    const copyAs: MenuEntry[] = [
      ...nameRows,
      {
        kind: 'item',
        label: 'Markdown Image',
        run: () => copyText(markdownImage(alt, relativePath), 'Copied Markdown image'),
      },
      {
        kind: 'item',
        label: 'HTML Image',
        run: () => copyText(htmlImage(alt, relativePath, width, height), 'Copied HTML image'),
      },
      {
        kind: 'item',
        label: tooBig ? 'Too large for a data URI' : 'Data URI',
        disabled: tooBig,
        run: () => copyText(dataUri(mime, base64), 'Copied data URI'),
      },
    ];
    if (isSvg() && !failed) {
      copyAs.push(
        { kind: 'divider' },
        { kind: 'label', label: 'SVG Scale' },
        ...SVG_SCALES.map((s): MenuEntry => ({
          kind: 'radio',
          label: `${s}x`,
          checked: svgScale === s,
          run: () => {
            svgScale = s;
          },
        })),
      );
    }
    entries = [
      {
        kind: 'item',
        label: 'Copy Image as PNG',
        disabled: failed,
        run: () => void copyImagePng(),
      },
      { kind: 'item', label: 'Save as PNG…', disabled: failed, run: () => void savePng() },
      { kind: 'divider' },
      { kind: 'submenu', label: 'Copy as', entries: copyAs },
      ...(isSvg()
        ? [{ kind: 'item', label: 'Copy SVG Source', run: copySvgSource } as MenuEntry]
        : []),
      { kind: 'divider' },
      {
        kind: 'submenu',
        label: 'View',
        entries: [
          { kind: 'item', label: 'Fit', run: () => setZoom('fit') },
          { kind: 'item', label: '100%', run: () => setZoom(100) },
          { kind: 'item', label: 'Zoom In', run: () => stepZoom(1) },
          { kind: 'item', label: 'Zoom Out', run: () => stepZoom(-1) },
          { kind: 'divider' },
          { kind: 'checkbox', label: 'Hand Tool', checked: hand, run: () => setHand(!hand) },
          // No row at all for a JPEG: it has no transparency to show a grid under.
          ...(checkerAllowed()
            ? [
                {
                  kind: 'checkbox' as const,
                  label: 'Transparency Grid',
                  checked: checkerVisible(),
                  run: toggleGrid,
                },
              ]
            : []),
        ],
      },
      {
        kind: 'submenu',
        label: 'Preferences',
        entries: [...themeItems(), backgroundItems()],
      },
      ...tail,
    ];
  }

  contextMenu.show(e.pageX, e.pageY, entries);
});

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

function backgroundItems(): MenuEntry {
  const entry = (label: string, value: Background): MenuEntry => ({
    kind: 'radio',
    label,
    checked: background === value,
    run: () => {
      applyBackground(value);
      vscode.postMessage({ type: 'updateSetting', key: 'image.background', value });
    },
  });
  return {
    kind: 'submenu',
    label: 'Background',
    entries: [
      entry('Checkerboard', 'checkerboard'),
      entry('Light', 'light'),
      entry('Dark', 'dark'),
      entry('Theme', 'theme'),
    ],
  };
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
// Only the extension host talks to this frame. VS Code delivers its messages from
// the webview's outer frame, which is the parent of this one and shares its origin
// (the inner document is written into a blank frame, so it inherits the origin).
// Either test identifies that sender; anything else is ignored.
function fromHost(event: MessageEvent): boolean {
  return event.origin === window.origin || event.source === window.parent;
}

window.addEventListener('message', (event: MessageEvent) => {
  if (!fromHost(event)) {
    return;
  }
  const msg = event.data as
    | LoadMessage
    | { type: 'error'; message: string }
    | { type: 'setTheme'; value: string }
    | { type: 'setBackground'; value?: unknown };
  if (!msg) {
    return;
  }
  if (msg.type === 'load') {
    load(msg);
  } else if (msg.type === 'error') {
    // A host error (deleted, unreadable, over the cap) means the image on screen
    // is no longer the file. Drop it, like the unknown-bytes path, so the menu
    // and status line show nothing stale. The name and path stay for Copy as.
    resetImage();
    info = undefined;
    bytes = new Uint8Array(0);
    base64 = '';
    fileBytes = 0;
    showError(msg.message);
    statusEl.textContent = '';
  } else if (msg.type === 'setTheme') {
    applyTheme(msg.value);
  } else if (msg.type === 'setBackground') {
    applyBackground(msg.value);
  }
});

// The host writes the saved background onto <body> so the first paint is right.
applyBackground(document.body.getAttribute('data-mc-background') ?? 'checkerboard');
vscode.postMessage({ type: 'ready' });
