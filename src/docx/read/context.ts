// State shared by the pieces of the document reader.
//
// One of these lives for one `renderDocxHtml` call. It carries the parsed
// styles and numbering, the media budget, and the bookkeeping that has to
// span the whole document: which bookmark ids have been handed out, how far
// each list has counted, and which footnotes the body referenced.
import { type Rels } from '../../ooxml/rels';
import { type MediaBudget } from '../../ooxml/media';
import { type Parts } from '../../ooxml/zip';
import { type XNode } from '../../ooxml/xnode';
import { type Numbering } from './numbering';
import { type Styles } from './styles';

/** The relationships of the part currently being read (the body, then each notes part). */
export interface PartRels {
  /** Internal targets (images), resolved to zip paths. */
  embed: Rels;
  /** External targets (hyperlinks), as written. Never fetched. */
  external: Map<string, string>;
}

/** Footnotes or endnotes: the definitions, and the ids in the order the body cited them. */
export interface NoteBook {
  defs: Map<string, XNode>;
  order: string[];
}

/** One comment from word/comments.xml. */
export interface CommentDef {
  node: XNode;
  author: string;
  /** `YYYY-MM-DD`, or '' when the file gave no usable date. */
  date: string;
  /** The `w14:paraId` of the comment's last paragraph, which `commentsExtended` keys on. */
  paraId?: string;
}

/** Comments: the definitions, the ids the body referenced in order, and the thread data. */
export interface CommentBook {
  defs: Map<string, CommentDef>;
  order: string[];
  /** paraId -> `{ parent paraId, done }` from word/commentsExtended.xml. */
  extended: Map<string, { parent?: string; done: boolean }>;
}

export interface ReadCtx {
  parts: Parts;
  styles: Styles;
  numbering: Numbering;
  media: MediaBudget;
  imageCache: Map<string, string>;
  rels: PartRels;
  /** Bookmark ids already emitted; the first claim on an id wins. */
  bookmarks: Set<string>;
  /** The next number per level, per abstract numbering definition, across the whole document. */
  counters: Map<string, (number | undefined)[]>;
  /** `numId:level` pairs already used, so a restart override applies only the first time. */
  seenLevels: Set<string>;
  footnotes: NoteBook;
  endnotes: NoteBook;
  comments: CommentBook;
  /** Comment ranges opened and not yet closed, so a range can cross paragraphs. */
  openComments: Set<string>;
  /**
   * Block markup (text boxes, charts) found while reading a paragraph's runs.
   * Block content cannot live inside a `<p>`, so the block reader drains this
   * and places it after the paragraph.
   */
  afterPara: string[];
  /** How deep text boxes nest inside text boxes; bounded so a crafted file stays cheap. */
  boxDepth: number;
  /** Paragraph budget: a crafted file can hold millions, and the preview is a string in memory. */
  budget: { used: number; max: number; truncated: boolean };
}

const MAX_ID = 120;

/** An element id for a bookmark name. The prefix keeps a hostile name from clobbering the shell's own ids. */
export function bookmarkId(name: string): string {
  return `mc-bm-${name.slice(0, MAX_ID).replace(/[^A-Za-z0-9_.-]/g, '-')}`;
}

/** Only web and mail links become links; anything else (file:, javascript:, a UNC path) stays text. */
export function safeHref(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const href = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (href.length > 2048 || /[\u0000-\u001f\u007f]/.test(href)) {
    return undefined;
  }
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : undefined;
}

type NoteKind = 'footnote' | 'endnote';

const NOTE_IDS = {
  footnote: { ref: 'mc-fnref-', note: 'mc-fn-' },
  endnote: { ref: 'mc-enref-', note: 'mc-en-' },
};

export function noteDomId(kind: NoteKind, id: string, which: 'ref' | 'note'): string {
  return `${NOTE_IDS[kind][which]}${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/** The superscript reference for a note, or '' when the file defines no such note. */
export function noteRefHtml(ctx: ReadCtx, kind: NoteKind, id: string): string {
  const book = kind === 'footnote' ? ctx.footnotes : ctx.endnotes;
  if (!book.defs.has(id)) {
    return '';
  }
  let n = book.order.indexOf(id) + 1;
  if (n === 0) {
    book.order.push(id);
    n = book.order.length;
  }
  return (
    `<sup class="mc-docx-noteref"><a href="#${noteDomId(kind, id, 'note')}" ` +
    `id="${noteDomId(kind, id, 'ref')}">${n}</a></sup>`
  );
}

/** The superscript marker for a comment, or '' when the file defines no such comment. */
export function commentRefHtml(ctx: ReadCtx, id: string): string {
  if (!ctx.comments.defs.has(id)) {
    return '';
  }
  let n = ctx.comments.order.indexOf(id) + 1;
  if (n === 0) {
    ctx.comments.order.push(id);
    n = ctx.comments.order.length;
  }
  const dom = commentDomId(id);
  return (
    `<sup class="mc-docx-commentref" data-mc-ignore="1"><a href="#mc-cm-${dom}" ` +
    `id="mc-cmref-${dom}" aria-label="Comment ${n}">C${n}</a></sup>`
  );
}

export function commentDomId(id: string): string {
  return id.slice(0, MAX_ID).replace(/[^A-Za-z0-9_-]/g, '-');
}
