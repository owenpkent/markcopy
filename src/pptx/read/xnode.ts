// A minimal in-memory XML tree, built once per part on top of the shared SAX
// walker in src/ooxml/xml.ts.
//
// The other OOXML readers stream because a worksheet's <sheetData> can run to
// hundreds of megabytes once inflated, and building a DOM for that would be the
// difference between previewing a large file and running the extension host
// out of memory. A slide, its layout, its master and its theme are nothing like
// that: they top out in the tens of kilobytes, and the zip guard in
// src/ooxml/zip.ts already bounds how big any one part can be before this ever
// runs. What a slide *is* is deeply and irregularly nested -- spPr inside sp
// inside grpSp inside spTree, txBody inside sp inside tc inside tr inside tbl
// -- and hand-rolling a stack machine that tracks every one of those shapes in
// a single SAX pass is far more code, and far easier to get wrong, than
// building the small tree once and walking it with ordinary recursion.
import { walkXml } from '../../ooxml/xml';

export interface XNode {
  /** Local name; the namespace prefix is already stripped by walkXml. */
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Text and CDATA that are direct children, concatenated in document order. */
  text: string;
}

export function parseXml(xml: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XNode[] = [root];
  walkXml(xml, {
    open(name, attrs) {
      const node: XNode = { name, attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    },
    text(t) {
      stack[stack.length - 1].text += t;
    },
    close() {
      // A well-formed document never closes past the root -- saxes would
      // already have thrown on whatever mismatch could cause that -- but an
      // empty stack is cheaper to guard against here than to prove impossible.
      if (stack.length > 1) {
        stack.pop();
      }
    },
  });
  return root;
}

/** The first direct child with this local name, if any. */
export function child(node: XNode, name: string): XNode | undefined {
  return node.children.find((c) => c.name === name);
}

/** Every direct child with this local name, in document order. */
export function children(node: XNode, name: string): XNode[] {
  return node.children.filter((c) => c.name === name);
}

/** Walk a chain of direct-child names, stopping at the first that is missing. */
export function deep(node: XNode | undefined, ...names: string[]): XNode | undefined {
  let cur = node;
  for (const name of names) {
    cur = cur === undefined ? undefined : child(cur, name);
  }
  return cur;
}

/** The first descendant at any depth with this local name, depth-first. */
export function findDeep(node: XNode, name: string): XNode | undefined {
  for (const c of node.children) {
    if (c.name === name) {
      return c;
    }
    const nested = findDeep(c, name);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}
