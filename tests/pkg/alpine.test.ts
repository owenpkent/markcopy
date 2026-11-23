// @vitest-environment node
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { formatBytes } from '../../src/binary/html';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import { readAlpineApk, parsePkgInfo } from '../../src/pkg/alpine';
import {
  PackageError,
  type PackageInfo,
  type PropertySection,
  type TableSection,
} from '../../src/pkg/model';
import { renderPackageHtml } from '../../src/pkg/render';
import { concat, tar } from './debFixture';
import { buildApk, DATAHASH, KEY_NAME, type ApkSpec } from './alpineFixture';

const RLO = String.fromCharCode(0x202e);
const LIMITS = { maxPages: 512, maxRead: 16 * 1024 * 1024 };
const NOT_ALPINE = 'it is a gzip archive, but not an Alpine package.';

const read = (bytes: Uint8Array): Promise<PackageInfo> =>
  readAlpineApk(new RangeReader(bytesSource(bytes), LIMITS));
const readSpec = (spec: ApkSpec = {}): Promise<PackageInfo> => read(buildApk(spec));

const properties = (info: PackageInfo, heading: string): Map<string, string> => {
  const section = info.sections.find((s) => s.heading === heading) as PropertySection | undefined;
  return new Map(section?.rows ?? []);
};
const table = (info: PackageInfo, heading: string): TableSection =>
  info.sections.find((s) => s.heading === heading) as TableSection;

describe('readAlpineApk: package information', () => {
  it('reads every field of the package section', async () => {
    const info = await readSpec();
    expect(info.format).toBe('Alpine package');
    expect(info.title).toBe('curl 8.5.0-r0');
    expect(info.summary).toBe('URL retrieval utility and library');
    const pkg = properties(info, 'Package');
    expect(pkg.get('Name')).toBe('curl');
    expect(pkg.get('Version')).toBe('8.5.0-r0');
    expect(pkg.get('Architecture')).toBe('x86_64');
    expect(pkg.get('Maintainer')).toBe('Ana Example <ana@example.org>');
    expect(pkg.get('Packager')).toBe('Buildozer <alpine-devel@lists.alpinelinux.org>');
    expect(pkg.get('License')).toBe('MIT');
    expect(pkg.get('URL')).toBe('https://curl.se/');
    expect(pkg.get('Origin')).toBe('curl');
    expect(pkg.get('Commit')).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(pkg.get('Installed size')).toBe(formatBytes(262144));
    expect(pkg.get('Built')).toBe('2023-11-14 22:13:20 UTC');
    expect(pkg.get('Data SHA-256')).toBe(DATAHASH);
    expect(info.warnings).toEqual([]);
  });

  it('lists dependencies, with a leading ! as a conflict, and replaces and install_if', async () => {
    const dependencies = table(await readSpec(), 'Dependencies');
    expect(dependencies.columns).toEqual(['Relation', 'Package', 'Version']);
    expect(dependencies.rows).toEqual([
      ['Depends', 'ca-certificates', ''],
      ['Depends', 'so:libc.musl-x86_64.so.1', ''],
      ['Conflicts', 'curl-old', ''],
      ['Depends', 'zlib', '>=1.2'],
      ['Replaces', 'curl-legacy', ''],
      ['Installed if', 'docs', '=8.5.0-r0'],
    ]);
  });

  it('lists what the package provides', async () => {
    expect(table(await readSpec(), 'Provides').rows).toEqual([
      ['cmd:curl', '=8.5.0-r0'],
      ['so:libcurl.so.4', '=4.8.0'],
    ]);
  });

  it('parses key = value lines and ignores comments', () => {
    const info = parsePkgInfo('# pkgname = no\npkgname = a\ndepend = b\ndepend = c\nnot a pair\n');
    expect(info.get('pkgname')).toEqual(['a']);
    expect(info.get('depend')).toEqual(['b', 'c']);
  });

  it('copes with a package that has no optional fields', async () => {
    const info = await readSpec({ pkginfo: 'pkgname = tiny\n', signature: null });
    expect(info.title).toBe('tiny');
    expect(info.sections.map((s) => s.heading)).toEqual(['Package']);
  });
});

describe('readAlpineApk: scripts and signature', () => {
  it('lists install scripts and trigger paths without printing the scripts', async () => {
    const info = await readSpec({ scripts: ['.post-install', '.trigger'] });
    const scripts = properties(info, 'Scripts');
    expect([...scripts.keys()]).toEqual(['.post-install', '.trigger', 'Trigger paths']);
    expect(scripts.get('.post-install')).toContain('as root');
    expect(scripts.get('Trigger paths')).toBe('/usr/share/ca-certificates /etc/ssl/certs');
    expect(JSON.stringify(info)).not.toContain('exit 0');
  });

  it('has no scripts section when there are none and no triggers', async () => {
    const info = await readSpec({ pkginfo: 'pkgname = x\n' });
    expect(info.sections.some((s) => s.heading === 'Scripts')).toBe(false);
  });

  it('reports the signing key name through the shared signature section', async () => {
    const signature = properties(await readSpec(), 'Signature');
    expect(signature.get('Status')).toBe('Alpine RSA signature present, not verified by MarkCopy');
    expect(signature.get('Key name')).toBe(KEY_NAME);
    expect(signature.has('Signer')).toBe(false);
  });

  it('finds the signature when its name is in a pax header', async () => {
    const signature = properties(await readSpec({ pax: true }), 'Signature');
    expect(signature.get('Key name')).toBe(KEY_NAME);
  });

  it('has no signature section when the signature stream is absent', async () => {
    const info = await readSpec({ signature: null });
    expect(info.title).toBe('curl 8.5.0-r0');
    expect(info.sections.some((s) => s.heading === 'Signature')).toBe(false);
  });
});

describe('readAlpineApk: the data stream', () => {
  it('does not need the data stream to be readable', async () => {
    const info = await readSpec({ data: new TextEncoder().encode('this is not gzip at all') });
    expect(info.title).toBe('curl 8.5.0-r0');
    expect(info.warnings).toEqual([]);
  });

  it('is not slowed or stopped by a data stream that expands to gigabytes', async () => {
    const bomb = gzipSync(tar([{ name: 'usr/big', data: new Uint8Array(40 * 1024 * 1024) }]));
    const info = await readSpec({ data: bomb });
    expect(info.title).toBe('curl 8.5.0-r0');
  });
});

describe('readAlpineApk: files that are not Alpine packages', () => {
  it('rejects a file that is not gzip', async () => {
    await expect(read(new TextEncoder().encode('plain text, not gzip'))).rejects.toThrow(
      'it is not a gzip archive.',
    );
  });

  it('rejects a gzip tar that has no .PKGINFO', async () => {
    const plain = gzipSync(tar([{ name: 'README', data: 'hello' }]));
    await expect(read(plain)).rejects.toThrow(NOT_ALPINE);
  });

  it('rejects gzip that is not a tar at all', async () => {
    await expect(read(gzipSync(new TextEncoder().encode('just some text')))).rejects.toThrow(
      NOT_ALPINE,
    );
  });

  it('rejects a gzip bomb that never reveals a .PKGINFO', async () => {
    const bomb = gzipSync(new Uint8Array(40 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(100 * 1024);
    await expect(read(bomb)).rejects.toThrow(NOT_ALPINE);
  });

  it('rejects a .PKGINFO that names no package', async () => {
    await expect(readSpec({ pkginfo: '# empty\n' })).rejects.toThrow(NOT_ALPINE);
  });

  it('rejects damaged gzip with the same message', async () => {
    const bytes = buildApk();
    bytes.fill(0xff, 12, 60);
    await expect(read(bytes)).rejects.toThrow(PackageError);
  });
});

describe('readAlpineApk: hostile structure', () => {
  it('warns about a package information file larger than it will read, and caps the table', async () => {
    const lines = Array.from({ length: 150000 }, () => 'depend = libfoo').join('\n');
    const info = await readSpec({ pkginfo: `pkgname = big\n${lines}\n` });
    expect(info.warnings).toEqual(['The package information is larger than MarkCopy will read.']);
    const dependencies = table(info, 'Dependencies');
    expect(dependencies.rows).toHaveLength(500);
    expect(dependencies.note).toMatch(/^Showing the first 500 of [\d,]+ relationships\.$/);
  });

  it('survives truncation at every length', async () => {
    const full = buildApk({ scripts: ['.post-install'] });
    const lengths: number[] = [];
    for (let n = 0; n <= Math.min(1024, full.length); n++) {
      lengths.push(n);
    }
    for (let n = 1024; n < full.length; n += 29) {
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

  it('survives a tar header that declares a size far beyond the file', async () => {
    const stream = gzipSync(tar([{ name: '.PKGINFO', data: 'pkgname = x\n' }], false));
    const huge = gzipSync(tar([{ name: 'usr/x', data: 'a', declaredSize: 0o7777777777 }], false));
    const info = await read(concat(stream, huge));
    expect(info.title).toBe('x');
  });
});

describe('readAlpineApk: rendering', () => {
  it('escapes markup from every field and strips direction overrides', async () => {
    const pkginfo = [
      'pkgname = <img src=x onerror=1>',
      'pkgver = 1',
      'pkgdesc = <script>alert(1)</script>',
      `maintainer = Eve ${RLO}gro.evil`,
      'depend = <b>dep</b>>=<i>1</i>',
      '',
    ].join('\n');
    const info = await readSpec({ pkginfo, signature: '<u>key</u>' });
    const html = renderPackageHtml(info, { fileName: '<svg onload=1>.apk', fileSize: 100 });
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    for (const tag of ['<img', '<script', '<b>', '<i>', '<u>', '<svg']) {
      expect(html).not.toContain(tag);
    }
    expect(JSON.stringify(info)).not.toContain(RLO);
    expect(html).not.toContain(RLO);
  });
});
