// Reading a .docx document into the preview's HTML.
//
// Free of the `vscode` module, like src/pptx/read and src/xlsx, so the whole
// fidelity surface unit-tests directly. The reader is read-only and lossy by
// design: it recovers what a person reading the document would call its
// content (headings, paragraphs with inline formatting, lists, tables, links,
// images with alt text, footnotes, comments, text boxes, and charts as data
// tables) and leaves layout alone. Page geometry is not drawn; the first
// header and last footer are shown once, as page chrome. Equations become
// LaTeX (omml.ts) in the placeholder markup the Markdown preview uses.
//
// Heading mapping: the `Title` style becomes `<h1 class="mc-docx-title">`, and
// `Heading 1` through `Heading 6` become `<h1>` through `<h6>`, so a document
// that has both has two levels of `<h1>`. That keeps the mapping a pure
// function of the paragraph (no look-ahead, no renumbering that would change
// when the author adds a Title) and matches what this extension's own Word
// export writes, which is what makes a round trip come back unchanged.
import { escapeHtml } from '../../escape';
import { type MediaBudget } from '../../ooxml/media';
import { readExternalRels, readRels, relsPathFor } from '../../ooxml/rels';
import { attr, walkXml } from '../../ooxml/xml';
import { child, children, parseXml, type XNode } from '../../ooxml/xnode';
import { openZip, OpcError, partText, type Parts, type ZipLimits } from '../../ooxml/zip';
import { renderBlocks } from './blocks';
import { emptyComments, readComments, renderComments } from './comments';
import { noteDomId, type NoteBook, type PartRels, type ReadCtx } from './context';
import { Numbering } from './numbering';
import { renderPagePart, sectionProps } from './pageParts';
import { Styles } from './styles';

export { OpcError as DocxError } from '../../ooxml/zip';

export interface ReadOptions {
  /** Paragraphs to render before stopping, counting those inside tables. Default 50,000. */
  maxParagraphs?: number;
  /**
   * Total budget, in bytes, for images inlined as data URIs. Default 16 MiB.
   * It bounds distinct parts and, separately, every emitted image reference.
   */
  maxMediaBytes?: number;
  zipLimits?: ZipLimits;
  /** Render equations as KaTeX math (default true). Off shows each one's LaTeX as code. */
  math?: boolean;
}

export interface DocxHtml {
  html: string;
  /** True when `maxParagraphs` cut the document short, or repeated content hit the output budget. */
  truncated: boolean;
}

const DEFAULT_MAX_PARAGRAPHS = 50_000;
const DEFAULT_MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export function renderDocxHtml(bytes: Uint8Array, opts: ReadOptions = {}): DocxHtml {
  const parts = openZip(bytes, {
    limits: opts.zipLimits,
    noun: 'document',
    notZip: 'this file is not a .docx document (the older .doc format is not supported).',
  });

  const mainPath = findMainPart(parts);
  const docXml = partText(parts, mainPath);
  if (docXml === undefined) {
    throw new OpcError(`this file has no document body (${mainPath} is missing).`);
  }
  let body: XNode | undefined;
  try {
    const root = parseXml(docXml).children[0];
    body = root && child(root, 'body');
  } catch (err) {
    throw new OpcError(
      `the document body could not be read (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  if (body === undefined) {
    throw new OpcError('this file has no document body.');
  }

  const dir = mainPath.slice(0, mainPath.lastIndexOf('/') + 1);
  const media: MediaBudget = {
    used: 0,
    max: Math.max(0, opts.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES),
  };
  const footnotePath = `${dir}footnotes.xml`;
  const endnotePath = `${dir}endnotes.xml`;
  const ctx: ReadCtx = {
    parts,
    // A missing or broken styles or numbering part costs fidelity (headings
    // fall back to outline levels, every list to bullets), never the document.
    styles: soft(() => new Styles(partText(parts, `${dir}styles.xml`)), new Styles(undefined)),
    numbering: soft(
      () => new Numbering(partText(parts, `${dir}numbering.xml`)),
      new Numbering(undefined),
    ),
    media,
    imageCache: new Map(),
    chartCache: new Map(),
    rels: partRels(parts, mainPath),
    bookmarks: new Set(),
    counters: new Map(),
    seenLevels: new Set(),
    footnotes: {
      defs: soft(() => readNotes(parts, footnotePath, 'footnote'), new Map()),
      order: [],
    },
    endnotes: { defs: soft(() => readNotes(parts, endnotePath, 'endnote'), new Map()), order: [] },
    comments: soft(
      () => readComments(parts, `${dir}comments.xml`, `${dir}commentsExtended.xml`),
      emptyComments(),
    ),
    openComments: new Set(),
    afterPara: [],
    boxDepth: 0,
    math: opts.math !== false,
    budget: {
      used: 0,
      max: Math.max(1, opts.maxParagraphs ?? DEFAULT_MAX_PARAGRAPHS),
      truncated: false,
    },
    inHeaderCell: false,
    output: { used: 0, max: media.max, truncated: false },
  };

  const sects = sectionProps(body);
  const relsFor = (path: string): PartRels => partRels(parts, path);
  let html = renderPagePart('header', sects, ctx, relsFor);
  html += renderBlocks(body.children, ctx, 0, true).join('');
  html += renderNotes(ctx, 'footnote', ctx.footnotes, partRels(parts, footnotePath));
  html += renderNotes(ctx, 'endnote', ctx.endnotes, partRels(parts, endnotePath));
  html += renderPagePart('footer', sects, ctx, relsFor);
  html += renderComments(ctx, partRels(parts, `${dir}comments.xml`));
  if (html === '') {
    html = '<p class="mc-docx-note">This document has no content to show.</p>';
  }
  if (ctx.budget.truncated) {
    html += `<p class="mc-docx-note">Showing the first ${ctx.budget.max} paragraphs. The rest of the document is not shown.</p>`;
  }
  if (ctx.output.truncated) {
    html +=
      '<p class="mc-docx-note">Some repeated images or charts are not shown, to keep the preview a reasonable size.</p>';
  }
  return {
    html: `<div class="mc-docx">${html}</div>`,
    truncated: ctx.budget.truncated || ctx.output.truncated,
  };
}

function soft<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** The main document part, from the package relationships, else the conventional path. */
function findMainPart(parts: Parts): string {
  let found: string | undefined;
  const xml = partText(parts, '_rels/.rels');
  if (xml !== undefined) {
    soft(() => {
      walkXml(xml, {
        open(name, attrs) {
          const type = attr(attrs, 'Type');
          const target = attr(attrs, 'Target');
          if (
            found === undefined &&
            name === 'Relationship' &&
            type?.endsWith('/officeDocument') &&
            target &&
            attr(attrs, 'TargetMode') !== 'External'
          ) {
            found = target.replace(/^\/+/, '');
          }
        },
      });
    }, undefined);
  }
  return found ?? 'word/document.xml';
}

function partRels(parts: Parts, partPath: string): PartRels {
  const relsPath = relsPathFor(partPath);
  return {
    embed: soft(() => readRels(parts, relsPath), new Map()),
    external: soft(() => readExternalRels(parts, relsPath), new Map()),
  };
}

function readNotes(parts: Parts, path: string, tag: string): Map<string, XNode> {
  const out = new Map<string, XNode>();
  const xml = partText(parts, path);
  const root = xml === undefined ? undefined : parseXml(xml).children[0];
  for (const n of root ? children(root, tag) : []) {
    const id = attr(n.attrs, 'id');
    const type = attr(n.attrs, 'type');
    // Separator notes are the rule Word draws above the notes, not content.
    if (id !== undefined && (type === undefined || type === 'normal')) {
      out.set(id, n);
    }
  }
  return out;
}

/** The notes the body cited, in the order it cited them, as one ordered list. */
function renderNotes(
  ctx: ReadCtx,
  kind: 'footnote' | 'endnote',
  book: NoteBook,
  rels: PartRels,
): string {
  if (book.order.length === 0) {
    return '';
  }
  const bodyRels = ctx.rels;
  ctx.rels = rels;
  const items: string[] = [];
  for (const id of book.order) {
    const def = book.defs.get(id);
    if (def === undefined) {
      continue;
    }
    const blocks = renderBlocks(def.children, ctx, 0, false);
    const back =
      `<a class="mc-docx-backref" data-mc-ignore="1" href="#${noteDomId(kind, id, 'ref')}" ` +
      `aria-label="Back to text">↩</a>`;
    const inner =
      blocks.length === 1 && blocks[0].startsWith('<p>') && blocks[0].endsWith('</p>')
        ? blocks[0].slice(3, -4)
        : blocks.join('');
    items.push(`<li id="${noteDomId(kind, id, 'note')}">${inner} ${back}</li>`);
  }
  ctx.rels = bodyRels;
  const label = kind === 'footnote' ? 'Footnotes' : 'Endnotes';
  return (
    `<section class="mc-docx-notes" aria-label="${escapeHtml(label)}">` +
    `<hr><ol>${items.join('')}</ol></section>`
  );
}
