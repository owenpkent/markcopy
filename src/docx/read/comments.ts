// Review comments: word/comments.xml, and the thread data in commentsExtended.xml.
//
// The body marks each commented range with `<mark>` and a superscript marker
// (see inline.ts); this module reads the comment definitions and draws the
// "Comments" section at the end. The marker and the whole section carry
// `data-mc-ignore`, and the `<mark>` is unwrapped by the copy paths, so none
// of it reaches the clipboard or an export: a comment is a review note about
// the text, not part of it.
import { escapeAttr, escapeHtml } from '../../escape';
import { attr } from '../../ooxml/xml';
import { children, parseXml } from '../../ooxml/xnode';
import { partText, type Parts } from '../../ooxml/zip';
import { renderBlocks } from './blocks';
import {
  commentDomId,
  type CommentBook,
  type CommentDef,
  type PartRels,
  type ReadCtx,
} from './context';

const MAX_AUTHOR = 200;
const MAX_THREAD_DEPTH = 6;

export function emptyComments(): CommentBook {
  return { defs: new Map(), order: [], extended: new Map() };
}

export function readComments(parts: Parts, path: string, extendedPath: string): CommentBook {
  const book = emptyComments();
  const xml = partText(parts, path);
  const root = xml === undefined ? undefined : parseXml(xml).children[0];
  for (const n of root ? children(root, 'comment') : []) {
    const id = attr(n.attrs, 'id');
    if (id === undefined) {
      continue;
    }
    const paras = children(n, 'p');
    const date = /^\d{4}-\d{2}-\d{2}/.exec(attr(n.attrs, 'date') ?? '')?.[0] ?? '';
    book.defs.set(id, {
      node: n,
      author: (attr(n.attrs, 'author') ?? '').slice(0, MAX_AUTHOR).trim(),
      date,
      paraId: paras.length > 0 ? attr(paras[paras.length - 1].attrs, 'paraId') : undefined,
    });
  }
  try {
    const extXml = book.defs.size > 0 ? partText(parts, extendedPath) : undefined;
    const extRoot = extXml === undefined ? undefined : parseXml(extXml).children[0];
    for (const ex of extRoot ? children(extRoot, 'commentEx') : []) {
      const paraId = attr(ex.attrs, 'paraId');
      if (paraId !== undefined) {
        book.extended.set(paraId, {
          parent: attr(ex.attrs, 'paraIdParent'),
          done: ['1', 'true', 'on'].includes(attr(ex.attrs, 'done') ?? ''),
        });
      }
    }
  } catch {
    // Thread data is optional; without it replies list in order.
  }
  return book;
}

/** The comments the body referenced, then any it did not, as a threaded list. */
export function renderComments(ctx: ReadCtx, rels: PartRels): string {
  const book = ctx.comments;
  if (book.defs.size === 0 || ctx.budget.truncated) {
    return '';
  }
  const referenced = new Set(book.order);
  const ids = [...book.order, ...[...book.defs.keys()].filter((id) => !referenced.has(id))];

  const byPara = new Map<string, string>();
  for (const id of ids) {
    const p = book.defs.get(id)?.paraId;
    if (p !== undefined) {
      byPara.set(p, id);
    }
  }
  const parentOf = (id: string): string | undefined => {
    const paraId = book.defs.get(id)?.paraId;
    const parent = paraId === undefined ? undefined : book.extended.get(paraId)?.parent;
    const pid = parent === undefined ? undefined : byPara.get(parent);
    return pid === id ? undefined : pid;
  };
  const replies = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of ids) {
    const parent = parentOf(id);
    if (parent === undefined) {
      roots.push(id);
    } else {
      replies.set(parent, [...(replies.get(parent) ?? []), id]);
    }
  }

  const savedRels = ctx.rels;
  const savedOpen = ctx.openComments;
  ctx.rels = rels;
  ctx.openComments = new Set();
  const seen = new Set<string>();
  const item = (id: string, depth: number): string => {
    const def = book.defs.get(id) as CommentDef;
    seen.add(id);
    const blocks = renderBlocks(def.node.children, ctx, 0, false);
    const inner =
      blocks.length === 1 && blocks[0].startsWith('<p>') && blocks[0].endsWith('</p>')
        ? blocks[0].slice(3, -4)
        : blocks.join('');
    const paraId = def.paraId;
    const resolved =
      depth === 0 && paraId !== undefined && book.extended.get(paraId)?.done === true;
    const meta =
      `<span class="mc-docx-cauthor">${escapeHtml(def.author || 'Unknown author')}</span>` +
      (def.date ? ` <span class="mc-docx-cdate">${escapeHtml(def.date)}</span>` : '') +
      (resolved ? ' <span class="mc-docx-resolved">Resolved</span>' : '');
    const dom = commentDomId(id);
    const back = referenced.has(id)
      ? ` <a class="mc-docx-backref" data-mc-ignore="1" href="#mc-cmref-${escapeAttr(dom)}" aria-label="Back to text">↩</a>`
      : '';
    const kids = (replies.get(id) ?? []).filter((r) => !seen.has(r));
    const nested =
      kids.length > 0 && depth < MAX_THREAD_DEPTH
        ? `<ol>${kids.map((k) => item(k, depth + 1)).join('')}</ol>`
        : '';
    return `<li id="mc-cm-${escapeAttr(dom)}"><div class="mc-docx-cmeta">${meta}</div>${inner}${back}${nested}</li>`;
  };
  try {
    const items = roots.map((id) => item(id, 0)).join('');
    return items === ''
      ? ''
      : `<section class="mc-docx-comments" aria-label="Comments" data-mc-ignore="1">` +
          `<hr><h2 class="mc-docx-comments-title">Comments</h2><ol>${items}</ol></section>`;
  } finally {
    ctx.rels = savedRels;
    ctx.openComments = savedOpen;
  }
}
