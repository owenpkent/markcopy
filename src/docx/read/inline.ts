// One paragraph's content: runs, links, fields, images, notes, bookmarks.
//
// The walk produces a flat list of atoms (a piece of formatted text, a line
// break, or finished markup for something like an image), and a second step
// turns that into HTML. The split exists so adjacent runs that share a format
// and a link merge into one `<strong>` or one `<a>` (Word shreds text into many
// runs on spell-check boundaries and revision marks, and `<strong>a</strong>
// <strong>b</strong>` is noise in a rich-text copy), and so a code paragraph can
// ask for its plain text without a second traversal.
//
// Track changes read as the final text: `w:ins` and `w:moveTo` content is
// kept, `w:del` and `w:moveFrom` content is dropped. Fields show their cached
// result. Comments, text boxes, and anything else not named here are skipped.
import { escapeAttr, escapeHtml } from '../../escape';
import { imageDataUri } from '../../ooxml/media';
import { attr, relAttr } from '../../ooxml/xml';
import { child, findAll, findDeep, type XNode } from '../../ooxml/xnode';
import { bookmarkId, noteRefHtml, safeHref, spendOutput, type ReadCtx } from './context';
import { mergeRunProps, readRunProps, type RunProps } from './styles';

interface Fmt {
  b: boolean;
  i: boolean;
  u: boolean;
  s: boolean;
  sup: boolean;
  sub: boolean;
  code: boolean;
  mark: boolean;
}

interface Link {
  key: string;
  open: string;
}

type Atom =
  | { kind: 'text'; text: string; fmt: Fmt; link?: Link }
  | { kind: 'br'; link?: Link }
  | { kind: 'html'; html: string; content: boolean; link?: Link };

export interface InlineResult {
  html: string;
  /** The text with line breaks as newlines and no formatting, for a code block. */
  plain: string;
  /** Anything a reader would see: non-blank text, an image, a note reference. */
  hasContent: boolean;
  /** Every visible character is in a monospace font, and there is nothing else. */
  allMono: boolean;
}

const EMU_PER_PX = 9525;
const MAX_IMAGE_PX = 8000;

// Wingdings and Symbol bullets arrive as private-use code points that no
// browser font has. These few are the ones lists and callouts actually use;
// anything else in that range is dropped rather than shown as a box.
const SYMBOL_GLYPHS: Record<number, string> = {
  0xf0b7: '•',
  0xf0a7: '▪',
  0xf0fc: '✓',
  0xf0d8: '➢',
  0xf076: '❖',
};

/**
 * `paraProps` are the run properties the paragraph's style gives every run in
 * it; a character style and then a run's own properties are layered on top.
 */
export function readInline(
  p: XNode,
  ctx: ReadCtx,
  paraMono: boolean,
  paraProps: RunProps = {},
): InlineResult {
  const walker = new InlineWalker(ctx, paraMono, paraProps);
  walker.nodes(p.children, undefined);
  return finish(walker.atoms);
}

/** The link a `HYPERLINK` field instruction names, if it is one worth following. */
function fieldLink(instr: string | undefined): Link | undefined {
  const m = /^\s*HYPERLINK\s+(.*)$/is.exec(instr ?? '');
  if (m === null) {
    return undefined;
  }
  const anchor = /\\l\s+"?([^"\s]+)"?/i.exec(m[1]);
  if (anchor !== null) {
    return internalLink(anchor[1]);
  }
  const target = /"([^"]*)"/.exec(m[1]) ?? /^\s*(\S+)/.exec(m[1]);
  return externalLink(safeHref(target?.[1]));
}

function internalLink(name: string | undefined): Link | undefined {
  if (!name) {
    return undefined;
  }
  const id = bookmarkId(name);
  return { key: `#${id}`, open: `<a href="#${escapeAttr(id)}">` };
}

function externalLink(href: string | undefined): Link | undefined {
  return href === undefined ? undefined : { key: href, open: `<a href="${escapeAttr(href)}">` };
}

interface Field {
  phase: 'instr' | 'result';
  instr: string;
  link?: Link;
}

class InlineWalker {
  readonly atoms: Atom[] = [];
  private readonly fields: Field[] = [];

  constructor(
    private readonly ctx: ReadCtx,
    private readonly paraMono: boolean,
    private readonly paraProps: RunProps,
  ) {}

  nodes(list: XNode[], link: Link | undefined): void {
    for (const n of list) {
      this.node(n, link);
    }
  }

  private node(n: XNode, link: Link | undefined): void {
    switch (n.name) {
      case 'r':
        this.run(n, link);
        break;
      case 'hyperlink':
        this.nodes(n.children, this.hyperlinkOf(n) ?? link);
        break;
      case 'fldSimple':
        this.nodes(n.children, fieldLink(attr(n.attrs, 'instr')) ?? link);
        break;
      // Inserted and moved-to text is the final text. Deleted and moved-from
      // text is not, and is not listed here, so it is skipped.
      case 'ins':
      case 'moveTo':
      case 'smartTag':
      case 'customXml':
      case 'dir':
      case 'bdo':
        this.nodes(n.children, link);
        break;
      case 'sdt': {
        const content = child(n, 'sdtContent');
        if (content !== undefined) {
          this.nodes(content.children, link);
        }
        break;
      }
      case 'bookmarkStart':
        this.bookmark(n, link);
        break;
      default:
        break;
    }
  }

  private hyperlinkOf(n: XNode): Link | undefined {
    const rid = relAttr(n.attrs, 'id');
    const anchor = attr(n.attrs, 'anchor');
    if (rid !== undefined) {
      let href = safeHref(this.ctx.rels.external.get(rid));
      if (href !== undefined && anchor && !href.includes('#')) {
        href += `#${anchor}`;
      }
      return externalLink(href);
    }
    return internalLink(anchor);
  }

  private bookmark(n: XNode, link: Link | undefined): void {
    const name = attr(n.attrs, 'name');
    if (!name || name === '_GoBack') {
      return;
    }
    const id = bookmarkId(name);
    if (this.ctx.bookmarks.has(id)) {
      return;
    }
    this.ctx.bookmarks.add(id);
    this.atoms.push({
      kind: 'html',
      html: `<span id="${escapeAttr(id)}"></span>`,
      content: false,
      link: this.link(link),
    });
  }

  /** The link in force: the enclosing `w:hyperlink`, else the innermost field's. */
  private link(link: Link | undefined): Link | undefined {
    if (link !== undefined) {
      return link;
    }
    for (let i = this.fields.length - 1; i >= 0; i--) {
      if (this.fields[i].phase === 'result' && this.fields[i].link !== undefined) {
        return this.fields[i].link;
      }
    }
    return undefined;
  }

  /** Inside a field's instruction, where nothing is shown. */
  private hidden(): boolean {
    return this.fields.some((f) => f.phase === 'instr');
  }

  private run(r: XNode, link: Link | undefined): void {
    const rPr = child(r, 'rPr');
    const styleId = rPr && attr(child(rPr, 'rStyle')?.attrs ?? {}, 'val');
    const props = mergeRunProps(
      mergeRunProps(this.paraProps, this.ctx.styles.runStyle(styleId)),
      readRunProps(rPr),
    );
    this.runChildren(r.children, props, link);
  }

  private runChildren(list: XNode[], props: RunProps, link: Link | undefined): void {
    for (const c of list) {
      switch (c.name) {
        case 't':
          this.text(c.text, props, link);
          break;
        case 'tab':
        case 'ptab':
          this.text('\t', props, link);
          break;
        case 'noBreakHyphen':
          this.text('-', props, link);
          break;
        case 'br': {
          // A page or column break is layout, not content.
          const type = attr(c.attrs, 'type');
          if ((type === undefined || type === 'textWrapping') && this.shown(props)) {
            this.atoms.push({ kind: 'br', link: this.link(link) });
          }
          break;
        }
        case 'cr':
          if (this.shown(props)) {
            this.atoms.push({ kind: 'br', link: this.link(link) });
          }
          break;
        case 'sym': {
          const code = Number.parseInt(attr(c.attrs, 'char') ?? '', 16);
          if (Number.isFinite(code)) {
            const glyph = code >= 0xe000 && code <= 0xf8ff ? SYMBOL_GLYPHS[code] : safeChar(code);
            if (glyph !== undefined) {
              this.text(glyph, props, link);
            }
          }
          break;
        }
        case 'drawing':
          if (this.shown(props)) {
            this.drawing(c, link);
          }
          break;
        case 'pict':
          if (this.shown(props)) {
            this.pict(c, link);
          }
          break;
        // Word wraps a drawing in Choice (modern) and Fallback (VML, a second
        // copy of the same picture). Reading both would show every image twice.
        case 'AlternateContent': {
          const choice = child(c, 'Choice');
          if (choice !== undefined) {
            this.runChildren(choice.children, props, link);
          }
          break;
        }
        case 'footnoteReference':
        case 'endnoteReference':
          if (this.shown(props)) {
            const kind = c.name === 'footnoteReference' ? 'footnote' : 'endnote';
            const html = noteRefHtml(this.ctx, kind, attr(c.attrs, 'id') ?? '');
            if (html !== '') {
              this.atoms.push({ kind: 'html', html, content: true });
            }
          }
          break;
        case 'fldChar':
          this.fieldChar(attr(c.attrs, 'fldCharType'));
          break;
        case 'instrText': {
          const f = this.fields[this.fields.length - 1];
          if (f !== undefined && f.phase === 'instr') {
            f.instr += c.text;
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private fieldChar(type: string | undefined): void {
    if (type === 'begin') {
      this.fields.push({ phase: 'instr', instr: '' });
    } else if (type === 'separate') {
      const f = this.fields[this.fields.length - 1];
      if (f !== undefined) {
        f.phase = 'result';
        f.link = fieldLink(f.instr);
      }
    } else if (type === 'end') {
      this.fields.pop();
    }
  }

  private shown(props: RunProps): boolean {
    return !props.vanish && !this.hidden();
  }

  private text(text: string, props: RunProps, link: Link | undefined): void {
    if (text === '' || !this.shown(props)) {
      return;
    }
    const l = this.link(link);
    this.atoms.push({
      kind: 'text',
      text,
      link: l,
      fmt: {
        b: !!props.b,
        i: !!props.i,
        // A link is underlined by the preview's own link style; the Hyperlink
        // character style asking for it too would double up.
        u: !!props.u && l === undefined,
        s: !!props.strike,
        sup: !!props.sup,
        sub: !!props.sub,
        code: !!props.mono || this.paraMono,
        mark: !!props.mark,
      },
    });
  }

  private drawing(d: XNode, link: Link | undefined): void {
    const host = child(d, 'inline') ?? child(d, 'anchor');
    const docPr = host && child(host, 'docPr');
    const docAlt = docPr
      ? attr(docPr.attrs, 'descr')?.trim() || attr(docPr.attrs, 'title')?.trim() || ''
      : '';
    const pics = findAll(d, 'pic');
    const extent = host && child(host, 'extent');
    for (const pic of pics) {
      const cNvPr = findDeep(pic, 'cNvPr');
      const alt =
        docAlt ||
        (cNvPr ? attr(cNvPr.attrs, 'descr')?.trim() || attr(cNvPr.attrs, 'title')?.trim() : '') ||
        '';
      const blip = findDeep(pic, 'blip');
      const embed = blip && relAttr(blip.attrs, 'embed');
      // Only a lone picture is sized by the drawing's extent; in a group that
      // extent belongs to the whole group.
      const size = pics.length === 1 && extent ? extentPx(extent) : undefined;
      this.image(embed, blip !== undefined && embed === undefined, alt, size, link);
    }
  }

  private pict(p: XNode, link: Link | undefined): void {
    for (const c of p.children) {
      const data = c.name === 'imagedata' ? c : findDeep(c, 'imagedata');
      if (data === undefined) {
        continue;
      }
      const alt = (attr(c.attrs, 'alt') || attr(data.attrs, 'title') || '').trim();
      this.image(relAttr(data.attrs, 'id'), false, alt, undefined, link);
    }
  }

  private image(
    embed: string | undefined,
    linkedOnly: boolean,
    alt: string,
    size: { w: number; h: number } | undefined,
    link: Link | undefined,
  ): void {
    const target = embed === undefined ? undefined : this.ctx.rels.embed.get(embed);
    let uri =
      target === undefined
        ? undefined
        : imageDataUri(this.ctx.parts, target, this.ctx.media, this.ctx.imageCache);
    // The cache makes the encoding free, but every reference writes the whole
    // URI into the output again, so each one is charged (at the part's size,
    // the unit the media budget uses).
    if (
      uri !== undefined &&
      target !== undefined &&
      !spendOutput(this.ctx, this.ctx.parts.get(target)?.length ?? 0)
    ) {
      uri = undefined;
    }
    let html: string;
    if (uri === undefined) {
      // A linked image is never fetched; EMF/WMF and anything over the media
      // or output budget cannot be shown. Name the gap instead of leaving a hole.
      const label = linkedOnly ? 'Linked image (not loaded)' : alt ? `Image: ${alt}` : 'Image';
      html = `<span class="mc-docx-placeholder">${escapeHtml(label)}</span>`;
    } else {
      const dims = size === undefined ? '' : ` width="${size.w}" height="${size.h}"`;
      html = `<img src="${uri}" alt="${escapeAttr(alt)}"${dims}>`;
    }
    this.atoms.push({ kind: 'html', html, content: true, link: this.link(link) });
  }
}

function extentPx(extent: XNode): { w: number; h: number } | undefined {
  const cx = Number(attr(extent.attrs, 'cx'));
  const cy = Number(attr(extent.attrs, 'cy'));
  if (!(cx > 0) || !(cy > 0)) {
    return undefined;
  }
  const clamp = (emu: number): number =>
    Math.min(MAX_IMAGE_PX, Math.max(1, Math.round(emu / EMU_PER_PX)));
  return { w: clamp(cx), h: clamp(cy) };
}

function safeChar(code: number): string | undefined {
  // Lone surrogates and non-characters would make the string malformed.
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
    return undefined;
  }
  return String.fromCodePoint(code);
}

function sig(f: Fmt): string {
  return `${+f.b}${+f.i}${+f.u}${+f.s}${+f.sup}${+f.sub}${+f.code}${+f.mark}`;
}

function wrapText(text: string, f: Fmt): string {
  let h = escapeHtml(text);
  if (f.code) {
    h = `<code>${h}</code>`;
  }
  if (f.sup) {
    h = `<sup>${h}</sup>`;
  }
  if (f.sub) {
    h = `<sub>${h}</sub>`;
  }
  if (f.u) {
    h = `<u>${h}</u>`;
  }
  if (f.s) {
    h = `<s>${h}</s>`;
  }
  if (f.i) {
    h = `<em>${h}</em>`;
  }
  if (f.b) {
    h = `<strong>${h}</strong>`;
  }
  if (f.mark) {
    h = `<mark>${h}</mark>`;
  }
  return h;
}

/**
 * The atoms with the whitespace stripped from the very start and end of the
 * paragraph. Word text routinely ends in a space (the one before a line wrap
 * or a revision mark); in markup it is invisible at best and, in a list item
 * or a cell, a stray gap in a copy at worst. The untrimmed atoms still feed
 * `plain`, where leading spaces are code indentation.
 */
function trimEnds(atoms: Atom[]): Atom[] {
  const out = atoms.slice();
  const visible = (a: Atom): boolean => a.kind !== 'html' || a.content;
  const first = out.findIndex(visible);
  if (first !== -1 && out[first].kind === 'text') {
    const a = out[first] as Extract<Atom, { kind: 'text' }>;
    out[first] = { ...a, text: a.text.trimStart() };
  }
  let last = out.length - 1;
  while (last >= 0 && !visible(out[last])) {
    last--;
  }
  if (last >= 0 && out[last].kind === 'text') {
    const a = out[last] as Extract<Atom, { kind: 'text' }>;
    out[last] = { ...a, text: a.text.trimEnd() };
  }
  return out.filter((a) => a.kind !== 'text' || a.text !== '');
}

function finish(source: Atom[]): InlineResult {
  const atoms = trimEnds(source);
  const pieces: { html: string; link?: Link }[] = [];
  const plain = source
    .map((a) => (a.kind === 'text' ? a.text : a.kind === 'br' ? '\n' : ''))
    .join('');
  let hasContent = false;
  let allMono = true;
  let visibleText = false;

  for (let i = 0; i < atoms.length;) {
    const a = atoms[i];
    if (a.kind === 'text') {
      let text = a.text;
      let j = i + 1;
      while (j < atoms.length) {
        const b = atoms[j];
        if (b.kind === 'text' && sig(b.fmt) === sig(a.fmt) && b.link?.key === a.link?.key) {
          text += b.text;
          j++;
        } else {
          break;
        }
      }
      pieces.push({ html: wrapText(text, a.fmt), link: a.link });
      if (text.trim() !== '') {
        hasContent = true;
        visibleText = true;
        if (!a.fmt.code) {
          allMono = false;
        }
      }
      i = j;
    } else if (a.kind === 'br') {
      pieces.push({ html: '<br>', link: a.link });
      i++;
    } else {
      pieces.push({ html: a.html, link: a.link });
      if (a.content) {
        hasContent = true;
        allMono = false;
      }
      i++;
    }
  }

  let html = '';
  for (let k = 0; k < pieces.length;) {
    const p = pieces[k];
    if (p.link === undefined) {
      html += p.html;
      k++;
      continue;
    }
    let inner = '';
    let m = k;
    while (m < pieces.length && pieces[m].link?.key === p.link.key) {
      inner += pieces[m].html;
      m++;
    }
    html += `${p.link.open}${inner}</a>`;
    k = m;
  }
  return { html, plain, hasContent, allMono: allMono && visibleText };
}
