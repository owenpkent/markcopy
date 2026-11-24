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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildElf } from './pkg/elfFixture';
import { buildMsi } from './pkg/msiFixture';

// The first input byte that picks shape `index`.
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
    const dmg = shaped(pick(SHAPES.length - 1, Buffer.alloc(2000, 0x41)));
    expect(dmg.name).toMatch(/\.dmg$/);
    expect(dmg.bytes.subarray(dmg.bytes.length - 512, dmg.bytes.length - 508).toString()).toBe(
      'koly',
    );
    expect(dmg.bytes.subarray(0, 4).toString()).toBe('AAAA');
  });

  it('grows a short input to hold a disk image trailer', () => {
    const dmg = shaped(pick(SHAPES.length - 1, Buffer.alloc(10)));
    expect(dmg.bytes).toHaveLength(512);
    expect(dmg.bytes.subarray(0, 4).toString()).toBe('koly');
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
