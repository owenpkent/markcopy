// A thin pull-parsing layer over saxes, shared by the workbook readers.
//
// Streaming rather than tree-building is not a preference here. A 10 MB workbook
// inflates to hundreds of megabytes of sheet XML, and building a DOM for it is
// the difference between previewing a large file and running the extension host
// out of memory. Every reader below consumes events and keeps only what it needs.
//
// On entities: saxes resolves the five predefined XML entities and nothing else.
// Entities declared in a DTD's internal subset are parsed but never expanded
// unless the caller populates `parser.ENTITIES`, which nothing here does. That is
// what makes the classic billion-laughs expansion and XXE inert against this
// reader, structurally rather than by a check we could forget. See
// tests/xlsx/reader.test.ts, which pins it.
import { SaxesParser, type SaxesTagPlain } from 'saxes';

export interface XmlHandlers {
  /** `name` is the local name, namespace prefix already stripped. */
  open?(name: string, attrs: Record<string, string>): void;
  text?(text: string): void;
  close?(name: string): void;
}

export function walkXml(xml: string, handlers: XmlHandlers): void {
  const parser = new SaxesParser();
  parser.on('opentag', (tag: SaxesTagPlain) => {
    handlers.open?.(localName(tag.name), tag.attributes);
  });
  if (handlers.text) {
    parser.on('text', (t: string) => handlers.text?.(t));
    // CDATA carries cell text just as well as a text node does.
    parser.on('cdata', (t: string) => handlers.text?.(t));
  }
  parser.on('closetag', (tag: SaxesTagPlain) => {
    handlers.close?.(localName(tag.name));
  });
  parser.on('error', (err: Error) => {
    throw err;
  });
  parser.write(xml).close();
}

/**
 * The local part of a possibly-prefixed name.
 *
 * Readers match on local names throughout. Matching qualified names would mean
 * tracking prefix bindings, and writers vary: the same element is `<sheet>` in
 * one workbook and `<x:sheet>` in another, both legal.
 */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Look an attribute up by local name.
 *
 * This is the wrong tool for a relationship-namespaced attribute like `r:id`:
 * asking for the qualified string `'r:id'` only ever matches that literal key
 * (its local name is `'id'`, which never equals the qualified name it is
 * compared against), and asking for the bare local name `'id'` risks matching
 * an unrelated, unprefixed attribute of the same name on the same element. Use
 * relAttr for those instead.
 */
export function attr(attrs: Record<string, string>, name: string): string | undefined {
  const direct = attrs[name];
  if (direct !== undefined) {
    return direct;
  }
  for (const key of Object.keys(attrs)) {
    if (localName(key) === name) {
      return attrs[key];
    }
  }
  return undefined;
}

/**
 * Look up a relationship-namespaced attribute (conventionally `r:id`,
 * `r:embed`, and so on) by its local name, under whatever prefix the package
 * actually bound that namespace to.
 *
 * `<p:sldId id="256" r:id="rId2"/>` is the collision this exists to avoid:
 * two attributes here have the local name `id`, the slide's own and the
 * relationship's, and only the relationship one carries a namespace prefix.
 * `attr(attrs, 'id')` would happily return the slide id instead, and
 * `attr(attrs, 'r:id')` only matches the literal prefix `r:`, which a package
 * is free to bind to something else entirely (`rel:embed`, say). Matching on
 * "local name equals `name`, AND the key carries some prefix" is what makes
 * this immune to both: a bare, unprefixed `id` can never be mistaken for a
 * relationship id, under any prefix the file chooses to use.
 */
export function relAttr(attrs: Record<string, string>, name: string): string | undefined {
  for (const key of Object.keys(attrs)) {
    const colon = key.indexOf(':');
    if (colon !== -1 && key.slice(colon + 1) === name) {
      return attrs[key];
    }
  }
  return undefined;
}

/** An attribute parsed as an integer, or undefined when absent or malformed. */
export function intAttr(attrs: Record<string, string>, name: string): number | undefined {
  const raw = attr(attrs, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

/** An attribute parsed as an OOXML boolean, which may be `1`/`0` or `true`/`false`. */
export function boolAttr(attrs: Record<string, string>, name: string): boolean {
  const raw = attr(attrs, name);
  return raw === '1' || raw === 'true';
}
