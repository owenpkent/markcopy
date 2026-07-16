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
    void load(msg.data as Uint8Array, msg.workerSrc as string);
  }
});

function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.setTimeout(() => (toastEl.hidden = true), 1600);
}

async function load(data: Uint8Array, workerSrc: string): Promise<void> {
  // Run pdf.js parsing/rasterising off the main thread via a module worker
  // created from the bundled worker URI (CSP allows same-origin workers).
  const worker = new Worker(workerSrc, { type: 'module' });
  pdfjsLib.GlobalWorkerOptions.workerPort = worker;

  root.textContent = '';
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

  showMenu(e.pageX, e.pageY, items);
});

document.addEventListener('click', () => (menu.hidden = true));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') menu.hidden = true;
});

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
