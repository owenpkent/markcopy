// Reading a .pptx presentation into the preview's HTML.
//
// Free of the `vscode` module, like src/xlsx and src/csv.ts, so the whole
// fidelity surface unit-tests directly: slide order, placeholder inheritance,
// EMU-to-percent conversion, bullet nesting, table merges, the media budget,
// and scheme colour resolution are all exercised in tests/pptx without a
// webview or a running editor.
import { openZip, partText, type Parts, type ZipLimits } from '../../ooxml/zip';
import { readDeck, type SlideSize } from './deck';
import { readSlideRelInfo, resolveSlideContext, type SlideContext } from './layout';
import { readSlideShapes, readSpeakerNotes, type MediaBudget } from './shape';
import { renderDeck, renderSlide, truncationNote } from './render';

export { OpcError as DeckError } from '../../ooxml/zip';

export interface ReadOptions {
  /** How many slides to render before stopping. Default 100. */
  maxSlides?: number;
  /** Show each slide's speaker notes under it. Default true. */
  showNotes?: boolean;
  /** Total budget, in bytes, for images inlined as data URIs. Default 16 MiB. */
  maxMediaBytes?: number;
  zipLimits?: ZipLimits;
}

export interface DeckHtml {
  html: string;
  /** Slides in the deck. */
  slides: number;
  /** Slides actually rendered, which is fewer when maxSlides bit. */
  rendered: number;
}

const DEFAULT_MAX_SLIDES = 100;
const DEFAULT_MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export function renderDeckHtml(bytes: Uint8Array, opts: ReadOptions = {}): DeckHtml {
  const maxSlides = Math.max(1, opts.maxSlides ?? DEFAULT_MAX_SLIDES);
  const showNotes = opts.showNotes ?? true;
  const media: MediaBudget = {
    used: 0,
    max: Math.max(0, opts.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES),
  };
  // One cache for the whole deck, not one per slide: a media part reused
  // across slides (a logo, a repeated header image) is encoded once and
  // charged against `media` once, no matter how many slides embed it.
  const imageCache = new Map<string, string>();

  const parts = openZip(bytes, {
    limits: opts.zipLimits,
    noun: 'presentation',
    notZip: 'this file is not a .pptx presentation (the older .ppt format is not supported).',
  });

  const deck = readDeck(parts);
  const totalSlides = deck.slides.length;
  const toRender = deck.slides.slice(0, maxSlides);

  // Slides overwhelmingly share a handful of layouts (and through them, a
  // master and a theme), so resolving that chain once per layout rather than
  // once per slide keeps a 100-slide deck from reparsing the same theme XML a
  // hundred times.
  const contextCache = new Map<string, SlideContext>();

  const sections: string[] = [];
  for (let i = 0; i < toRender.length; i++) {
    const slidePath = toRender[i].path;
    const slideXml = partText(parts, slidePath);
    if (slideXml === undefined) {
      // The part a <p:sldId> pointed at is missing from the package. Skip it
      // rather than failing the whole deck, the same as a worksheet whose
      // relationship is missing in src/xlsx/workbook.ts.
      continue;
    }

    // One pass over this slide's own .rels for everything it can answer: the
    // r:embed/r:id map shapes need, the layout target (also this slide's
    // context-cache key), and the notes target. Each used to cost its own
    // separate SAX pass over the same small part.
    const relInfo = readSlideRelInfo(parts, slidePath);
    const shapes = readSlideShapes(slideXml, {
      parts,
      slideRels: relInfo.rels,
      media,
      imageCache,
      defaultTextStyle: deck.defaultTextStyle,
      ...slideContextFor(parts, relInfo.layoutPath, contextCache),
    });
    const notes = showNotes ? readSpeakerNotes(parts, relInfo.notesPath) : undefined;
    sections.push(renderSlide(shapes, notes, i, deck.size));
  }

  const rendered = sections.length;
  return {
    html: renderDeck(sections, truncationNote(rendered, totalSlides, toRender.length)),
    slides: totalSlides,
    rendered,
  };
}

function slideContextFor(
  parts: Parts,
  layoutPath: string | undefined,
  cache: Map<string, SlideContext>,
): SlideContext {
  // Every slide with no resolvable layout gets the exact same context (an
  // empty theme, the identity colour map, an empty placeholder chain): none
  // of that depends on which slide asked, only on there being no layout to
  // resolve. A single shared key for all of them is correct, not just cheap.
  const key = layoutPath ?? '#no-layout';
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const context = resolveSlideContext(parts, layoutPath);
  cache.set(key, context);
  return context;
}

export type { SlideSize };
