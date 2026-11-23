// Parsing XML that came out of an untrusted file into a small tree.
//
// src/ooxml/xnode.ts builds the same tree for the Office readers, whose parts
// the zip guard has already bounded. The file-information readers hand it XML
// they inflated or sliced out of a package themselves, and a tree costs far
// more than its text: an empty element is three bytes of input and about three
// hundred of objects, so a 16 MiB table of contents of `<a/>` is over a
// gigabyte of tree. This is the same walk with a budget on the two things an
// attacker controls for free: how many nodes, and how deep.
import { walkXml } from '../ooxml/xml';
import type { XNode } from '../ooxml/xnode';
import { ReadError } from './reader';

export interface XmlLimits {
  /** Elements in the whole document. */
  maxNodes: number;
  /** Nesting. The tree is walked recursively, so this is also what keeps a walk off the end of the stack. */
  maxDepth: number;
  /** Characters of the document itself, checked before any of it is parsed. */
  maxChars: number;
}

// A real installer's table of contents or a manifest has a few thousand
// elements, a handful deep. These are far past anything legitimate and keep
// the tree to tens of megabytes.
export const DEFAULT_XML_LIMITS: XmlLimits = {
  maxNodes: 100_000,
  maxDepth: 128,
  maxChars: 16 * 1024 * 1024,
};

/**
 * The document as a tree, or a ReadError when it is larger than a real one is.
 * Malformed XML throws whatever the underlying parser throws, as parseXml does.
 */
export function parseXmlBounded(xml: string, limits: Partial<XmlLimits> = {}): XNode {
  const { maxNodes, maxDepth, maxChars } = { ...DEFAULT_XML_LIMITS, ...limits };
  if (xml.length > maxChars) {
    throw new ReadError('its XML is larger than MarkCopy will read.');
  }
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XNode[] = [root];
  let nodes = 0;
  walkXml(xml, {
    open(name, attrs) {
      if (++nodes > maxNodes) {
        throw new ReadError('its XML has more elements than MarkCopy will read.');
      }
      if (stack.length > maxDepth) {
        throw new ReadError('its XML is nested more deeply than MarkCopy will read.');
      }
      const node: XNode = { name, attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    },
    text(t) {
      stack[stack.length - 1].text += t;
    },
    close() {
      if (stack.length > 1) {
        stack.pop();
      }
    },
  });
  return root;
}
