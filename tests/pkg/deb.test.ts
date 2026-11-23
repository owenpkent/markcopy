// @vitest-environment node
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import { formatBytes } from '../../src/binary/html';
import { parseControl, parseRelations, readDeb } from '../../src/pkg/deb';
import {
  PackageError,
  type PackageInfo,
  type PropertySection,
  type TableSection,
} from '../../src/pkg/model';
import { renderPackageHtml } from '../../src/pkg/render';
import { b64, buildDeb, VECTOR_XZ, VECTOR_ZST, ar, tar, type DebSpec } from './debFixture';

const RLO = String.fromCharCode(0x202e);
const LIMITS = { maxPages: 512, maxRead: 16 * 1024 * 1024 };

const read = (bytes: Uint8Array): Promise<PackageInfo> =>
  readDeb(new RangeReader(bytesSource(bytes), LIMITS));
const readSpec = (spec: DebSpec = {}): Promise<PackageInfo> => read(buildDeb(spec));

const properties = (info: PackageInfo, heading: string): Map<string, string> => {
  const section = info.sections.find((s) => s.heading === heading) as PropertySection | undefined;
  return new Map(section?.rows ?? []);
};
const table = (info: PackageInfo, heading: string): TableSection =>
  info.sections.find((s) => s.heading === heading) as TableSection;

describe('readDeb: control fields', () => {
  it('reads every field of the package section', async () => {
    const info = await readSpec();
    expect(info.format).toBe('Debian package');
    expect(info.title).toBe('curl 8.5.0-2');
    expect(info.summary).toBe('command line tool for transferring data');
    const pkg = properties(info, 'Package');
    expect(pkg.get('Package')).toBe('curl');
    expect(pkg.get('Version')).toBe('8.5.0-2');
    expect(pkg.get('Architecture')).toBe('amd64');
    expect(pkg.get('Maintainer')).toBe('Ana Example <ana@example.org>');
    expect(pkg.get('Installed size')).toBe(formatBytes(1536 * 1024));
    expect(pkg.get('Section')).toBe('web');
    expect(pkg.get('Priority')).toBe('optional');
    expect(pkg.get('Homepage')).toBe('https://curl.example/');
    expect(pkg.get('Source')).toBe('curl-src (8.5.0)');
    expect(pkg.get('Essential')).toBe('no');
    expect(pkg.get('Multi-Arch')).toBe('foreign');
    expect(pkg.get('Built-Using')).toBe('glibc (= 2.38-1)');
    expect(pkg.get('X-Custom')).toBe('kept as written');
    expect(pkg.get('Package format')).toBe('2.0');
    expect(pkg.get('Control files')).toBe('control');
    expect(info.warnings).toEqual([]);
  });

  it('keeps the packaged fields first and the others after them, in file order', async () => {
    const labels = [...properties(await readSpec(), 'Package').keys()];
    expect(labels.indexOf('Package')).toBeLessThan(labels.indexOf('Version'));
    expect(labels.indexOf('Built-Using')).toBeLessThan(labels.indexOf('X-Custom'));
  });

  it('does not repeat description and relationship fields in the package section', async () => {
    const pkg = properties(await readSpec(), 'Package');
    for (const name of ['Depends', 'Description', 'Provides', 'Recommends']) {
      expect(pkg.has(name)).toBe(false);
    }
  });

  it('splits the description into paragraphs at a lone dot', async () => {
    const section = (await readSpec()).sections.find((s) => s.heading === 'Description');
    expect(section).toEqual({
      kind: 'text',
      heading: 'Description',
      paragraphs: [
        'curl is a tool for transferring data from or to a server.\nIt supports many protocols.',
        'Second paragraph with a <img src=x onerror=1> tag.',
      ],
    });
  });

  it('names an installer package by its Package-Type', async () => {
    const info = await readSpec({ control: 'Package: x\nVersion: 1\nPackage-Type: udeb\n' });
    expect(info.format).toBe('Debian installer package');
  });

  it('shows the data archive compression and compressed size', async () => {
    const pkg = properties(await readSpec({ dataSuffix: '.zst', dataSize: 3000 }), 'Package');
    expect(pkg.get('Package data')).toBe(`Zstandard compressed, ${formatBytes(3000)}`);
  });
});

describe('readDeb: dependencies', () => {
  it('lists each relation with alternatives in one row', async () => {
    const dependencies = table(await readSpec(), 'Dependencies');
    expect(dependencies.columns).toEqual(['Relation', 'Package', 'Version']);
    expect(dependencies.rows).toEqual([
      ['Depends', 'libc6', '>= 2.34'],
      ['Depends', 'libssl3 | libssl1.1', 'any | >= 1.1.1'],
      ['Depends', 'zlib1g', ''],
      ['Pre-Depends', 'dpkg', '>= 1.17'],
      ['Recommends', 'ca-certificates', ''],
      ['Suggests', 'curl-doc', ''],
      ['Enhances', 'wget', ''],
      ['Breaks', 'curl-old', '<< 8.0'],
      ['Conflicts', 'curl-ssl', ''],
      ['Replaces', 'curl-old', ''],
      ['Provides', 'http-client', ''],
    ]);
  });

  it('parses relations directly, ignoring architecture and profile qualifiers', () => {
    expect(parseRelations('a (>= 1) [amd64] <!nocheck>, b:any')).toEqual([
      { packages: 'a', versions: '>= 1' },
      { packages: 'b:any', versions: '' },
    ]);
    expect(parseRelations(' , ,')).toEqual([]);
  });

  it('has no dependencies table when there are none', async () => {
    const info = await readSpec({ control: 'Package: x\nVersion: 1\n' });
    expect(info.sections.some((s) => s.heading === 'Dependencies')).toBe(false);
  });
});

describe('readDeb: control parsing', () => {
  it('reads continuation lines and stops at the first blank line', () => {
    const fields = parseControl('A: one\n two\n\tthree\n\nB: other\n');
    expect(fields).toEqual([{ name: 'A', lines: ['one', 'two', 'three'] }]);
  });

  it('ignores comments and lines without a colon', () => {
    expect(parseControl('# note\nnonsense\nA: 1\n')).toEqual([{ name: 'A', lines: ['1'] }]);
  });
});

describe('readDeb: maintainer scripts and contents', () => {
  it('lists the scripts that exist, and does not print them', async () => {
    const info = await readSpec({
      scripts: ['postinst', 'prerm'],
      files: { conffiles: '/etc/x\n' },
    });
    const scripts = properties(info, 'Maintainer scripts');
    expect([...scripts.keys()]).toEqual(['postinst', 'prerm']);
    expect(scripts.get('postinst')).toContain('as root');
    expect(JSON.stringify(info)).not.toContain('exit 0');
    expect(properties(info, 'Package').get('Control files')).toBe(
      'control, conffiles, postinst, prerm',
    );
    const section = info.sections.find(
      (s) => s.heading === 'Maintainer scripts',
    ) as PropertySection;
    expect(section.note).toContain('as root');
  });

  it('has no scripts section when the package has none', async () => {
    const info = await readSpec({ files: { conffiles: '/etc/x\n' } });
    expect(info.sections.some((s) => s.heading === 'Maintainer scripts')).toBe(false);
  });

  it('takes the file list from md5sums, paths only, and counts them in the lead', async () => {
    const info = await readSpec({ md5sums: ['usr/bin/curl', 'usr/share/doc/curl/copyright'] });
    const contents = table(info, 'Contents');
    expect(contents.columns).toEqual(['Path']);
    expect(contents.rows).toEqual([['usr/bin/curl'], ['usr/share/doc/curl/copyright']]);
    expect(contents.lead).toBe('The package lists 2 files.');
  });

  it('shows at most 200 paths and counts the rest', async () => {
    const paths = Array.from({ length: 450 }, (_, i) => `usr/share/f${i}`);
    const contents = table(await readSpec({ md5sums: paths }), 'Contents');
    expect(contents.rows).toHaveLength(200);
    expect(contents.lead).toBe('The package lists 450 files.');
    expect(contents.note).toBe('Showing the first 200 of 450 files.');
  });

  it('says nothing about contents when there is no md5sums', async () => {
    const info = await readSpec();
    expect(info.sections.some((s) => s.heading === 'Contents')).toBe(false);
  });
});

describe('readDeb: compression', () => {
  it('reads an uncompressed control.tar', async () => {
    expect((await readSpec({ compression: 'none' })).title).toBe('curl 8.5.0-2');
  });

  it('reads a control.tar.xz made by lzma', async () => {
    const info = await readSpec({ compression: 'xz', controlBytes: b64(VECTOR_XZ) });
    expect(info.title).toBe('vectorpkg 1.2-3');
    expect(table(info, 'Dependencies').rows[1]).toEqual(['Depends', 'a | b', '']);
    expect(info.summary).toBe('compressed control');
  });

  it('reads a control.tar.zst', async () => {
    const info = await readSpec({ compression: 'zst', controlBytes: b64(VECTOR_ZST) });
    expect(info.title).toBe('vectorpkg 1.2-3');
  });

  it('reports a bzip2 control archive as unsupported and keeps the ar facts', async () => {
    const info = await readSpec({ compression: 'bz2' });
    expect(info.warnings.join(' ')).toContain('bzip2');
    expect(info.title).toBeUndefined();
    const pkg = properties(info, 'Package');
    expect(pkg.get('Control archive')).toBe('control.tar.bz2');
    expect(pkg.get('Package data')).toContain('xz compressed');
  });

  it('reports an LZMA control archive the same way', async () => {
    const info = await readSpec({ compression: 'lzma' });
    expect(info.warnings.join(' ')).toContain('LZMA');
  });

  it('turns a gzip bomb in the control archive into a warning', async () => {
    const bomb = gzipSync(tar([{ name: './control', data: new Uint8Array(20 * 1024 * 1024) }]));
    expect(bomb.length).toBeLessThan(200 * 1024);
    const info = await read(
      ar([
        { name: 'debian-binary', data: '2.0\n' },
        { name: 'control.tar.gz', data: bomb },
        { name: 'data.tar.xz', data: new Uint8Array(10) },
      ]),
    );
    expect(info.warnings.join(' ')).toContain('more data than MarkCopy will unpack');
    expect(info.title).toBeUndefined();
  });

  it('warns when the control archive is damaged', async () => {
    const bytes = buildDeb({ compression: 'gz' });
    // Flip bytes inside the gzip stream (the control member's data starts at byte 132).
    for (let i = 140; i < 160; i++) {
      bytes[i] ^= 0xff;
    }
    const info = await read(bytes);
    expect(info.warnings.length).toBeGreaterThan(0);
  });

  it('warns when the control file holds no fields', async () => {
    const info = await readSpec({ control: '', files: { md5sums: '' } });
    expect(info.warnings).toEqual(['The control file holds no package fields.']);
  });
});

describe('readDeb: files that are not Debian packages', () => {
  it('rejects a file that is not an ar archive', async () => {
    await expect(read(new TextEncoder().encode('hello world, not an archive'))).rejects.toThrow(
      PackageError,
    );
  });

  it('rejects an ar archive whose first member is not debian-binary', async () => {
    await expect(readSpec({ firstMember: 'hello.txt' })).rejects.toThrow(
      'it is an ar archive, but not a Debian package.',
    );
  });

  it('rejects a package without a control archive', async () => {
    await expect(readSpec({ omitControl: true })).rejects.toThrow(PackageError);
  });

  it('warns when there is no data archive', async () => {
    const info = await readSpec({ omitData: true });
    expect(info.warnings).toContain('The package has no data archive.');
  });
});

describe('readDeb: hostile structure', () => {
  it('does not read a control member larger than the file', async () => {
    const bytes = ar([
      { name: 'debian-binary', data: '2.0\n' },
      { name: 'control.tar.gz', data: new Uint8Array(10), declaredSize: 2_000_000_000 },
    ]);
    const info = await read(bytes);
    expect(info.warnings.join(' ')).toContain('ends inside the control archive');
  });

  it('refuses a control archive larger than it will read', async () => {
    const bytes = ar([
      { name: 'debian-binary', data: '2.0\n' },
      { name: 'control.tar.gz', data: new Uint8Array(9 * 1024 * 1024) },
      { name: 'data.tar.xz', data: new Uint8Array(10) },
    ]);
    const info = await read(bytes);
    expect(info.warnings.join(' ')).toContain('larger than MarkCopy will read');
  });

  it('stops at a member header with the wrong terminator', async () => {
    const bytes = buildDeb();
    bytes[8 + 58] = 0x41;
    await expect(read(bytes)).rejects.toThrow(PackageError);
  });

  it('survives a field count and value length far beyond the caps', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => `X-F${i}: v`).join('\n');
    const info = await readSpec({
      control: `Package: p\nVersion: 1\n${many}\nBig: ${'x'.repeat(100000)}\n`,
    });
    expect(info.title).toBe('p 1');
    expect(properties(info, 'Package').size).toBeLessThan(520);
  });

  it('survives truncation at every length', async () => {
    const full = buildDeb({ scripts: ['postinst'], md5sums: ['usr/bin/a'], dataSize: 600 });
    const lengths: number[] = [];
    for (let n = 0; n <= Math.min(1024, full.length); n++) {
      lengths.push(n);
    }
    for (let n = 1024; n < full.length; n += 37) {
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

describe('readDeb: rendering', () => {
  it('escapes markup from every field and strips direction overrides', async () => {
    const control = [
      'Package: <img src=x onerror=1>',
      'Version: 1',
      `Maintainer: Eve ${RLO}gro.evil@x`,
      'Depends: dep (>= <i>1</i>)',
      'Description: <script>alert(1)</script>',
      ' <img src=x onerror=1>',
      '',
    ].join('\n');
    const info = await readSpec({ control, md5sums: ['<u>path</u>'] });
    const html = renderPackageHtml(info, { fileName: '<svg onload=1>.deb', fileSize: 100 });
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    for (const tag of ['<img', '<script', '<b>', '<i>', '<u>', '<svg']) {
      expect(html).not.toContain(tag);
    }
    expect(JSON.stringify(info)).not.toContain(RLO);
    expect(html).not.toContain(RLO);
  });
});
