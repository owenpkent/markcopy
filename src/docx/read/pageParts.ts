// Page headers and footers.
//
// A preview is one continuous column, so the first section's default header is
// shown once at the top and the last section's default footer once at the
// bottom. They are chrome for the page, not content: both carry
// `data-mc-ignore`, which keeps them out of every copy and export. Page-number
// fields are dropped by the inline reader, since a number means nothing here.
import { attr, relAttr } from '../../ooxml/xml';
import { child, children, parseXml, type XNode } from '../../ooxml/xnode';
import { partText } from '../../ooxml/zip';
import { renderBlocks } from './blocks';
import { type PartRels, type ReadCtx } from './context';

/** The section properties in reading order: each paragraph-level one, then the body's own (the last section). */
export function sectionProps(body: XNode): XNode[] {
  const out: XNode[] = [];
  for (const n of body.children) {
    if (n.name === 'p') {
      const pPr = child(n, 'pPr');
      const sect = pPr && child(pPr, 'sectPr');
      if (sect !== undefined) {
        out.push(sect);
      }
    } else if (n.name === 'sectPr') {
      out.push(n);
    }
  }
  return out;
}

function refId(sect: XNode, kind: 'header' | 'footer'): string | undefined {
  const refs = children(sect, `${kind}Reference`);
  const typed = (type: string): XNode | undefined =>
    refs.find((r) => (attr(r.attrs, 'type') ?? 'default') === type);
  const ref = typed('default') ?? typed('first');
  return ref && relAttr(ref.attrs, 'id');
}

/** Render a header or footer to its element, or '' when it is absent, unreadable, or empty. */
export function renderPagePart(
  kind: 'header' | 'footer',
  sects: XNode[],
  ctx: ReadCtx,
  relsFor: (partPath: string) => PartRels,
): string {
  // A header belongs to the first section. A footer is the last one that
  // names one: a section without its own inherits the previous section's.
  const order = kind === 'header' ? sects.slice(0, 1) : [...sects].reverse();
  let rid: string | undefined;
  for (const s of order) {
    rid = refId(s, kind);
    if (rid !== undefined) {
      break;
    }
  }
  const path = rid === undefined ? undefined : ctx.rels.embed.get(rid);
  const xml = path === undefined ? undefined : partText(ctx.parts, path);
  if (path === undefined || xml === undefined) {
    return '';
  }
  const savedRels = ctx.rels;
  const savedOpen = ctx.openComments;
  try {
    const root = parseXml(xml).children[0];
    ctx.rels = relsFor(path);
    ctx.openComments = new Set();
    const html = root ? renderBlocks(root.children, ctx, 0, false).join('') : '';
    if (html === '') {
      return '';
    }
    const [tag, cls, label] =
      kind === 'header'
        ? ['header', 'mc-docx-pagehead', 'Page header']
        : ['footer', 'mc-docx-pagefoot', 'Page footer'];
    return `<${tag} class="${cls}" aria-label="${label}" data-mc-ignore="1">${html}</${tag}>`;
  } catch {
    return '';
  } finally {
    ctx.rels = savedRels;
    ctx.openComments = savedOpen;
  }
}
