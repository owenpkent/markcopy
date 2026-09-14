// Looking the reader's selection up on the web, from the preview's right-click
// menu.
//
// The query is read off the DOM rather than taken from Selection.toString(), for
// two reasons. toString() serializes the whole selection, which after a
// select-all over a large sheet is every cell in it, on every right-click, for a
// query that only ever uses the first few words. And it reads text the reader
// never sees as words: KaTeX renders each equation twice, once as glyphs and once
// as hidden MathML, and the grid's row-number gutter and A/B/C header are cells
// like any other. Walking the text nodes stops as soon as there is enough, and
// can step over both.

/**
 * The most of a selection that goes into a search, in characters.
 *
 * Google reads only the first 32 words of a query, so nothing past that changes
 * the results, while a query as long as a document builds a URL the OS launcher
 * or Google itself refuses. 200 characters covers 32 ordinary words and, even
 * fully percent-encoded as CJK, stays inside the 2,048 a URL can safely be.
 */
export const SEARCH_QUERY_MAX = 200;

/** How many characters of the query the menu row shows. */
export const SEARCH_LABEL_MAX = 30;

// Text inside these is not words on the page: KaTeX's MathML twin of an equation,
// and the viewer chrome marked `data-mc-ignore` (see stripViewerChrome in
// src/webview/main.ts).
const SKIP = '.katex-mathml, [data-mc-ignore], script, style';

// Crossing from one of these into the next is a word break, even where the markup
// has no whitespace between them: two table cells, or a heading and the
// paragraph under it.
const BLOCK =
  'address, article, aside, blockquote, caption, dd, div, dl, dt, figcaption, figure, ' +
  'footer, h1, h2, h3, h4, h5, h6, header, li, main, nav, ol, p, pre, section, table, ' +
  'tbody, td, tfoot, th, thead, tr, ul';

/**
 * The selected text as a search query: whitespace collapsed, viewer chrome and
 * hidden MathML left out, and capped at `max` characters. Empty when nothing
 * searchable is selected.
 */
export function selectionSearchText(selection: Selection | null, max = SEARCH_QUERY_MAX): string {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return '';
  }
  // Two code units hold any one character, so this much raw text is always
  // enough to fill `max` characters once it is cut.
  const budget = max * 2;
  let text = '';
  for (let i = 0; i < selection.rangeCount && text.length < budget; i++) {
    text = appendRange(text, selection.getRangeAt(i), budget);
  }
  return truncate(text.trim(), max);
}

function appendRange(text: string, range: Range, budget: number): string {
  const root = range.commonAncestorContainer;
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  // Start at the range rather than at the top of its common ancestor, which
  // for a selection deep in a long document is the whole document.
  const start = range.startContainer;
  const startNode = start.nodeType === Node.TEXT_NODE ? start : start.childNodes[range.startOffset];
  let node: Node | null;
  if (startNode?.nodeType === Node.TEXT_NODE) {
    walker.currentNode = startNode;
    node = startNode;
  } else {
    walker.currentNode = startNode ?? start;
    node = walker.nextNode();
  }
  let lastBlock: Element | null | undefined;
  for (; node && text.length < budget; node = walker.nextNode()) {
    // Past the end of the range: nothing further in document order is in it.
    if (range.comparePoint(node, 0) > 0) {
      break;
    }
    // Before its start, which only happens when the range opens at the end of
    // an element and the walk above began inside it.
    if (!range.intersectsNode(node)) {
      continue;
    }
    const parent = node.parentElement;
    if (parent?.closest(SKIP)) {
      continue;
    }
    const data = (node as Text).data;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : data.length;
    // Sliced before the whitespace pass so one enormous text node (a CSV line
    // with no breaks in it) costs no more than the budget.
    const piece = data.slice(from, Math.min(to, from + budget)).replace(/\s+/g, ' ');
    const block = parent?.closest(BLOCK) ?? null;
    if (lastBlock !== undefined && block !== lastBlock && !text.endsWith(' ')) {
      text += ' ';
    }
    lastBlock = block;
    text += text.endsWith(' ') && piece.startsWith(' ') ? piece.slice(1) : piece;
  }
  return text;
}

/**
 * The first `max` characters of `text`, counted as characters rather than UTF-16
 * code units, so an emoji or astral CJK character is never split in half.
 */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  // A slice by code units upstream can leave half a surrogate pair at the very
  // end, which renders as a replacement glyph and makes encodeURIComponent throw.
  const whole = /[\uD800-\uDBFF]$/.test(text) ? chars.slice(0, -1) : chars;
  return (whole.length > max ? whole.slice(0, max) : whole).join('').trimEnd();
}

/** The menu row for a query: the first few words, and an ellipsis if cut. */
export function searchLabel(query: string): string {
  const shown = truncate(query, SEARCH_LABEL_MAX);
  return `Search Google for “${shown}${shown.length < query.length ? '…' : ''}”`;
}

/** The Google results page for a query. */
export function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
