// Reading a presentation's structure: its slide size, its slide order, and
// where each slide's part lives.
import { attr, intAttr, walkXml } from '../../ooxml/xml';
import { readRels, relsPathFor, type Rels } from '../../ooxml/rels';
import {
  OpcError as DeckError,
  partForRels,
  partText,
  resolveTarget,
  type Parts,
} from '../../ooxml/zip';
import { findDeep, parseXml, type XNode } from './xnode';

export interface SlideSize {
  cx: number;
  cy: number;
}

export interface SlideRef {
  /** Zip path of the slide part. */
  path: string;
}

export interface Deck {
  /** Zip path of the presentation part, which is not always ppt/presentation.xml. */
  path: string;
  /** Relationships declared by the presentation part, for resolving slide r:ids. */
  rels: Rels;
  size: SlideSize;
  /** Slide order, exactly as declared by <p:sldIdLst>. Never filename order. */
  slides: SlideRef[];
  /** <p:defaultTextStyle>, the deck-wide fallback below even the master's <p:txStyles>. */
  defaultTextStyle?: XNode;
}

// The default widescreen size (EMU), used whenever <p:sldSz> is absent or
// declares something non-positive. 914400 EMU/inch: 13.333in x 7.5in.
const DEFAULT_SIZE: SlideSize = { cx: 12192000, cy: 6858000 };

export function readDeck(parts: Parts): Deck {
  const path = findPresentationPart(parts);
  const xml = partText(parts, path);
  if (xml === undefined) {
    throw new DeckError('this presentation has no presentation part.');
  }

  const rels = readRels(parts, relsPathFor(path));

  let size = DEFAULT_SIZE;
  const slides: SlideRef[] = [];

  walkXml(xml, {
    open(name, attrs) {
      if (name === 'sldSz') {
        const cx = intAttr(attrs, 'cx');
        const cy = intAttr(attrs, 'cy');
        if (cx !== undefined && cx > 0 && cy !== undefined && cy > 0) {
          size = { cx, cy };
        }
      } else if (name === 'sldId') {
        // <p:sldId id="256" r:id="rId2"/> carries two attributes whose local
        // name is "id": the slide's own id and the relationship id. attr()
        // matches an exact key before it falls back to local-name matching, so
        // asking for the literal "r:id" key is what keeps this from resolving
        // to the slide id instead of the relationship.
        const rId = attr(attrs, 'r:id');
        const target = rId === undefined ? undefined : rels.get(rId);
        if (target !== undefined) {
          slides.push({ path: target });
        }
        // A <sldId> whose relationship is missing or unresolved names a slide
        // that cannot be read. Skipping it here, rather than failing the whole
        // deck, matches how a missing worksheet relationship is handled in
        // src/xlsx/workbook.ts: the rest of the deck is still worth showing.
      }
    },
  });

  if (slides.length === 0) {
    throw new DeckError('this presentation has no slides.');
  }

  const defaultTextStyle = findDeep(parseXml(xml), 'defaultTextStyle');
  return { path, rels, size, slides, defaultTextStyle };
}

/**
 * Locate the presentation part through the package relationships.
 *
 * Mirrors findWorkbookPart in src/xlsx/workbook.ts: the officeDocument
 * relationship in `_rels/.rels` is what actually says where the presentation
 * lives, and the conventional `ppt/presentation.xml` path is only a fallback
 * for a package whose root relationship part is damaged or missing.
 */
function findPresentationPart(parts: Parts): string {
  const rootRels = partText(parts, '_rels/.rels');
  if (rootRels !== undefined) {
    let found: string | undefined;
    walkXml(rootRels, {
      open(name, attrs) {
        if (name !== 'Relationship' || found !== undefined) {
          return;
        }
        const type = attr(attrs, 'Type') ?? '';
        const target = attr(attrs, 'Target');
        if (target && /\/officeDocument$/.test(type)) {
          found = resolveTarget(partForRels('_rels/.rels'), target);
        }
      },
    });
    if (found !== undefined && parts.has(found)) {
      return found;
    }
  }
  if (parts.has('ppt/presentation.xml')) {
    return 'ppt/presentation.xml';
  }
  throw new DeckError('this presentation has no presentation part.');
}
