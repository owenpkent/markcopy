// Reading a .pptx presentation into the preview's HTML.
//
// Free of the `vscode` module, like src/xlsx and src/csv.ts, so the whole
// fidelity surface unit-tests directly: slide order, placeholder inheritance,
// EMU-to-percent conversion, bullet nesting, table merges, the media budget,
// and scheme colour resolution are all exercised in tests/pptx without a
// webview or a running editor.
import { readRels, relsPathFor } from '../../ooxml/rels';
import { openZip, partText, type Parts, type ZipLimits } from '../../ooxml/zip';
import { readDeck, type SlideSize } from './deck';
import { findRelByType, resolveSlideContext, type SlideContext } from './layout';
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

    const shapes = readSlideShapes(slideXml, {
      parts,
      slideRels: readRels(parts, relsPathFor(slidePath)),
      media,
      defaultTextStyle: deck.defaultTextStyle,
      ...slideContextFor(parts, slidePath, contextCache),
    });
    const notes = showNotes ? readSpeakerNotes(parts, slidePath) : undefined;
    sections.push(renderSlide(shapes, notes, i, deck.size));
  }

  const rendered = sections.length;
  return {
    html: renderDeck(sections, truncationNote(rendered, totalSlides)),
    slides: totalSlides,
    rendered,
  };
}

function slideContextFor(
  parts: Parts,
  slidePath: string,
  cache: Map<string, SlideContext>,
): SlideContext {
  const layoutPath = findRelByType(parts, relsPathFor(slidePath), '/slideLayout');
  const key = layoutPath ?? `#no-layout:${slidePath}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const context = resolveSlideContext(parts, slidePath);
  cache.set(key, context);
  return context;
}

export type { SlideSize };
