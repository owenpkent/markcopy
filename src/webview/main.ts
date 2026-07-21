import mermaid from 'mermaid';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { toBlob } from 'html-to-image';
import { htmlToMarkdown } from './markdownConvert';
import { tableToDelimited } from './table';

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
let mermaidConfig: Record<string, unknown> = {};
// Identity of the document currently shown, so a render that swaps to a new
// document can reset scroll to the top (or a linked heading) instead of keeping
// the previous document's position. Empty until the first render.
let currentDocKey = '';

// Current setting values, refreshed on every `render` message. Read by the
// context menu's SETTINGS section so it always reflects the host's state.
let currentStyleProfile = 'github';
let currentTheme = 'auto';
let currentSyncScroll = true;
let currentAutoPreview = true;
let currentMath = true;

// The preview is dark when the theme is forced dark, or (in auto mode) when VS
// Code is in a dark/high-contrast theme. Mirrors the CSS in preview.css.
function isDark(): boolean {
  const forced = document.body.dataset.mcTheme;
  if (forced === 'dark') return true;
  if (forced === 'light') return false;
  return (
    document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast')
  );
}

// (Re)initialize Mermaid so diagrams match the current theme, merging any
// user-supplied `markcopy.mermaid` config on top.
function initMermaid(): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark() ? 'dark' : 'default',
    ...mermaidConfig,
  } as Parameters<typeof mermaid.initialize>[0]);
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  switch (msg?.type) {
    case 'render':
      render(
        msg.html as string,
        msg.source as string,
        msg.styleProfile as string,
        msg.theme as string,
        (msg.mermaidConfig as Record<string, unknown>) ?? {},
        Boolean(msg.syncScroll),
        Boolean(msg.autoPreview),
        msg.math === undefined ? true : Boolean(msg.math),
        (msg.docKey as string) ?? '',
        msg.revealFragment as string | undefined,
      );
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
async function render(
  html: string,
  source: string,
  styleProfile: string,
  theme: string,
  config: Record<string, unknown>,
  syncScroll: boolean,
  autoPreview: boolean,
  math: boolean,
  docKey: string,
  revealFragment: string | undefined,
): Promise<void> {
  const docChanged = docKey !== currentDocKey;
  currentDocKey = docKey;
  sourceLines = source.split(/\r?\n/);
  document.body.dataset.style = styleProfile;
  // 'auto' follows the VS Code theme (native `vscode-dark` class); 'light' and
  // 'dark' force the palette. See preview.css for how data-mc-theme is used.
  document.body.dataset.mcTheme = theme || 'auto';
  mermaidConfig = config;
  currentStyleProfile = styleProfile;
  currentTheme = theme || 'auto';
  currentSyncScroll = syncScroll;
  currentAutoPreview = autoPreview;
  currentMath = math;
  // Defense in depth. The host renders Markdown with `html: true`, so raw HTML
  // in the document reaches us untrusted. The webview CSP already blocks script
  // execution (script-src 'nonce-...', no unsafe-inline), but sanitizing here
  // means an XSS is not one CSP change away from firing. DOMPurify's defaults
  // strip <script>, inline event handlers, and javascript: URIs while keeping
  // formatting HTML, data-source-line attributes, and the mermaid placeholder
  // (<pre class="mermaid-src">) intact. Remote https images are left alone so
  // they still render; to also close the preview-open beacon vector, forbid
  // external image loads here (FORBID_ATTR / a uponSanitizeAttribute hook).
  content.innerHTML = DOMPurify.sanitize(html);
  // Render math synchronously, before any await below can yield a paint, so the
  // raw `$...$` placeholder text is never shown. katex.render is synchronous.
  renderKatex();
  // Initialize after data-mc-theme is set so the diagram theme matches.
  initMermaid();
  await renderMermaid();
  // On a live edit (same document) keep the reader's scroll position, unless the
  // navigation asked for a heading (e.g. a `file.md#sec` link back into the doc
  // already shown). When the preview swaps to a new document, land at the linked
  // heading or the top.
  if (revealFragment) {
    scrollToAnchor(revealFragment);
  } else if (docChanged) {
    scrollToTop();
  }
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

// Upgrade the inert math placeholders emitted by render.ts into rendered KaTeX.
// Runs after DOMPurify (like renderMermaid) so the sanitizer never sees KaTeX's
// markup. The original LaTeX is stashed on `data-tex` before katex.render()
// overwrites the element, so the context menu can still copy it back out.
function renderKatex(): void {
  const nodes = content.querySelectorAll<HTMLElement>('.mc-math');
  nodes.forEach((el) => {
    const tex = el.textContent ?? '';
    el.dataset.tex = tex;
    const displayMode = el.dataset.display === '1';
    try {
      katex.render(tex, el, { displayMode, throwOnError: false, output: 'htmlAndMathml' });
    } catch (err) {
      el.classList.add('mc-error');
      el.textContent = `Math error: ${String(err)}`;
    }
  });
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

function scrollToTop(): void {
  programmaticScroll = true;
  window.scrollTo(0, 0);
  window.setTimeout(() => (programmaticScroll = false), 60);
}

// Scroll to a heading (or named anchor) by its id/name. markdown-it-anchor gives
// every heading a slug id, so `[x](#slug)` links resolve here.
function scrollToAnchor(rawId: string): void {
  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    /* keep the raw id */
  }
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
  const el =
    document.getElementById(id) ??
    document.getElementById(rawId) ??
    content.querySelector<HTMLElement>(`a[name="${escaped}"]`);
  if (el) {
    programmaticScroll = true;
    el.scrollIntoView({ block: 'start' });
    window.setTimeout(() => (programmaticScroll = false), 60);
  }
}

// Follow links clicked in the rendered content. In-page `#fragment` links scroll
// the preview locally; every other link is handed to the host, which opens it in
// the browser or retargets the preview to a linked local document. The default
// action is broken inside the webview (relative hrefs resolve against the
// vscode-webview:// base), so we always intercept.
content.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0) {
    return;
  }
  const anchor = (e.target as HTMLElement).closest?.('a');
  const href = anchor?.getAttribute('href');
  if (!anchor || !href) {
    return;
  }
  e.preventDefault();
  if (href.startsWith('#')) {
    scrollToAnchor(href.slice(1));
  } else {
    vscode.postMessage({ type: 'openLink', href });
  }
});

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
// A plain clickable action ('item'), a group heading ('label', not
// interactive), a horizontal rule ('divider'), or a radio/checkbox setting
// toggle that renders a leading checkmark when active.
type MenuEntry =
  | { kind: 'item'; label: string; run: () => void | Promise<void> }
  | { kind: 'label'; label: string }
  | { kind: 'divider' }
  | { kind: 'radio' | 'checkbox'; label: string; checked: boolean; run: () => void };

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const target = e.target as HTMLElement;
  const entries: MenuEntry[] = [
    ...buildMenu(target),
    { kind: 'divider' },
    ...buildSettingsEntries(),
  ];
  showMenu(e.pageX, e.pageY, entries);
});

document.addEventListener('click', () => hideMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideMenu();
  }
});

function buildMenu(target: HTMLElement): MenuEntry[] {
  const items: MenuEntry[] = [];
  const selection = window.getSelection();
  const hasSelection = !!selection && selection.toString().trim().length > 0;
  const block = target.closest<HTMLElement>('[data-source-line]');
  const code = target.closest<HTMLElement>('pre.hljs, pre code');
  const table = target.closest<HTMLElement>('table');
  const mermaidEl = target.closest<HTMLElement>('.mc-mermaid');
  const mathEl = target.closest<HTMLElement>('.mc-math');

  if (hasSelection) {
    items.push({
      kind: 'item',
      label: 'Copy Selection as Rich Text',
      run: () => copyRichFromSelection(),
    });
    items.push({
      kind: 'item',
      label: 'Copy Selection as Markdown',
      run: () => copyText(selectionMarkdown()),
    });
  }

  if (code) {
    items.push({ kind: 'item', label: 'Copy Code', run: () => copyText(code.textContent ?? '') });
  }

  if (table) {
    items.push({ kind: 'item', label: 'Copy Table (Rich Text)', run: () => copyRichText(table) });
    items.push({
      kind: 'item',
      label: 'Copy Table as CSV',
      run: () => copyText(tableToDelimited(table, ',')),
    });
    items.push({
      kind: 'item',
      label: 'Copy Table as TSV',
      run: () => copyText(tableToDelimited(table, '\t')),
    });
    items.push({ kind: 'item', label: 'Copy Table as PNG', run: () => copyPng(table) });
  }

  if (mermaidEl) {
    items.push({ kind: 'item', label: 'Copy Diagram as PNG', run: () => copyPng(mermaidEl) });
    const svg = mermaidEl.querySelector('svg');
    if (svg) {
      items.push({
        kind: 'item',
        label: 'Copy Diagram as SVG',
        run: () => copyText(svg.outerHTML),
      });
    }
  }

  if (mathEl) {
    const tex = mathEl.dataset.tex ?? mathEl.textContent ?? '';
    const display = mathEl.dataset.display === '1';
    items.push({ kind: 'item', label: 'Copy Equation as PNG', run: () => copyPng(mathEl) });
    items.push({
      kind: 'item',
      label: 'Copy Equation as LaTeX',
      run: () => copyText(display ? `$$${tex}$$` : `$${tex}$`),
    });
  }

  // "Copy Block" grabs the whole element you clicked in. It's the no-selection
  // convenience, so hide it once there's a selection to avoid overlapping the
  // "Copy Selection" actions above.
  if (block && !hasSelection && !code && !table && !mermaidEl && !mathEl) {
    items.push({ kind: 'item', label: 'Copy Block as Rich Text', run: () => copyRichText(block) });
    items.push({
      kind: 'item',
      label: 'Copy Block as Markdown',
      run: () => copyText(blockMarkdown(block)),
    });
    items.push({ kind: 'item', label: 'Copy Block as PNG', run: () => copyPng(block) });
  }

  // Always-available document-level actions.
  items.push({
    kind: 'item',
    label: 'Copy Whole Document as Rich Text',
    run: () => copyRichText(content),
  });
  return items;
}

// A radio-style setting entry (Theme / Style groups): posts `updateSetting`
// with the fixed `value` for this option, regardless of current state.
function radioEntry(label: string, checked: boolean, key: string, value: string): MenuEntry {
  return {
    kind: 'radio',
    label,
    checked,
    run: () => vscode.postMessage({ type: 'updateSetting', key, value }),
  };
}

// A checkbox-style setting entry (Sync scroll / Auto-open preview): posts the
// toggled value, since the host re-renders with the new state afterwards.
function checkboxEntry(label: string, checked: boolean, key: string): MenuEntry {
  return {
    kind: 'checkbox',
    label,
    checked,
    run: () => vscode.postMessage({ type: 'updateSetting', key, value: !checked }),
  };
}

// The persistent SETTINGS section, shown on every right-click below a divider
// from the contextual copy actions. Reflects the last values seen in `render`.
function buildSettingsEntries(): MenuEntry[] {
  return [
    { kind: 'label', label: 'Theme' },
    radioEntry('Auto', currentTheme === 'auto', 'theme', 'auto'),
    radioEntry('Light', currentTheme === 'light', 'theme', 'light'),
    radioEntry('Dark', currentTheme === 'dark', 'theme', 'dark'),
    { kind: 'label', label: 'Style' },
    radioEntry('GitHub', currentStyleProfile === 'github', 'styleProfile', 'github'),
    radioEntry('VS Code', currentStyleProfile === 'vscode', 'styleProfile', 'vscode'),
    { kind: 'divider' },
    checkboxEntry('Sync scroll', currentSyncScroll, 'syncScroll'),
    checkboxEntry('Auto-open preview', currentAutoPreview, 'autoPreview'),
    checkboxEntry('Math ($ LaTeX)', currentMath, 'math'),
    { kind: 'divider' },
    {
      kind: 'item',
      label: 'MarkCopy Settings…',
      run: () => vscode.postMessage({ type: 'openSettings' }),
    },
  ];
}

function showMenu(x: number, y: number, entries: MenuEntry[]): void {
  menu.innerHTML = '';
  for (const entry of entries) {
    if (entry.kind === 'divider') {
      const el = document.createElement('div');
      el.className = 'mc-menu-divider';
      el.setAttribute('role', 'separator');
      menu.appendChild(el);
      continue;
    }
    if (entry.kind === 'label') {
      const el = document.createElement('div');
      el.className = 'mc-menu-group-label';
      el.textContent = entry.label;
      menu.appendChild(el);
      continue;
    }
    const el = document.createElement('div');
    el.tabIndex = 0;
    if (entry.kind === 'radio' || entry.kind === 'checkbox') {
      el.className = 'mc-menu-item mc-menu-item--check';
      el.setAttribute('role', entry.kind === 'radio' ? 'menuitemradio' : 'menuitemcheckbox');
      el.setAttribute('aria-checked', String(entry.checked));
      const check = document.createElement('span');
      check.className = 'mc-menu-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = entry.checked ? '✓' : '';
      const text = document.createElement('span');
      text.textContent = entry.label;
      el.append(check, text);
    } else {
      el.className = 'mc-menu-item';
      el.setAttribute('role', 'menuitem');
      el.textContent = entry.label;
    }
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hideMenu();
      void entry.run();
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
  const md = htmlToMarkdown(wrapper.innerHTML).trim();
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

// PNG copy via html-to-image + async Clipboard image write. Force the light
// palette during capture so the image is dark-on-white regardless of the
// preview theme (KaTeX and text inherit their color, so a dark theme would
// otherwise render invisibly on the white background).
async function copyPng(el: HTMLElement): Promise<void> {
  el.classList.add('mc-force-light');
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
  } finally {
    el.classList.remove('mc-force-light');
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
  // Force a light palette while reading computed styles, so the clipboard HTML
  // is dark-on-light regardless of the preview's display theme. This is applied
  // and removed synchronously here, so the on-screen preview never repaints.
  source.classList.add('mc-force-light');
  const clone = source.cloneNode(true) as HTMLElement;
  clone.classList.remove('mc-force-light');
  const srcAll = source.querySelectorAll<HTMLElement>('*');
  const dstAll = clone.querySelectorAll<HTMLElement>('*');
  applyInline(source, clone);
  for (let i = 0; i < srcAll.length; i++) {
    applyInline(srcAll[i], dstAll[i]);
  }
  source.classList.remove('mc-force-light');
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
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let seed = 0;
function idSeed(): number {
  return ++seed;
}

// Tell the host we are ready (host renders on open regardless).
vscode.postMessage({ type: 'ready' });
