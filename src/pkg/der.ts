// A small, bounded reader for DER and BER, for the key-file labels. It decodes
// tag, length and nesting and nothing else: no signature is checked and no key
// is parsed. Definite lengths and the indefinite form that some PKCS#12
// writers use are both read; a limit on depth and on the number of nodes
// bounds a hostile file.
import { Undetermined } from './labels';

const MAX_DEPTH = 12;
const MAX_NODES = 20000;
const MAX_OCTETS = 8 * 1024 * 1024;

export interface DerNode {
  tag: number;
  constructed: boolean;
  /** Content start and end, in the buffer. */
  start: number;
  end: number;
  /** Where the next sibling starts. */
  next: number;
  /** The children of an indefinite-length node, found while its end was. */
  kids?: DerNode[];
}

export class Der {
  private nodes = 0;
  constructor(readonly bytes: Uint8Array) {}

  /** The node at `at`, which must end by `limit`. */
  read(at: number, limit = this.bytes.length, depth = 0): DerNode {
    if (++this.nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new Undetermined('the structure is too large');
    }
    const b = this.bytes;
    if (at + 2 > limit) {
      throw new Undetermined('the data ends early');
    }
    const tagByte = b[at];
    if ((tagByte & 0x1f) === 0x1f) {
      throw new Undetermined('a high tag number');
    }
    const constructed = (tagByte & 0x20) !== 0;
    let pos = at + 1;
    const first = b[pos++];
    if (first === 0x80) {
      if (!constructed) {
        throw new Undetermined('an indefinite length on a primitive');
      }
      const start = pos;
      const kids: DerNode[] = [];
      while (true) {
        if (pos + 2 > limit) {
          throw new Undetermined('the data ends early');
        }
        if (b[pos] === 0 && b[pos + 1] === 0) {
          return { tag: tagByte, constructed, start, end: pos, next: pos + 2, kids };
        }
        const kid = this.read(pos, limit, depth + 1);
        kids.push(kid);
        pos = kid.next;
      }
    }
    let length = first;
    if (first & 0x80) {
      const n = first & 0x7f;
      if (n > 4 || pos + n > limit) {
        throw new Undetermined('a length is out of range');
      }
      length = 0;
      for (let i = 0; i < n; i++) {
        length = length * 256 + b[pos++];
      }
    }
    if (pos + length > limit) {
      throw new Undetermined('the data ends early');
    }
    return { tag: tagByte, constructed, start: pos, end: pos + length, next: pos + length };
  }

  /** The children of a constructed node, at most `max`. */
  children(node: DerNode, max = 64): DerNode[] {
    if (node.kids) {
      return node.kids.slice(0, max);
    }
    const out: DerNode[] = [];
    let pos = node.start;
    while (pos < node.end && out.length < max) {
      const kid = this.read(pos, node.end, 1);
      out.push(kid);
      pos = kid.next;
    }
    return out;
  }

  /** The dotted form of an OBJECT IDENTIFIER node. */
  oid(node: DerNode | undefined): string {
    if (!node || node.tag !== 0x06 || node.end - node.start < 1 || node.end - node.start > 32) {
      throw new Undetermined('not an object identifier');
    }
    const parts: number[] = [];
    let value = 0;
    for (let i = node.start; i < node.end; i++) {
      value = value * 128 + (this.bytes[i] & 0x7f);
      if ((this.bytes[i] & 0x80) === 0) {
        if (parts.length === 0) {
          const first = Math.min(2, Math.floor(value / 40));
          parts.push(first, value - first * 40);
        } else {
          parts.push(value);
        }
        value = 0;
      }
      if (value > 2 ** 40) {
        throw new Undetermined('an arc is out of range');
      }
    }
    return parts.join('.');
  }

  /** A small non-negative INTEGER, or undefined when it is larger than 2^48 or negative. */
  int(node: DerNode | undefined): number | undefined {
    if (!node || node.tag !== 0x02 || node.end - node.start < 1 || node.end - node.start > 7) {
      return undefined;
    }
    if (this.bytes[node.start] & 0x80) {
      return undefined;
    }
    let value = 0;
    for (let i = node.start; i < node.end; i++) {
      value = value * 256 + this.bytes[i];
    }
    return value;
  }

  /** The bytes of an OCTET STRING, joining the chunks of the constructed form. */
  octets(node: DerNode | undefined, depth = 0): Uint8Array {
    if (depth > 4 || !node || (node.tag & 0xdf) !== 0x04) {
      throw new Undetermined('not an octet string');
    }
    if (!node.constructed) {
      return this.bytes.subarray(node.start, node.end);
    }
    const chunks = this.children(node, 4096).map((k) => this.octets(k, depth + 1));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total > MAX_OCTETS) {
      throw new Undetermined('the data is too large');
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}
