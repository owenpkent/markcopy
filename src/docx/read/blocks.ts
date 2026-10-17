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
  /** The abstract numbering definition the list started under. */
  key: string;
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
          open = {
            kind: 'list',
            key: ctx.numbering.abstractKey(para.numId),
            stack: [],
            html: '',
          };
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
  // A heading or a header cell is bold already; that is its own look, not
  // emphasis to repeat as <strong> inside the <h1> or <th>.
  const paraProps = styles.runStyle(styleId);
  if (heading !== undefined || ctx.inHeaderCell) {
    delete paraProps.b;
  }
  const inline = readInline(p, ctx, styles.isMono(styleId), paraProps);
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
 * Word counts per abstract numbering definition, not per `numId`: several
 * `w:num` instances of one `abstractNum` are one running list unless an
 * instance restarts a level (`startOverride`, honored the first time that
 * instance is used). So a list continues while the abstract definition stays
 * the same and no restart is pending. A deeper item always nests under the
 * open list, since writers (this extension's own export included) give a
 * sublist its own definition or instance.
 */
function continuesList(list: ListOpen, numId: string, ilvl: number, ctx: ReadCtx): boolean {
  const base = list.stack[0];
  if (base === undefined) {
    return false;
  }
  if (ilvl > base.ilvl) {
    return true;
  }
  if (isRestart(numId, ilvl, ctx)) {
    return false;
  }
  return list.key === ctx.numbering.abstractKey(numId);
}

/** A restart pending: this instance overrides the level and has not been used at it yet. */
function isRestart(numId: string, ilvl: number, ctx: ReadCtx): boolean {
  return (
    ctx.numbering.level(numId, ilvl).restart === true && !ctx.seenLevels.has(`${numId}:${ilvl}`)
  );
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
  const key = ctx.numbering.abstractKey(numId);
  // `next[level]` is the number the next item at that level will show,
  // tracked per abstract definition across the whole document so a list that
  // resumes after other content, or moves to another instance of the same
  // definition, keeps counting.
  let next = ctx.counters.get(key);
  if (next === undefined) {
    next = [];
    ctx.counters.set(key, next);
  }
  const restart = isRestart(numId, ilvl, ctx);
  ctx.seenLevels.add(`${numId}:${ilvl}`);
  if (restart) {
    next[ilvl] = lvl.start;
  }
  const number = Math.min(1_000_000, Math.max(0, next[ilvl] ?? lvl.start));

  const stack = list.stack;
  // A restart ends any list already open at this level or deeper.
  while (
    stack.length > 0 &&
    (restart ? stack[stack.length - 1].ilvl >= ilvl : stack[stack.length - 1].ilvl > ilvl)
  ) {
    list.html += `</li></${stack.pop()!.tag}>`;
  }
  if (stack.length > 0 && stack[stack.length - 1].ilvl === ilvl) {
    list.html += '</li>';
  } else {
    let attrs = '';
    if (tag === 'ol') {
      if (number !== 1) {
        attrs += ` start="${number}"`;
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

  next[ilvl] = number + 1;
  // A shallower item restarts every deeper level, as Word does.
  for (let k = ilvl + 1; k < next.length; k++) {
    next[k] = undefined;
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

  const gaps = leadingGaps(rows);
  const render = (row: Row, index: number): string => {
    const tag = row.header ? 'th' : 'td';
    let html = '<tr>';
    for (const span of gaps[index]) {
      const attrs = (row.header ? ' scope="col"' : '') + (span > 1 ? ` colspan="${span}"` : '');
      html += `<${tag}${attrs}></${tag}>`;
    }
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
      const outer = ctx.inHeaderCell;
      ctx.inHeaderCell = row.header;
      html += `<${tag}${attrs}>${cellHtml(cell.node, ctx, depth)}</${tag}>`;
      ctx.inHeaderCell = outer;
    }
    return `${html}</tr>`;
  };

  // Only the leading rows marked as headers form the head; Word lets a
  // header row repeat mid-table, which HTML has no place for.
  let headCount = 0;
  while (headCount < rows.length && rows[headCount].header) {
    headCount++;
  }
  const head = rows
    .slice(0, headCount)
    .map((r, i) => render(r, i))
    .join('');
  const body = rows
    .slice(headCount)
    .map((r, i) => render({ ...r, header: false }, headCount + i))
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
    let col = Math.min(
      MAX_SPAN,
      Math.max(0, (gridBefore && intAttr(gridBefore.attrs, 'val')) ?? 0),
    );
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

/**
 * For each row, the widths of the empty cells to draw before its first cell.
 *
 * `w:gridBefore` skips grid columns at the start of a row, and the cells after
 * it sit at their grid position. HTML places cells left to right, so the skip
 * has to be drawn or everything shifts left (and so does a per-table TSV copy).
 * Columns a rowspan from an earlier row already holds are not empty and are
 * left out; each run of free columns between them is one cell.
 */
function leadingGaps(rows: Row[]): number[][] {
  const held: [number, number][][] = rows.map(() => []);
  rows.forEach((row, r) => {
    for (const cell of row.cells) {
      for (let n = r + 1; n < Math.min(rows.length, r + cell.rowSpan); n++) {
        held[n].push([cell.col, cell.col + cell.span]);
      }
    }
  });
  return rows.map((row, r) => {
    const first = row.cells.find((c) => !c.covered);
    const gaps: number[] = [];
    if (first === undefined) {
      return gaps;
    }
    let cursor = 0;
    for (const [start, end] of held[r].sort((a, b) => a[0] - b[0])) {
      if (start >= first.col) {
        break;
      }
      if (start > cursor) {
        gaps.push(start - cursor);
      }
      cursor = Math.max(cursor, end);
    }
    if (first.col > cursor) {
      gaps.push(first.col - cursor);
    }
    return gaps;
  });
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
