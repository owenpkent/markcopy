// @vitest-environment node
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import type { PackageInfo, PropertySection, TableSection } from '../../src/pkg/model';
import { readRpm } from '../../src/pkg/rpm';
import { CpioWalker, MAX_MEMBER_NAME } from '../../src/pkg/rpmPayload';
import { buildRpm, int32, str, type RpmFile, type Tag } from './rpmFixture';

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
const hex = (n: number): string => n.toString(16).toUpperCase().padStart(8, '0');
const pad = (n: number): number => (4 - (n % 4)) % 4;

/** One newc member: 110-byte header, NUL-terminated name padded to 4, data padded to 4. */
function member(name: string, data = '', magic = '070701', namesize?: number): Uint8Array {
  const nameBytes = ascii(`${name}\0`);
  const body = ascii(data);
  const fields = [
    1,
    0o100644,
    0,
    0,
    1,
    0,
    body.length,
    0,
    0,
    0,
    0,
    namesize ?? nameBytes.length,
    0,
  ];
  const header = `${magic}${fields.map(hex).join('')}`;
  const nameAt = 110 + nameBytes.length + pad(110 + nameBytes.length);
  const out = new Uint8Array(nameAt + body.length + pad(body.length));
  out.set(ascii(header), 0);
  out.set(nameBytes, 110);
  out.set(body, nameAt);
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Members with data of 1, 4, 7 ... bytes, so every padding length occurs. */
const cpio = (names: string[], trailer = true): Uint8Array =>
  concat(
    ...names.map((n, i) => member(n, 'x'.repeat(i * 3 + 1))),
    ...(trailer ? [member('TRAILER!!!')] : []),
  );

/** A zstd frame made of raw blocks, which any decoder accepts. */
function zstdRaw(data: Uint8Array): Uint8Array {
  // Frame header: single segment, 4-byte content size.
  const head = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0, 0, 0, 0]);
  new DataView(head.buffer).setUint32(5, data.length, true);
  const MAX = 128 * 1024;
  const blocks: Uint8Array[] = [head];
  for (let at = 0; at === 0 || at < data.length; at += MAX) {
    const piece = data.subarray(at, at + MAX);
    const word = (piece.length << 3) | (at + MAX >= data.length ? 1 : 0);
    blocks.push(
      concat(new Uint8Array([word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff]), piece),
    );
  }
  return concat(...blocks);
}

const FILES: RpmFile[] = [
  { dir: '/usr/bin/', name: 'tree', size: 100 },
  { dir: '/usr/share/doc/', name: 'tree', size: 0, mode: 0o040755 },
  { dir: '/usr/share/doc/tree/', name: 'README', size: 12 },
  { dir: '/var/log/', name: 'tree.log', size: 0 },
];
const PATHS = ['./usr/bin/tree', './usr/share/doc/tree', './usr/share/doc/tree/README'];

const read = (bytes: Uint8Array): Promise<PackageInfo> =>
  readRpm(new RangeReader(bytesSource(bytes), { maxPages: 512, maxRead: 16 * 1024 * 1024 }));

const rpm = (payload: Uint8Array, extra: Tag[] = [], files = FILES): Uint8Array =>
  buildRpm({ files, payload, main: extra });

const row = (info: PackageInfo): string | undefined =>
  (
    info.sections.find((s) => s.heading === 'Payload contents') as PropertySection | undefined
  )?.rows.find(([l]) => l === 'Payload contents')?.[1];
const names = (info: PackageInfo, heading: string): string[] =>
  ((info.sections.find((s) => s.heading === heading) as TableSection | undefined)?.rows ?? []).map(
    (r) => r[0],
  );

// The fourth file is a %ghost (RPMFILE_GHOST), so the payload does not hold it.
const GHOST: Tag = int32(1037, 0, 0, 0, 0x40);
const GZIP = str(1125, 'gzip');
const gz = (list: string[]): Uint8Array => gzipSync(cpio(list));

describe('readRpm: payload against the file list', () => {
  it('says the payload holds the same entries, leaving %ghost entries out and saying so', async () => {
    const info = await read(rpm(gz(PATHS), [GZIP, GHOST]));
    expect(row(info)).toBe(
      'The payload holds the same 3 entries the header lists. 1 entry marked %ghost (which rpm leaves out of a payload) was not compared.',
    );
    expect(info.warnings).toEqual([]);
  });

  it('reads a zstd payload, and names with or without a leading ./', async () => {
    const payload = zstdRaw(cpio(PATHS.map((p) => p.slice(1))));
    const info = await read(rpm(payload, [GHOST]));
    expect(row(info)).toContain('The payload holds the same 3 entries');
  });

  it('counts an unmarked entry missing from the payload as listed but not in it', async () => {
    const info = await read(rpm(gz(PATHS), [GZIP]));
    expect(row(info)).toBe(
      "The payload differs from the header's file list: 1 listed are not in the payload, 0 in the payload are not listed.",
    );
    expect(names(info, 'Listed but not in the payload')).toEqual(['var/log/tree.log']);
    expect(names(info, 'In the payload but not listed')).toEqual([]);
  });

  it('compares names as stored, so a control character neither hides nor invents a difference', async () => {
    const files: RpmFile[] = [{ dir: '/usr/bin/', name: 'tool	name', size: 1 }];
    const same = await read(rpm(gz(['./usr/bin/tool	name']), [GZIP], files));
    expect(row(same)).toBe('The payload holds the same 1 entries the header lists.');
    const other = await read(rpm(gz(['./usr/bin/toolname']), [GZIP], files));
    expect(row(other)).toContain(
      '1 listed are not in the payload, 1 in the payload are not listed',
    );
    expect(names(other, 'Listed but not in the payload')).toEqual(['usr/bin/toolname']);
    expect(names(other, 'In the payload but not listed')).toEqual(['usr/bin/toolname']);
  });

  it('lists the names that differ in both directions, at most ten of each', async () => {
    const extra = Array.from({ length: 13 }, (_, i) => `./opt/extra${String(i).padStart(2, '0')}`);
    const info = await read(rpm(gz([...PATHS.slice(0, 2), ...extra]), [GZIP, GHOST]));
    expect(row(info)).toBe(
      "The payload differs from the header's file list: 1 listed are not in the payload, 13 in the payload are not listed. 1 entry marked %ghost (which rpm leaves out of a payload) was not compared.",
    );
    expect(names(info, 'Listed but not in the payload')).toEqual(['usr/share/doc/tree/README']);
    expect(names(info, 'In the payload but not listed')).toHaveLength(10);
    expect(names(info, 'In the payload but not listed')[0]).toBe('opt/extra00');
    const shown = info.sections.find((s) => s.heading === 'In the payload but not listed');
    expect((shown as TableSection).note).toBe('Showing the first 10 of 13 paths.');
  });

  it('does not call a %ghost entry found in the payload unlisted', async () => {
    const info = await read(rpm(gz([...PATHS, './var/log/tree.log']), [GZIP, GHOST]));
    expect(row(info)).toContain('The payload holds the same 3 entries');
  });

  it('says not checked for a compressor or format it does not read', async () => {
    expect(row(await read(rpm(gz(PATHS), [str(1125, 'bzip2')])))).toBe(
      'Not checked: MarkCopy does not read a bzip2 payload.',
    );
    expect(row(await read(rpm(gz(PATHS), [str(1125, 'lzma')])))).toBe(
      'Not checked: MarkCopy does not read a lzma payload.',
    );
    expect(row(await read(rpm(gz(PATHS), [GZIP, str(1124, 'xar')])))).toBe(
      'Not checked: the payload format is "xar", and MarkCopy reads only cpio.',
    );
  });

  it('says not checked for a cpio variant it does not read', async () => {
    const odd = gzipSync(member('./usr/bin/tree', '', '07070X'));
    expect(row(await read(rpm(odd, [GZIP])))).toBe(
      'Not checked: the payload\'s cpio format is "07070X", not newc or crc.',
    );
  });

  it('says not checked when the archive stops before its trailer or the data is damaged', async () => {
    expect(row(await read(rpm(gzipSync(cpio(PATHS, false)), [GZIP])))).toBe(
      'Not checked: the payload ended before the cpio trailer.',
    );
    expect(row(await read(rpm(new Uint8Array(500).fill(7), [GZIP])))).toBe(
      'Not checked: the gzip data could not be decompressed.',
    );
    expect(row(await read(rpm(new Uint8Array(500), [str(1125, 'zstd')])))).toBe(
      'Not checked: the zstd data could not be decompressed.',
    );
  });

  it('says not checked for a payload larger than it reads', async () => {
    const info = await read(rpm(new Uint8Array(17 * 1024 * 1024), [GZIP]));
    expect(row(info)).toMatch(/^Not checked: the compressed payload is .*, larger than the 16 MiB/);
  });

  it('says not checked when a member name is longer than it reads', async () => {
    const long = member('a', '', '070701', MAX_MEMBER_NAME + 1);
    expect(row(await read(rpm(gzipSync(long), [GZIP])))).toMatch(
      /^Not checked: a cpio member name is 4,097 bytes/,
    );
  });

  it('shows nothing when the header lists no files', async () => {
    expect(row(await read(rpm(gz([]), [], [])))).toBeUndefined();
  });
});

describe('CpioWalker', () => {
  it('reads the same names whatever the piece size', () => {
    const list = ['./a', './bb', './ccc', './dddd'];
    const bytes = cpio(list);
    for (const size of [1, 3, 7, 110, bytes.length]) {
      const walker = new CpioWalker();
      for (let i = 0; i < bytes.length; i += size) {
        walker.feed(bytes.subarray(i, i + size));
      }
      expect(walker.names).toEqual(list);
      expect(walker.finished).toBe(true);
    }
  });
});
