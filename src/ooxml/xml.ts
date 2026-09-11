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
 * Relationship ids in particular are namespaced (`r:id`), and the prefix is only
 * conventional, so a plain `attrs['r:id']` misses the workbooks that bind it to
 * something else.
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
