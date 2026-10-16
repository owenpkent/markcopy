// Block structure: paragraphs, headings, lists, code, quotes, tables.
//
// Word has no list element. A list is a run of ordinary paragraphs that each
// point at a numbering definition, so the walk below keeps one open container
// at a time (a list, a code block, or a quote) and decides on each paragraph
// whether it extends that container or closes it. Everything is built as
// strings, in reading order; nothing here sees the DOM.
import { attr, intAttr } from '../../ooxml/xml';
import { child, children, type XNode } from '../../ooxml/xnode';
import { type ReadCtx } from './context';
import { readInline } from './inline';

/** Deeper than any real document nests tables; beyond it a table is named, not drawn. */
const MAX_TABLE_DEPTH = 8;
const MAX_SPAN = 1000;

interface ListOpen {
  kind: 'list';
  numId: string;
  stack: { ilvl: number; tag: 'ul' | 'ol' }[];
  html: string;
}
interface PreOpen {
  kind: 'pre';
  lines: string[];
  blank: boolean;
}
interface QuoteOpen {
  kind: 'quote';
  parts: string[];
}
type Open = ListOpen | PreOpen | QuoteOpen;

/** The paragraphs and tables in a container, looking through content controls and revision wrappers. */
function* blockNodes(nodes: XNode[]): Generator<XNode> {
  for (const n of nodes) {
    switch (n.name) {
      case 'p':
      case 'tbl':
        yield n;
        break;
      case 'sdt': {
        const content = child(n, 'sdtContent');
        if (content !== undefined) {
          yield* blockNodes(content.children);
        }
        break;
      }
      case 'customXml':
      case 'ins':
      case 'moveTo':
      case 'smartTag':
        yield* blockNodes(n.children);
        break;
      default:
        break;
    }
  }
}

/**
 * Render a container's blocks (the body, a table cell, a note) to HTML, one
 * string per top-level block.
 *
 * `allowPre` is false inside cells and notes: a monospace paragraph there stays
 * a paragraph of inline `<code>`, because a `<pre>` box in a table cell is
 * heavier than anything the author drew.
 */
export function renderBlocks(
  nodes: XNode[],
  ctx: ReadCtx,
  depth: number,
  allowPre: boolean,
): string[] {
  const out: string[] = [];
  let open: Open | undefined;

  const close = (): void => {
    if (open === undefined) {
      return;
    }
    if (open.kind === 'list') {
      let html = open.html;
      for (let i = open.stack.length - 1; i >= 0; i--) {
        html += `</li></${open.stack[i].tag}>`;
      }
      out.push(html);
    } else if (open.kind === 'pre') {
      out.push(`<pre><code>${open.lines.join('\n')}</code></pre>`);
    } else {
      out.push(`<blockquote>${open.parts.join('')}</blockquote>`);
    }
    open = undefined;
  };

  for (const node of blockNodes(nodes)) {
    if (ctx.budget.truncated) {
      break;
    }
    if (node.name === 'tbl') {
      close();
      const table = renderTable(node, ctx, depth);
      if (table !== '') {
        out.push(table);
      }
      continue;
    }
    if (++ctx.budget.used > ctx.budget.max) {
      ctx.budget.truncated = true;
      break;
    }
    const para = readParagraph(node, ctx, allowPre);
    switch (para.t) {
      case 'empty':
        // A blank paragraph is spacing, not content, and the preview spaces
        // blocks itself. It never splits a list or a quote; inside a code
        // block it is a blank line, kept only if more code follows.
        if (open?.kind === 'pre') {
          open.blank = true;
        }
        break;
      case 'item':
        if (open?.kind !== 'list' || !continuesList(open, para.numId, para.ilvl, ctx)) {
          close();
          open = { kind: 'list', numId: para.numId, stack: [], html: '' };
        }
        addItem(open, para.numId, para.ilvl, para.html, ctx);
        break;
      case 'code':
        if (open?.kind !== 'pre') {
          close();
          open = { kind: 'pre', lines: [], blank: false };
        }
        if (open.blank && open.lines.length > 0) {
          open.lines.push('');
        }
        open.blank = false;
        open.lines.push(para.html);
        break;
      case 'quote':
        if (open?.kind !== 'quote') {
          close();
          open = { kind: 'quote', parts: [] };
        }
        open.parts.push(para.html);
        break;
      default:
        close();
        out.push(para.html);
    }
  }
  close();
  return out;
}

type Para =
  | { t: 'empty' }
  | { t: 'item'; numId: string; ilvl: number; html: string }
  | { t: 'code' | 'quote' | 'block'; html: string };

function val(node: XNode | undefined): string | undefined {
  return node === undefined ? undefined : attr(node.attrs, 'val');
}

function readParagraph(p: XNode, ctx: ReadCtx, allowPre: boolean): Para {
  const pPr = child(p, 'pPr');
  const styleId = val(pPr && child(pPr, 'pStyle'));
  const styles = ctx.styles;
  const outline = pPr && child(pPr, 'outlineLvl');
  const heading = styles.heading(styleId, outline && intAttr(outline.attrs, 'val'));
  const inline = readInline(p, ctx, styles.isMono(styleId));
  if (!inline.hasContent) {
    return { t: 'empty' };
  }

  const jc = val(pPr && child(pPr, 'jc')) ?? styles.jc(styleId);
  const align =
    jc === 'center' ? 'mc-docx-center' : jc === 'right' || jc === 'end' ? 'mc-docx-right' : '';
  const cls = (extra = ''): string => {
    const all = [extra, align].filter(Boolean).join(' ');
    return all === '' ? '' : ` class="${all}"`;
  };

  // A heading stays a heading even when its style also carries a multilevel
  // list number: Word numbers its headings that way, and they are not items.
  if (heading !== undefined) {
    const tag = `h${heading.level}`;
    return {
      t: 'block',
      html: `<${tag}${cls(heading.title ? 'mc-docx-title' : '')}>${inline.html}</${tag}>`,
    };
  }

  const numPr = pPr && child(pPr, 'numPr');
  const fromStyle = styles.numbering(styleId);
  const numId = val(numPr && child(numPr, 'numId')) ?? fromStyle.numId;
  if (numId !== undefined && numId !== '0') {
    const ilvlNode = numPr && child(numPr, 'ilvl');
    const ilvl = (ilvlNode && intAttr(ilvlNode.attrs, 'val')) ?? fromStyle.ilvl ?? 0;
    return { t: 'item', numId, ilvl: clampLevel(ilvl), html: inline.html };
  }

  if (allowPre && inline.allMono) {
    return { t: 'code', html: escapePlain(inline.plain) };
  }
  if (styles.isQuote(styleId)) {
    return { t: 'quote', html: `<p${cls()}>${inline.html}</p>` };
  }
  return { t: 'block', html: `<p${cls()}>${inline.html}</p>` };
}

/**
 * Whether an item belongs to the list already open.
 *
 * Same `numId` always does. Beyond that, Word writers (this extension's own
 * export included) give each nested list and each separate bullet list its own
 * `numId`, so insisting on equality would split one visual list into a stack of
 * fragments: a deeper item continues the open list as its sublist, and a bullet
 * continues an open bullet list (bullets carry no count, so there is nothing
 * to restart). Two ordered lists with different ids stay apart, since that is
 * how a restart is written.
 */
function continuesList(list: ListOpen, numId: string, ilvl: number, ctx: ReadCtx): boolean {
  if (list.numId === numId) {
    return true;
  }
  const base = list.stack[0];
  if (base === undefined) {
    return false;
  }
  if (ilvl > base.ilvl) {
    return true;
  }
  const fmt = ctx.numbering.level(numId, ilvl).fmt;
  return base.tag === 'ul' && ilvl === base.ilvl && (fmt === 'bullet' || fmt === 'none');
}

function clampLevel(n: number): number {
  return Math.min(8, Math.max(0, n));
}

function escapePlain(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const OL_TYPE: Record<string, string> = {
  lowerLetter: 'a',
  upperLetter: 'A',
  lowerRoman: 'i',
  upperRoman: 'I',
};

function addItem(list: ListOpen, numId: string, ilvl: number, html: string, ctx: ReadCtx): void {
  const lvl = ctx.numbering.level(numId, ilvl);
  const tag: 'ul' | 'ol' = lvl.fmt === 'bullet' || lvl.fmt === 'none' ? 'ul' : 'ol';
  let counts = ctx.counters.get(numId);
  if (counts === undefined) {
    counts = [];
    ctx.counters.set(numId, counts);
  }

  const stack = list.stack;
  while (stack.length > 0 && stack[stack.length - 1].ilvl > ilvl) {
    list.html += `</li></${stack.pop()!.tag}>`;
  }
  if (stack.length > 0 && stack[stack.length - 1].ilvl === ilvl) {
    list.html += '</li>';
  } else {
    // A new list at this level. A list that was interrupted and resumes
    // (same numId, later in the document) carries on counting where it left off.
    let attrs = '';
    if (tag === 'ol') {
      const start = Math.min(1_000_000, Math.max(0, lvl.start + (counts[ilvl] ?? 0)));
      if (start !== 1) {
        attrs += ` start="${start}"`;
      }
      const type = OL_TYPE[lvl.fmt];
      if (type !== undefined) {
        attrs += ` type="${type}"`;
      }
    }
    list.html += `<${tag}${attrs}>`;
    stack.push({ ilvl, tag });
  }
  list.html += `<li>${html}`;

  counts[ilvl] = (counts[ilvl] ?? 0) + 1;
  for (let k = ilvl + 1; k < counts.length; k++) {
    counts[k] = 0;
  }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface Cell {
  col: number;
  span: number;
  merge: 'restart' | 'continue' | undefined;
  node: XNode;
  rowSpan: number;
  covered: boolean;
}

interface Row {
  header: boolean;
  cells: Cell[];
}

function renderTable(tbl: XNode, ctx: ReadCtx, depth: number): string {
  if (depth >= MAX_TABLE_DEPTH) {
    return '<p><span class="mc-docx-placeholder">Table nested too deeply to show</span></p>';
  }
  const rows = readRows(tbl);
  if (rows.length === 0) {
    return '';
  }
  mergeRows(rows);

  const render = (row: Row): string => {
    const tag = row.header ? 'th' : 'td';
    let html = '<tr>';
    for (const cell of row.cells) {
      if (cell.covered) {
        continue;
      }
      let attrs = row.header ? ' scope="col"' : '';
      if (cell.span > 1) {
        attrs += ` colspan="${cell.span}"`;
      }
      if (cell.rowSpan > 1) {
        attrs += ` rowspan="${cell.rowSpan}"`;
      }
      html += `<${tag}${attrs}>${cellHtml(cell.node, ctx, depth)}</${tag}>`;
    }
    return `${html}</tr>`;
  };

  // Only the leading rows marked as headers form the head; Word lets a
  // header row repeat mid-table, which HTML has no place for.
  let headCount = 0;
  while (headCount < rows.length && rows[headCount].header) {
    headCount++;
  }
  const head = rows.slice(0, headCount).map(render).join('');
  const body = rows
    .slice(headCount)
    .map((r) => render({ ...r, header: false }))
    .join('');
  return (
    '<table>' +
    (head === '' ? '' : `<thead>${head}</thead>`) +
    (body === '' ? '' : `<tbody>${body}</tbody>`) +
    '</table>'
  );
}

function readRows(tbl: XNode): Row[] {
  const rows: Row[] = [];
  for (const tr of children(tbl, 'tr')) {
    const trPr = child(tr, 'trPr');
    // A row deleted under track changes is not in the final text.
    if (trPr !== undefined && child(trPr, 'del') !== undefined) {
      continue;
    }
    const tblHeader = trPr && child(trPr, 'tblHeader');
    const header = tblHeader !== undefined && !['0', 'false', 'off'].includes(val(tblHeader) ?? '');
    const gridBefore = trPr && child(trPr, 'gridBefore');
    let col = (gridBefore && intAttr(gridBefore.attrs, 'val')) ?? 0;
    const cells: Cell[] = [];
    for (const tc of children(tr, 'tc')) {
      const tcPr = child(tc, 'tcPr');
      const spanNode = tcPr && child(tcPr, 'gridSpan');
      const span = Math.min(
        MAX_SPAN,
        Math.max(1, (spanNode && intAttr(spanNode.attrs, 'val')) ?? 1),
      );
      const hMerge = tcPr && child(tcPr, 'hMerge');
      // Legacy horizontal merge: a continuation cell widens the one before it.
      if (hMerge !== undefined && val(hMerge) !== 'restart' && cells.length > 0) {
        const prev = cells[cells.length - 1];
        prev.span = Math.min(MAX_SPAN, prev.span + span);
        col += span;
        continue;
      }
      const vMerge = tcPr && child(tcPr, 'vMerge');
      cells.push({
        col,
        span,
        merge:
          vMerge === undefined ? undefined : val(vMerge) === 'restart' ? 'restart' : 'continue',
        node: tc,
        rowSpan: 1,
        covered: false,
      });
      col += span;
    }
    rows.push({ header, cells });
  }
  return rows;
}

/** Fold each vertical merge into a rowspan on its first cell and mark the rest covered. */
function mergeRows(rows: Row[]): void {
  for (let r = 0; r < rows.length; r++) {
    for (const cell of rows[r].cells) {
      if (cell.merge !== 'restart' || cell.covered) {
        continue;
      }
      for (let n = r + 1; n < rows.length; n++) {
        // A rowspan cannot cross from the head into the body.
        if (rows[n].header !== rows[r].header) {
          break;
        }
        const below = rows[n].cells.find((c) => c.col === cell.col && c.merge === 'continue');
        if (below === undefined || below.covered) {
          break;
        }
        below.covered = true;
        cell.rowSpan = Math.min(MAX_SPAN, cell.rowSpan + 1);
      }
    }
  }
}

function cellHtml(tc: XNode, ctx: ReadCtx, depth: number): string {
  const blocks = renderBlocks(tc.children, ctx, depth + 1, false);
  // The cell is already the block container, so a lone plain paragraph needs
  // no <p> of its own.
  if (blocks.length === 1 && blocks[0].startsWith('<p>') && blocks[0].endsWith('</p>')) {
    return blocks[0].slice(3, -4);
  }
  return blocks.join('');
}
