// Drawing content that is not a picture: text boxes and charts.
//
// Both are block content (a text box holds paragraphs, a chart becomes a figure
// with a table), and block markup cannot live inside the `<p>` that anchors the
// drawing. So these push finished markup onto `ctx.afterPara`, and the block
// reader places it right after the paragraph. A chart that cannot be shown
// (a cx: chartex chart, a part with no cached data, a missing part) returns
// an inline placeholder instead, the same idea as the unsupported-image box.
//
// Everything is read from the package and escaped; a chart's numbers are the
// values cached in the chart part, never recomputed from an embedded workbook.
import { escapeAttr, escapeHtml } from '../../escape';
import { attr, relAttr } from '../../ooxml/xml';
import { child, children, findAll, findDeep, type XNode } from '../../ooxml/xnode';
import { partText } from '../../ooxml/zip';
import { renderBlocks } from './blocks';
import { type ReadCtx } from './context';
import { parseXml } from '../../ooxml/xnode';

/** Text boxes inside text boxes are real but rare; past this they are dropped. */
const MAX_BOX_DEPTH = 4;
const MAX_CHART_ROWS = 2000;
const MAX_CHART_SERIES = 64;

export interface DrawingExtras {
  /** Inline markup (a placeholder) to show in the paragraph itself. */
  inline: string[];
}

/** Text boxes and the chart of one `w:drawing`. Blocks are queued on `ctx.afterPara`. */
export function drawingExtras(d: XNode, ctx: ReadCtx): DrawingExtras {
  const inline: string[] = [];
  ctx.afterPara.push(...textBoxes(d, ctx));

  const data = findDeep(d, 'graphicData');
  const uri = (data && attr(data.attrs, 'uri')) ?? '';
  if (data !== undefined && /\/chart$/i.test(uri)) {
    const host = child(d, 'inline') ?? child(d, 'anchor');
    const docPr = host && child(host, 'docPr');
    const alt = docPr
      ? attr(docPr.attrs, 'descr')?.trim() || attr(docPr.attrs, 'title')?.trim() || ''
      : '';
    const ref = child(data, 'chart');
    const rid = ref && relAttr(ref.attrs, 'id');
    const html = renderChart(rid, alt, ctx);
    if (html.startsWith('<figure')) {
      ctx.afterPara.push(html);
    } else {
      inline.push(html);
    }
  } else if (data !== undefined && /chartex/i.test(uri)) {
    inline.push(placeholder('Chart (this chart type is not supported)'));
  }
  return { inline };
}

function placeholder(label: string): string {
  return `<span class="mc-docx-placeholder">${escapeHtml(label)}</span>`;
}

// ---------------------------------------------------------------------------
// Text boxes
// ---------------------------------------------------------------------------

/**
 * The `w:txbxContent` bodies under a drawing or a VML picture, each as an
 * `<aside>`.
 *
 * A text box inside `mc:AlternateContent` is written twice, once as DrawingML
 * and once as VML. Only one branch is read (Choice, else Fallback) so the text
 * is never duplicated. Content inside a text box is not searched for further
 * boxes here: rendering it with the block reader finds those on its own.
 */
export function textBoxes(root: XNode, ctx: ReadCtx): string[] {
  if (ctx.boxDepth >= MAX_BOX_DEPTH) {
    return [];
  }
  const found: XNode[] = [];
  collectBoxes(root, found);
  const out: string[] = [];
  for (const box of found) {
    const savedAfter = ctx.afterPara;
    const savedOpen = ctx.openComments;
    ctx.afterPara = [];
    ctx.openComments = new Set();
    ctx.boxDepth++;
    try {
      const html = renderBlocks(box.children, ctx, 0, false).join('');
      if (html !== '') {
        out.push(`<aside class="mc-docx-textbox">${html}</aside>`);
      }
    } finally {
      ctx.boxDepth--;
      ctx.afterPara = savedAfter;
      ctx.openComments = savedOpen;
    }
  }
  return out;
}

function collectBoxes(node: XNode, out: XNode[]): void {
  for (const c of node.children) {
    if (c.name === 'txbxContent') {
      out.push(c);
    } else if (c.name === 'AlternateContent') {
      const branch = child(c, 'Choice') ?? child(c, 'Fallback');
      if (branch !== undefined) {
        collectBoxes(branch, out);
      }
    } else {
      collectBoxes(c, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

interface Cache {
  /** Values by point index; holes are ''. */
  pts: string[];
  format: string;
}

interface Series {
  name: string;
  x?: Cache;
  cat?: Cache;
  val?: Cache;
}

const TYPE_LABELS: Record<string, string> = {
  bar: 'Bar',
  line: 'Line',
  pie: 'Pie',
  ofPie: 'Pie of pie',
  doughnut: 'Doughnut',
  area: 'Area',
  scatter: 'Scatter',
  bubble: 'Bubble',
  radar: 'Radar',
  stock: 'Stock',
  surface: 'Surface',
};

function renderChart(rid: string | undefined, alt: string, ctx: ReadCtx): string {
  const target = rid === undefined ? undefined : ctx.rels.embed.get(rid);
  const xml = target === undefined ? undefined : partText(ctx.parts, target);
  if (xml === undefined) {
    return placeholder(alt ? `Chart (data not available): ${alt}` : 'Chart (data not available)');
  }
  try {
    const html = chartFigure(xml, alt);
    if (html !== undefined) {
      return html;
    }
  } catch {
    // A malformed chart part costs the chart, never the document.
  }
  return placeholder(alt ? `Chart (no data to show): ${alt}` : 'Chart (no data to show)');
}

function chartFigure(xml: string, alt: string): string | undefined {
  const space = parseXml(xml).children[0];
  const chart = space && child(space, 'chart');
  const plot = chart && child(chart, 'plotArea');
  if (chart === undefined || plot === undefined) {
    return undefined;
  }

  const kinds: string[] = [];
  const series: Series[] = [];
  let xy = false;
  for (const group of plot.children) {
    if (!group.name.endsWith('Chart')) {
      continue;
    }
    const kind = group.name.replace(/Chart$/, '').replace(/3D$/, '');
    const label = TYPE_LABELS[kind] ?? (kind ? kind[0].toUpperCase() + kind.slice(1) : 'Chart');
    if (!kinds.includes(label)) {
      kinds.push(label);
    }
    for (const ser of children(group, 'ser')) {
      if (series.length >= MAX_CHART_SERIES) {
        break;
      }
      const s: Series = { name: seriesName(ser, series.length + 1) };
      const xVal = child(ser, 'xVal');
      if (xVal !== undefined) {
        xy = true;
        s.x = readCache(xVal);
        s.val = readCache(child(ser, 'yVal'));
      } else {
        s.cat = readCache(child(ser, 'cat'));
        s.val = readCache(child(ser, 'val'));
      }
      series.push(s);
    }
  }
  const withData = series.filter((s) => (s.val?.pts.length ?? 0) > 0);
  if (withData.length === 0) {
    return undefined;
  }

  const typeLabel =
    kinds.length === 0
      ? 'Chart'
      : `${[kinds[0], ...kinds.slice(1).map((k) => k.toLowerCase())].join(' and ')} chart`;
  const title = chartTitle(chart) || alt;
  const caption = title ? `${title} (${typeLabel})` : typeLabel;

  const labelOf = (s: Series): Cache | undefined => (xy ? s.x : s.cat);
  const first = withData.find((s) => labelOf(s) !== undefined && labelOf(s)!.pts.length > 0);
  const sharedLabels =
    first === undefined ||
    withData.every((s) => {
      const a = labelOf(s)?.pts ?? [];
      const b = labelOf(first)?.pts ?? [];
      return a.length === 0 || (a.length === b.length && a.every((v, i) => v === b[i]));
    });

  const head: string[] = [];
  const cols: { cache: Cache | undefined }[] = [];
  if (sharedLabels) {
    head.push(xy ? 'X' : 'Category');
    cols.push({ cache: first && labelOf(first) });
    for (const s of withData) {
      head.push(s.name);
      cols.push({ cache: s.val });
    }
  } else {
    // Series that do not share their x values (or categories) each get their own pair.
    for (const s of withData) {
      head.push(`${s.name} (${xy ? 'X' : 'Category'})`, `${s.name} (${xy ? 'Y' : 'Value'})`);
      cols.push({ cache: labelOf(s) }, { cache: s.val });
    }
  }
  const rows = Math.min(MAX_CHART_ROWS, Math.max(...cols.map((c) => c.cache?.pts.length ?? 0)));

  let html = `<tr>${head.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join('')}</tr>`;
  const body: string[] = [];
  for (let r = 0; r < rows; r++) {
    // Only the value columns are formatted; labels are shown as cached.
    const cells = cols.map((c, i) => {
      const raw = c.cache?.pts[r] ?? '';
      const isValue = sharedLabels ? i > 0 : i % 2 === 1;
      return `<td>${escapeHtml(isValue && c.cache ? formatValue(raw, c.cache.format) : raw)}</td>`;
    });
    body.push(`<tr>${cells.join('')}</tr>`);
  }
  html = `<table><thead>${html}</thead><tbody>${body.join('')}</tbody></table>`;
  const aria = alt ? ` aria-label="${escapeAttr(alt)}"` : '';
  return (
    `<figure class="mc-docx-chart"${aria}>` +
    `<figcaption>${escapeHtml(caption)}</figcaption>${html}</figure>`
  );
}

function textOf(node: XNode | undefined): string {
  if (node === undefined) {
    return '';
  }
  return findAll(node, 't')
    .map((t) => t.text)
    .join('');
}

function chartTitle(chart: XNode): string {
  const title = child(chart, 'title');
  const tx = title && child(title, 'tx');
  if (tx === undefined) {
    return '';
  }
  const rich = child(tx, 'rich');
  if (rich !== undefined) {
    return children(rich, 'p')
      .map((p) => textOf(p))
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  return (
    readCache(tx)
      .pts.find((v) => v !== '')
      ?.trim() ?? ''
  );
}

function seriesName(ser: XNode, n: number): string {
  const tx = child(ser, 'tx');
  const name = tx ? readCache(tx).pts.find((v) => v !== '') : undefined;
  return name?.trim() || `Series ${n}`;
}

/** A reference's cached points (or a literal's), by index. Missing caches read as empty. */
function readCache(node: XNode | undefined): Cache {
  const empty: Cache = { pts: [], format: '' };
  if (node === undefined) {
    return empty;
  }
  let cache: XNode | undefined;
  for (const name of ['strRef', 'numRef', 'multiLvlStrRef']) {
    const ref = child(node, name);
    if (ref !== undefined) {
      cache = child(ref, 'strCache') ?? child(ref, 'numCache') ?? child(ref, 'multiLvlStrCache');
      break;
    }
  }
  cache ??= child(node, 'strLit') ?? child(node, 'numLit');
  // A literal value directly under c:tx.
  if (cache === undefined) {
    const v = child(node, 'v');
    return v === undefined ? empty : { pts: [v.text], format: '' };
  }
  // Several category levels: the innermost is the first one listed.
  const holder = cache.name === 'multiLvlStrCache' ? child(cache, 'lvl') : cache;
  if (holder === undefined) {
    return empty;
  }
  const declared = Number.parseInt(attr(child(cache, 'ptCount')?.attrs ?? {}, 'val') ?? '', 10);
  const pts: string[] = [];
  let max = Number.isFinite(declared) ? Math.min(declared, MAX_CHART_ROWS) : 0;
  for (const pt of children(holder, 'pt')) {
    const idx = Number.parseInt(attr(pt.attrs, 'idx') ?? '', 10);
    if (!(idx >= 0) || idx >= MAX_CHART_ROWS) {
      continue;
    }
    pts[idx] = child(pt, 'v')?.text ?? '';
    max = Math.max(max, idx + 1);
  }
  for (let i = 0; i < max; i++) {
    pts[i] ??= '';
  }
  return { pts, format: child(cache, 'formatCode')?.text.trim() ?? '' };
}

/** Percent and fixed-decimal codes only; any other code shows the cached value as written. */
function formatValue(raw: string, code: string): string {
  if (raw === '' || code === '' || code === 'General') {
    return raw;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return raw;
  }
  const percent = /^0(?:\.(0{1,6}))?%$/.exec(code);
  if (percent !== null) {
    return `${(n * 100).toFixed(percent[1]?.length ?? 0)}%`;
  }
  const fixed = /^0\.(0{1,6})$/.exec(code);
  return fixed !== null ? n.toFixed(fixed[1].length) : raw;
}
