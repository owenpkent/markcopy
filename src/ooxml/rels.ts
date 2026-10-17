// Reading an OPC relationship part.
//
// Every Office package addresses its own contents indirectly: a part names a
// relationship id, and the `_rels` file beside it says which zip path that id
// means. Nothing here is format-specific, and all three readers need it, so it
// lives with the container rather than with any one of them.
import { attr, walkXml } from './xml';
import { partForRels, partText, resolveTarget, type Parts } from './zip';

/** Relationship id -> target, resolved to a zip path. */
export type Rels = Map<string, string>;

/**
 * The relationships declared by one `.rels` part, or an empty map when it has
 * none. Absent is normal: a part with nothing to point at has no `.rels` file.
 */
export function readRels(parts: Parts, relsPath: string): Rels {
  const out: Rels = new Map();
  const xml = partText(parts, relsPath);
  if (xml === undefined) {
    return out;
  }
  walkXml(xml, {
    open(name, attrs) {
      if (name !== 'Relationship') {
        return;
      }
      const id = attr(attrs, 'Id');
      const target = attr(attrs, 'Target');
      if (!id || !target) {
        return;
      }
      // An external relationship points outside the package: another workbook on
      // a share, a remote image, a DDE or OLE link. Following one would turn
      // opening a file into a network fetch, which on Windows can leak
      // credentials to whatever host it names. The preview reads the package and
      // nothing else.
      if (attr(attrs, 'TargetMode') === 'External') {
        return;
      }
      out.set(id, resolveTarget(partForRels(relsPath), target));
    },
  });
  return out;
}

/** The `.rels` part that describes `partPath`, whether or not it exists. */
export function relsPathFor(partPath: string): string {
  return partPath.replace(/([^/]+)$/, '_rels/$1.rels');
}

/**
 * The external relationships of one `.rels` part, id -> target exactly as
 * written (a URL, not a zip path).
 *
 * `readRels` drops these on purpose, so nothing that resolves a part can be
 * steered outside the package. A hyperlink is the one thing that legitimately
 * names an external target, and it is only ever shown as a link the reader
 * clicks, never fetched; this exists for that and for nothing else, and the
 * caller must filter the scheme before it becomes an href.
 */
export function readExternalRels(parts: Parts, relsPath: string): Map<string, string> {
  const out = new Map<string, string>();
  const xml = partText(parts, relsPath);
  if (xml === undefined) {
    return out;
  }
  walkXml(xml, {
    open(name, attrs) {
      if (name !== 'Relationship' || attr(attrs, 'TargetMode') !== 'External') {
        return;
      }
      const id = attr(attrs, 'Id');
      const target = attr(attrs, 'Target');
      if (id && target) {
        out.set(id, target);
      }
    },
  });
  return out;
}
