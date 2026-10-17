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
  /** Paragraph budget: a crafted file can hold millions, and the preview is a string in memory. */
  budget: { used: number; max: number; truncated: boolean };
  /** Inside a header cell, whose <th> is already bold. */
  inHeaderCell: boolean;
  /** Rendered-output budget: everything emitted from embedded bytes, charged per emission. */
  output: OutputBudget;
}

/**
 * A document-wide ceiling on content the reader generates from package bytes.
 * The media budget caps unique parts; this caps what is written into the HTML,
 * where one small part referenced many times costs its full size every time.
 */
export interface OutputBudget {
  used: number;
  max: number;
  /** Set once a charge was refused, so the result can say content was left out. */
  truncated: boolean;
}

/**
 * Charge `cost` bytes of generated output. False means the budget is spent and
 * the caller must emit a placeholder instead; the refusal marks the result
 * truncated. A refused charge costs nothing, so a smaller item may still fit.
 */
export function spendOutput(ctx: ReadCtx, cost: number): boolean {
  const out = ctx.output;
  if (out.used + cost > out.max) {
    out.truncated = true;
    return false;
  }
  out.used += cost;
  return true;
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
