// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseAxml, parseManifest, type ManifestNode } from '../../src/pkg/axml';
import { PackageError } from '../../src/pkg/model';
import { buildAxml, buildPoolBomb, type AxmlElement } from './axmlFixture';

const RLO = String.fromCharCode(0x202e);

const tree: AxmlElement = {
  name: 'manifest',
  attrs: [
    { name: 'package', type: 'string', value: 'com.example.app', ns: '' },
    { name: 'versionCode', resId: 0x0101021b, type: 'int', value: 42 },
    { name: 'versionName', resId: 0x0101021c, type: 'string', value: '1.2.3' },
  ],
  children: [
    {
      name: 'application',
      attrs: [
        { name: 'label', resId: 0x01010001, type: 'ref', value: 0x7f0f0001 },
        { name: 'debuggable', resId: 0x0101000f, type: 'bool', value: true },
        { name: 'allowBackup', resId: 0x01010280, type: 'bool', value: false },
        { name: 'glEsVersion', resId: 0x01010281, type: 'hex', value: 0x30001 },
        { name: 'maxSdkVersion', resId: 0x01010271, type: 'int', value: -1 },
      ],
      children: [
        {
          name: 'activity',
          attrs: [{ name: 'name', resId: 0x01010003, type: 'string', value: '.Main' }],
        },
      ],
    },
  ],
};

const names = (node: ManifestNode): string[] => [node.name, ...node.children.flatMap(names)];

describe('parseAxml', () => {
  it.each([
    ['UTF-16', false],
    ['UTF-8', true],
  ])('reads elements, names and typed values from a %s string pool', (_label, utf8) => {
    const root = parseAxml(buildAxml(tree, { utf8 }));
    expect(root.name).toBe('manifest');
    expect(root.attrs).toMatchObject({
      package: 'com.example.app',
      versionCode: '42',
      versionName: '1.2.3',
    });
    const app = root.children[0];
    expect(app.name).toBe('application');
    expect(app.attrs.label).toBe('@0x7f0f0001');
    expect(app.attrs.debuggable).toBe('true');
    expect(app.attrs.allowBackup).toBe('false');
    expect(app.attrs.glEsVersion).toBe('0x30001');
    expect(app.attrs.maxSdkVersion).toBe('-1');
    expect(app.children[0].attrs.name).toBe('.Main');
    expect(names(root)).toEqual(['manifest', 'application', 'activity']);
  });

  it('recovers attribute names from resource IDs when the pool has blanked them', () => {
    const root = parseAxml(buildAxml(tree, { stripNames: true }));
    expect(root.attrs.versionCode).toBe('42');
    expect(root.attrs.versionName).toBe('1.2.3');
    expect(root.children[0].attrs.debuggable).toBe('true');
  });

  it('names an unknown resource ID by the ID', () => {
    const root = parseAxml(
      buildAxml(
        { name: 'a', attrs: [{ name: 'x', resId: 0x01019999, type: 'int', value: 1 }] },
        { stripNames: true },
      ),
    );
    expect(root.attrs['0x01019999']).toBe('1');
  });

  it('reads a long UTF-8 string with a two-byte length', () => {
    const long = 'é'.repeat(300);
    const root = parseAxml(
      buildAxml(
        { name: 'a', attrs: [{ name: 'n', type: 'string', value: long, ns: '' }] },
        { utf8: true },
      ),
    );
    expect(root.attrs.n).toBe(long);
  });

  it('cuts a very long string', () => {
    const root = parseAxml(
      buildAxml({
        name: 'a',
        attrs: [{ name: 'n', type: 'string', value: 'x'.repeat(9000), ns: '' }],
      }),
    );
    expect(root.attrs.n.length).toBe(4096);
  });

  it('strips control and direction characters from strings', () => {
    const root = parseAxml(
      buildAxml({
        name: 'a',
        attrs: [{ name: 'n', type: 'string', value: `a${RLO}b\u0007c`, ns: '' }],
      }),
    );
    expect(root.attrs.n).toBe('abc');
  });

  it('does not build a tree deeper than the cap, and stays balanced', () => {
    let deep: AxmlElement = { name: 'leaf' };
    for (let i = 0; i < 300; i++) {
      deep = { name: 'n', children: [deep] };
    }
    const root = parseAxml(buildAxml({ name: 'manifest', children: [deep, { name: 'after' }] }));
    let depth = 0;
    for (let node: ManifestNode | undefined = root.children[0]; node; node = node.children[0]) {
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(100);
    expect(root.children.map((c) => c.name)).toEqual(['n', 'after']);
  });

  it('refuses more elements than the cap', () => {
    const many: AxmlElement = {
      name: 'manifest',
      children: Array.from({ length: 100_001 }, () => ({ name: 'a' })),
    };
    expect(() => parseAxml(buildAxml(many))).toThrow(PackageError);
  });

  it('refuses a string table that claims more strings than the cap', () => {
    const bytes = buildAxml(tree);
    // The pool follows the 8-byte file header; its string count is 8 bytes into the pool chunk.
    new DataView(bytes.buffer).setUint32(8 + 8, 5_000_000, true);
    expect(() => parseAxml(bytes)).toThrow(PackageError);
  });

  it('refuses a chunk whose size runs past the file', () => {
    const bytes = buildAxml(tree);
    new DataView(bytes.buffer).setUint32(8 + 4, 0x7fffffff, true);
    expect(() => parseAxml(bytes)).toThrow(PackageError);
  });

  it('refuses data that is not binary XML', () => {
    expect(() => parseAxml(new Uint8Array(0))).toThrow(PackageError);
    expect(() => parseAxml(new TextEncoder().encode('hello there'))).toThrow(PackageError);
    expect(() => parseAxml(Uint8Array.from([3, 0, 8, 0, 8, 0, 0, 0]))).toThrow(PackageError);
  });

  it('ignores an attribute count beyond the chunk', () => {
    const bytes = buildAxml(tree);
    // Find the manifest start-element chunk (type 0x0102) and inflate its attribute count.
    const view = new DataView(bytes.buffer);
    for (let at = 8; at + 36 < bytes.length; at += 4) {
      if (view.getUint16(at, true) === 0x0102) {
        view.setUint16(at + 28, 60000, true);
        break;
      }
    }
    expect(() => parseAxml(bytes)).not.toThrow();
  });

  it('only ever throws a PackageError when cut short or corrupted', () => {
    const bytes = buildAxml(tree, { utf8: true });
    for (let n = 0; n < bytes.length; n++) {
      try {
        parseAxml(bytes.subarray(0, n));
      } catch (error) {
        expect(error).toBeInstanceOf(PackageError);
      }
    }
    for (let i = 0; i < bytes.length; i++) {
      for (const flip of [0xff, 0x80, 0x01]) {
        const copy = bytes.slice();
        copy[i] ^= flip;
        try {
          parseAxml(copy);
        } catch (error) {
          expect(error).toBeInstanceOf(PackageError);
        }
      }
    }
  });
});

describe('parseManifest', () => {
  it('reads a plain-text manifest, attributes by local name', () => {
    const root = parseManifest(
      new TextEncoder().encode(
        '﻿<?xml version="1.0"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="p.q" android:versionCode="3"><application android:label="@string/app"><activity android:name=".A"/></application></manifest>',
      ),
    );
    expect(root.attrs).toEqual({ package: 'p.q', versionCode: '3' });
    expect(root.children[0].attrs.label).toBe('@string/app');
    expect(root.children[0].children[0].attrs.name).toBe('.A');
  });

  it('dispatches binary data to the binary reader', () => {
    expect(parseManifest(buildAxml(tree)).attrs.package).toBe('com.example.app');
  });

  it('reports XML that does not parse', () => {
    expect(() => parseManifest(new TextEncoder().encode('<manifest><a>'))).toThrow(PackageError);
  });

  it('stops a text manifest at the depth cap', () => {
    const xml = `${'<a>'.repeat(120)}${'</a>'.repeat(120)}`;
    let depth = 0;
    for (
      let node: ManifestNode | undefined = parseManifest(new TextEncoder().encode(xml));
      node;
      node = node.children[0]
    ) {
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(101);
  });
});

describe('parseAxml: string pool bombs', () => {
  const heap = (): number => {
    globalThis.gc?.();
    return process.memoryUsage().heapUsed;
  };

  it('does not decode a pool of many offsets that share one long string', () => {
    // 50,000 strings, all at one 16,000-character string: decoding every one
    // used to cost count times length.
    const bytes = buildPoolBomb({ count: 50_000, chars: 16_000, attrs: 1000 });
    const before = heap();
    const warnings: string[] = [];
    const root = parseAxml(bytes, warnings);
    expect(heap() - before).toBeLessThan(64 * 1024 * 1024);
    expect(root.name).toBe('manifest');
    // The long string is decoded once and cut: every attribute shares it.
    expect(root.attrs['manifest']).toBeDefined();
    expect(root.attrs['manifest'].length).toBe(4096);
    expect(warnings).toEqual([]);
  });

  it('refuses a pool that declares more strings than the cap', () => {
    expect(() => parseAxml(buildPoolBomb({ count: 50_001, chars: 8 }))).toThrow(PackageError);
  });

  it('budgets the characters kept across distinct long strings, and says so', () => {
    // 600 distinct 4,096-character strings is 2.4 million characters, over the pool budget.
    const bytes = buildPoolBomb({ count: 700, chars: 4096, distinct: true, attrs: 600 });
    const before = heap();
    const warnings: string[] = [];
    const root = parseAxml(bytes, warnings);
    expect(heap() - before).toBeLessThan(64 * 1024 * 1024);
    expect(warnings).toContain(
      'The manifest has more text than MarkCopy reads, so some values are blank.',
    );
    // The last attribute named a string read after the budget was spent.
    expect(root.attrs['manifest']).toBe('');
  });
});

describe('parseAxml: the text budget belongs to the whole document', () => {
  const retained = (node: { attrs: Record<string, string> }): number => {
    const distinct = new Set<string>();
    for (const [key, value] of Object.entries(node.attrs)) {
      distinct.add(key);
      distinct.add(value);
    }
    return [...distinct].reduce((n, text) => n + text.length, 0);
  };

  it('refuses a second string pool instead of giving it a fresh allowance', () => {
    // Three pools of 400 distinct 4,096-character strings, as in the review: each
    // alone is under the pool budget, together they are 4.9 million characters.
    const bytes = buildPoolBomb({ count: 450, chars: 4096, distinct: true, attrs: 400, pools: 3 });
    const before = process.memoryUsage().heapUsed;
    expect(() => parseAxml(bytes)).toThrow(PackageError);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
  });

  it('refuses a string pool or resource map after the elements', () => {
    expect(() =>
      parseAxml(buildPoolBomb({ count: 4, chars: 8, attrs: 1, trailingPool: true })),
    ).toThrow(PackageError);
  });

  it('retains no more text than the budget, counting distinct strings', () => {
    const bytes = buildPoolBomb({
      count: 700,
      chars: 4096,
      distinct: true,
      attrs: 600,
      keysFromPool: true,
    });
    const warnings: string[] = [];
    const root = parseAxml(bytes, warnings);
    expect(warnings.length).toBe(1);
    expect(retained(root)).toBeLessThanOrEqual(1024 * 1024 + 1024);
  });

  it('still reads a single pool exactly as before', () => {
    const root = parseAxml(buildAxml(tree));
    expect(root.attrs.versionName).toBe('1.2.3');
  });
});

describe('parseManifest: bounded text XML', () => {
  it('rejects a text manifest nested past the XML depth bound as invalid XML', () => {
    const xml = `${'<a>'.repeat(300)}${'</a>'.repeat(300)}`;
    expect(() => parseManifest(new TextEncoder().encode(xml))).toThrow(PackageError);
  });
});

describe('parseAxml: string pool and header guards', () => {
  const u16 = (v: number): number[] => [v & 255, (v >>> 8) & 255];
  const u32 = (v: number): number[] => [...u16(v & 0xffff), ...u16(v >>> 16)];
  const NONE = 0xffffffff;

  /** A chunk of the given type and header size; `size` defaults to the real length. */
  const chunk = (type: number, headerSize: number, body: number[], size?: number): number[] => [
    ...u16(type),
    ...u16(headerSize),
    ...u32(size ?? 8 + body.length),
    ...body,
  ];
  /** A string pool whose string data is exactly `raw`, with one offset per entry in `offsets`. */
  const rawPool = (raw: number[], offsets: number[], utf8 = false): number[] =>
    chunk(0x0001, 28, [
      ...u32(offsets.length),
      ...u32(0),
      ...u32(utf8 ? 0x100 : 0),
      ...u32(28 + offsets.length * 4),
      ...u32(0),
      ...offsets.flatMap(u32),
      ...raw,
    ]);
  const utf16 = (text: string): number[] => [
    ...u16(text.length),
    ...[...text].flatMap((c) => u16(c.charCodeAt(0))),
    0,
    0,
  ];
  /** A UTF-16 pool of these strings. */
  const pool = (strings: string[]): number[] => {
    const raw: number[] = [];
    const offsets = strings.map((s) => {
      const at = raw.length;
      raw.push(...utf16(s));
      return at;
    });
    return rawPool(raw, offsets);
  };
  interface RawAttr {
    name: number;
    raw: number;
    type: number;
    data: number;
  }
  /** A start-element chunk whose name is pool string `nameIndex`. */
  const element = (nameIndex: number, attrs: RawAttr[] = []): number[] =>
    chunk(0x0102, 16, [
      ...u32(1),
      ...u32(NONE),
      ...u32(NONE),
      ...u32(nameIndex),
      ...u16(0x14),
      ...u16(0x14),
      ...u16(attrs.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...attrs.flatMap((a) => [
        ...u32(NONE),
        ...u32(a.name),
        ...u32(a.raw),
        ...u16(8),
        0,
        a.type,
        ...u32(a.data),
      ]),
    ]);
  const doc = (...chunks: number[][]): Uint8Array => {
    const body = chunks.flat();
    return Uint8Array.from(chunk(0x0003, 8, body));
  };
  /** The element name that comes out of a pool whose first string is `raw`. */
  const nameFrom = (raw: number[], utf8: boolean): string =>
    parseAxml(doc(rawPool(raw, [0], utf8), element(0))).name;

  it('decodes a good string from the same hand-built pools, as a control', () => {
    expect(nameFrom([2, 2, 0x61, 0x62], true)).toBe('ab');
    expect(nameFrom([2, 0, 0x61, 0, 0x62, 0, 0, 0], false)).toBe('ab');
  });

  it('gives an empty string for a UTF-8 offset at or past the end of the pool', () => {
    expect(parseAxml(doc(rawPool([2, 2, 0x61, 0x62], [100], true), element(0))).name).toBe('');
  });

  it('gives an empty string for a UTF-8 string cut off after its first length byte', () => {
    expect(nameFrom([0x05], true)).toBe('');
  });

  it('gives an empty string for a UTF-8 string cut off inside a two-byte byte length', () => {
    expect(nameFrom([0x01, 0x81], true)).toBe('');
  });

  it('reads only the bytes that exist when a UTF-8 length claims more', () => {
    expect(nameFrom([5, 100, 0x61, 0x62], true)).toBe('ab');
  });

  it('gives an empty string for a UTF-16 string with no room for its length', () => {
    expect(nameFrom([0x01], false)).toBe('');
  });

  it('gives an empty string for a UTF-16 string cut off inside a four-byte length', () => {
    expect(nameFrom([0x01, 0x80], false)).toBe('');
  });

  it('reads a UTF-16 string with a four-byte length', () => {
    expect(nameFrom([0x00, 0x80, 0x02, 0x00, 0x61, 0, 0x62, 0], false)).toBe('ab');
  });

  it('reads only the characters that exist when a UTF-16 length claims more', () => {
    expect(nameFrom([100, 0, 0x61, 0, 0x62, 0], false)).toBe('ab');
  });

  it('refuses a string table chunk too short to hold its own header', () => {
    const short = chunk(0x0001, 28, new Array<number>(12).fill(0), 20);
    expect(() => parseAxml(doc(short, element(0)))).toThrow('damaged string table');
  });

  it('refuses a string table whose offset array runs past its chunk', () => {
    const lying = chunk(0x0001, 28, [...u32(1000), ...u32(0), ...u32(0), ...u32(28), ...u32(0)]);
    expect(() => parseAxml(doc(lying, element(0)))).toThrow('damaged string table');
  });

  it('refuses a string table whose string data starts past its chunk', () => {
    const lying = chunk(0x0001, 28, [...u32(0), ...u32(0), ...u32(0), ...u32(0xffff), ...u32(0)]);
    expect(() => parseAxml(doc(lying, element(0)))).toThrow('damaged string table');
  });

  it('reads a file whose header size and total size fields are zero', () => {
    const bytes = buildAxml(tree);
    bytes.fill(0, 2, 4);
    bytes.fill(0, 4, 8);
    expect(parseAxml(bytes).name).toBe('manifest');
  });

  it('shows each attribute value type in its own form', () => {
    const strings = [
      'm',
      'float',
      'attr',
      'color',
      'str',
      'strRaw',
      'strNone',
      'odd',
      'oddRaw',
      's',
    ];
    const at = (name: string): number => strings.indexOf(name);
    const root = parseAxml(
      doc(
        pool(strings),
        element(0, [
          { name: at('float'), raw: NONE, type: 0x04, data: 0x3fc00000 },
          { name: at('attr'), raw: NONE, type: 0x02, data: 0x7f010001 },
          { name: at('color'), raw: NONE, type: 0x1c, data: 0xff112233 },
          { name: at('str'), raw: NONE, type: 0x03, data: at('s') },
          { name: at('strRaw'), raw: at('s'), type: 0x03, data: 999 },
          { name: at('strNone'), raw: NONE, type: 0x03, data: 999 },
          { name: at('odd'), raw: NONE, type: 0x20, data: 0x10 },
          { name: at('oddRaw'), raw: at('s'), type: 0x20, data: 0x10 },
        ]),
      ),
    );
    expect(root.attrs).toMatchObject({
      float: '1.5',
      attr: '?0x7f010001',
      color: '#ff112233',
      str: 's',
      strRaw: 's',
      strNone: '',
      odd: '0x10',
      oddRaw: 's',
    });
  });

  it('refuses a text manifest that holds a comment and no element', () => {
    const bytes = new TextEncoder().encode('<!-- nothing here -->');
    expect(() => parseManifest(bytes)).toThrow(PackageError);
  });
});
