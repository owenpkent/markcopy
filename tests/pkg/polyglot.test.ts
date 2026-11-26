// @vitest-environment node
//
// A file with the structure of more than one format: the first in the probe
// table is read, the others are named in a notice, and the first other format
// that has a reader is read too, under its own heading.
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import { findZipEnd, hasPdfHeader, looksLikePe } from '../../src/binary/signatures';
import { readPackage, renderPackageHtml, type PackageInfo } from '../../src/pkg';
import { buildPe } from '../pe/fixture';
import { buildElf } from './elfFixture';
import { buildMsi } from './msiFixture';
import { buildRpm } from './rpmFixture';
import { buildZip } from './zipFixture';

const read = (bytes: Uint8Array, name = 'file.bin'): Promise<PackageInfo> =>
  readPackage(bytesSource(bytes), name);
const zip = (prefix?: Uint8Array, comment?: string): Uint8Array =>
  buildZip([{ name: 'a.txt', data: 'hello' }], { prefix, comment });
const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const page = (info: PackageInfo): string =>
  renderPackageHtml(info, { fileName: 'file.bin', fileSize: 1 });
const KOLY = 'koly' + 'x'.repeat(508);
const reader = (bytes: Uint8Array) => new RangeReader(bytesSource(bytes));

describe('a file that is two formats', () => {
  it('reads an MSI with a zip behind it as an MSI, names the zip and reads it too', async () => {
    const info = await read(join(buildMsi(), zip()));
    expect(info.format).toBe('Windows Installer package');
    expect(info.also?.matches).toEqual([
      { format: 'zip archive', fact: 'its central directory ends at the end of the file' },
    ]);
    expect(info.also?.info?.format).toMatch(/zip/i);
    const html = page(info);
    expect(html).toContain(
      'This file has the structure of two formats: Windows Installer package and zip archive. Both readings are shown below.',
    );
    expect(html).toContain('Also read as: zip archive');
    expect(html).toContain('its central directory ends at the end of the file');
    expect(html.indexOf('mc-info-alert')).toBeLessThan(html.indexOf('Also read as'));
  });

  it('does the same for an RPM', async () => {
    const info = await read(join(buildRpm(), zip()));
    expect(info.format).toMatch(/RPM/);
    expect(info.also?.matches.map((m) => m.format)).toEqual(['zip archive']);
    expect(info.also?.info).toBeDefined();
  });

  it('finds an end-of-directory record behind the longest comment', async () => {
    const info = await read(join(buildMsi(), zip(undefined, 'c'.repeat(65535))));
    expect(info.also?.matches.map((m) => m.format)).toEqual(['zip archive']);
  });

  it('does not match a zip whose end record is cut short', async () => {
    const bytes = join(buildMsi(), zip());
    const info = await read(bytes.subarray(0, bytes.length - 5));
    expect(info.also).toBeUndefined();
  });

  it('does not match a record whose comment runs past the file', async () => {
    const bytes = join(buildMsi(), zip(undefined, 'abc'));
    const info = await read(bytes.subarray(0, bytes.length - 1));
    expect(info.also).toBeUndefined();
  });

  it('keeps the existing order: a zip with a disk image trailer is read as a zip', async () => {
    const info = await read(join(zip(), new TextEncoder().encode(KOLY)), 'x.zip');
    expect(info.format).toMatch(/zip/i);
    expect(info.also?.matches.map((m) => m.format)).toEqual(['disk image']);
    expect(info.also?.read).toBe('disk image');
    expect(page(info)).toContain('Also read as: disk image');
  });

  it('names a PDF header in a zip, which has no reader to show', async () => {
    const info = await read(buildZip([{ name: 'x%PDF-1.4', data: 'hello' }]));
    expect(info.also?.matches.map((m) => m.format)).toEqual(['PDF document']);
    expect(info.also?.info).toBeUndefined();
    expect(page(info)).toContain('structure of two formats: zip archive and PDF document.');
    expect(page(info)).not.toContain('Both readings');
  });

  it('reads one extra format only when three match, and says so', async () => {
    const info = await read(zip(buildElf(), KOLY));
    expect(info.format).toMatch(/^(?:ELF|Linux|AppImage)/);
    expect(info.also?.matches.map((m) => m.format)).toEqual(['zip archive', 'disk image']);
    expect(info.also?.read).toBe('zip archive');
    const html = page(info);
    expect(html).toContain('three formats: ELF file, zip archive and disk image.');
    expect(html).toContain('Only one other format, zip archive, is read below.');
    expect(html).not.toContain('Also read as: disk image');
  });

  it('says nothing of intent', async () => {
    const html = page(await read(join(buildMsi(), zip())));
    expect(html).not.toMatch(/malicious|suspicious|hidden|disguis/i);
  });
});

describe('a file with one structure', () => {
  it.each([
    ['an MSI', buildMsi()],
    ['an RPM', buildRpm()],
    ['a zip', zip()],
    ['an ELF file', buildElf()],
  ])('gets no notice or second reading: %s', async (_name, bytes) => {
    const info = await read(bytes);
    expect(info.also).toBeUndefined();
    expect(page(info)).not.toContain('mc-info-alert');
    expect(page(info)).not.toContain('Also read as');
  });
});

describe('the structure tests', () => {
  it('takes a PE only when e_lfanew points at PE and two zero bytes inside the file', async () => {
    const pe = buildPe();
    expect(await looksLikePe(reader(pe))).toBe(true);
    const bad = pe.slice();
    new DataView(bad.buffer).setUint32(0x3c, bad.length - 2, true);
    expect(await looksLikePe(reader(bad))).toBe(false);
    expect(await looksLikePe(reader(Uint8Array.of(0x4d, 0x5a)))).toBe(false);
  });

  it('finds a PDF header up to byte 1,024 and not beyond', () => {
    const at = (n: number): Uint8Array => {
      const b = new Uint8Array(2048);
      b.set(new TextEncoder().encode('%PDF-'), n);
      return b;
    };
    expect(hasPdfHeader(at(1019))).toBe(true);
    expect(hasPdfHeader(at(1020))).toBe(false);
  });

  it('puts the central directory inside the data it is asked about', async () => {
    const end = await findZipEnd(reader(zip(new Uint8Array(1000))));
    expect(end?.directoryStart).toBeGreaterThanOrEqual(1000);
  });

  it('does not match a stray record with no directory in front of it', async () => {
    const stray = new Uint8Array(82);
    new DataView(stray.buffer).setUint32(60, 0x06054b50, true);
    new DataView(stray.buffer).setUint32(60 + 12, 30, true);
    expect(await findZipEnd(reader(stray))).toBeUndefined();
  });
});
