import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';

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

// Cache of extracted page text, keyed by 1-based page number.
const pageText = new Map<number, string>();

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type === 'load') {
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

// Never fail silently: surface any uncaught error/rejection in the panel so a
// blank page always carries an explanation.
window.addEventListener('error', (e) => showFatal(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));

function showFatal(err: unknown): void {
  root.innerHTML = `<pre class="mc-error">PDF preview error: ${escapeHtml(String(err))}</pre>`;
}

function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.setTimeout(() => (toastEl.hidden = true), 1600);
}

async function load(data: Uint8Array, workerSrc: string): Promise<void> {
  root.textContent = '';

  // Run pdf.js parsing/rasterising off the main thread. The worker script is a
  // webview-resource URI (https://…vscode-cdn.net) which is cross-origin to the
  // webview document (vscode-webview://…), so `new Worker(workerSrc)` would throw
  // a SecurityError. Fetch it and start the worker from a same-origin blob URL
  // instead (CSP allows `blob:` in worker-src and the fetch via connect-src).
  try {
    const res = await fetch(workerSrc);
    const code = await res.text();
    const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const worker = new Worker(blobUrl, { type: 'module' });
    pdfjsLib.GlobalWorkerOptions.workerPort = worker;
  } catch (err) {
    root.innerHTML = `<pre class="mc-error">Failed to start PDF worker: ${escapeHtml(String(err))}</pre>`;
    return;
  }

  let doc: PDFDocumentProxy;
  try {
    doc = await pdfjsLib.getDocument({ data }).promise;
  } catch (err) {
    root.innerHTML = `<pre class="mc-error">Failed to open PDF: ${escapeHtml(String(err))}</pre>`;
    return;
  }

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const scale = 1.5;
    const viewport = page.getViewport({ scale });

    const wrap = document.createElement('div');
    wrap.className = 'mc-page';
    wrap.dataset.page = String(n);

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    wrap.appendChild(canvas);
    root.appendChild(wrap);

    if (ctx) {
      await page.render({ canvasContext: ctx, viewport }).promise;
    }

    // Extract text once, for the copy actions.
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : ''))
      .join('')
      .trim();
    pageText.set(n, text);
  }

  toast(`Loaded ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`);
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
    if (canvas) {
      items.push({ label: `Copy Page ${n} as PNG`, run: () => copyCanvasPng(canvas) });
    }
    items.push({ label: `Copy Page ${n} Text`, run: () => copyText(pageText.get(n) ?? '') });
  }

  items.push({ label: 'Copy All Text', run: () => copyText(allText()) });

  // View: flip page inversion for this session (defaults to following the theme).
  items.push({
    label: pagesInverted() ? 'Light Pages' : 'Dark Pages',
    run: () => togglePages(),
  });

  showMenu(e.pageX, e.pageY, items);
});

// ---------------------------------------------------------------------------
// Dark-mode pages
// ---------------------------------------------------------------------------
// 'auto' follows the active theme (via CSS); the toggle pins an explicit choice
// for the session by adding an override class the stylesheet honours.
type PageMode = 'auto' | 'normal' | 'inverted';
let pageMode: PageMode = 'auto';

function isDarkTheme(): boolean {
  const t = document.body.getAttribute('data-mc-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return (
    document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast')
  );
}

// Whether pages are currently shown inverted (dark), accounting for the theme
// default and any per-session override.
function pagesInverted(): boolean {
  if (pageMode === 'inverted') return true;
  if (pageMode === 'normal') return false;
  return isDarkTheme();
}

function togglePages(): void {
  pageMode = pagesInverted() ? 'normal' : 'inverted';
  document.body.classList.toggle('mc-pages-inverted', pageMode === 'inverted');
  document.body.classList.toggle('mc-pages-normal', pageMode === 'normal');
}

document.addEventListener('click', () => (menu.hidden = true));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') menu.hidden = true;
});

// ---------------------------------------------------------------------------
// Hand tool (drag to scroll)
// ---------------------------------------------------------------------------
// Left-drag anywhere on the page area pans the view. Always on: the pages are
// canvas-only (no selectable text layer), so a drag is never a text selection.
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
  // Left button only, and never start a pan from the context menu.
  if (e.button !== 0 || (e.target as HTMLElement).closest('#mc-menu')) {
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
  // Capture so a drag that leaves the webview still delivers move/up and never
  // leaves the pan stuck on.
  try {
    s.setPointerCapture(e.pointerId);
  } catch {
    /* capture is best-effort */
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

async function copyCanvasPng(canvas: HTMLCanvasElement): Promise<void> {
  try {
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

vscode.postMessage({ type: 'ready' });
