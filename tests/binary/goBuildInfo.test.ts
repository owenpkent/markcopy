import { describe, expect, it } from 'vitest';
import {
  findHeader,
  GO_MODULE_ROWS,
  goModuleRows,
  goProperties,
  parseModinfo,
  readGoBuildInfo,
  stripSentinels,
  uvarint,
} from '../../src/binary/goBuildInfo';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import {
  concat,
  END,
  inlineBlock,
  MAGIC,
  modinfo,
  pointerBlock,
  SAMPLE_LINES,
  START,
  uvarintBytes,
} from './goFixture';

const RLO = String.fromCharCode(0x202e);
const LS = String.fromCharCode(0x2028);
const reader = (bytes: Uint8Array): RangeReader => new RangeReader(bytesSource(bytes));
/** Addresses are file offsets plus 0x1000, and only the first `size` bytes are mapped. */
const mapper =
  (size: number) =>
  (address: bigint): number | undefined =>
    address >= 0x1000n && address < BigInt(0x1000 + size) ? Number(address - 0x1000n) : undefined;
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('uvarint', () => {
  it('reads one and several bytes', () => {
    expect(uvarint(Uint8Array.of(0x05))).toEqual({ value: 5, length: 1 });
    expect(uvarint(Uint8Array.of(0xac, 0x02))).toEqual({ value: 300, length: 2 });
    expect(uvarint(Uint8Array.of(9, 9, 9), 2)).toEqual({ value: 9, length: 1 });
    expect(uvarintBytes(300)).toEqual(Uint8Array.of(0xac, 0x02));
  });

  it('rejects a number that runs off the end, runs past 10 bytes or overflows 64 bits', () => {
    expect(uvarint(Uint8Array.of(0x80))).toBeUndefined();
    expect(uvarint(new Uint8Array(11).fill(0x80))).toBeUndefined();
    expect(uvarint(Uint8Array.of(...new Array(10).fill(0xff), 0x01))).toBeUndefined();
    expect(uvarint(Uint8Array.of(...new Array(9).fill(0xff), 0x02))).toBeUndefined();
    expect(uvarint(Uint8Array.of(...new Array(9).fill(0xff), 0x01))?.length).toBe(10);
  });
});

describe('parseModinfo', () => {
  it('reads the package, module, dependencies, replacements and settings', () => {
    const parsed = parseModinfo(modinfo(SAMPLE_LINES));
    expect(parsed.path).toBe('example.com/app/cmd/app');
    expect(parsed.module).toEqual({ path: 'example.com/app', version: 'v1.4.0' });
    expect(parsed.deps).toEqual([
      { path: 'github.com/spf13/cobra', version: 'v1.8.0' },
      {
        path: 'golang.org/x/sys',
        version: 'v0.15.0',
        replacedBy: { path: 'example.com/fork-sys', version: 'v0.15.1' },
      },
    ]);
    expect(parsed.depTotal).toBe(2);
    expect(parsed.settings).toContainEqual(['-trimpath', 'true']);
    expect(parsed.settings).toContainEqual(['GOOS', 'linux']);
    expect(parsed.settings).toHaveLength(6);
  });

  it('strips the sentinels only when the newline sits 17 bytes from the end', () => {
    const text = bytesOf('path\tx\n');
    expect(Array.from(stripSentinels(concat(START, text, END)))).toEqual(Array.from(text));
    const plain = bytesOf('path\tmain.go and some more text here, no newline');
    expect(Array.from(stripSentinels(plain))).toEqual(Array.from(plain));
    const short = bytesOf('a\n' + 'b'.repeat(16));
    expect(short.length).toBeLessThan(33);
    expect(Array.from(stripSentinels(short))).toEqual(Array.from(short));
    expect(parseModinfo(modinfo(SAMPLE_LINES, false))).toEqual(parseModinfo(modinfo(SAMPLE_LINES)));
  });

  it('applies a replacement to the module when it follows the mod line', () => {
    const parsed = parseModinfo(
      modinfo(['mod\texample.com/app\t(devel)', '=>\t../local', 'dep\tx.org/y\tv1.0.0']),
    );
    expect(parsed.module?.replacedBy).toEqual({ path: '../local', version: '' });
    expect(parsed.deps[0].replacedBy).toBeUndefined();
  });

  it('reads quoted build keys and values', () => {
    const parsed = parseModinfo(
      modinfo([
        'build\t-ldflags="-s -w -X \\"a.b=c\\""',
        'build\t"we ird key"=v',
        'build\t"back\\\\slash"="quoted value"',
        'build\tvcs.revision=abc123',
        'build\tno-equals-sign',
        'build\t"unterminated=1',
      ]),
    );
    expect(parsed.settings).toEqual([
      ['-ldflags', '-s -w -X "a.b=c"'],
      ['we ird key', 'v'],
      ['back\\slash', 'quoted value'],
      ['vcs.revision', 'abc123'],
    ]);
  });

  it('ignores unknown lines and tolerates missing fields', () => {
    const parsed = parseModinfo(modinfo(['go\t1.22', 'weird', '', 'dep', 'path']));
    expect(parsed.depTotal).toBe(1);
    expect(parsed.deps).toEqual([{ path: '', version: '' }]);
    expect(parsed.path).toBeUndefined();
  });

  it('keeps 500 dependencies and counts them all', () => {
    const lines = Array.from({ length: 800 }, (_, i) => `dep\tx.org/m${i}\tv1.0.${i}`);
    lines.splice(600, 0, '=>\tfork.org/late\tv9');
    const parsed = parseModinfo(modinfo(lines));
    expect(parsed.deps).toHaveLength(500);
    expect(parsed.depTotal).toBe(800);
    expect(parsed.deps.every((d) => d.replacedBy === undefined)).toBe(true);
  });

  it('parses at most 2,000 lines but still counts the dependencies past them', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `dep\tx.org/m${i}\tv1`);
    lines.push('path\tlate.org/cmd', 'build\tlate=1');
    const parsed = parseModinfo(modinfo(lines));
    expect(parsed.depTotal).toBe(5000);
    expect(parsed.deps).toHaveLength(500);
    expect(parsed.path).toBeUndefined();
    expect(parsed.settings).toEqual([]);
  });

  it('keeps at most 64 build settings', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `build\tkey${i}=v`);
    expect(parseModinfo(modinfo(lines)).settings).toHaveLength(64);
  });

  it('cuts each field to 512 characters', () => {
    const long = 'a'.repeat(5000);
    const parsed = parseModinfo(
      modinfo([`path\t${long}`, `dep\t${long}\t${long}`, `build\t${long}=${long}`]),
    );
    expect(parsed.path).toHaveLength(512);
    expect(parsed.deps[0].path).toHaveLength(512);
    expect(parsed.deps[0].version).toHaveLength(512);
    expect(parsed.settings[0][0]).toHaveLength(512);
    expect(parsed.settings[0][1]).toHaveLength(512);
  });

  it('removes control and direction characters from every field', () => {
    const parsed = parseModinfo(
      modinfo([
        `path\tgood${RLO}bad\u0007`,
        `dep\texample.org/${RLO}x\u001b[31m\tv1\u0000`,
        `build\tk${RLO}=v${LS}w`,
      ]),
    );
    const all = JSON.stringify(parsed);
    expect(all).not.toContain(RLO);
    expect(all).not.toContain('\\u0007');
    expect(all).not.toContain('\\u001b');
    expect(all).not.toContain(LS);
    expect(parsed.path).toBe('goodbad');
  });
});

describe('findHeader', () => {
  it('finds the magic at a 16-byte boundary only', () => {
    const at = (offset: number): Uint8Array => {
      const bytes = new Uint8Array(128);
      bytes.set(MAGIC, offset);
      return bytes;
    };
    expect(findHeader(at(0))).toBe(0);
    expect(findHeader(at(48))).toBe(48);
    expect(findHeader(at(40))).toBeUndefined();
    expect(findHeader(new Uint8Array(10))).toBeUndefined();
  });
});

describe('readGoBuildInfo: inline strings', () => {
  const read = (bytes: Uint8Array, offset = 0) =>
    readGoBuildInfo(reader(bytes), { offset, size: bytes.length - offset }, mapper(bytes.length));

  it('reads the version and module text after the header', async () => {
    const info = await read(inlineBlock({ info: SAMPLE_LINES }));
    expect(info?.goVersion).toBe('go1.22.1');
    expect(info?.module?.path).toBe('example.com/app');
    expect(info?.depTotal).toBe(2);
    expect(info?.warnings).toEqual([]);
  });

  it('finds a block after other data, and reads big-endian and 4-byte headers', async () => {
    const bytes = concat(new Uint8Array(64).fill(7), inlineBlock({ big: true, pointerSize: 4 }));
    expect((await read(bytes))?.goVersion).toBe('go1.22.1');
  });

  it('gives nothing when there is no header, and ignores one past 64 KiB', async () => {
    expect(await read(new Uint8Array(1000))).toBeUndefined();
    const far = concat(new Uint8Array(0x10000), inlineBlock());
    expect(await read(far)).toBeUndefined();
  });

  it('accepts a binary that ends after the version', async () => {
    const whole = inlineBlock();
    const info = await read(whole.subarray(0, whole.length - 1));
    expect(info?.goVersion).toBe('go1.22.1');
    expect(info?.deps).toEqual([]);
  });

  it('refuses a pointer size other than 4 or 8', async () => {
    for (const size of [0, 1, 2, 16, 255]) {
      await expect(read(inlineBlock({ pointerSize: size }))).rejects.toThrow();
    }
  });

  it('refuses malformed varints and versions that are not versions', async () => {
    const head = inlineBlock().subarray(0, 32);
    await expect(read(concat(head, new Uint8Array(12).fill(0x80)))).rejects.toThrow();
    await expect(read(concat(head, Uint8Array.of(0x80)))).rejects.toThrow();
    await expect(read(inlineBlock({ version: 'x'.repeat(65) }))).rejects.toThrow();
    await expect(read(inlineBlock({ version: '' }))).rejects.toThrow();
  });

  it('refuses lengths that run past the end of the file', async () => {
    await expect(
      read(inlineBlock({ info: SAMPLE_LINES, declaredInfoLength: 5000 })),
    ).rejects.toThrow();
    await expect(read(inlineBlock().subarray(0, 33))).rejects.toThrow();
  });

  it('does not read module text declared longer than 256 KiB, and says so', async () => {
    const info = await read(inlineBlock({ info: SAMPLE_LINES, declaredInfoLength: 300 * 1024 }));
    expect(info?.goVersion).toBe('go1.22.1');
    expect(info?.deps).toEqual([]);
    expect(info?.warnings).toHaveLength(1);
  });

  it('cleans the version string', async () => {
    const info = await read(inlineBlock({ version: `go1.${RLO}22\u0007` }));
    expect(info?.goVersion).toBe('go1.22');
  });
});

describe('readGoBuildInfo: pointers', () => {
  const read = (spec: Parameters<typeof pointerBlock>[0], mapped?: number) => {
    const bytes = pointerBlock(spec)(0x1000);
    return readGoBuildInfo(
      reader(bytes),
      { offset: 0, size: bytes.length },
      mapper(mapped ?? bytes.length),
    );
  };

  it('follows pointers to the version and the module text', async () => {
    const info = await read({ info: SAMPLE_LINES });
    expect(info?.goVersion).toBe('go1.16.5');
    expect(info?.path).toBe('example.com/app/cmd/app');
    expect(info?.depTotal).toBe(2);
  });

  it('reads 4-byte and big-endian pointers', async () => {
    for (const spec of [{ pointerSize: 4 }, { big: true }, { big: true, pointerSize: 4 }]) {
      const info = await read({ ...spec, info: SAMPLE_LINES });
      expect(info?.goVersion).toBe('go1.16.5');
      expect(info?.settings.length).toBe(6);
    }
  });

  it('shows the version alone when there is no module text', async () => {
    const info = await read({});
    expect(info?.goVersion).toBe('go1.16.5');
    expect(info?.deps).toEqual([]);
  });

  it('refuses a pointer that maps to no file data', async () => {
    await expect(read({ info: SAMPLE_LINES }, 40)).rejects.toThrow();
  });

  it('refuses a length past the end of the file, and warns on one over the cap', async () => {
    await expect(read({ declaredInfoLength: 100000 })).rejects.toThrow();
    const info = await read({ info: SAMPLE_LINES, declaredInfoLength: 300 * 1024 });
    expect(info?.warnings).toHaveLength(1);
    expect(info?.deps).toEqual([]);
  });

  it('refuses a version pointer that is not mapped', async () => {
    const bytes = pointerBlock({})(0x1000);
    new DataView(bytes.buffer, bytes.byteOffset).setBigUint64(16, 0xdeadbeefn, true);
    await expect(
      readGoBuildInfo(reader(bytes), { offset: 0, size: bytes.length }, mapper(bytes.length)),
    ).rejects.toThrow();
  });
});

describe('rows', () => {
  it('words a replaced module', () => {
    const parsed = parseModinfo(modinfo(SAMPLE_LINES));
    const info = { goVersion: 'go1.22.1', ...parsed, warnings: [] };
    expect(goProperties(info)).toEqual([
      ['Go version', 'go1.22.1'],
      ['Package', 'example.com/app/cmd/app'],
      ['Module', 'example.com/app'],
      ['Module version', 'v1.4.0'],
    ]);
    expect(goModuleRows(info)).toEqual([
      ['github.com/spf13/cobra', 'v1.8.0'],
      ['golang.org/x/sys', 'v0.15.0, replaced by example.com/fork-sys v0.15.1'],
    ]);
    expect(GO_MODULE_ROWS).toBe(200);
  });
});
