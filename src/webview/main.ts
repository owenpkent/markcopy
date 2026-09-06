import type MermaidApi from 'mermaid';
import type KatexApi from 'katex';
import DOMPurify from 'dompurify';
import { htmlToMarkdown } from './markdownConvert';
import { tableToDelimited, tableToMarkdown } from './table';
import { enhanceCsvTables, resetColumnWidths } from './csvTable';
import { enableCsvEditing, editorIn, gridRefFrom, parkFocus } from './csvEdit';
import { createMenu, type MenuEntry } from './menu';
import { nounFor, refFromHref, refFromText } from './links';
import { lineForOffset, offsetForLine, sample, type Anchor } from './scrollSync';
// Type only: the host owns the grid operations, and naming them in one place
// keeps the menu and the writeback from drifting apart. Erased at build time, so
// no host code follows it into the webview bundle.
import type { GridOp } from '../csv';

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
// Built here rather than beside its handlers further down, because `render`
// hands it to the CSV grid: an editor left open underneath the menu asks it
// whether it is the thing that took the keyboard, and when it gives it back.
const contextMenu = createMenu(menu);
const toastEl = document.getElementById('mc-toast') as HTMLDivElement;

let sourceLines: string[] = [];
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
// The document version the grid on screen was drawn from. Only the context menu
// reads it, and only while building itself, which is why a global is safe here
// where the cell editor deliberately closes over its own render version instead:
// a menu is always built against the grid on screen, while an open editor can
// outlive the render that made it.
let currentDocVersion = 0;

// Whether the surface on screen participates in scroll sync. Separate from
// currentSyncScroll, which is the user's setting: the menu shows the setting,
// this decides whether anything is wired up.
let surfaceSyncs = true;

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
        msg.supportsSync === undefined ? true : Boolean(msg.supportsSync),
        Boolean(msg.autoPreview),
        msg.math === undefined ? true : Boolean(msg.math),
        (msg.docKey as string) ?? '',
        (msg.kind as string) ?? 'markdown',
        Number(msg.docVersion ?? -1),
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
  // Whether this surface takes part in scroll sync at all, which is not the same
  // as whether the user has the setting on. A sheet preview has no TextDocument
  // behind it, so there is nothing to reveal into however the setting is set.
  supportsSync: boolean,
  autoPreview: boolean,
  math: boolean,
  docKey: string,
  // What the host rendered: 'markdown' or 'csv'. Drives the full-width,
  // self-scrolling grid layout in preview.css; the rest of the webview treats
  // both the same.
  kind: string,
  docVersion: number,
  revealFragment: string | undefined,
): Promise<void> {
  const docChanged = docKey !== currentDocKey;
  currentDocKey = docKey;
  sourceLines = source.split(/\r?\n/);
  document.body.dataset.mcKind = kind || 'markdown';
  // 'auto' follows the VS Code theme (native `vscode-dark` class); 'light' and
  // 'dark' force the palette. See preview.css for how data-mc-theme is used.
  document.body.dataset.mcTheme = theme || 'auto';
  mermaidConfig = config;
  currentTheme = theme || 'auto';
  currentSyncScroll = syncScroll;
  surfaceSyncs = supportsSync;
  currentAutoPreview = autoPreview;
  currentMath = math;
  currentDocVersion = docVersion;
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
  // Hang the drag-to-resize handles off a CSV grid's column headers, and make the
  // grid's own scroller drive preview -> editor sync (the page itself does not
  // scroll in the CSV layout, so the window listener never fires there).
  enhanceCsvTables(content);
  // `docVersion` is the parameter, deliberately, not a shared latest-render
  // global: it pins the edit to the version *this* grid was drawn from. Reading
  // a global here would stamp a grid that a later render had already replaced
  // with that later version, which is exactly what the host's staleness check
  // exists to catch.
  enableCsvEditing(
    content,
    (line, column, value) =>
      vscode.postMessage({ type: 'editCell', line, column, value, docVersion }),
    contextMenu,
  );
  content
    .querySelectorAll<HTMLElement>('.mc-csv-wrap')
    .forEach((wrap) => wrap.addEventListener('scroll', syncEditorToPreview, { passive: true }));
  // Every block just moved, so the measured anchors describe the previous render.
  invalidateAnchors();
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
    // Only when there is a real line to carry. markdown-it's fence rule returns the
    // highlighter's output verbatim when it already starts with `<pre`, which drops
    // the token's attributes, so this is often absent. Setting it to '' anyway
    // would hand scroll sync an anchor claiming line 0.
    if (pre.dataset.sourceLine) {
      host.dataset.sourceLine = pre.dataset.sourceLine;
    }
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
// Editor and preview drive each other, so every move one side makes comes back as
// a request to move the other. Left alone the two fight: scrolling the preview
// reveals a line in the editor, the editor reports its new position, and the
// preview is yanked to that line's block mid-gesture, which reads as sync scroll
// being broken rather than as a loop.
//
// Two rules break it. A scroll we performed ourselves is not reported back (the
// suppression window), and a request that arrives while the user is actively
// scrolling the preview is dropped, because it can only be the echo of what they
// are already doing. The window is generous enough to cover the reveal round-trip
// through the extension host and short enough to be invisible.
const SYNC_ECHO_MS = 250;

// Sampling cap for the anchor list; see `sample` in scrollSync.ts.
const MAX_ANCHORS = 600;

let syncSuppressedUntil = 0;
let userScrolledAt = 0;

// Where our own last programmatic scroll left the scroller, so the deferred
// re-check below can tell that scroll from the reader's. -1 means there is
// nothing of ours to disown.
let suppressedOffset = -1;

function suppressSync(ms = SYNC_ECHO_MS): void {
  syncSuppressedUntil = Math.max(syncSuppressedUntil, Date.now() + ms);
}

/** Suppress, and remember the offset we are about to move to. */
function suppressSyncTo(offset: number): void {
  suppressSync();
  suppressedOffset = offset;
}

function syncSuppressed(): boolean {
  return Date.now() < syncSuppressedUntil;
}

// What actually scrolls. A Markdown preview scrolls the page; a grid preview (CSV
// or a spreadsheet sheet) is viewport-tall and scrolls inside its own wrapper (see
// preview.css), and the page itself never moves.
function isGridKind(): boolean {
  const kind = document.body.dataset.mcKind;
  return kind === 'csv' || kind === 'xlsx';
}

function scroller(): HTMLElement | null {
  return isGridKind() ? content.querySelector<HTMLElement>('.mc-csv-wrap') : null;
}

function scrollTop(): number {
  const el = scroller();
  return el ? el.scrollTop : window.scrollY;
}

function setScrollTop(value: number): void {
  const el = scroller();
  if (el) {
    el.scrollTop = value;
  } else {
    window.scrollTo(0, value);
  }
}

function maxScroll(): number {
  const el = scroller();
  return el
    ? Math.max(0, el.scrollHeight - el.clientHeight)
    : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
}

// Anchors are measured once and reused: a long document has hundreds of them, and
// re-measuring on every scroll frame would cost a forced layout each time. The
// cache is dropped on render, on resize, and whenever the content's height changes
// under it (a late image, font, or diagram settling).
let anchorCache: Anchor[] | null = null;
let anchorCacheHeight = -1;

function invalidateAnchors(): void {
  anchorCache = null;
}

function anchors(): Anchor[] {
  const height = scroller()?.scrollHeight ?? document.documentElement.scrollHeight;
  if (anchorCache && anchorCacheHeight === height) {
    return anchorCache;
  }

  // `data-source-line` marks the Markdown blocks, and a CSV grid puts one on every
  // body row (src/csv.ts), so one selector covers both. The grid's header row is
  // excluded because csv.ts deliberately omits the attribute there: the header is
  // sticky, so its position tracks the scroll rather than the content.
  const nodes = Array.from(content.querySelectorAll<HTMLElement>('[data-source-line]'));
  const base = scrollTop();
  const containerTop = scroller()?.getBoundingClientRect().top ?? 0;

  const out: Anchor[] = [];
  for (const el of sample(nodes, MAX_ANCHORS)) {
    const raw = el.dataset.sourceLine ?? '';
    // An empty attribute is not line 0. `Number('')` is 0 and passes isFinite, so
    // an element carrying `data-source-line=""` would anchor the top of the
    // document to itself: see the Mermaid host below, whose source line markdown-it
    // does not always supply.
    if (raw.trim() === '') {
      continue;
    }
    const line = Number(raw);
    if (!Number.isFinite(line)) {
      continue;
    }
    const offset = el.getBoundingClientRect().top - containerTop + base;
    const prev = out[out.length - 1];
    // Interpolation needs both keys non-decreasing. Anything that measures out of
    // order (a float, an absolutely positioned block) is skipped rather than
    // allowed to invert the mapping.
    if (prev && (line <= prev.line || offset <= prev.offset)) {
      continue;
    }
    out.push({ line, offset });
  }

  // Close the list off at the end of the document, so the last screenful maps
  // proportionally instead of pinning to the final block's top edge.
  //
  // Measured anchors at or past the end of the scroll range go first. Without
  // that, the synthetic anchor below almost never qualifies: the preview leaves
  // 120px of room to scroll past the end, so a closing paragraph of 20-40px sits
  // beyond `maxScroll()` and the `offset` comparison fails on nearly every
  // document. Dropping them rather than loosening the comparison keeps `offset`
  // strictly increasing, which the binary search in scrollSync.ts depends on.
  const limit = maxScroll();
  if (limit > 0) {
    while (out.length > 0 && out[out.length - 1].offset >= limit) {
      out.pop();
    }
  }
  // A grid truncated by markcopy.csv.maxRows renders far fewer rows than the file
  // has lines, so the document's last line is not what the bottom of the scroll
  // range is showing. Anchoring to it would interpolate the final few pixels
  // across every unrendered row and fling the editor to the end of the file.
  const last = out[out.length - 1];
  const endLine = isGridKind() ? (last?.line ?? 0) + 1 : Math.max(0, sourceLines.length - 1);
  const end = { line: endLine, offset: limit };
  if (!last || (end.line > last.line && end.offset > last.offset)) {
    out.push(end);
  }

  anchorCache = out;
  anchorCacheHeight = height;
  return out;
}

// Editor -> preview.
function scrollToLine(line: number): void {
  if (!currentSyncScroll || !surfaceSyncs || !Number.isFinite(line)) {
    return;
  }
  // The user's own scrolling wins: this is almost certainly the echo of the reveal
  // that their preview scroll just caused in the editor.
  if (Date.now() - userScrolledAt < SYNC_ECHO_MS) {
    return;
  }
  const target = offsetForLine(anchors(), line);
  if (target === undefined || Math.abs(target - scrollTop()) < 1) {
    return;
  }
  suppressSyncTo(target);
  setScrollTop(target);
}

function scrollToTop(): void {
  suppressSyncTo(0);
  setScrollTop(0);
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
    suppressSync();
    el.scrollIntoView({ block: 'start' });
    // scrollIntoView picks the offset itself, and it is synchronous, so this is
    // where it landed. Recorded for the same reason as the other two: so the
    // scroll it just fired is not reported back to the host as the reader's.
    suppressedOffset = scrollTop();
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

// Sheet tabs, in a workbook preview. The host re-renders with the chosen sheet;
// the webview holds no workbook state of its own, exactly as it holds no Markdown
// or CSV state.
content.addEventListener('click', (e) => {
  const tab = (e.target as HTMLElement).closest?.<HTMLElement>('[data-mc-sheet]');
  if (!tab) {
    return;
  }
  vscode.postMessage({ type: 'selectSheet', index: Number(tab.dataset.mcSheet) });
});

// Preview -> editor: report the source line showing at the top of the viewport,
// interpolated between the blocks either side of it. Bound to the window for the
// Markdown layout, and (in render) to the CSV grid's scroll container, which is
// what actually scrolls in the CSV layout.
//
// Throttled to one message per frame: a scroll gesture fires far more events than
// that, and each one costs a round-trip through the extension host.
let syncRaf = 0;
// Set when a scroll arrives inside the echo-suppression window. A gesture that
// both starts and ends in that window would otherwise be dropped outright, and
// nothing would ever resend it: the host only pushes on an *editor* move, so the
// editor would sit on the old line until the reader scrolled again. Re-checked
// once the window closes.
let syncPending = 0;

function syncEditorToPreview(): void {
  if (syncRaf) {
    return;
  }
  syncRaf = requestAnimationFrame(() => {
    syncRaf = 0;
    if (syncSuppressed()) {
      // Our own scroll, not the reader's, or at least indistinguishable from it.
      // Come back when the window has closed and decide then.
      if (!syncPending) {
        syncPending = window.setTimeout(
          () => {
            syncPending = 0;
            syncEditorToPreview();
          },
          Math.max(0, syncSuppressedUntil - Date.now()) + 1,
        );
      }
      return;
    }
    // The window has closed. If the scroller is still sitting where the host put
    // it, nothing happened here except the host's own move, and reporting it back
    // as a revealLine is a pure echo: the editor jumps to wherever the round trip
    // rounds to, and userScrolledAt below would then mute the next genuine
    // editor-to-preview sync for the length of the window. A reader who moved
    // during the window has left the scroller somewhere else, which is the case
    // the deferral exists to catch, and that still reports.
    if (suppressedOffset >= 0 && Math.abs(scrollTop() - suppressedOffset) < 1) {
      suppressedOffset = -1;
      return;
    }
    suppressedOffset = -1;
    userScrolledAt = Date.now();
    if (!currentSyncScroll || !surfaceSyncs) {
      return;
    }
    const line = lineForOffset(anchors(), scrollTop());
    if (line !== undefined) {
      vscode.postMessage({ type: 'revealLine', line: Math.max(0, Math.floor(line)) });
    }
  });
}

window.addEventListener('scroll', syncEditorToPreview, { passive: true });
// Offsets move with the panel width; the next sync re-measures.
window.addEventListener('resize', invalidateAnchors, { passive: true });

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
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

  // A link leads the menu, ahead of even a selection. Right-clicking one is the
  // most precise gesture there is -- it names a single element, where a
  // selection names a range that may not have been aimed at anything -- and the
  // address behind a link is the value a hand-drag across its text cannot get
  // at all.
  const link = linkGroup(target);
  if (link) {
    groups.push(link);
  }

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

  // A cell's own text, and the address in it when it holds one. Nothing
  // linkifies CSV or spreadsheet cells -- they are rendered verbatim on purpose
  // -- so in a grid this is the only route to an address that isn't a hand-drag.
  //
  // `data-mc-ignore` marks viewer chrome: the row-number gutter, a sheet's
  // A/B/C header row. Every other copy flavor already leaves it out, and a row
  // that put a row number on the clipboard would be the one place it leaked.
  const cell = target.closest<HTMLElement>('td:not([data-mc-ignore]), th:not([data-mc-ignore])');
  const cellText = (cell?.textContent ?? '').trim();
  // Skipped under a link, which has already contributed the same address from
  // its href, and from the row above this one.
  const cellRef = cell && cellText && !link ? refFromText(cellText) : null;
  const cellGroup: CopyGroup | null =
    cell && cellText
      ? {
          noun: cellRef ? nounFor(cellRef) : 'Cell',
          actions: [
            ...(cellRef ? [{ label: nounFor(cellRef), run: () => copyText(cellRef.value) }] : []),
            { label: 'Cell Text', run: () => copyText(cellText) },
          ],
        }
      : null;

  // Ahead of the table only when the cell holds something a table copy cannot
  // give you. "Copy Table" is what a right-click in a grid has always offered
  // and what docs/TESTING.md promises, so an ordinary cell stays behind it and
  // reaches the menu through "Copy as".
  if (cellGroup && cellRef) {
    groups.push(cellGroup);
  }

  if (table) {
    groups.push({
      noun: 'Table',
      actions: [
        { label: 'Rich Text', run: () => copyRichText(table) },
        // A spreadsheet sheet and a CSV grid are both tables by the time they get
        // here, so this is also how a range of cells leaves as a Markdown table:
        // the thing no other extension offers and the reason someone reaches for
        // MarkCopy over a viewer.
        { label: 'Markdown', run: () => void copyTableMarkdown(table) },
        { label: 'CSV', run: () => copyText(tableToDelimited(table, ',')) },
        { label: 'TSV', run: () => copyText(tableToDelimited(table, '\t')) },
        { label: 'PNG', run: () => copyPng(table) },
      ],
    });
  }

  if (cellGroup && !cellRef) {
    groups.push(cellGroup);
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

  // A group with no formats would put a "Copy X" row on the menu with nothing
  // behind it. None of the groups above can come out empty today, but the
  // Diagram group builds its list conditionally, so make the invariant hold
  // here rather than leaving it to whoever adds the next group.
  const specific = groups.filter((group) => group.actions.length > 0);

  // "Block" grabs the whole element you clicked in. It's the fallback for when
  // nothing more specific applies, so it drops out as soon as anything does.
  if (block && specific.length === 0) {
    specific.push({
      noun: 'Block',
      actions: [
        { label: 'Rich Text', run: () => copyRichText(block) },
        { label: 'Markdown', run: () => copyText(blockMarkdown(block)) },
        { label: 'PNG', run: () => copyPng(block) },
      ],
    });
  }

  return specific;
}

// What a link under the pointer is worth copying, or null when the pointer is
// not on one.
//
// The href is read as written rather than through the browser's resolved
// `.href`, because inside a webview a relative link resolves against a
// `vscode-webview://` origin: the resolved form of `./notes.md` is an address
// that means nothing outside this window, while the written form is the one the
// document says.
function linkGroup(target: HTMLElement): CopyGroup | null {
  const anchor = target.closest<HTMLAnchorElement>('a[href]');
  const ref = anchor && refFromHref(anchor.getAttribute('href') ?? '');
  if (!ref) {
    return null;
  }
  const noun = nounFor(ref);
  const text = (anchor?.textContent ?? '').trim();
  const actions = [{ label: noun, run: () => copyText(ref.value) }];
  // Only a mailto: has an href that differs from the address in it. For a URL
  // the two are the same characters, and a second row copying them under a
  // second name lengthens the menu without adding anything to it.
  if (ref.href !== ref.value) {
    actions.push({ label: 'Link Address', run: () => copyText(ref.href) });
  }
  // Dropped when the link shows its own target, which every autolinked address
  // in the prose does: the row would copy what the row above it just copied.
  if (text && text !== ref.value) {
    actions.push({ label: 'Link Text', run: () => copyText(text) });
  }
  // The flavor the rest of the menu is built around: a link that lands in a
  // document as a link rather than as loose characters someone has to re-wrap.
  actions.push({
    label: 'Markdown',
    run: () => copyText(markdownLink(text || ref.value, ref.href)),
  });
  return { noun, actions };
}

// `[text](href)`, escaped enough to survive being pasted back into a document.
// Brackets in the text would end the label early, and whitespace or parentheses
// in the address would end the target early; angle brackets are the form that
// takes them.
function markdownLink(text: string, href: string): string {
  const label = text.replace(/([[\]])/g, '\\$1');
  const target = /[()\s]/.test(href) ? `<${href}>` : href;
  return `[${label}](${target})`;
}

// Row and column edits for the CSV grid, offered on whatever the pointer is
// over: a data cell, a column header, or the row-number gutter.
//
// Absent for a spreadsheet sheet, which renders this same markup read-only (see
// data-mc-editable in src/csv.ts), and absent while a cell editor is open: the
// re-render one of these causes would take the half-typed value down with it,
// and the reader can close the editor and right-click again.
function buildGridEntries(target: HTMLElement): MenuEntry[] {
  const grid = target.closest<HTMLTableElement>('table.mc-csv[data-mc-editable="1"]');
  if (!grid || editorIn(target)) {
    return [];
  }
  const ref = gridRefFrom(target);
  if (!ref) {
    return [];
  }
  // Read now, while the menu is built against this grid, rather than when a row
  // is clicked: the ref above describes *this* render, so if another one lands
  // in between, the host should refuse the edit rather than apply it to a grid
  // the reader never saw.
  const docVersion = currentDocVersion;
  // Every one of these moves the grid under the reader rather than moving the
  // reader: after an insert above, the blank row is the square they were on;
  // after a delete, the row below has slid up into it. So they all park focus on
  // the same square and let the re-render seat them there.
  const focus = { line: ref.line, column: Math.max(ref.column, 0) };
  const run = (op: GridOp) => (): void => {
    parkFocus(focus);
    vscode.postMessage({ type: 'gridOp', op, line: ref.line, column: ref.column, docVersion });
  };

  const insert: MenuEntry[] = [
    { kind: 'item', label: 'Row Above', run: run('insertRowAbove') },
    { kind: 'item', label: 'Row Below', run: run('insertRowBelow') },
  ];
  const remove: MenuEntry[] = [{ kind: 'item', label: 'Row', run: run('deleteRow') }];
  // The gutter addresses a row but no column, so from there only the row half of
  // each menu means anything.
  if (ref.column >= 0) {
    insert.push(
      { kind: 'item', label: 'Column Left', run: run('insertColumnLeft') },
      { kind: 'item', label: 'Column Right', run: run('insertColumnRight') },
    );
    // Taking the only column out would leave a file of blank lines, which renders
    // as an empty document: there would be no column left to right-click to get
    // back. Deleting the last row is offered, because an empty file still shows
    // the grid's own chrome and Ctrl+Z is right there.
    if (columnCount(grid) > 1) {
      remove.push({ kind: 'item', label: 'Column', run: run('deleteColumn') });
    }
  }

  return [
    { kind: 'submenu', label: 'Insert', entries: insert },
    { kind: 'submenu', label: 'Delete', entries: remove },
  ];
}

// Data columns in the grid. The renderer emits one <col> per column plus one for
// the row-number gutter (src/csv.ts).
function columnCount(grid: HTMLTableElement): number {
  return Math.max(0, grid.querySelectorAll('colgroup > col').length - 1);
}

function buildMenu(target: HTMLElement): MenuEntry[] {
  const entries: MenuEntry[] = [];
  // A CSV cell being edited is a text field, not a slice of the document, so the
  // copy rows are the ones that change: the generic ones would offer the table
  // around it and never the value being typed, because window.getSelection()
  // cannot see inside a textarea and so comes out empty exactly when the reader
  // has something selected. Only that group is swapped. Everything below it is
  // about the grid or the document, has nothing to do with the textarea, and the
  // menu is the only route to most of it.
  const cellEditor = editorIn(target);
  const copies = cellEditor ? buildCellEditorEntries(cellEditor) : buildCopyEntries(target);
  if (copies.length > 0) {
    entries.push(...copies, { kind: 'divider' });
  }

  // Row and column edits, when the pointer is over a grid that can take them.
  const structure = buildGridEntries(target);
  if (structure.length > 0) {
    entries.push(...structure, { kind: 'divider' });
  }

  // Undo any dragging done to the CSV grid's columns. Only offered on a grid the
  // reader has actually resized, so it never shows up as a dead row.
  const grid = target.closest<HTMLTableElement>('table.mc-csv');
  if (grid && grid.dataset.mcFrozen === '1') {
    entries.push({
      kind: 'item',
      label: 'Reset Column Widths',
      run: () => resetColumnWidths(grid),
    });
    entries.push({ kind: 'divider' });
  }

  // Always-available document-level actions.
  entries.push({ kind: 'item', label: 'Copy Whole Document', run: () => copyRichText(content) });
  entries.push({ kind: 'item', label: 'Save as PDF…', run: () => exportPdf() });
  entries.push({ kind: 'divider' });
  entries.push({ kind: 'submenu', label: 'Preferences', entries: buildSettingsEntries() });
  return entries;
}

// The copy rows for whatever was clicked: the primary "Copy X" for the most
// specific thing under the pointer, then a "Copy as" submenu holding its other
// formats and every format of the less specific things around it.
function buildCopyEntries(target: HTMLElement): MenuEntry[] {
  const groups = copyGroups(target);
  if (groups.length === 0) {
    return [];
  }
  const [first, ...rest] = groups;
  const entries: MenuEntry[] = [
    { kind: 'item', label: `Copy ${first.noun}`, run: first.actions[0].run },
  ];

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
  return entries;
}

// What you can do with the value in an open CSV cell editor. Read now, when the
// menu is built, rather than when a row is clicked: the edit can end in between
// (anything that commits it takes the textarea out of the DOM with it), and a
// row that read a detached editor would copy nothing.
function buildCellEditorEntries(editor: HTMLTextAreaElement): MenuEntry[] {
  const value = editor.value;
  const selected = value.slice(editor.selectionStart ?? 0, editor.selectionEnd ?? 0);
  // Hand the caret back before copying, not after. The menu took the focus to
  // open and the edit is still live underneath it, so this both leaves the
  // reader where they were and gives `document.execCommand('copy')` a focused
  // field with a live selection to run against, rather than a menu row.
  const resume = (): void => editor.focus();
  const entries: MenuEntry[] = [];
  // An empty field has nothing to copy and nothing to select. Every row below
  // would be a no-op under a confident label, so offer none of them and let the
  // menu fall through to what the reader can actually do.
  if (!value) {
    return entries;
  }
  if (selected) {
    entries.push({
      kind: 'item',
      label: 'Copy Selection',
      run: () => {
        resume();
        copyText(selected);
      },
    });
  }
  // Dropped when the selection already is the whole value, where it would be the
  // same action under a second name.
  if (selected !== value) {
    entries.push({
      kind: 'item',
      label: 'Copy Cell',
      run: () => {
        resume();
        copyText(value);
      },
    });
  }
  entries.push({
    kind: 'item',
    label: 'Select All',
    run: () => {
      resume();
      editor.select();
    },
  });
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

/**
 * Copy a rendered table as a Markdown table.
 *
 * Turndown's GFM plugin does the conversion, so this works for a Markdown table,
 * a CSV grid, and a spreadsheet sheet alike. Chrome the viewer added has to go
 * first, though: the row-number gutter and a sheet's A/B/C header row are marked
 * `data-mc-ignore` and would otherwise become real columns in the output, which
 * is the same reason tableToDelimited skips them.
 */
async function copyTableMarkdown(table: HTMLElement): Promise<void> {
  // The reshaping lives in table.ts, next to the other serializer and away from
  // the clipboard, so it can be unit-tested against real grid markup. It also
  // owns the round trip for pipes in the data, which have to survive Turndown as
  // a placeholder, so the conversion is handed to it rather than called here.
  const md = (await tableToMarkdown(table, htmlToMarkdown)).trim();
  if (md && md.includes('|')) {
    copyText(md);
  } else {
    toast('Nothing to copy');
  }
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
  // mc-copy-clean hides the viewer's own chrome (the CSV grid's row-number
  // gutter) for the duration of the capture, so the image is the data.
  el.classList.add('mc-force-light', 'mc-copy-clean');
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
    el.classList.remove('mc-force-light', 'mc-copy-clean');
  }
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------
// Serialize the already-rendered preview (KaTeX HTML, Mermaid SVG, highlighted
// code all live in the DOM) and hand it to the host, which wraps it in a
// standalone page and renders that to a PDF file (see src/pdfExport.ts). Local
// images are inlined as data URIs so they survive outside the webview; the host
// injects preview.css + KaTeX CSS, so we send raw markup and let CSS style it.
async function exportPdf(): Promise<void> {
  try {
    const clone = content.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('[data-source-line]')
      .forEach((el) => el.removeAttribute('data-source-line'));
    // The viewer's own furniture is not part of the document, so it does not
    // belong in a printed copy of it. Same rule the copy paths follow.
    stripViewerChrome(clone);
    await relightMermaid(clone);
    await inlineImages(clone);
    vscode.postMessage({ type: 'pdfHtml', bodyHtml: clone.innerHTML });
    toast('Exporting PDF…');
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
  // After the style walk, which pairs source and clone by index: dropping these
  // earlier would shear the two lists apart.
  stripViewerChrome(clone);
  return `<div>${clone.outerHTML}</div>`;
}

/**
 * Remove the viewer's own furniture from a detached copy of the preview.
 *
 * `data-mc-ignore` marks chrome rather than document content: the CSV grid's
 * row-number gutter, and in a sheet the A/B/C column header. None of it belongs
 * on the clipboard or in an exported PDF.
 *
 * The gutter's `<col>` goes with it. Dropping the cells alone leaves the
 * colgroup one entry longer than every row, which renders as a blank column down
 * the left edge of the copy.
 */
function stripViewerChrome(root: HTMLElement): void {
  root.querySelectorAll('[data-mc-ignore]').forEach((el) => el.remove());
  root.querySelectorAll('col.mc-csv-gutter-col').forEach((el) => el.remove());
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
