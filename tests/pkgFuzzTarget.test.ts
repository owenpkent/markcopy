import { describe, expect, it } from 'vitest';
import {
  fuzz,
  MAX_HEAP_GROWTH,
  MAX_HTML_CHARS,
  MAX_MILLISECONDS,
  PKG_FORMATS,
  shapeFor,
  shaped,
  SHAPES,
} from '../fuzz/targets/pkg.fuzz';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytesSource } from '../src/binary/reader';
import { readPackage } from '../src/pkg';
import { buildElf } from './pkg/elfFixture';
import { buildMsi } from './pkg/msiFixture';

// The first input byte that picks shape `index`.
const DMG = SHAPES.findIndex((s) => s.format === 'dmg');
const CORPUS = join(__dirname, '../fuzz/corpus/pkg');
const seeds = (format: string): string[] =>
  readdirSync(CORPUS).filter((f) => f.startsWith(`${format}-`) && f.endsWith('.seed'));
const pick = (index: number, rest: Buffer): Buffer => Buffer.concat([Buffer.of(index), rest]);

describe('pkg fuzz target', () => {
  it('accepts real files, junk, and an empty input without throwing', async () => {
    await fuzz(Buffer.from(buildElf()));
    await fuzz(Buffer.from(buildMsi()));
    await fuzz(Buffer.alloc(0));
    await fuzz(Buffer.alloc(4096, 0x41));
    await fuzz(Buffer.alloc(4096, 0xff));
  });

  it('accepts every shape over zeros and over 0xff', async () => {
    for (let i = 0; i < SHAPES.length; i++) {
      await fuzz(pick(i, Buffer.alloc(2048, 0)));
      await fuzz(pick(i, Buffer.alloc(2048, 0xff)));
      await fuzz(pick(i, Buffer.alloc(3)));
    }
  });

  it('writes the chosen magic over the start of the file and names it to match', () => {
    const rest = Buffer.alloc(100, 0x41);
    const elf = shaped(pick(0, rest));
    expect([...elf.bytes.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    expect(elf.bytes).toHaveLength(100);
    expect(elf.name).toMatch(/\.so$/);

    const gzip = shaped(pick(11, rest));
    expect([...gzip.bytes.subarray(0, 3)]).toEqual([0x1f, 0x8b, 0x08]);
    expect(gzip.name).toMatch(/\.apk$/);
  });

  it('pads an input shorter than the magic, rather than dropping the magic', () => {
    const deb = shaped(pick(2, Buffer.alloc(2)));
    expect(deb.bytes.subarray(0, 8).toString('latin1')).toBe('!<arch>\n');
  });

  it('wraps the index around the shapes', () => {
    const wrapped = shaped(pick(SHAPES.length + 1, Buffer.alloc(64)));
    expect(wrapped.name).toBe(SHAPES[1].name);
  });

  it('writes the disk image trailer over the last 512 bytes', () => {
    const dmg = shaped(pick(DMG, Buffer.alloc(2000, 0x41)));
    expect(dmg.name).toMatch(/\.dmg$/);
    expect(dmg.bytes.subarray(dmg.bytes.length - 512, dmg.bytes.length - 508).toString()).toBe(
      'koly',
    );
    expect(dmg.bytes.subarray(0, 4).toString()).toBe('AAAA');
  });

  it('grows a short input to hold a disk image trailer', () => {
    const dmg = shaped(pick(DMG, Buffer.alloc(10)));
    expect(dmg.bytes).toHaveLength(512);
    expect(dmg.bytes.subarray(0, 4).toString()).toBe('koly');
  });

  // A committed seed names its shape by index, so a shape inserted before an
  // existing one silently turns every seed after it into another format.
  it('keeps every committed seed on the shape of its own format', () => {
    for (const format of PKG_FORMATS) {
      expect(seeds(format).length, format).toBeGreaterThan(0);
      for (const file of seeds(format)) {
        const choice = readFileSync(join(CORPUS, file))[0];
        expect(SHAPES[choice % SHAPES.length].format, file).toBe(format);
      }
    }
    for (const file of seeds('dmg')) {
      expect(shapeFor(readFileSync(join(CORPUS, file))[0]).trailer, file).toBe(true);
    }
    expect(DMG).toBe(12);
  });

  it('reaches the thin reader and the universal reader through shaped()', async () => {
    const thin = readFileSync(join(CORPUS, 'macho-default.seed'));
    const universal = readFileSync(join(CORPUS, 'macho-universal.seed'));
    const thinFile = shaped(thin);
    const fatFile = shaped(universal);
    expect((await readPackage(bytesSource(thinFile.bytes), thinFile.name)).format).toMatch(
      /^Mach-O dynamic library/,
    );
    const fat = await readPackage(bytesSource(fatFile.bytes), fatFile.name);
    expect(fat.format).toMatch(/^Universal binary \(x86_64, ppc\)/);
    // The macho variant keeps both: a seed's own shape is inside the format.
    expect(shaped(universal, 'macho').name).toBe(fatFile.name);
    expect(shaped(thin, 'macho').name).toBe(thinFile.name);
    // Any other choice inside the variant still lands on one of its two shapes.
    for (let choice = 0; choice < 256; choice++) {
      expect(shapeFor(choice, 'macho').format).toBe('macho');
    }
  });

  it('keeps a plausible architecture count and repairs an implausible one', () => {
    const fat = SHAPES.findIndex((s) => s.name === 'fuzz.universal');
    const count = (input: Buffer): number => shaped(pick(fat, input)).bytes.readUInt32BE(4);
    expect(count(Buffer.alloc(40))).toBe(1);
    expect(count(Buffer.alloc(3))).toBe(1);
    expect(count(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 3]))).toBe(3);
    expect(count(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0xff, 0xff, 0xff, 0xff]))).toBe(1);
  });

  it('leaves an empty input alone', () => {
    expect(shaped(Buffer.alloc(0)).bytes).toHaveLength(0);
  });
});

// The target fails an input that costs too much, not only one that throws: a
// reader that spends a gigabyte and returns a small page throws nothing.
describe('pkg fuzz target: cost limits', () => {
  it('has limits a real file is nowhere near', async () => {
    expect(MAX_MILLISECONDS).toBeGreaterThanOrEqual(1000);
    expect(MAX_HTML_CHARS).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(MAX_HEAP_GROWTH).toBeLessThanOrEqual(512 * 1024 * 1024);
    const started = performance.now();
    await fuzz(Buffer.from(buildMsi()));
    await fuzz(Buffer.from(buildElf()));
    expect(performance.now() - started).toBeLessThan(MAX_MILLISECONDS);
  });

  it('narrows to one format for a variant, keeping a choice already inside it', () => {
    const msi = SHAPES.findIndex((s) => s.format === 'msi');
    expect(shapeFor(msi, 'msi')).toBe(SHAPES[msi]);
    for (let choice = 0; choice < 256; choice++) {
      expect(shapeFor(choice, 'zip').format).toBe('zip');
      expect(shapeFor(choice, undefined)).toBe(SHAPES[choice % SHAPES.length]);
    }
    expect(shaped(Buffer.of(0, 1, 2, 3), 'rpm').name).toBe('fuzz.rpm');
  });

  it('lists the same formats fuzz/run.js and the nightly matrix offer as pkg-<format>', () => {
    const run = readFileSync(join(__dirname, '../fuzz/run.js'), 'utf8');
    const listed = /formats: \[('elf'[^\]]*)\]/
      .exec(run)?.[1]
      .split(',')
      .map((f) => f.trim().slice(1, -1));
    expect(listed).toEqual(PKG_FORMATS);
    const nightly = readFileSync(join(__dirname, '../.github/workflows/fuzz.yml'), 'utf8');
    for (const format of PKG_FORMATS) {
      expect(nightly).toMatch(new RegExp(`\\bpkg-${format}\\b`));
    }
  });
});
