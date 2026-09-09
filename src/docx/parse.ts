// XHTML string -> a small element tree the DOCX builder can walk.
//
// The builder needs a tree, not a stream: a table's grid width is only known
// once its widest row has been seen, and a run's formatting is the union of
// every ancestor between it and its block. Building the tree is safe here for
// the same reason it is not in the xlsx reader (src/xlsx/xml.ts): what arrives
// is one rendered preview, capped by what a person is willing to read, not an
// arbitrarily large sheet.
//
// The input is produced by XMLSerializer in the webview, so it is well-formed
// XML rather than HTML: void elements are self-closed and every attribute is
// quoted. That is the whole reason the export serializes the clone that way
// instead of handing over `innerHTML`, which a strict XML parser rejects at the
// first `<img src="...">`.
//
// walkXml is reused rather than reimplemented so this parser inherits its entity
// behavior: saxes resolves the five predefined XML entities and expands nothing
// from a DTD, which is what keeps billion-laughs and XXE inert. A second SAX
// wrapper here would quietly drop that property.
import { walkXml } from '../xlsx/xml';
import { stripInvalidXml } from './ooxml';

export interface DocxText {
  kind: 'text';
  text: string;
}

export interface DocxElement {
  kind: 'element';
  /** Lower-cased local name; XHTML carries no prefixes worth keeping. */
  name: string;
  attrs: Record<string, string>;
  children: DocxNode[];
}

export type DocxNode = DocxElement | DocxText;

export function isElement(node: DocxNode): node is DocxElement {
  return node.kind === 'element';
}

/** Parse one well-formed XML element into a tree. Throws on malformed input. */
export function parseXhtml(xhtml: string): DocxElement {
  const root: DocxElement = { kind: 'element', name: '#root', attrs: {}, children: [] };
  const stack: DocxElement[] = [root];

  walkXml(stripInvalidXml(xhtml), {
    open(name, attrs) {
      const el: DocxElement = {
        kind: 'element',
        name: name.toLowerCase(),
        attrs: lowerKeys(attrs),
        children: [],
      };
      stack[stack.length - 1].children.push(el);
      stack.push(el);
    },
    text(text) {
      if (text.length > 0) {
        stack[stack.length - 1].children.push({ kind: 'text', text });
      }
    },
    close() {
      // Never pop the synthetic root: saxes has already rejected any document
      // whose tags do not nest, so a close always has an element to match.
      if (stack.length > 1) {
        stack.pop();
      }
    },
  });

  return root;
}

function lowerKeys(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    // Strip any namespace prefix (`xml:space`, `xlink:href`): the export uses
    // none of them, and matching on the local name keeps lookups simple.
    const colon = key.indexOf(':');
    out[(colon === -1 ? key : key.slice(colon + 1)).toLowerCase()] = value;
  }
  return out;
}

/** The concatenated text of a subtree, with no formatting applied. */
export function textOf(node: DocxNode): string {
  if (node.kind === 'text') {
    return node.text;
  }
  return node.children.map(textOf).join('');
}

/** Whether `el` carries `cls` in its class attribute. */
export function hasClass(el: DocxElement, cls: string): boolean {
  const value = el.attrs.class;
  return value === undefined ? false : value.split(/\s+/).includes(cls);
}
