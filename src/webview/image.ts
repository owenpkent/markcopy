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
const img = box('img', 'mc-image', 'margin:auto;flex:none;outline:none;');
img.alt = '';
scroller.append(img);
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
app.append(scroller, errorEl, statusEl, menuEl, toastEl);

const contextMenu = createMenu(menuEl);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
type Background = 'checkerboard' | 'light' | 'dark' | 'theme';
const BACKGROUNDS: Background[] = ['checkerboard', 'light', 'dark', 'theme'];

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
// 'fit' or a percentage. Session-only.
let zoom: 'fit' | number = 'fit';
let svgScale = 2;
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
  const width = info?.width ?? (img.naturalWidth || undefined);
  const height = info?.height ?? (img.naturalHeight || undefined);
  return { width, height };
}

function updateStatus(): void {
  if (!info) {
    statusEl.textContent = fileName;
    return;
  }
  const { width, height } = dims();
  statusEl.textContent = statusLine(fileName, fileBytes, info, width, height);
}

function showError(message: string): void {
  scroller.style.display = 'none';
  errorEl.style.display = 'flex';
  errorEl.textContent = message;
}

function applyBackground(value: unknown): void {
  background = BACKGROUNDS.includes(value as Background) ? (value as Background) : 'checkerboard';
  for (const b of BACKGROUNDS) {
    scroller.classList.toggle(`mc-image-bg-${b}`, b === background);
  }
  const s = scroller.style;
  s.backgroundImage = '';
  s.backgroundSize = '';
  s.backgroundColor = '';
  if (background === 'checkerboard') {
    s.backgroundColor = 'var(--mc-pre-bg)';
    s.backgroundImage =
      'conic-gradient(var(--mc-border) 25%, transparent 0 50%, var(--mc-border) 0 75%, transparent 0)';
    s.backgroundSize = '16px 16px';
  } else if (background === 'light') {
    s.backgroundColor = '#ffffff';
  } else if (background === 'dark') {
    s.backgroundColor = '#1e1e1e';
  } else {
    s.backgroundColor = 'var(--vscode-editor-background, var(--mc-bg))';
  }
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
  img.addEventListener(
    'load',
    () => {
      loaded = true;
      updateStatus();
      applyZoom();
    },
    { once: true },
  );
  // The sniffed type, never the extension.
  blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: info.mime }));
  img.src = blobUrl;
  updateStatus();
  applyZoom();
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------
function naturalSize(): { w: number; h: number } {
  const { width, height } = dims();
  return { w: img.naturalWidth || width || 0, h: img.naturalHeight || height || 0 };
}

function applyZoom(): void {
  if (zoom === 'fit') {
    img.style.width = '';
    img.style.height = '';
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';
    img.style.imageRendering = '';
    return;
  }
  const { w, h } = naturalSize();
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  if (w && h) {
    img.style.width = `${(w * zoom) / 100}px`;
    img.style.height = `${(h * zoom) / 100}px`;
  }
  img.style.imageRendering = zoom > 200 ? 'pixelated' : '';
}

function currentPercent(): number {
  if (zoom !== 'fit') {
    return zoom;
  }
  const { w } = naturalSize();
  const shown = img.clientWidth;
  return w && shown ? (shown / w) * 100 : 100;
}

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
  const vb = viewBoxSize();
  let w = info?.width ?? vb?.w ?? nat.w;
  let h = info?.height ?? vb?.h ?? nat.h;
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
  copyText(new TextDecoder('utf-8').decode(bytes), 'Copied SVG source');
}

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
    const { width, height } = dims();
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
    if (isSvg()) {
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
      { kind: 'item', label: 'Copy Image as PNG', run: () => void copyImagePng() },
      { kind: 'item', label: 'Save as PNG…', run: () => void savePng() },
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
window.addEventListener('message', (event: MessageEvent) => {
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
    showError(msg.message);
  } else if (msg.type === 'setTheme') {
    applyTheme(msg.value);
  } else if (msg.type === 'setBackground') {
    applyBackground(msg.value);
  }
});

// The host writes the saved background onto <body> so the first paint is right.
applyBackground(document.body.getAttribute('data-mc-background') ?? 'checkerboard');
vscode.postMessage({ type: 'ready' });
