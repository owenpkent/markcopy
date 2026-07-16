import mermaid from 'mermaid';
import { toBlob } from 'html-to-image';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// Converts rendered preview HTML back to Markdown for "copy selection as
// Markdown". Configured to match the flavor the source is typically written in.
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});
turndown.use(gfm);

// Minimal VS Code webview API surface we use.
interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const content = document.getElementById('content') as HTMLDivElement;
const menu = document.getElementById('mc-menu') as HTMLDivElement;
const toastEl = document.getElementById('mc-toast') as HTMLDivElement;

let sourceLines: string[] = [];
let programmaticScroll = false;

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  switch (msg?.type) {
    case 'render':
      render(msg.html as string, msg.source as string, msg.styleProfile as string);
      break;
    case 'scrollToLine':
      scrollToLine(msg.line as number);
      break;
    case 'copyAll':
      void copyRichText(content);
      break;
  }
});

function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.setTimeout(() => (toastEl.hidden = true), 1600);
  vscode.postMessage({ type: 'toast', text });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
async function render(html: string, source: string, styleProfile: string): Promise<void> {
  sourceLines = source.split(/\r?\n/);
  document.body.dataset.style = styleProfile;
  content.innerHTML = html;
  await renderMermaid();
}

async function renderMermaid(): Promise<void> {
  const nodes = Array.from(content.querySelectorAll('pre.mermaid-src'));
  for (let i = 0; i < nodes.length; i++) {
    const pre = nodes[i] as HTMLElement;
    const code = pre.textContent ?? '';
    const host = document.createElement('div');
    host.className = 'mc-mermaid';
    host.dataset.sourceLine = pre.dataset.sourceLine ?? '';
    pre.replaceWith(host);
    try {
      const { svg } = await mermaid.render(`mc-mmd-${i}-${idSeed()}`, code);
      host.innerHTML = svg;
    } catch (err) {
      host.innerHTML = `<pre class="mc-error">Mermaid error: ${escapeHtml(String(err))}</pre>`;
    }
  }
}

// ---------------------------------------------------------------------------
// Scroll sync
// ---------------------------------------------------------------------------
function scrollToLine(line: number): void {
  const el = nearestElementForLine(line);
  if (el) {
    programmaticScroll = true;
    el.scrollIntoView({ block: 'start' });
    window.setTimeout(() => (programmaticScroll = false), 60);
  }
}

function nearestElementForLine(line: number): HTMLElement | null {
  const marked = Array.from(content.querySelectorAll<HTMLElement>('[data-source-line]'));
  let best: HTMLElement | null = null;
  for (const el of marked) {
    const l = Number(el.dataset.sourceLine);
    if (l <= line) {
      best = el;
    } else {
      break;
    }
  }
  return best ?? marked[0] ?? null;
}

window.addEventListener(
  'scroll',
  () => {
    if (programmaticScroll) {
      return;
    }
    const marked = Array.from(content.querySelectorAll<HTMLElement>('[data-source-line]'));
    for (const el of marked) {
      if (el.getBoundingClientRect().top >= 0) {
        vscode.postMessage({ type: 'revealLine', line: Number(el.dataset.sourceLine) });
        break;
      }
    }
  },
  { passive: true },
);

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
  const items = buildMenu(target);
  showMenu(e.pageX, e.pageY, items);
});

document.addEventListener('click', () => hideMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideMenu();
  }
});

function buildMenu(target: HTMLElement): MenuItem[] {
  const items: MenuItem[] = [];
  const selection = window.getSelection();
  const hasSelection = !!selection && selection.toString().trim().length > 0;
  const block = target.closest<HTMLElement>('[data-source-line]');
  const code = target.closest<HTMLElement>('pre.hljs, pre code');
  const table = target.closest<HTMLElement>('table');
  const mermaidEl = target.closest<HTMLElement>('.mc-mermaid');

  if (hasSelection) {
    items.push({ label: 'Copy Selection as Rich Text', run: () => copyRichFromSelection() });
    items.push({ label: 'Copy Selection as Markdown', run: () => copyText(selectionMarkdown()) });
  }

  if (code) {
    items.push({ label: 'Copy Code', run: () => copyText(code.textContent ?? '') });
  }

  if (table) {
    items.push({ label: 'Copy Table (Rich Text)', run: () => copyRichText(table) });
    items.push({ label: 'Copy Table as CSV', run: () => copyText(tableToDelimited(table, ',')) });
    items.push({ label: 'Copy Table as TSV', run: () => copyText(tableToDelimited(table, '\t')) });
    items.push({ label: 'Copy Table as PNG', run: () => copyPng(table) });
  }

  if (mermaidEl) {
    items.push({ label: 'Copy Diagram as PNG', run: () => copyPng(mermaidEl) });
    const svg = mermaidEl.querySelector('svg');
    if (svg) {
      items.push({ label: 'Copy Diagram as SVG', run: () => copyText(svg.outerHTML) });
    }
  }

  if (block && !code && !table && !mermaidEl) {
    items.push({ label: 'Copy Block as Rich Text', run: () => copyRichText(block) });
    items.push({ label: 'Copy Block as Markdown', run: () => copyText(blockMarkdown(block)) });
    items.push({ label: 'Copy Block as PNG', run: () => copyPng(block) });
  }

  // Always-available document-level actions.
  items.push({ label: 'Copy Whole Document as Rich Text', run: () => copyRichText(content) });
  return items;
}

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
      hideMenu();
      void item.run();
    });
    menu.appendChild(el);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.hidden = false;
  // Keep the menu inside the viewport.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(0, x - rect.width)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(0, y - rect.height)}px`;
  }
}

function hideMenu(): void {
  menu.hidden = true;
}

// ---------------------------------------------------------------------------
// Markdown slicing (for "copy as Markdown")
// ---------------------------------------------------------------------------
function blockMarkdown(block: HTMLElement): string {
  const start = Number(block.dataset.sourceLine);
  if (Number.isNaN(start)) {
    return block.textContent ?? '';
  }
  const marked = Array.from(content.querySelectorAll<HTMLElement>('[data-source-line]'));
  const idx = marked.indexOf(block);
  let end = sourceLines.length;
  for (let i = idx + 1; i < marked.length; i++) {
    const l = Number(marked[i].dataset.sourceLine);
    if (l > start) {
      end = l;
      break;
    }
  }
  return sourceLines.slice(start, end).join('\n').trim();
}

function selectionMarkdown(): string {
  // Exact: serialize just the selected fragment back to Markdown. Verbatim
  // source slicing is not possible (we only have block-level line mapping), so
  // the selected rendered HTML is converted with Turndown. This handles partial
  // paragraphs and selections spanning multiple blocks.
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return '';
  }
  const wrapper = document.createElement('div');
  for (let i = 0; i < sel.rangeCount; i++) {
    wrapper.appendChild(sel.getRangeAt(i).cloneContents());
  }
  // Rendered diagrams and raw SVG do not serialize to Markdown; drop them.
  wrapper.querySelectorAll('svg, .mc-mermaid').forEach((n) => n.remove());
  const md = turndown.turndown(wrapper.innerHTML).trim();
  return md || sel.toString();
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------
function copyText(text: string): void {
  writeClipboard(null, text);
  toast('Copied');
}

function copyRichText(el: HTMLElement): void {
  const html = inlineStyledHtml(el);
  writeClipboard(html, el.innerText);
  toast('Copied as rich text');
}

function copyRichFromSelection(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return;
  }
  const wrapper = document.createElement('div');
  wrapper.appendChild(sel.getRangeAt(0).cloneContents());
  content.appendChild(wrapper); // attach so computed styles resolve
  const html = inlineStyledHtml(wrapper);
  wrapper.remove();
  writeClipboard(html, sel.toString());
  toast('Copied selection as rich text');
}

// Synchronous copy-event write: the most reliable way to put text/html on the
// clipboard from inside a VS Code webview iframe (async Clipboard API can be
// permission-blocked). Falls back to writeText.
function writeClipboard(html: string | null, plain: string): void {
  const onCopy = (e: ClipboardEvent) => {
    if (e.clipboardData) {
      if (html) {
        e.clipboardData.setData('text/html', html);
      }
      e.clipboardData.setData('text/plain', plain);
    }
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  if (!ok) {
    void navigator.clipboard?.writeText(plain);
  }
}

// PNG copy via html-to-image + async Clipboard image write.
async function copyPng(el: HTMLElement): Promise<void> {
  try {
    const blob = await toBlob(el, { pixelRatio: 2, backgroundColor: '#ffffff' });
    if (blob && navigator.clipboard && 'write' in navigator.clipboard) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Copied as PNG');
    } else {
      toast('PNG copy not supported here');
    }
  } catch {
    toast('PNG copy failed');
  }
}

// ---------------------------------------------------------------------------
// Inline styling so pasted HTML survives Gmail/Outlook/Word (they strip <style>
// and external CSS, honoring only inline styles).
// ---------------------------------------------------------------------------
const INLINE_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'color',
  'background-color',
  'text-align',
  'text-decoration-line',
  'line-height',
  'padding',
  'padding-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'margin',
  'margin-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'border',
  'border-collapse',
  'border-color',
  'border-style',
  'border-width',
  'list-style-type',
  'white-space',
];

function inlineStyledHtml(source: HTMLElement): string {
  const clone = source.cloneNode(true) as HTMLElement;
  const srcAll = source.querySelectorAll<HTMLElement>('*');
  const dstAll = clone.querySelectorAll<HTMLElement>('*');
  applyInline(source, clone);
  for (let i = 0; i < srcAll.length; i++) {
    applyInline(srcAll[i], dstAll[i]);
  }
  return `<div>${clone.outerHTML}</div>`;
}

function applyInline(src: HTMLElement, dst: HTMLElement): void {
  const cs = window.getComputedStyle(src);
  let style = '';
  for (const p of INLINE_PROPS) {
    const v = cs.getPropertyValue(p);
    if (v && v !== 'normal' && v !== 'none' && v !== 'auto') {
      style += `${p}:${v};`;
    }
  }
  if (style) {
    dst.setAttribute('style', style);
  }
  dst.removeAttribute('data-source-line');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
// Serialize a table to delimiter-separated values. Pass ',' for CSV or '\t' for
// TSV. CSV fields follow RFC 4180 quoting; TSV flattens tabs/newlines to spaces.
function tableToDelimited(table: HTMLElement, delimiter: string): string {
  return Array.from(table.querySelectorAll('tr'))
    .map((tr) =>
      Array.from(tr.querySelectorAll('th,td'))
        .map((c) => escapeField((c.textContent ?? '').trim(), delimiter))
        .join(delimiter),
    )
    .join('\r\n');
}

function escapeField(value: string, delimiter: string): string {
  if (delimiter === '\t') {
    return value.replace(/[\t\r\n]+/g, ' ');
  }
  // RFC 4180: quote the field if it contains the delimiter, a quote, or a newline.
  if (value.includes(delimiter) || value.includes('"') || /[\r\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let seed = 0;
function idSeed(): number {
  return ++seed;
}

// Tell the host we are ready (host renders on open regardless).
vscode.postMessage({ type: 'ready' });
