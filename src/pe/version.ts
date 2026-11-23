// The version resource (VS_VERSIONINFO): the block Explorer's Details tab reads.
//
// It is a tree of length-prefixed nodes with UTF-16 keys, each padded to a
// 32-bit boundary. The root carries a fixed binary record (the numeric file
// and product versions); under it, StringFileInfo holds one table of named
// strings per language, and VarFileInfo lists those languages.

import { printable } from '../binary/text';

export interface VersionInfo {
  /** The numeric versions from the fixed record, as "a.b.c.d". */
  fileVersion?: string;
  productVersion?: string;
  /** DEBUG, PRERELEASE and the like, when the fixed record sets them. */
  flags: string[];
  /** Language and code page of the string table shown, as "0409 / 04B0". */
  language?: string;
  /** The named strings of the first language's table, in file order. */
  strings: [string, string][];
}

interface Node {
  key: string;
  valueOffset: number;
  valueLength: number;
  end: number;
}

const MAX_STRINGS = 64;
const MAX_VALUE = 2048;

const align = (n: number): number => (n + 3) & ~3;

function nodeAt(view: DataView, offset: number, limit: number): Node | undefined {
  if (offset + 6 > limit) {
    return undefined;
  }
  const length = view.getUint16(offset, true);
  if (length < 6) {
    return undefined;
  }
  const end = Math.min(offset + length, limit);
  let at = offset + 6;
  let key = '';
  for (;;) {
    if (at + 2 > end || key.length > 64) {
      return undefined;
    }
    const unit = view.getUint16(at, true);
    at += 2;
    if (unit === 0) {
      break;
    }
    key += String.fromCharCode(unit);
  }
  return { key, valueOffset: align(at), valueLength: view.getUint16(offset + 2, true), end };
}

function* children(view: DataView, start: number, limit: number): Generator<Node> {
  let at = start;
  for (let i = 0; i < 256; i++) {
    const node = nodeAt(view, at, limit);
    if (!node) {
      return;
    }
    yield node;
    at = align(node.end);
  }
}

// A string's declared value length is in characters in a correct file and in
// bytes in files from several widely used resource compilers, so it is not
// trusted either way: the text runs to its NUL or to the end of its node.
function textAt(view: DataView, node: Node): string {
  let text = '';
  for (let at = node.valueOffset; at + 2 <= node.end && text.length < MAX_VALUE; at += 2) {
    const unit = view.getUint16(at, true);
    if (unit === 0) {
      break;
    }
    text += String.fromCharCode(unit);
  }
  return printable(text, true).trim();
}

const FLAGS: [number, string][] = [
  [0x01, 'Debug build'],
  [0x02, 'Prerelease'],
  [0x04, 'Patched'],
  [0x08, 'Private build'],
  [0x20, 'Special build'],
];

export function readVersionResource(bytes: Uint8Array): VersionInfo | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const root = nodeAt(view, 0, bytes.length);
  if (!root || root.key !== 'VS_VERSION_INFO') {
    return undefined;
  }
  const info: VersionInfo = { flags: [], strings: [] };
  const fixed = root.valueOffset;
  if (
    root.valueLength >= 52 &&
    fixed + 52 <= root.end &&
    view.getUint32(fixed, true) === 0xfeef04bd
  ) {
    const quad = (at: number): string => {
      const high = view.getUint32(at, true);
      const low = view.getUint32(at + 4, true);
      return `${high >>> 16}.${high & 0xffff}.${low >>> 16}.${low & 0xffff}`;
    };
    info.fileVersion = quad(fixed + 8);
    info.productVersion = quad(fixed + 16);
    const set = view.getUint32(fixed + 28, true) & view.getUint32(fixed + 24, true);
    info.flags = FLAGS.filter(([bit]) => set & bit).map(([, label]) => label);
  }
  for (const block of children(view, align(fixed + root.valueLength), root.end)) {
    if (block.key !== 'StringFileInfo' || info.strings.length > 0) {
      continue;
    }
    for (const table of children(view, block.valueOffset, block.end)) {
      if (/^[0-9a-f]{8}$/i.test(table.key)) {
        info.language = `${table.key.slice(0, 4)} / ${table.key.slice(4)}`.toUpperCase();
      }
      for (const entry of children(view, table.valueOffset, table.end)) {
        if (info.strings.length >= MAX_STRINGS) {
          break;
        }
        const value = textAt(view, entry);
        if (entry.key && value) {
          info.strings.push([entry.key, value]);
        }
      }
      // One language is what the preview shows; a second table repeats the
      // same keys in another tongue.
      break;
    }
  }
  return info.fileVersion || info.strings.length > 0 ? info : undefined;
}
