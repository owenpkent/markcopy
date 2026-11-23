// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatBytes } from '../../src/binary/html';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import {
  PackageError,
  type PackageInfo,
  type PropertySection,
  type TableSection,
} from '../../src/pkg/model';
import { renderPackageHtml } from '../../src/pkg/render';
import { openPgpIssuer, readRpm } from '../../src/pkg/rpm';
import {
  bin,
  buildRpm,
  header,
  int32,
  int64,
  KEY_ID,
  KEY_ID_HEX,
  lead,
  pgpSignatureV3,
  pgpSignatureV4,
  str,
  strings,
  TYPE,
  type RpmSpec,
} from './rpmFixture';

const RLO = String.fromCharCode(0x202e);
const LIMITS = { maxPages: 512, maxRead: 16 * 1024 * 1024 };

const read = (bytes: Uint8Array): Promise<PackageInfo> =>
  readRpm(new RangeReader(bytesSource(bytes), LIMITS));
const readSpec = (spec: RpmSpec = {}): Promise<PackageInfo> => read(buildRpm(spec));

const properties = (info: PackageInfo, heading: string): Map<string, string> => {
  const section = info.sections.find((s) => s.heading === heading) as PropertySection | undefined;
  return new Map(section?.rows ?? []);
};
const table = (info: PackageInfo, heading: string): TableSection =>
  info.sections.find((s) => s.heading === heading) as TableSection;

describe('readRpm: identity', () => {
  it('reads every field of the package section', async () => {
    const info = await readSpec();
    expect(info.format).toBe('RPM package');
    expect(info.title).toBe('curl 1:8.5.0-2.fc40');
    expect(info.summary).toBe('A tool for transferring data');
    const pkg = properties(info, 'Package');
    expect(pkg.get('Name')).toBe('curl');
    expect(pkg.get('Epoch')).toBe('1');
    expect(pkg.get('Version')).toBe('8.5.0');
    expect(pkg.get('Release')).toBe('2.fc40');
    expect(pkg.get('Architecture')).toBe('x86_64');
    expect(pkg.get('Vendor')).toBe('Example Vendor');
    expect(pkg.get('Distribution')).toBe('Example Distribution');
    expect(pkg.get('Packager')).toBe('Example Packager');
    expect(pkg.get('License')).toBe('curl');
    expect(pkg.get('Group')).toBe('Applications/Internet');
    expect(pkg.get('URL')).toBe('https://curl.example/');
    expect(pkg.get('Installed size')).toBe(formatBytes(4096));
    expect(pkg.get('Built')).toBe('2023-11-14 22:13:20 UTC');
    expect(pkg.get('Build host')).toBe('builder.example.org');
    expect(pkg.get('Operating system')).toBe('linux');
    expect(pkg.get('Source package')).toBe('curl-8.5.0-2.fc40.src.rpm');
    expect(pkg.get('Payload format')).toBe('cpio');
    expect(pkg.get('Payload flags')).toBe('19');
    expect(pkg.get('Header SHA-256')).toBe('a'.repeat(64));
    expect(info.warnings).toEqual([]);
  });

  it('reports the compressed payload size from where the main header ends', async () => {
    const info = await readSpec({ payload: new Uint8Array(1234) });
    expect(properties(info, 'Package').get('Payload')).toBe(
      `zstd compressed, ${formatBytes(1234)}`,
    );
  });

  it('prefers LONGSIZE over SIZE for the installed size', async () => {
    const info = await readSpec({ main: [int64(5009, 5_000_000_000n)] });
    expect(properties(info, 'Package').get('Installed size')).toBe(formatBytes(5_000_000_000));
  });

  it('leaves out the epoch from the title when there is none', async () => {
    const info = await readSpec({ without: [1003] });
    expect(info.title).toBe('curl 8.5.0-2.fc40');
    expect(properties(info, 'Package').has('Epoch')).toBe(false);
  });

  it('calls a package without a source RPM, or with lead type 1, a source package', async () => {
    expect((await readSpec({ without: [1044] })).format).toBe('RPM source package');
    expect((await readSpec({ leadType: 1 })).format).toBe('RPM source package');
  });

  it('splits the description into paragraphs at blank lines', async () => {
    const section = (await readSpec()).sections.find((s) => s.heading === 'Description');
    expect(section).toEqual({
      kind: 'text',
      heading: 'Description',
      paragraphs: ['curl is a tool.', 'Second paragraph with a <img src=x onerror=1> tag.'],
    });
  });
});

describe('readRpm: dependencies', () => {
  it('lists requirements with comparison operators and hides rpmlib entries, counting them', async () => {
    const dependencies = table(await readSpec(), 'Dependencies');
    expect(dependencies.columns).toEqual(['Relation', 'Package', 'Version']);
    expect(dependencies.lead).toBe(
      '2 rpmlib requirements about the rpm tool itself are not shown.',
    );
    expect(dependencies.rows).toEqual([
      ['Requires', 'libc.so.6()(64bit)', ''],
      ['Requires', 'glibc', '>= 2.34'],
      ['Requires', 'zlib', '> 1.2'],
      ['Recommends', 'ca-certificates', ''],
      ['Suggests', 'curl-doc', '= 8.5.0'],
      ['Conflicts', 'curl-old', '< 7.0'],
      ['Obsoletes', 'curl-legacy', '<= 6.0'],
    ]);
  });

  it('says "requirement" for exactly one hidden entry', async () => {
    const info = await readSpec({
      main: [strings(1049, ['rpmlib(X)', 'glibc']), int32(1048, 0, 0), strings(1050, ['', ''])],
    });
    expect(table(info, 'Dependencies').lead).toBe(
      '1 rpmlib requirement about the rpm tool itself is not shown.',
    );
  });

  it('lists what the package provides in its own table', async () => {
    const provides = table(await readSpec(), 'Provides');
    expect(provides.rows).toEqual([
      ['curl', '= 8.5.0-2.fc40'],
      ['curl(x86-64)', '= 8.5.0-2.fc40'],
    ]);
  });

  it('shows no comparison when the flags array is missing', async () => {
    const info = await readSpec({
      main: [strings(1049, ['glibc']), strings(1050, ['2.0'])],
      without: [1048],
    });
    expect(table(info, 'Dependencies').rows[0]).toEqual(['Requires', 'glibc', '2.0']);
  });
});

describe('readRpm: scripts and contents', () => {
  it('lists the scripts that exist and not their text', async () => {
    const info = await readSpec();
    const scripts = properties(info, 'Scripts');
    expect([...scripts.keys()]).toEqual([
      'Pre-install (%pre)',
      'Post-install (%post)',
      'Post-uninstall (%postun)',
      'Post-transaction (%posttrans)',
    ]);
    expect(scripts.get('Post-install (%post)')).toContain('as root');
    expect(JSON.stringify(info)).not.toContain('ldconfig');
    expect(JSON.stringify(info)).not.toContain('echo done');
  });

  it('has no scripts section when there are none', async () => {
    const info = await readSpec({ without: [1023, 1024, 1026, 1152] });
    expect(info.sections.some((s) => s.heading === 'Scripts')).toBe(false);
  });

  it('builds each path from its directory and name, and totals files but not directories', async () => {
    const contents = table(await readSpec(), 'Contents');
    expect(contents.columns).toEqual(['Path', 'Size']);
    expect(contents.rows).toEqual([
      ['/usr/bin/curl', formatBytes(250000)],
      ['/usr/share/doc/curl/README', formatBytes(1200)],
    ]);
    expect(contents.lead).toBe(
      `The package contains 2 files totalling ${formatBytes(251200)} and 1 directory.`,
    );
  });

  it('uses 64-bit file sizes when present', async () => {
    const info = await readSpec({
      files: [{ dir: '/a/', name: 'big', size: 1 }],
      main: [int64(5008, 6_000_000_000n)],
    });
    expect(table(info, 'Contents').rows[0][1]).toBe(formatBytes(6_000_000_000));
  });

  it('shows at most 200 files and the real total', async () => {
    const files = Array.from({ length: 450 }, (_, i) => ({ dir: '/d/', name: `f${i}`, size: 10 }));
    const contents = table(await readSpec({ files }), 'Contents');
    expect(contents.rows).toHaveLength(200);
    expect(contents.lead).toContain('450 files totalling');
    expect(contents.note).toBe('Showing the first 200 of 450 files.');
  });

  it('warns and shows no contents when the directory indexes do not match the names', async () => {
    const info = await readSpec({ main: [int32(1116, 0)] });
    expect(info.warnings).toEqual(['The file list could not be read.']);
    expect(info.sections.some((s) => s.heading === 'Contents')).toBe(false);
  });

  it('survives a directory index that points past the directory list', async () => {
    const info = await readSpec({ main: [int32(1116, 0, 7, 0)] });
    expect(table(info, 'Contents').rows[1][0]).toBe('README');
  });

  it('has no contents section for a package with no files', async () => {
    const info = await readSpec({ files: [] });
    expect(info.sections.some((s) => s.heading === 'Contents')).toBe(false);
  });
});

describe('readRpm: signature', () => {
  it('reports an OpenPGP RSA signature with the issuer key ID and no signer', async () => {
    const section = properties(await readSpec(), 'Signature');
    expect(section.get('Status')).toContain('OpenPGP (RSA) signature present, not verified');
    expect(section.get('Key ID')).toBe(KEY_ID_HEX);
    expect(section.has('Signer')).toBe(false);
  });

  it('reads the key ID of an old-format version 3 DSA signature in the PGP tag', async () => {
    const info = await readSpec({
      without: [268],
      signature: [bin(1002, pgpSignatureV3(17))],
    });
    const section = properties(info, 'Signature');
    expect(section.get('Status')).toContain('OpenPGP (DSA)');
    expect(section.get('Key ID')).toBe(KEY_ID_HEX);
  });

  it('still reports a signature whose packet cannot be read, without a key ID', async () => {
    const info = await readSpec({ signature: [bin(268, new Uint8Array([1, 2, 3]))] });
    const section = properties(info, 'Signature');
    expect(section.get('Status')).toContain('OpenPGP signature present');
    expect(section.has('Key ID')).toBe(false);
  });

  it('has no signature section for an unsigned package', async () => {
    const info = await readSpec({ without: [268] });
    expect(info.sections.some((s) => s.heading === 'Signature')).toBe(false);
  });

  it('parses packets directly and never throws on short or lying ones', () => {
    expect(openPgpIssuer(pgpSignatureV4(22))).toEqual({ algorithm: 22, keyId: KEY_ID_HEX });
    const full = pgpSignatureV4();
    for (let n = 0; n < full.length; n++) {
      expect(() => openPgpIssuer(full.subarray(0, n))).not.toThrow();
    }
    const lying = Uint8Array.from(full);
    lying[1] = 250;
    expect(openPgpIssuer(lying)).toBeUndefined();
    expect(
      openPgpIssuer(Uint8Array.from([0xc2, 0xff, 255, 255, 255, 255, 4, 0, 1, 8])),
    ).toBeUndefined();
    expect(KEY_ID).toHaveLength(8);
  });
});

describe('readRpm: files that are not RPM packages', () => {
  it('rejects a file without the lead magic', async () => {
    await expect(read(new TextEncoder().encode('x'.repeat(300)))).rejects.toThrow(PackageError);
    await expect(read(new Uint8Array(10))).rejects.toThrow(PackageError);
  });

  it('rejects a lead followed by something that is not a header', async () => {
    const bytes = new Uint8Array(400);
    bytes.set(lead());
    await expect(read(bytes)).rejects.toThrow('header in it is damaged');
  });

  it('rejects headers that hold no package name', async () => {
    await expect(readSpec({ without: [1000] })).rejects.toThrow('no package name');
  });
});

describe('readRpm: hostile structure', () => {
  it('refuses an index count above the cap', async () => {
    await expect(readSpec({ mainOptions: { indexCount: 0xffffffff } })).rejects.toThrow(
      'larger than MarkCopy will read',
    );
  });

  it('refuses a store size above the cap, and one beyond the end of the file', async () => {
    await expect(readSpec({ mainOptions: { storeSize: 0xffffffff } })).rejects.toThrow(
      'larger than MarkCopy will read',
    );
    await expect(readSpec({ mainOptions: { storeSize: 20 * 1024 * 1024 } })).rejects.toThrow(
      'the file ends before',
    );
  });

  it('ignores a tag whose offset is outside the store', async () => {
    const tags = [str(1000, 'x'), str(1001, '1')];
    const raw = header(tags);
    // Entry 1 (tag 1001) starts at 16 + 16; its offset field is 8 bytes in.
    new DataView(raw.buffer).setUint32(16 + 16 + 8, 0x7fffffff);
    const bytes = new Uint8Array([
      ...lead(),
      ...header([int32(1000, 1)]),
      ...new Uint8Array(4),
      ...raw,
    ]);
    // The signature header is 36 bytes after a 96-byte lead, so 4 pad bytes reach a multiple of 8.
    const info = await read(bytes);
    expect(info.title).toBe('x');
  });

  it('survives counts that claim far more values than the store holds', async () => {
    const main = header([str(1000, 'x'), strings(1117, ['a']), int32(1116, 0)]);
    const view = new DataView(main.buffer);
    for (let i = 0; i < 3; i++) {
      view.setUint32(16 + i * 16 + 12, 0xffffffff); // count of every entry
    }
    const sig = header([int32(1000, 1)]);
    const bytes = new Uint8Array([...lead(), ...sig, ...new Uint8Array(4), ...main]);
    const info = await read(bytes);
    expect(info.title).toBe('x');
  });

  it('rejects a header whose store is cut one byte short', async () => {
    const main = header([str(1000, 'name'), strings(1117, ['abc'])]);
    const cut = main.subarray(0, main.length - 1);
    const sig = header([int32(1000, 1)]);
    const bytes = new Uint8Array([...lead(), ...sig, ...new Uint8Array(4), ...cut]);
    await expect(read(bytes)).rejects.toThrow(PackageError);
  });

  it('survives truncation at every length', async () => {
    const full = buildRpm({ payload: new Uint8Array(200) });
    const lengths: number[] = [];
    for (let n = 0; n <= Math.min(1024, full.length); n++) {
      lengths.push(n);
    }
    for (let n = 1024; n < full.length; n += 41) {
      lengths.push(n);
    }
    for (const n of lengths) {
      try {
        await read(full.subarray(0, n));
      } catch (error) {
        expect(error).toBeInstanceOf(PackageError);
      }
    }
  });
});

describe('readRpm: rendering', () => {
  it('escapes markup from every field and strips direction overrides', async () => {
    const info = await readSpec({
      main: [
        str(1000, '<img src=x onerror=1>'),
        i18nSummary('<script>alert(1)</script>'),
        str(1015, `Eve ${RLO}gro.evil`),
      ],
      files: [{ dir: '/x/', name: '<b>f</b>', size: 1 }],
    });
    const html = renderPackageHtml(info, { fileName: '<svg onload=1>.rpm', fileSize: 100 });
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    for (const tag of ['<img', '<script', '<b>', '<svg']) {
      expect(html).not.toContain(tag);
    }
    expect(JSON.stringify(info)).not.toContain(RLO);
    expect(html).not.toContain(RLO);
  });
});

function i18nSummary(value: string): ReturnType<typeof str> {
  return { tag: 1004, type: 9, value };
}

describe('readRpm: memory and work bounds', () => {
  const heap = (): number => process.memoryUsage().heapUsed;

  it('cuts a megabyte directory name that 200 files share', async () => {
    const files = Array.from({ length: 200 }, (_, i) => ({
      dir: 'd'.repeat(1 << 20),
      name: `f${i}`,
      size: 1,
    }));
    const bytes = buildRpm({ files });
    const before = heap();
    const info = await read(bytes);
    const contents = table(info, 'Contents');
    expect(contents.rows).toHaveLength(200);
    for (const row of contents.rows) {
      expect(row[0].length).toBeLessThanOrEqual(2048);
    }
    expect(heap() - before).toBeLessThan(64 * 1024 * 1024);
  });

  it('counts only the first 200,000 files of a longer list and says so', async () => {
    const count = 250_000;
    const names = Array.from({ length: count }, (_, i) => `f${i}`);
    const info = await readSpec({
      files: [],
      main: [
        strings(1117, names),
        { tag: 1116, type: TYPE.INT32, value: new Array<number>(count).fill(0) },
        strings(1118, ['/d/']),
      ],
    });
    expect(table(info, 'Contents').lead).toContain('200,000 files');
    expect(info.warnings.join(' ')).toContain('only its first 200,000 entries');
  });

  it('reads a long relationship list up to a cap and warns', async () => {
    const count = 30_000;
    const names = Array.from({ length: count }, (_, i) => `lib${i}`);
    const info = await readSpec({
      main: [
        strings(1049, names),
        { tag: 1048, type: TYPE.INT32, value: new Array<number>(count).fill(0) },
        strings(
          1050,
          names.map(() => ''),
        ),
      ],
    });
    const dependencies = table(info, 'Dependencies');
    expect(dependencies.rows.length).toBeLessThanOrEqual(500);
    expect(info.warnings.join(' ')).toContain('larger than MarkCopy will read');
  });

  it('takes one value from a text tag without building its whole array', async () => {
    const huge = Array.from({ length: 100_000 }, () => 'aa');
    const bytes = buildRpm({ main: [strings(1004, huge)] });
    const before = heap();
    const info = await read(bytes);
    expect(info.summary).toBe('aa');
    expect(heap() - before).toBeLessThan(64 * 1024 * 1024);
  });
});
