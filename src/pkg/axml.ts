// Android binary XML (AXML): the form an APK's AndroidManifest.xml is stored in.
//
// A chunked, little-endian format: a file header, a string pool, a table of
// resource IDs for the attributes, then start and end chunks for namespaces
// and elements. Release builds often strip attribute names from the string
// pool and leave only the resource ID, so names are recovered from the ID.
//
// The input is untrusted: every chunk size, string offset and count is checked
// against the bytes in hand, and the loops that follow file-supplied structure
// have named caps.
import { printable } from '../binary/text';
import { PackageError } from './model';
import { parseXmlBounded } from '../binary/xml';
import type { XNode } from '../ooxml/xnode';
import { localName } from '../ooxml/xml';

/** One element with its attributes keyed by local name, whichever namespace they were in. */
export interface ManifestNode {
  name: string;
  attrs: Record<string, string>;
  children: ManifestNode[];
}

const CHUNK_HEADER = 0x0003;
const CHUNK_STRING_POOL = 0x0001;
const CHUNK_RESOURCE_MAP = 0x0180;
const CHUNK_START_ELEMENT = 0x0102;
const CHUNK_END_ELEMENT = 0x0103;

// A manifest has dozens to a few thousand strings; this bounds the offset table.
const MAX_STRINGS = 50_000;
// Characters kept across the whole pool. Strings are decoded lazily and each
// offset once, so this is what a hostile pool of long distinct strings can cost.
const MAX_POOL_CHARS = 1024 * 1024;
// Attributes kept across the whole tree (elements times attributes would
// otherwise multiply).
const MAX_TOTAL_ATTRIBUTES = 200_000;
// Every attribute value shown is cut here; a manifest holds names and numbers.
const MAX_STRING_CHARS = 4096;
// A manifest nests about five levels; this stops a pathological one from
// building a tree as deep as the file is long.
const MAX_DEPTH = 100;
const MAX_ELEMENTS = 100_000;
const MAX_ATTRIBUTES = 1000;
// Each chunk is at least 8 bytes and the walk moves forward by its size, so
// this only bounds the work on a file made of tiny chunks.
const MAX_CHUNKS = 400_000;
const NONE = 0xffffffff;

// Android's attr resource IDs (android.R.attr). Release builds name attributes
// only by these.
const ATTRIBUTE_NAMES: Record<number, string> = {
  0x01010000: 'theme',
  0x01010001: 'label',
  0x01010002: 'icon',
  0x01010003: 'name',
  0x01010006: 'permission',
  0x01010008: 'persistent',
  0x0101000b: 'sharedUserId',
  0x0101000c: 'hasCode',
  0x0101000e: 'enabled',
  0x0101000f: 'debuggable',
  0x01010010: 'exported',
  0x01010011: 'process',
  0x0101001d: 'launchMode',
  0x0101001e: 'screenOrientation',
  0x0101001f: 'configChanges',
  0x01010027: 'scheme',
  0x01010028: 'host',
  0x0101020c: 'minSdkVersion',
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
  0x01010270: 'targetSdkVersion',
  0x01010271: 'maxSdkVersion',
  0x01010272: 'testOnly',
  0x01010280: 'allowBackup',
  0x01010281: 'glEsVersion',
  0x0101028e: 'required',
  0x010102b7: 'installLocation',
  0x0101035a: 'largeHeap',
  0x010104ea: 'usesCleartextTraffic',
  0x01010527: 'networkSecurityConfig',
  0x01010572: 'compileSdkVersion',
  0x01010573: 'compileSdkVersionCodename',
  0x01010576: 'versionCodeMajor',
  0x01010603: 'requestLegacyExternalStorage',
};

/**
 * The string pool, decoded on demand.
 *
 * A pool can declare tens of thousands of strings whose offsets all point at
 * one long string, or at distinct long ones. Decoding the whole table up front
 * costs count times length, so strings are decoded when an attribute or element
 * asks for one, each offset at most once (shared by every index that names it),
 * and the characters kept across the whole pool are budgeted.
 */
class StringPool {
  private readonly byOffset = new Map<number, string>();
  private budget = MAX_POOL_CHARS;
  truncated = false;

  constructor(
    private readonly view: DataView,
    private readonly tableAt: number,
    private readonly dataAt: number,
    private readonly end: number,
    readonly count: number,
    private readonly utf8: boolean,
  ) {}

  has(index: number): boolean {
    return index < this.count;
  }

  get(index: number): string {
    if (index >= this.count) {
      return '';
    }
    const offset = this.view.getUint32(this.tableAt + index * 4, true);
    const cached = this.byOffset.get(offset);
    if (cached !== undefined) {
      return cached;
    }
    let text = '';
    if (this.budget <= 0) {
      this.truncated = true;
    } else {
      text = this.decode(this.dataAt + offset);
      this.budget -= text.length;
    }
    // Only distinct offsets are stored, and each is bounded by the budget.
    this.byOffset.set(offset, text);
    return text;
  }

  private decode(start: number): string {
    const { view, end } = this;
    let at = start;
    if (at >= end) {
      return '';
    }
    if (this.utf8) {
      // Two lengths: characters, then bytes. Each is one byte, or two with the
      // high bit of the first set.
      at += view.getUint8(at) & 0x80 ? 2 : 1;
      if (at >= end) {
        return '';
      }
      let length = view.getUint8(at++);
      if (length & 0x80) {
        if (at >= end) {
          return '';
        }
        length = ((length & 0x7f) << 8) | view.getUint8(at++);
      }
      const take = Math.max(0, Math.min(length, end - at, MAX_STRING_CHARS * 4));
      const bytes = new Uint8Array(view.buffer, view.byteOffset + at, take);
      return printable(new TextDecoder().decode(bytes).slice(0, MAX_STRING_CHARS));
    }
    if (at + 2 > end) {
      return '';
    }
    let length = view.getUint16(at, true);
    at += 2;
    if (length & 0x8000) {
      if (at + 2 > end) {
        return '';
      }
      length = ((length & 0x7fff) << 16) | view.getUint16(at, true);
      at += 2;
    }
    const take = Math.max(0, Math.min(length, MAX_STRING_CHARS, Math.floor((end - at) / 2)));
    const codes = new Array<number>(take);
    for (let j = 0; j < take; j++) {
      codes[j] = view.getUint16(at + j * 2, true);
    }
    return printable(String.fromCharCode(...codes));
  }
}

function stringPool(view: DataView, start: number, end: number): StringPool {
  if (start + 28 > end) {
    throw new PackageError('its AndroidManifest.xml has a damaged string table.');
  }
  const count = view.getUint32(start + 8, true);
  const flags = view.getUint32(start + 16, true);
  const stringsStart = view.getUint32(start + 20, true);
  const headerSize = view.getUint16(start + 2, true);
  if (count > MAX_STRINGS || start + headerSize + count * 4 > end || stringsStart > end - start) {
    throw new PackageError('its AndroidManifest.xml has a damaged string table.');
  }
  return new StringPool(
    view,
    start + headerSize,
    start + stringsStart,
    end,
    count,
    (flags & 0x100) !== 0,
  );
}

function typedValue(pool: StringPool, raw: number, type: number, data: number): string {
  const hex = (n: number): string => n.toString(16).padStart(8, '0');
  switch (type) {
    case 0x03:
      return pool.has(data) ? pool.get(data) : raw !== NONE ? pool.get(raw) : '';
    case 0x10:
      return String(data | 0);
    case 0x11:
      return `0x${data.toString(16)}`;
    case 0x12:
      return data !== 0 ? 'true' : 'false';
    case 0x01:
      return `@0x${hex(data)}`;
    case 0x02:
      return `?0x${hex(data)}`;
    case 0x04: {
      const scratch = new DataView(new ArrayBuffer(4));
      scratch.setUint32(0, data);
      return String(scratch.getFloat32(0));
    }
    default:
      if (type >= 0x1c && type <= 0x1f) {
        return `#${hex(data)}`;
      }
      return raw !== NONE && pool.has(raw) ? pool.get(raw) : `0x${data.toString(16)}`;
  }
}

/** Parse a binary AndroidManifest.xml into an element tree. */
export function parseAxml(bytes: Uint8Array, warnings: string[] = []): ManifestNode {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || view.getUint16(0, true) !== CHUNK_HEADER) {
    throw new PackageError('its AndroidManifest.xml is not Android binary XML.');
  }
  let pool: StringPool | undefined;
  let resourceIds: number[] = [];
  const root: ManifestNode = { name: '#root', attrs: {}, children: [] };
  const stack: ManifestNode[] = [root];
  // Elements deeper than MAX_DEPTH are walked but not kept, so the chunk
  // balance stays right without building the tree.
  let skipped = 0;
  let elements = 0;
  let attributesKept = 0;
  let pos = view.getUint16(2, true);
  if (pos < 8) {
    pos = 8;
  }
  const end = Math.min(bytes.length, view.getUint32(4, true) || bytes.length);

  for (let chunks = 0; pos + 8 <= end && chunks < MAX_CHUNKS; chunks++) {
    const type = view.getUint16(pos, true);
    const size = view.getUint32(pos + 4, true);
    if (size < 8 || pos + size > end) {
      throw new PackageError('its AndroidManifest.xml is cut short or damaged.');
    }
    const chunkEnd = pos + size;
    if (type === CHUNK_STRING_POOL) {
      pool = stringPool(view, pos, chunkEnd);
    } else if (type === CHUNK_RESOURCE_MAP) {
      const count = Math.min(Math.floor((size - 8) / 4), MAX_STRINGS);
      resourceIds = [];
      for (let i = 0; i < count; i++) {
        resourceIds.push(view.getUint32(pos + 8 + i * 4, true));
      }
    } else if (type === CHUNK_START_ELEMENT && size >= 36) {
      elements++;
      if (elements > MAX_ELEMENTS) {
        throw new PackageError('its AndroidManifest.xml has more elements than MarkCopy reads.');
      }
      if (stack.length > MAX_DEPTH) {
        skipped++;
      } else {
        const nameIndex = view.getUint32(pos + 20, true);
        const attributeStart = view.getUint16(pos + 24, true);
        const attributeSize = view.getUint16(pos + 26, true);
        const attributeCount = Math.min(view.getUint16(pos + 28, true), MAX_ATTRIBUTES);
        const node: ManifestNode = {
          name: pool?.get(nameIndex) ?? '',
          attrs: {},
          children: [],
        };
        for (
          let i = 0;
          attributeSize >= 20 && i < attributeCount && attributesKept < MAX_TOTAL_ATTRIBUTES;
          i++
        ) {
          const at = pos + 16 + attributeStart + i * attributeSize;
          if (at + 20 > chunkEnd) {
            break;
          }
          const attrName = view.getUint32(at + 4, true);
          const raw = view.getUint32(at + 8, true);
          const type = view.getUint8(at + 15);
          const data = view.getUint32(at + 16, true);
          // The resource ID is the reliable name: a release build blanks the
          // string, and a hostile one could make the string say anything.
          const id = resourceIds[attrName];
          const label =
            (id !== undefined ? ATTRIBUTE_NAMES[id] : undefined) ||
            pool?.get(attrName) ||
            (id !== undefined ? `0x${id.toString(16).padStart(8, '0')}` : `#${i}`);
          attributesKept++;
          node.attrs[label] = pool ? typedValue(pool, raw, type, data) : '';
        }
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      }
    } else if (type === CHUNK_END_ELEMENT) {
      if (skipped > 0) {
        skipped--;
      } else if (stack.length > 1) {
        stack.pop();
      }
    }
    pos = chunkEnd;
  }
  if (pool?.truncated) {
    warnings.push('The manifest has more text than MarkCopy reads, so some values are blank.');
  }
  if (attributesKept >= MAX_TOTAL_ATTRIBUTES) {
    warnings.push('The manifest has more attributes than MarkCopy reads.');
  }
  const manifest = root.children[0];
  if (!manifest) {
    throw new PackageError('its AndroidManifest.xml holds no elements.');
  }
  return manifest;
}

function fromXml(node: XNode, depth = 0): ManifestNode {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.attrs)) {
    const name = localName(key);
    if (!key.startsWith('xmlns')) {
      attrs[name] = printable(value.slice(0, MAX_STRING_CHARS));
    }
  }
  return {
    name: node.name,
    attrs,
    children: depth >= MAX_DEPTH ? [] : node.children.map((c) => fromXml(c, depth + 1)),
  };
}

/** A manifest from either form: binary XML, or the plain text some build tools leave. */
export function parseManifest(bytes: Uint8Array, warnings: string[] = []): ManifestNode {
  let at = 0;
  // A UTF-8 byte order mark, then white space, before the first angle bracket.
  while (
    at < 8 &&
    at < bytes.length &&
    (bytes[at] === 0xef || bytes[at] === 0xbb || bytes[at] === 0xbf || bytes[at] <= 0x20)
  ) {
    at++;
  }
  if (bytes[at] === 0x3c) {
    let tree: XNode;
    try {
      tree = parseXmlBounded(new TextDecoder().decode(bytes));
    } catch {
      throw new PackageError('its AndroidManifest.xml is not valid XML.');
    }
    const first = tree.children[0];
    if (!first) {
      throw new PackageError('its AndroidManifest.xml holds no elements.');
    }
    return fromXml(first);
  }
  return parseAxml(bytes, warnings);
}
