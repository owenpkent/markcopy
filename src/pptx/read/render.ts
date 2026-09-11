// The shape model -> HTML.
//
// Every number that reaches a style attribute here is a percentage of the
// slide box or a cqw font size, per docs/PPTX-DESIGN.md: exact under any
// panel width, and never requiring a resize handler to stay correct, because
// this HTML is also what html-to-image rasterizes for Copy as PNG and what
// headless Chrome prints for Save as PDF.
import { escapeAttr, escapeHtml } from '../../escape';
import { clamp, fmtNum } from './format';
import {
  alignCss,
  cqwFontSize,
  firstDefinedAlign,
  firstDefinedSize,
  paragraphsToBlocks,
  runsHtml,
  type Block,
  type Paragraph,
} from './text';
import type { RenderShape, ShapeGeometry, TableCell, TableModel } from './shape';
import type { SlideSize } from './deck';

const EMU_PER_POINT = 12700;

export function renderSlide(
  shapes: RenderShape[],
  notes: string[] | undefined,
  index: number,
  size: SlideSize,
): string {
  const shapesHtml = shapes.map((s) => renderShape(s, size)).join('');
  const aspectRatio = size.cy > 0 ? (size.cx / size.cy).toFixed(4) : '1.7778';
  // Viewer chrome, not deck content: a copy or export must leave it out, the
  // same as the CSV grid's row-number gutter (see src/csv.ts).
  const numberLabel = `<div class="mc-pptx-number" data-mc-ignore="1">${index + 1}</div>`;
  const notesHtml = renderNotes(notes);

  return (
    `<section class="mc-pptx-slide" data-source-line="${index}">` +
    numberLabel +
    `<div class="mc-pptx-canvas" style="aspect-ratio:${aspectRatio}">${shapesHtml}</div>` +
    notesHtml +
    `</section>`
  );
}

export function renderDeck(sections: string[], truncationNoteHtml: string): string {
  return `<div class="mc-pptx-deck">${sections.join('')}${truncationNoteHtml}</div>`;
}

/**
 * Same voice as the xlsx row-cap note in src/xlsx/render.ts.
 *
 * `cappedAt` and `rendered` are tracked separately on purpose: `cappedAt` is
 * how many slides `maxSlides` let through (`Math.min(maxSlides, total)`),
 * while `rendered` is how many of those actually had a readable part.
 * Conflating them used to blame every gap on the setting -- a deck missing a
 * slide part reported "raise markcopy.pptx.maxSlides", which does nothing for
 * a missing part, said "first N" even when the missing slide was in the
 * middle, and for an entirely unreadable deck said "showing the first 0 of N
 * slides" instead of naming the actual problem.
 */
export function truncationNote(rendered: number, total: number, cappedAt: number): string {
  const notes: string[] = [];
  if (cappedAt < total) {
    notes.push(
      `Showing the first ${cappedAt} of ${total} slides. ` +
        `Raise <code>markcopy.pptx.maxSlides</code> to show more.`,
    );
  }
  const missing = cappedAt - rendered;
  if (missing > 0) {
    notes.push(
      missing === 1
        ? `1 slide could not be read and was skipped.`
        : `${missing} slides could not be read and were skipped.`,
    );
  }
  return notes.length === 0 ? '' : `<p class="mc-pptx-note">${notes.join(' ')}</p>`;
}

function renderNotes(notes: string[] | undefined): string {
  if (notes === undefined || !notes.some((line) => line.trim() !== '')) {
    return '';
  }
  return `<p class="mc-pptx-notes">${notes.map(escapeHtml).join('<br>')}</p>`;
}

function renderShape(shape: RenderShape, size: SlideSize): string {
  switch (shape.content.kind) {
    case 'text':
      return shape.isTitle
        ? renderTitle(shape.content.paragraphs, shape.geom, size)
        : renderTextShape(shape.content.paragraphs, shape.geom, size);
    case 'picture':
      return (
        `<img class="mc-pptx-shape mc-pptx-pic" style="${boxStyle(shape.geom, size)}" ` +
        `src="${shape.content.dataUri}" alt="${escapeAttr(shape.content.alt)}">`
      );
    case 'table':
      return renderTable(shape.content.table, shape.geom, size);
    case 'unsupported':
      return (
        `<div class="mc-pptx-shape mc-pptx-placeholder" style="${boxStyle(shape.geom, size)}">` +
        `${escapeHtml(shape.content.label)}</div>`
      );
  }
}

function slideWidthPointsOf(size: SlideSize): number {
  return size.cx / EMU_PER_POINT;
}

/** The `font-size:Xcqw` style fragment for a shape's base size, or nothing when no run declares one. */
function baseSizeStyle(paragraphs: Paragraph[], size: SlideSize): string[] {
  const base = firstDefinedSize(paragraphs);
  if (base === undefined) {
    return [];
  }
  return [`font-size:${fmtNum(cqwFontSize(base, slideWidthPointsOf(size)))}cqw`];
}

// A title never bullets (per docs/PPTX-DESIGN.md), so its paragraphs join
// with <br> inside one <h2> rather than becoming the separate <p> blocks a
// body placeholder's would.
function renderTitle(paragraphs: Paragraph[], geom: ShapeGeometry, size: SlideSize): string {
  const base = firstDefinedSize(paragraphs);
  const slideWidthPt = slideWidthPointsOf(size);
  const inner = paragraphs.map((p) => runsHtml(p.runs, base, slideWidthPt)).join('<br>');
  const extra = baseSizeStyle(paragraphs, size);
  const align = alignCss(firstDefinedAlign(paragraphs));
  if (align !== undefined) {
    extra.push(`text-align:${align}`);
  }
  const style = boxStyle(geom, size, extra);
  return `<h2 class="mc-pptx-shape mc-pptx-title" style="${style}">${inner}</h2>`;
}

// A shape whose text collapses to exactly one block (the common case: one
// bulleted list, or one paragraph of plain text) becomes that block directly,
// carrying the position and class on the <ul>/<ol>/<p> itself, which is what
// the design doc's sample markup shows. A shape that mixes bulleted and plain
// paragraphs produces more than one block, and only then does a wrapping
// <div> carry the position instead.
function renderTextShape(paragraphs: Paragraph[], geom: ShapeGeometry, size: SlideSize): string {
  const base = firstDefinedSize(paragraphs);
  const slideWidthPt = slideWidthPointsOf(size);
  const blocks = paragraphsToBlocks(paragraphs, base, slideWidthPt);
  const cls = 'mc-pptx-shape mc-pptx-body';

  if (blocks.length === 1) {
    const b = blocks[0];
    const extra = baseSizeStyle(paragraphs, size);
    if (b.align !== undefined) {
      extra.push(`text-align:${b.align}`);
    }
    const style = boxStyle(geom, size, extra);
    return `<${b.tag} class="${cls}" style="${style}">${b.html}</${b.tag}>`;
  }
  const style = boxStyle(geom, size, baseSizeStyle(paragraphs, size));
  const inner = blocks.map(wrapBlock).join('');
  return `<div class="${cls}" style="${style}">${inner}</div>`;
}

function wrapBlock(b: Block): string {
  const style = b.align === undefined ? '' : ` style="text-align:${b.align}"`;
  return `<${b.tag}${style}>${b.html}</${b.tag}>`;
}

function renderTable(table: TableModel, geom: ShapeGeometry, size: SlideSize): string {
  const totalWidth = table.columnWidths.reduce((a, b) => a + b, 0);
  const colgroup =
    totalWidth > 0
      ? '<colgroup>' +
        table.columnWidths
          .map((w) => `<col style="width:${fmtNum((w / totalWidth) * 100)}%">`)
          .join('') +
        '</colgroup>'
      : '';

  const rowsHtmlList = table.rows.map((row, r) =>
    renderTableRow(row, table.firstRowHeader && r === 0, size),
  );
  const headHtml =
    table.firstRowHeader && rowsHtmlList.length > 0 ? `<thead>${rowsHtmlList[0]}</thead>` : '';
  const bodyRows = table.firstRowHeader ? rowsHtmlList.slice(1) : rowsHtmlList;
  const bodyHtml = bodyRows.length > 0 ? `<tbody>${bodyRows.join('')}</tbody>` : '';

  const style = boxStyle(geom, size);
  return `<table class="mc-pptx-shape mc-pptx-table" style="${style}">${colgroup}${headHtml}${bodyHtml}</table>`;
}

function renderTableRow(
  row: (TableCell | undefined)[],
  isHeader: boolean,
  size: SlideSize,
): string {
  const cellsHtml = row
    .map((cell) => {
      if (cell === undefined) {
        // Covered by a merge anchored above or to the left; no <td> at all.
        return '';
      }
      const tag = isHeader ? 'th' : 'td';
      const { html, align, fontSize } = cellHtml(cell, size);
      const attrs: string[] = [];
      if (isHeader) {
        attrs.push(' scope="col"');
      }
      const cellStyle: string[] = [];
      if (align !== undefined) {
        cellStyle.push(`text-align:${align}`);
      }
      if (fontSize !== undefined) {
        cellStyle.push(`font-size:${fontSize}cqw`);
      }
      if (cellStyle.length > 0) {
        attrs.push(` style="${cellStyle.join(';')}"`);
      }
      if (cell.colspan > 1) {
        attrs.push(` colspan="${clampInt(cell.colspan, 1, 1000)}"`);
      }
      if (cell.rowspan > 1) {
        attrs.push(` rowspan="${clampInt(cell.rowspan, 1, 1000)}"`);
      }
      return `<${tag}${attrs.join('')}>${html}</${tag}>`;
    })
    .join('');
  return `<tr>${cellsHtml}</tr>`;
}

function cellHtml(
  cell: TableCell,
  size: SlideSize,
): { html: string; align?: string; fontSize?: string } {
  const base = firstDefinedSize(cell.paragraphs);
  const slideWidthPt = slideWidthPointsOf(size);
  const blocks = paragraphsToBlocks(cell.paragraphs, base, slideWidthPt);
  // The cell's base size, same reasoning as baseSizeStyle for a title/body
  // shape: runHtml suppresses a run's own inline font-size whenever it agrees
  // with `base`, on the assumption that whatever calls it will put that size
  // on the cell (or a wrapper) itself. Nothing did, so a cell whose runs all
  // resolved to the same declared size rendered at the table's stylesheet
  // default instead of that size.
  const fontSize = base === undefined ? undefined : fmtNum(cqwFontSize(base, slideWidthPt));
  // A <td>/<th> is already the block container, so the common case -- one
  // plain paragraph -- needs no <p> wrapper inside it (its alignment moves to
  // the cell itself instead). A bulleted list, or a cell with more than one
  // paragraph, still gets real block markup.
  if (blocks.length === 1 && blocks[0].tag === 'p') {
    return { html: blocks[0].html, align: blocks[0].align, fontSize };
  }
  return { html: blocks.map(wrapBlock).join(''), fontSize };
}

/**
 * Position and size as percentages of the slide box, which are exact under
 * any panel width -- the whole reason nothing here needs a resize handler.
 * `extra` styles (a font size, from the caller) are appended verbatim; they
 * come from this module's own fmtNum/cqwFontSize output, never straight from
 * the file, so nothing further to escape there.
 */
function boxStyle(geom: ShapeGeometry, size: SlideSize, extra: string[] = []): string {
  const parts = [
    `left:${pct(geom.x, size.cx)}%`,
    `top:${pct(geom.y, size.cy)}%`,
    `width:${pct(geom.cx, size.cx)}%`,
    `height:${pct(geom.cy, size.cy)}%`,
  ];
  const transform = transformOf(geom);
  if (transform !== '') {
    parts.push(`transform:${transform}`);
  }
  parts.push(...extra);
  return escapeAttr(parts.join(';'));
}

function pct(value: number, total: number): string {
  if (!(total > 0)) {
    return '0';
  }
  // A crafted or corrupt file can put a shape far off the slide; clamped to a
  // generous but finite range rather than to [0, 100], because a shape that
  // deliberately bleeds off the edge (a full-bleed background image, say) is
  // legitimate and shouldn't be clipped back onto the canvas.
  return fmtNum(clamp((value / total) * 100, -1000, 1000));
}

function transformOf(geom: ShapeGeometry): string {
  const parts: string[] = [];
  if (geom.rot !== 0) {
    parts.push(`rotate(${fmtNum(clamp(geom.rot / 60000, -3600, 3600))}deg)`);
  }
  if (geom.flipH || geom.flipV) {
    parts.push(`scale(${geom.flipH ? -1 : 1},${geom.flipV ? -1 : 1})`);
  }
  return parts.join(' ');
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.round(clamp(n, lo, hi));
}
