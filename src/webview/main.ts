import type MermaidApi from 'mermaid';
import type KatexApi from 'katex';
import DOMPurify from 'dompurify';
import { htmlToMarkdown } from './markdownConvert';
import { tableToDelimited } from './table';
import { createMenu, type MenuEntry } from './menu';

// Heavy libraries are loaded lazily on first use so the initial webview bundle
// stays small. Each getter caches the module's default export after the first
// dynamic import, so later renders reuse it without re-importing.
let _mermaid: typeof MermaidApi | undefined;
async function getMermaid(): Promise<typeof MermaidApi> {
  return (_mermaid ??= (await import('mermaid')).default);
}

let _katex: typeof KatexApi | undefined;
async function getKatex(): Promise<typeof KatexApi> {
  return (_katex ??= (await import('katex')).default);
}

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
async function initMermaid(): Promise<void> {
  const mermaid = await getMermaid();
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
    case 'exportPdf':
      void exportPdf();
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
  // Retained in the render message for protocol compatibility; markcopy.styleProfile
  // is now github-only and no longer drives any styling, so it is unused here.
  _styleProfile: string,
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
  // 'auto' follows the VS Code theme (native `vscode-dark` class); 'light' and
  // 'dark' force the palette. See preview.css for how data-mc-theme is used.
  document.body.dataset.mcTheme = theme || 'auto';
  mermaidConfig = config;
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
  // Upgrade the math and diagram placeholders. KaTeX and Mermaid are now loaded
  // lazily on first use, so the very first math/diagram document may briefly show
  // its raw `$...$` / source text before the library finishes importing.
  await renderKatex();
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
  if (nodes.length === 0) {
    return;
  }
  // Initialize right before the first render (after data-mc-theme is set) so the
  // diagram theme matches, and so Mermaid is only imported when a diagram exists.
  await initMermaid();
  const mermaid = await getMermaid();
  for (let i = 0; i < nodes.length; i++) {
    const pre = nodes[i] as HTMLElement;
    const code = pre.textContent ?? '';
    const host = document.createElement('div');
    host.className = 'mc-mermaid';
    host.dataset.sourceLine = pre.dataset.sourceLine ?? '';
    // Keep the source so the diagram can be re-rendered in a light theme for PDF
    // export (Mermaid bakes theme colors into the SVG, so a dark-theme diagram is
    // unreadable on a forced-light printout).
    host.dataset.mermaidSrc = code;
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
async function renderKatex(): Promise<void> {
  const nodes = content.querySelectorAll<HTMLElement>('.mc-math');
  if (nodes.length === 0) {
    return;
  }
  const katex = await getKatex();
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
const contextMenu = createMenu(menu);

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  contextMenu.show(e.pageX, e.pageY, buildMenu(e.target as HTMLElement));
});

document.addEventListener('click', () => contextMenu.hide());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    contextMenu.hide();
  }
});

// One thing you can copy (a table, a diagram, the selection…) and every format
// MarkCopy can put it on the clipboard in. `actions[0]` is the format the
// top-level "Copy X" row uses; the rest live in the "Copy as" submenu.
interface CopyGroup {
  noun: string;
  actions: { label: string; run: () => void | Promise<void> }[];
}

// The copy groups that apply to the clicked element, most specific first.
// Several can apply at once — selecting text inside a table yields both — and
// the first one drives the menu's primary row.
function copyGroups(target: HTMLElement): CopyGroup[] {
  const groups: CopyGroup[] = [];
  const selection = window.getSelection();
  const hasSelection = !!selection && selection.toString().trim().length > 0;
  const block = target.closest<HTMLElement>('[data-source-line]');
  const code = target.closest<HTMLElement>('pre.hljs, pre code');
  const table = target.closest<HTMLElement>('table');
  const mermaidEl = target.closest<HTMLElement>('.mc-mermaid');
  const mathEl = target.closest<HTMLElement>('.mc-math');

  if (hasSelection) {
    groups.push({
      noun: 'Selection',
      actions: [
        { label: 'Rich Text', run: () => copyRichFromSelection() },
        { label: 'Markdown', run: async () => copyText(await selectionMarkdown()) },
      ],
    });
  }

  if (code) {
    groups.push({
      noun: 'Code',
      actions: [{ label: 'Plain Text', run: () => copyText(code.textContent ?? '') }],
    });
  }

  if (table) {
    groups.push({
      noun: 'Table',
      actions: [
        { label: 'Rich Text', run: () => copyRichText(table) },
        { label: 'CSV', run: () => copyText(tableToDelimited(table, ',')) },
        { label: 'TSV', run: () => copyText(tableToDelimited(table, '\t')) },
        { label: 'PNG', run: () => copyPng(table) },
      ],
    });
  }

  if (mermaidEl) {
    const svg = mermaidEl.querySelector('svg');
    groups.push({
      noun: 'Diagram',
      actions: [
        { label: 'PNG', run: () => copyPng(mermaidEl) },
        ...(svg ? [{ label: 'SVG', run: () => copyText(svg.outerHTML) }] : []),
      ],
    });
  }

  if (mathEl) {
    const tex = mathEl.dataset.tex ?? mathEl.textContent ?? '';
    const display = mathEl.dataset.display === '1';
    groups.push({
      noun: 'Equation',
      actions: [
        { label: 'PNG', run: () => copyPng(mathEl) },
        { label: 'LaTeX', run: () => copyText(display ? `$$${tex}$$` : `$${tex}$`) },
      ],
    });
  }

  // "Block" grabs the whole element you clicked in. It's the fallback for when
  // nothing more specific applies, so it drops out as soon as anything does.
  if (block && groups.length === 0) {
    groups.push({
      noun: 'Block',
      actions: [
        { label: 'Rich Text', run: () => copyRichText(block) },
        { label: 'Markdown', run: () => copyText(blockMarkdown(block)) },
        { label: 'PNG', run: () => copyPng(block) },
      ],
    });
  }

  return groups;
}

function buildMenu(target: HTMLElement): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const groups = copyGroups(target);

  if (groups.length > 0) {
    const [first, ...rest] = groups;
    entries.push({ kind: 'item', label: `Copy ${first.noun}`, run: first.actions[0].run });

    // Everything the primary row didn't cover: the clicked thing's other
    // formats, then every format of the less specific things around it.
    const sections = [{ noun: first.noun, actions: first.actions.slice(1) }, ...rest].filter(
      (group) => group.actions.length > 0,
    );
    const variants: MenuEntry[] = [];
    for (const group of sections) {
      // Only head the sections when more than one contributes, so the common
      // single-context case reads as a bare list of formats.
      if (sections.length > 1) {
        variants.push({ kind: 'label', label: group.noun });
      }
      for (const action of group.actions) {
        variants.push({ kind: 'item', label: action.label, run: action.run });
      }
    }
    if (variants.length > 0) {
      entries.push({ kind: 'submenu', label: 'Copy as', entries: variants });
    }
    entries.push({ kind: 'divider' });
  }

  // Always-available document-level actions.
  entries.push({ kind: 'item', label: 'Copy Whole Document', run: () => copyRichText(content) });
  entries.push({ kind: 'item', label: 'Save as PDF…', run: () => exportPdf() });
  entries.push({ kind: 'divider' });
  entries.push({ kind: 'submenu', label: 'Preferences', entries: buildSettingsEntries() });
  return entries;
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

// The contents of the "Preferences" submenu, rebuilt on every right-click so it
// reflects the last setting values seen in `render`.
function buildSettingsEntries(): MenuEntry[] {
  return [
    {
      kind: 'submenu',
      label: 'Theme',
      entries: [
        radioEntry('Auto', currentTheme === 'auto', 'theme', 'auto'),
        radioEntry('Light', currentTheme === 'light', 'theme', 'light'),
        radioEntry('Dark', currentTheme === 'dark', 'theme', 'dark'),
        radioEntry('Green on black', currentTheme === 'green', 'theme', 'green'),
      ],
    },
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

async function selectionMarkdown(): Promise<string> {
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
  const md = (await htmlToMarkdown(wrapper.innerHTML)).trim();
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
    const { toBlob } = await import('html-to-image');
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
// PDF export
// ---------------------------------------------------------------------------
// Serialize the already-rendered preview (KaTeX HTML, Mermaid SVG, highlighted
// code all live in the DOM) and hand it to the host, which wraps it in a
// standalone HTML file and opens it in the browser for printing to PDF. Local
// images are inlined as data URIs so they survive outside the webview; the host
// injects preview.css + KaTeX CSS, so we send raw markup and let CSS style it.
async function exportPdf(): Promise<void> {
  try {
    const clone = content.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('[data-source-line]')
      .forEach((el) => el.removeAttribute('data-source-line'));
    await relightMermaid(clone);
    await inlineImages(clone);
    vscode.postMessage({ type: 'pdfHtml', bodyHtml: clone.innerHTML });
    toast('Opening PDF export…');
  } catch {
    toast('PDF export failed');
  }
}

// Re-render every Mermaid diagram in the export clone with the light theme.
// The on-screen SVGs bake in the (possibly dark) preview theme, which turns into
// unreadable black boxes on the forced-light PDF page. We re-render from the
// stashed source with `theme: 'default'`, then restore the on-screen config.
async function relightMermaid(root: HTMLElement): Promise<void> {
  const hosts = Array.from(root.querySelectorAll<HTMLElement>('.mc-mermaid'));
  if (hosts.length === 0) {
    return;
  }
  const mermaid = await getMermaid();
  // `theme` last so it wins over any user `markcopy.mermaid` theme for the print.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    ...mermaidConfig,
    theme: 'default',
  } as Parameters<typeof mermaid.initialize>[0]);
  try {
    for (let i = 0; i < hosts.length; i++) {
      const src = hosts[i].dataset.mermaidSrc;
      if (!src) {
        continue;
      }
      try {
        const { svg } = await mermaid.render(`mc-pdf-${i}-${idSeed()}`, src);
        hosts[i].innerHTML = svg;
      } catch {
        /* leave the existing SVG; a themed diagram beats no diagram */
      }
    }
  } finally {
    await initMermaid();
  }
}

// Replace webview-hosted image srcs with data URIs so they load from a plain
// file:// page. Remote (http/https) and already-inlined (data:) images are left
// untouched: they still load in the browser, and the CSP forbids fetching them.
async function inlineImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') ?? '';
      if (!src || /^(https?:|data:)/i.test(src)) {
        return;
      }
      try {
        const blob = await (await fetch(src)).blob();
        img.setAttribute('src', await blobToDataUrl(blob));
      } catch {
        /* leave the original src; a broken image beats aborting the export */
      }
    }),
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
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
