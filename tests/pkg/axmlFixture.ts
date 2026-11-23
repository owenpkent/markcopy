// Building Android binary XML (AXML) as exact bytes, from the chunk layout
// documented in AOSP's ResourceTypes.h (ResChunk_header, ResStringPool_header,
// ResXMLTree_node, ResXMLTree_attribute, Res_value), not from src/pkg/axml.ts.
//
// The string pool holds the names of attributes that carry a resource ID
// first, in order, because the resource map is indexed by string index.

export interface AxmlAttr {
  name: string;
  /** android.R.attr resource ID, which also puts the attribute in the resource map. */
  resId?: number;
  /** Namespace URI; the android one by default when a resId is given. */
  ns?: string;
  type: 'string' | 'int' | 'hex' | 'bool' | 'ref';
  value: string | number | boolean;
}

export interface AxmlElement {
  name: string;
  attrs?: AxmlAttr[];
  children?: AxmlElement[];
}

export interface AxmlOptions {
  utf8?: boolean;
  /** Blank the name strings of attributes with a resource ID, as release builds do. */
  stripNames?: boolean;
}

export const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

class Out {
  readonly parts: number[] = [];
  get length(): number {
    return this.parts.length;
  }
  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >>> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) {
      this.parts.push(b[i]);
    }
    return this;
  }
}

function chunk(type: number, headerSize: number, header: number[], body: number[]): number[] {
  const out = new Out();
  out
    .u16(type)
    .u16(headerSize)
    .u32(headerSize + body.length)
    .bytes(header)
    .bytes(body);
  return out.parts;
}

function encodeString(text: string, utf8: boolean): number[] {
  const out = new Out();
  if (utf8) {
    const bytes = new TextEncoder().encode(text);
    const length = (n: number): void => {
      if (n > 0x7f) {
        out.u8(0x80 | (n >> 8)).u8(n & 0xff);
      } else {
        out.u8(n);
      }
    };
    length(text.length);
    length(bytes.length);
    out.bytes(bytes).u8(0);
  } else {
    out.u16(text.length);
    for (let i = 0; i < text.length; i++) {
      out.u16(text.charCodeAt(i));
    }
    out.u16(0);
  }
  while (out.length % 4 !== 0) {
    out.u8(0);
  }
  return out.parts;
}

export function buildAxml(root: AxmlElement, options: AxmlOptions = {}): Uint8Array {
  const strings: string[] = [];
  const resourceIds: number[] = [];
  const index = (text: string): number => {
    let at = strings.indexOf(text);
    if (at < 0) {
      strings.push(text);
      at = strings.length - 1;
    }
    return at;
  };

  const walk = (el: AxmlElement, visit: (e: AxmlElement) => void): void => {
    visit(el);
    el.children?.forEach((c) => walk(c, visit));
  };
  // Attribute names with resource IDs come first, one string per ID.
  const idNames = new Map<number, number>();
  walk(root, (el) => {
    for (const attr of el.attrs ?? []) {
      if (attr.resId !== undefined && !idNames.has(attr.resId)) {
        strings.push(options.stripNames ? '' : attr.name);
        resourceIds.push(attr.resId);
        idNames.set(attr.resId, strings.length - 1);
      }
    }
  });
  const prefix = index('android');
  const uri = index(ANDROID_NS);

  const body = new Out();
  body.bytes(
    chunk(0x0100, 16, [1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff], new Out().u32(prefix).u32(uri).parts),
  );
  const emit = (el: AxmlElement): void => {
    const attrs = el.attrs ?? [];
    const rows = new Out();
    for (const attr of attrs) {
      const ns = attr.resId !== undefined || attr.ns ? index(attr.ns ?? ANDROID_NS) : -1;
      const name = attr.resId !== undefined ? idNames.get(attr.resId)! : index(attr.name);
      let raw = -1;
      let type = 0x03;
      let data: number;
      if (attr.type === 'string') {
        raw = index(String(attr.value));
        data = raw;
      } else if (attr.type === 'int') {
        type = 0x10;
        data = Number(attr.value) >>> 0;
      } else if (attr.type === 'hex') {
        type = 0x11;
        data = Number(attr.value) >>> 0;
      } else if (attr.type === 'bool') {
        type = 0x12;
        data = attr.value ? 0xffffffff : 0;
      } else {
        type = 0x01;
        data = Number(attr.value) >>> 0;
      }
      rows.u32(ns).u32(name).u32(raw).u16(8).u8(0).u8(type).u32(data);
    }
    const header = new Out()
      .u32(1)
      .u32(0xffffffff)
      .u32(0xffffffff)
      .u32(index(el.name))
      .u16(0x14)
      .u16(0x14)
      .u16(attrs.length)
      .u16(0)
      .u16(0)
      .u16(0);
    // The element chunk's header is 16 bytes; the rest is the body.
    const fixed = header.parts;
    body.bytes(chunk(0x0102, 16, fixed.slice(0, 8), [...fixed.slice(8), ...rows.parts]));
    el.children?.forEach(emit);
    body.bytes(
      chunk(
        0x0103,
        16,
        [1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff],
        new Out().u32(0xffffffff).u32(index(el.name)).parts,
      ),
    );
  };
  // Strings must be known before the pool is written, so emit the tree first.
  emit(root);
  body.bytes(
    chunk(0x0101, 16, [1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff], new Out().u32(prefix).u32(uri).parts),
  );

  const pool = new Out();
  const offsets = new Out();
  strings.forEach((s) => {
    offsets.u32(pool.length);
    pool.bytes(encodeString(s, options.utf8 === true));
  });
  const stringsStart = 28 + strings.length * 4;
  const poolChunk = chunk(
    0x0001,
    28,
    new Out()
      .u32(strings.length)
      .u32(0)
      .u32(options.utf8 ? 0x100 : 0)
      .u32(stringsStart)
      .u32(0).parts,
    [...offsets.parts, ...pool.parts],
  );
  const ids = new Out();
  resourceIds.forEach((id) => ids.u32(id));
  const map = chunk(0x0180, 8, [], ids.parts);

  const inner = [...poolChunk, ...map, ...body.parts];
  return Uint8Array.from(chunk(0x0003, 8, [], inner));
}

/**
 * An AXML whose string pool declares `count` strings, written by hand from the
 * same layout: string 0 is the element name "manifest", the others are
 * `chars` characters of "a". With `distinct` each string has its own data;
 * otherwise all of them share one copy, as the hostile samples did. One
 * element carries `attrs` attributes whose string values name pool entries 1..attrs.
 */
export function buildPoolBomb(options: {
  count: number;
  chars: number;
  distinct?: boolean;
  attrs?: number;
  /** Name each attribute by pool string i as well as value i, so keys are long too. */
  keysFromPool?: boolean;
  /** String pool chunks in a row before the element (default 1). */
  pools?: number;
  /** A further string pool after the element. */
  trailingPool?: boolean;
}): Uint8Array {
  const { count, chars, distinct = false, attrs = 0 } = options;
  const record = (text: string): number[] => {
    const out = new Out();
    const length = (n: number): void => {
      if (n > 0x7f) {
        out.u8(0x80 | (n >> 8)).u8(n & 0xff);
      } else {
        out.u8(n);
      }
    };
    length(text.length);
    length(text.length);
    for (const ch of text) {
      out.u8(ch.charCodeAt(0));
    }
    return out.u8(0).parts;
  };
  const data = new Out();
  const offsets = new Out();
  const name = record('manifest');
  data.bytes(name);
  const bigAt = data.length;
  const big = record('a'.repeat(chars));
  data.bytes(big);
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      offsets.u32(0);
    } else if (distinct && i > 1) {
      offsets.u32(data.length);
      data.bytes(big);
    } else {
      offsets.u32(bigAt);
    }
  }
  const poolChunk = chunk(
    0x0001,
    28,
    new Out()
      .u32(count)
      .u32(0)
      .u32(0x100)
      .u32(28 + count * 4)
      .u32(0).parts,
    [...offsets.parts, ...data.parts],
  );
  const rows = new Out();
  for (let i = 1; i <= attrs; i++) {
    rows
      .u32(0xffffffff)
      .u32(options.keysFromPool ? i : 0)
      .u32(0xffffffff)
      .u16(8)
      .u8(0)
      .u8(0x03)
      .u32(i);
  }
  const start = new Out()
    .u32(1)
    .u32(0xffffffff)
    .u32(0xffffffff)
    .u32(0)
    .u16(0x14)
    .u16(0x14)
    .u16(attrs)
    .u16(0)
    .u16(0)
    .u16(0).parts;
  const element = chunk(0x0102, 16, start.slice(0, 8), [...start.slice(8), ...rows.parts]);
  const end = chunk(
    0x0103,
    16,
    [1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff],
    new Out().u32(0xffffffff).u32(0).parts,
  );
  return Uint8Array.from(
    chunk(
      0x0003,
      8,
      [],
      [
        ...Array.from({ length: options.pools ?? 1 }, () => poolChunk).flat(),
        ...element,
        ...end,
        ...(options.trailingPool ? poolChunk : []),
      ],
    ),
  );
}
