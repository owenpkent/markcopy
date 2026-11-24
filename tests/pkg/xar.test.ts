import { gzipSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import { readPackage } from '../../src/pkg';
import { PackageError } from '../../src/pkg/model';
import { renderPackageHtml } from '../../src/pkg/render';
import { readXar } from '../../src/pkg/xar';
import type { InfoSection, PackageInfo } from '../../src/pkg/model';
import {
  buildCertificate,
  buildProduct,
  buildXar,
  packageInfoXml,
  type XarSpec,
} from './xarFixture';

const read = (bytes: Uint8Array): Promise<PackageInfo> =>
  readXar(new RangeReader(bytesSource(bytes)));
const RLO = String.fromCharCode(0x202e);

const section = (info: PackageInfo, heading: string): InfoSection | undefined =>
  info.sections.find((s) => s.heading === heading);
const rowsOf = (info: PackageInfo, heading: string): Record<string, string> => {
  const s = section(info, heading);
  return s?.kind === 'properties' ? Object.fromEntries(s.rows) : {};
};
const tableOf = (info: PackageInfo, heading: string): string[][] => {
  const s = section(info, heading);
  return s?.kind === 'table' ? s.rows : [];
};

describe('readXar: product archive', () => {
  const product = () =>
    read(
      buildProduct({
        distribution: {
          title: 'Example Tool',
          version: '2.0',
          installationCheck: true,
          license: 'license.html',
          readme: 'readme.html',
          choices: ['Command line tools', 'Documentation'],
        },
        components: [
          {
            dir: 'Tool.pkg',
            scripts: true,
            info: {
              identifier: 'com.example.tool',
              version: '2.0.1',
              installKBytes: 4096,
              numberOfFiles: 20,
              preinstall: true,
              postinstall: true,
              bundles: [{ id: 'com.example.app', version: '2.0', path: './Example.app' }],
            },
          },
          {
            dir: 'Helper.pkg',
            info: {
              identifier: 'com.example.helper',
              version: '1.0',
              installKBytes: 1024,
              auth: 'none',
            },
          },
        ],
      }),
    );

  it('reads the package section from Distribution and PackageInfo', async () => {
    const info = await product();
    expect(info.format).toBe('macOS installer package');
    expect(info.title).toBe('Example Tool 2.0');
    expect(info.warnings).toEqual([]);
    const pkg = rowsOf(info, 'Package');
    expect(pkg['Title']).toBe('Example Tool');
    expect(pkg['Version']).toBe('2.0');
    expect(pkg['Installs as root']).toBe('Yes (PackageInfo auth="root")');
    expect(pkg['Host architectures']).toBe('x86_64,arm64');
    expect(pkg['Minimum macOS']).toBe('10.13');
    expect(pkg['Installed size']).toContain('5.00 MB');
    expect(pkg['Files installed']).toBe('32');
    expect(pkg['Installation checks']).toContain('JavaScript');
    expect(pkg['License']).toBe('license.html');
    expect(pkg['Read me']).toBe('readme.html');
    expect(pkg['Created']).toBe('2024-03-05 10:20:30 UTC');
  });

  it('lists components, bundles, choices and scripts', async () => {
    const info = await product();
    expect(tableOf(info, 'Components')).toEqual([
      ['com.example.tool', '2.0.1', '/usr/local', '4.00 MB (4,194,304 bytes)'],
      ['com.example.helper', '1.0', '/usr/local', '1.00 MB (1,048,576 bytes)'],
    ]);
    expect(tableOf(info, 'Bundles')).toEqual([['com.example.app', '2.0', './Example.app']]);
    expect(tableOf(info, 'Choices')).toEqual([['Command line tools'], ['Documentation']]);
    expect(tableOf(info, 'Scripts')).toEqual([
      ['com.example.tool', 'preinstall, postinstall', 'root'],
    ]);
  });

  it('lists the archive contents with extracted sizes', async () => {
    const info = await product();
    const contents = tableOf(info, 'Contents').map((r) => r[0]);
    expect(contents).toContain('Distribution');
    expect(contents).toContain('Tool.pkg/PackageInfo');
    expect(contents).toContain('Tool.pkg/Payload');
    expect(contents).not.toContain('Tool.pkg');
    const payload = tableOf(info, 'Contents').find((r) => r[0] === 'Tool.pkg/Payload');
    expect(payload?.[1]).toBe('100 bytes');
    const s = section(info, 'Contents');
    expect(s?.kind === 'table' && s.lead).toMatch(/^\d+ files, /);
  });

  it('reads a stored (uncompressed) PackageInfo', async () => {
    const info = await read(
      buildProduct({ components: [{ dir: 'A.pkg', gzip: false, info: { identifier: 'com.a' } }] }),
    );
    expect(tableOf(info, 'Components')[0][0]).toBe('com.a');
  });

  it('reports a signature with the signer from the first certificate', async () => {
    const cert = buildCertificate(
      'Developer ID Installer: Example Inc',
      'Developer ID Certification Authority',
    );
    const info = await read(buildProduct({ certificate: cert }));
    const sig = rowsOf(info, 'Signature');
    expect(sig['Status']).toContain('Apple installer signature present, not verified');
    expect(sig['Signer']).toBe('Developer ID Installer: Example Inc');
    expect(sig['Issued by']).toBe('Developer ID Certification Authority');
  });

  it('shows no signature section for an unsigned archive', async () => {
    expect(section(await product(), 'Signature')).toBeUndefined();
  });
});

// pkgbuild describes a bundle under the root and repeats only its id under
// <bundle-version>. Reading the second place alone left the version and path
// blank on every real package tried.
describe('readXar: bundles as pkgbuild writes them', () => {
  it('takes the version and path from the described bundle, not the bare reference', async () => {
    const info = await read(
      buildXar({
        files: [
          {
            name: 'PackageInfo',
            data: packageInfoXml({
              identifier: 'com.flat',
              version: '9',
              pkgbuildLayout: true,
              bundles: [
                { id: 'com.example.app', version: '4.3.0', path: './Applications/Example.app' },
                { id: 'com.example.helper', version: '1.1', path: './Library/Helper.bundle' },
              ],
            }),
          },
        ],
      }),
    );
    expect(tableOf(info, 'Bundles')).toEqual([
      ['com.example.app', '4.3.0', './Applications/Example.app'],
      ['com.example.helper', '1.1', './Library/Helper.bundle'],
    ]);
  });
});

describe('readXar: flat component package and plain archives', () => {
  it('reads a flat package from its root PackageInfo', async () => {
    const info = await read(
      buildXar({
        files: [
          {
            name: 'PackageInfo',
            data: packageInfoXml({ identifier: 'com.flat', version: '9' }),
            encoding: 'zlib',
          },
          { name: 'Payload', data: 'abc', encoding: 'zlib' },
          { name: 'Scripts', data: 'abc', encoding: 'zlib' },
        ],
      }),
    );
    expect(info.format).toBe('macOS installer package');
    expect(info.title).toBe('com.flat 9');
    expect(rowsOf(info, 'Package')['Identifier']).toBe('com.flat');
    expect(tableOf(info, 'Scripts')).toEqual([['com.flat', 'scripts archive only', 'root']]);
  });

  it('calls an archive with neither Distribution nor PackageInfo a xar archive', async () => {
    const info = await read(
      buildXar({ files: [{ name: 'dir', children: [{ name: 'a.txt', data: 'hello' }] }] }),
    );
    expect(info.format).toBe('xar archive');
    expect(info.sections.map((s) => s.heading)).toEqual(['Archive', 'Contents']);
    expect(tableOf(info, 'Contents')).toEqual([['dir/a.txt', '5 bytes']]);
  });

  it('falls back to pkg-refs when no PackageInfo is present', async () => {
    const info = await read(
      buildXar({
        files: [
          {
            name: 'Distribution',
            data: '<installer-gui-script><title>Refs</title><pkg-ref id="com.ref" version="3" installKBytes="10"/></installer-gui-script>',
          },
        ],
      }),
    );
    expect(tableOf(info, 'Components')[0].slice(0, 2)).toEqual(['com.ref', '3']);
  });

  it('caps the contents list at 200 rows and says how many were left out', async () => {
    const files = Array.from({ length: 250 }, (_, i) => ({ name: `f${i}`, data: 'x' }));
    const info = await read(buildXar({ files }));
    expect(tableOf(info, 'Contents')).toHaveLength(200);
    const s = section(info, 'Contents');
    expect(s?.kind === 'table' && s.note).toBe('Showing the first 200 of 250 files.');
  });
});

describe('readXar: rejection and damage', () => {
  it('rejects a file that is not a xar archive', async () => {
    await expect(read(new TextEncoder().encode('PK\u0003\u0004'.padEnd(64, 'x')))).rejects.toThrow(
      PackageError,
    );
    await expect(read(new Uint8Array(10))).rejects.toThrow(PackageError);
  });

  it('rejects a table of contents that is not XML', async () => {
    await expect(read(buildXar({ rawToc: 'not xml <<<' }))).rejects.toThrow(PackageError);
  });

  it('rejects a table that declares more than it will read', async () => {
    const bytes = buildXar();
    new DataView(bytes.buffer).setBigUint64(8, 1n << 40n, false);
    await expect(read(bytes)).rejects.toThrow(/larger than MarkCopy will read/);
  });

  it('rejects a table of contents that runs past the end of the file', async () => {
    const bytes = buildXar();
    new DataView(bytes.buffer).setBigUint64(8, BigInt(bytes.length), false);
    await expect(read(bytes)).rejects.toThrow(PackageError);
  });

  it('stops inflating a table of contents bomb at the cap', async () => {
    // 20 MiB of spaces is 20 KB compressed; the table cap is 16 MiB.
    const bomb = zlibSync(new Uint8Array(20 * 1024 * 1024).fill(0x20));
    const bytes = new Uint8Array(28 + bomb.length);
    const header = new DataView(bytes.buffer);
    header.setUint32(0, 0x78617221, false);
    header.setUint16(4, 28, false);
    header.setUint16(6, 1, false);
    header.setBigUint64(8, BigInt(bomb.length), false);
    header.setBigUint64(16, 100n, false);
    bytes.set(bomb, 28);
    await expect(read(bytes)).rejects.toThrow(/larger than MarkCopy will read/);
  });

  it('warns when a PackageInfo inflates past its cap, and still lists the files', async () => {
    const info = await read(
      buildXar({
        files: [
          {
            name: 'PackageInfo',
            data: new Uint8Array(3 * 1024 * 1024).fill(0x20),
            encoding: 'zlib',
          },
        ],
      }),
    );
    expect(info.format).toBe('macOS installer package');
    expect(info.warnings.join(' ')).toContain('PackageInfo');
  });

  it('warns when a file points outside the heap instead of failing', async () => {
    const info = await read(
      buildXar({
        files: [
          { name: 'Distribution', data: '<x/>', declaredOffset: 1_000_000 },
          { name: 'ok.txt', data: 'a' },
        ],
      }),
    );
    expect(info.warnings.join(' ')).toContain('Distribution');
    expect(tableOf(info, 'Contents').map((r) => r[0])).toContain('ok.txt');
  });

  it('warns on an unsupported encoding', async () => {
    const info = await read(
      buildXar({ files: [{ name: 'Distribution', data: 'x', encoding: 'bzip2' }] }),
    );
    expect(info.warnings.join(' ')).toContain('Distribution');
  });

  it('survives hostile sizes and lengths in the table', async () => {
    const info = await read(
      buildXar({
        files: [
          { name: 'Distribution', data: 'x', declaredLength: 2 ** 40 },
          { name: 'PackageInfo', data: 'x', declaredLength: -5 },
        ],
      }),
    );
    expect(info.format).toBe('macOS installer package');
  });

  it('never throws anything but PackageError when truncated', async () => {
    const bytes = buildProduct({
      certificate: buildCertificate('Signer', 'Issuer'),
      components: [{ dir: 'Tool.pkg', scripts: true, info: { preinstall: true } }],
    });
    const cuts: number[] = [];
    for (let n = 0; n < Math.min(1024, bytes.length); n++) {
      cuts.push(n);
    }
    for (let n = 1024; n < bytes.length; n += 37) {
      cuts.push(n);
    }
    for (const n of cuts) {
      try {
        await read(bytes.subarray(0, n));
      } catch (e) {
        expect(e).toBeInstanceOf(PackageError);
      }
    }
  });
});

describe('readXar: rendering', () => {
  it('escapes the file name and strips direction overrides', async () => {
    const spec: XarSpec = {
      files: [
        { name: '<img src=x onerror=1>', data: 'a' },
        { name: `evil${RLO}fdp.exe`, data: 'a' },
      ],
    };
    const info = await read(buildXar(spec));
    const html = renderPackageHtml(info, { fileName: 'a.pkg', fileSize: 10 });
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain(RLO);
    expect(html).toContain('evilfdp.exe');
  });

  it('escapes a hostile title and package identifier', async () => {
    const info = await read(
      buildProduct({
        distribution: { title: '<img src=x onerror=1>' },
        components: [{ dir: 'A.pkg', info: { identifier: `a${RLO}b<script>` } }],
      }),
    );
    const html = renderPackageHtml(info, { fileName: 'a.pkg', fileSize: 10 });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(RLO);
  });
});

describe('readXar: Base64 names', () => {
  // The first character of a Chinese word, built from its code point.
  const ZHONG = String.fromCharCode(0x4e2d);
  const paths = async (files: XarSpec['files']): Promise<string[]> =>
    tableOf(await read(buildXar({ files })), 'Contents').map((r) => r[0]);

  it('decodes a name marked enctype="base64" as UTF-8', async () => {
    expect(await paths([{ name: `${ZHONG}.txt`, base64Name: true, data: 'a' }])).toEqual([
      `${ZHONG}.txt`,
    ]);
  });

  it('keeps a decoded directory name in every descendant path', async () => {
    expect(
      await paths([{ name: ZHONG, base64Name: true, children: [{ name: 'a.txt', data: 'a' }] }]),
    ).toEqual([`${ZHONG}/a.txt`]);
  });

  it('finds PackageInfo by its decoded name', async () => {
    const info = await read(
      buildXar({
        files: [
          {
            name: 'PackageInfo',
            base64Name: true,
            data: packageInfoXml({ identifier: 'com.b64' }),
          },
        ],
      }),
    );
    expect(info.format).toBe('macOS installer package');
    expect(tableOf(info, 'Components')[0][0]).toBe('com.b64');
  });

  it('does not let a decoded name carry a path separator', async () => {
    const [path] = await paths([{ name: 'a/b', base64Name: true, data: 'x' }]);
    expect(path).not.toContain('/');
    expect(path).toHaveLength(3);
  });

  it('shows malformed Base64 as written', async () => {
    const toc =
      '<xar><toc><file><name enctype="base64">!!!=x</name><type>file</type></file></toc></xar>';
    const info = await read(buildXar({ rawToc: toc }));
    expect(tableOf(info, 'Contents')[0][0]).toBe('!!!=x');
  });

  it('cuts a huge Base64 name to the name cap without decoding it all', async () => {
    const toc = `<xar><toc><file><name enctype="base64">${'QUJD'.repeat(250_000)}</name><type>file</type></file></toc></xar>`;
    const info = await read(buildXar({ rawToc: toc }));
    expect(tableOf(info, 'Contents')[0][0]).toHaveLength(255);
  });
});

describe('readXar: compression wrappers', () => {
  const viaPackage = (bytes: Uint8Array) => readPackage(bytesSource(bytes), 'a.pkg');
  const gzipToc = (xml: Uint8Array): Uint8Array =>
    gzipSync(xml, { filename: 'n'.repeat(256 * 1024) });
  const withHeader = (edit: (z: Uint8Array) => void) => (xml: Uint8Array) => {
    const z = zlibSync(xml);
    edit(z);
    return z;
  };

  it('reads a normal zlib table of contents, directly and through readPackage', async () => {
    const bytes = buildXar({ files: [{ name: 'a.txt', data: 'x' }] });
    expect(tableOf(await read(bytes), 'Contents')).toEqual([['a.txt', '1 byte']]);
    expect((await viaPackage(bytes)).format).toBe('xar archive');
  });

  it('refuses a gzip-wrapped table of contents with a huge file name, quickly', async () => {
    const bytes = buildXar({ files: [{ name: 'a' }], compressToc: gzipToc });
    for (const run of [read, viaPackage]) {
      const start = performance.now();
      await expect(run(bytes)).rejects.toThrow(PackageError);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });

  it('refuses a zlib header with FDICT set or a bad check value', async () => {
    const fdict = buildXar({
      compressToc: withHeader((z) => {
        z[1] = (z[1] & 0xc0) | 0x20;
        z[1] |= 31 - (((z[0] << 8) | z[1]) % 31);
      }),
    });
    const badCheck = buildXar({ compressToc: withHeader((z) => (z[1] ^= 1)) });
    for (const bytes of [fdict, badCheck]) {
      await expect(read(bytes)).rejects.toThrow(PackageError);
      await expect(viaPackage(bytes)).rejects.toThrow(PackageError);
    }
  });

  it('warns about a gzip-wrapped PackageInfo with a huge file name, quickly', async () => {
    const bytes = buildXar({
      files: [
        {
          name: 'PackageInfo',
          data: packageInfoXml(),
          encoding: 'gzip',
          gzipNameLength: 256 * 1024,
        },
      ],
    });
    for (const run of [read, viaPackage]) {
      const start = performance.now();
      const info = await run(bytes);
      expect(performance.now() - start).toBeLessThan(500);
      expect(info.warnings.join(' ')).toContain('PackageInfo');
      expect(tableOf(info, 'Components')).toEqual([]);
    }
  });

  it('still reads a short true-gzip PackageInfo through the bounded gzip reader', async () => {
    const info = await read(
      buildXar({
        files: [
          {
            name: 'PackageInfo',
            data: packageInfoXml({ identifier: 'com.gz' }),
            encoding: 'gzip',
          },
        ],
      }),
    );
    expect(tableOf(info, 'Components')[0][0]).toBe('com.gz');
  });
});

describe('readXar: what counts as a signature', () => {
  const cert = buildCertificate('Developer ID Installer: Example Inc', 'Developer ID CA');
  const sigRows = async (spec: XarSpec) => rowsOf(await read(buildXar(spec)), 'Signature');
  const notASignature = (rows: Record<string, string>): void => {
    expect(rows['Status']).toContain('A signature element is present but');
    expect(rows['Status']).not.toContain('signature present, not verified');
    expect(rows['Signer']).toBeUndefined();
    expect(rows['Issued by']).toBeUndefined();
  };

  it('accepts a complete RSA signature and names its kind', async () => {
    const rows = await sigRows({ signature: { certificate: cert } });
    expect(rows['Status']).toContain('signature present, not verified');
    expect(rows['Kind']).toBe('RSA (signature)');
    expect(rows['Signer']).toBe('Developer ID Installer: Example Inc');
  });

  it('accepts a CMS x-signature, and reports both kinds when both exist', async () => {
    const cms = await sigRows({
      signature: { element: 'x-signature', style: 'CMS', certificate: cert },
    });
    expect(cms['Kind']).toBe('CMS (x-signature)');
    const toc =
      '<xar><toc><signature style="RSA"><offset>20</offset><size>256</size><KeyInfo><X509Data><X509Certificate>QUJD</X509Certificate></X509Data></KeyInfo></signature>' +
      '<x-signature style="CMS"><offset>276</offset><size>8</size><KeyInfo><X509Data><X509Certificate>QUJD</X509Certificate></X509Data></KeyInfo></x-signature></toc></xar>';
    const bytes = buildXar({ rawToc: toc });
    const padded = new Uint8Array(bytes.length + 512);
    padded.set(bytes);
    expect(rowsOf(await read(padded), 'Signature')['Kind']).toBe(
      'RSA (signature), CMS (x-signature)',
    );
  });

  it('refuses a signature element with a zero or missing size', async () => {
    notASignature(await sigRows({ signature: { size: 0, certificate: cert } }));
    notASignature(await sigRows({ signature: { size: null, certificate: cert } }));
  });

  it('refuses a signature element with no offset or no style', async () => {
    notASignature(await sigRows({ signature: { offset: null, certificate: cert } }));
    notASignature(await sigRows({ signature: { style: '', certificate: cert } }));
  });

  it('refuses a signature whose bytes are not inside the file', async () => {
    notASignature(await sigRows({ signature: { offset: 10_000_000, certificate: cert } }));
    notASignature(await sigRows({ signature: { noHeapBytes: true, certificate: cert } }));
    notASignature(await sigRows({ signature: { size: 2 ** 40, certificate: cert } }));
  });

  it('refuses a signature element with no certificate', async () => {
    notASignature(await sigRows({ signature: { certificate: null } }));
  });

  it('claims nothing for a certificate with no signature element', async () => {
    const toc =
      '<xar><toc><file><name>a</name><type>file</type></file><KeyInfo><X509Data><X509Certificate>QUJD</X509Certificate></X509Data></KeyInfo></toc></xar>';
    const info = await read(buildXar({ rawToc: toc }));
    expect(section(info, 'Signature')).toBeUndefined();
  });
});

describe('readXar: claims about installing', () => {
  const root = async (auth: string | null) =>
    rowsOf(await read(buildProduct({ components: [{ dir: 'A.pkg', info: { auth } }] })), 'Package')[
      'Installs as root'
    ];

  it('says root only for auth="root", says no for another stated value, and nothing when absent', async () => {
    expect(await root('root')).toContain('Yes');
    expect(await root('none')).toBe('No (PackageInfo auth="none")');
    expect(await root(null)).toBeUndefined();
  });

  it('reports installation checks only when the element names a script', async () => {
    const check = async (xml: string) =>
      rowsOf(await read(buildXar({ files: [{ name: 'Distribution', data: xml }] })), 'Package')[
        'Installation checks'
      ];
    expect(
      await check(
        '<installer-gui-script><installation-check script="f()"/></installer-gui-script>',
      ),
    ).toContain('JavaScript');
    expect(
      await check('<installer-gui-script><installation-check/></installer-gui-script>'),
    ).toBeUndefined();
  });
});

describe('readXar: guards', () => {
  const entryXml = (inner: string): string => `<xar><toc>${inner}</toc></xar>`;
  const dist = (xml: string) => read(buildXar({ files: [{ name: 'Distribution', data: xml }] }));

  it('refuses a one-byte table of contents as not a zlib stream', async () => {
    const bytes = new Uint8Array(29);
    const header = new DataView(bytes.buffer);
    header.setUint32(0, 0x78617221, false);
    header.setUint16(4, 28, false);
    header.setBigUint64(8, 1n, false);
    header.setBigUint64(16, 10n, false);
    await expect(read(bytes)).rejects.toThrow(/not a zlib stream/);
  });

  it('refuses a document with no toc element', async () => {
    await expect(read(buildXar({ rawToc: '<xar><other/></xar>' }))).rejects.toThrow(
      /no table of contents/,
    );
  });

  it('finds a toc element that has no xar element around it', async () => {
    const info = await read(buildXar({ rawToc: '<toc/>' }));
    expect(info.format).toBe('xar archive');
  });

  it('counts a data-bearing entry with no type as a file, and a typed directory as not', async () => {
    const toc = entryXml(
      '<file><name>untyped</name><data><length>1</length><offset>20</offset><size>7</size></data></file>' +
        '<file><name>dir</name><type>directory</type></file>',
    );
    expect(tableOf(await read(buildXar({ rawToc: toc })), 'Contents')).toEqual([
      ['untyped', '7 bytes'],
    ]);
  });

  it('reads a size that is not plain digits, or too big to be exact, as zero', async () => {
    const file = (size: string) =>
      `<file><name>f</name><type>file</type><data><size>${size}</size></data></file>`;
    for (const size of ['12abc', '', '99999999999999999999']) {
      const info = await read(buildXar({ rawToc: entryXml(file(size)) }));
      expect(tableOf(info, 'Contents')).toEqual([['f', '0 bytes']]);
    }
    const padded = await read(buildXar({ rawToc: entryXml(file(' 7 ')) }));
    expect(tableOf(padded, 'Contents')).toEqual([['f', '7 bytes']]);
  });

  it('converts a creation time with an offset to UTC, and drops one that is not a date', async () => {
    const created = async (value: string) =>
      rowsOf(
        await read(buildXar({ rawToc: entryXml(`<creation-time>${value}</creation-time>`) })),
        'Archive',
      )['Created'];
    expect(await created('2024-03-05T10:20:30+02:00')).toBe('2024-03-05 08:20:30 UTC');
    expect(await created('2024-03-05T10:20:30Z')).toBe('2024-03-05 10:20:30 UTC');
    expect(await created('not a date')).toBeUndefined();
  });

  it('shows a Base64 name with no Base64 characters as written', async () => {
    const toc = entryXml('<file><name enctype="base64">***</name><type>file</type></file>');
    expect(tableOf(await read(buildXar({ rawToc: toc })), 'Contents')[0][0]).toBe('***');
  });

  it('warns when the table lists more entries than it will walk', async () => {
    // Name-less entries also reach the empty-name path. 50,001 elements stay under the node cap.
    const toc = entryXml('<file/>'.repeat(50_001));
    const info = await read(buildXar({ rawToc: toc }));
    expect(info.warnings.join(' ')).toContain('more entries than MarkCopy will read');
  });

  it('warns that an entry with no offset could not be read', async () => {
    const toc = entryXml(
      '<file><name>Distribution</name><type>file</type><data><length>5</length><size>5</size></data></file>',
    );
    const info = await read(buildXar({ rawToc: toc }));
    expect(info.warnings).toContain('The Distribution file could not be read.');
  });

  it('warns when a PackageInfo has no pkg-info element', async () => {
    const info = await read(buildXar({ files: [{ name: 'PackageInfo', data: '<other/>' }] }));
    expect(info.warnings).toContain('The package description at PackageInfo could not be read.');
  });

  it('reads only the first 64 packages and says so', async () => {
    const files = Array.from({ length: 65 }, (_, i) => ({
      name: `p${i}`,
      children: [{ name: 'PackageInfo', data: packageInfoXml({ identifier: `com.p${i}` }) }],
    }));
    const info = await read(buildXar({ files }));
    expect(info.warnings).toContain('Only the first 64 of 65 packages were read.');
    expect(tableOf(info, 'Components')).toHaveLength(64);
  });

  it('merges bundles by id, and keeps a bundle with no id or no bundle-version list', async () => {
    const xml =
      '<pkg-info identifier="com.a">' +
      '<bundle id="x" path="./X.app"/>' +
      '<bundle id="y" CFBundleVersion="9"/>' +
      '<bundle CFBundleShortVersionString="1.0" path="p"/>' +
      '</pkg-info>';
    const info = await read(buildXar({ files: [{ name: 'PackageInfo', data: xml }] }));
    expect(tableOf(info, 'Bundles')).toEqual([
      ['x', '', './X.app'],
      ['y', '9', ''],
      ['', '1.0', 'p'],
    ]);
  });

  it('skips a pkg-ref with no id, merges repeats, and drops duplicate or untitled choices', async () => {
    const info = await dist(
      '<installer-gui-script><pkg-ref/><pkg-ref id="a"/><pkg-ref id="a" version="2"/>' +
        '<choice title="X"/><choice title="X"/><choice/></installer-gui-script>',
    );
    expect(tableOf(info, 'Components')).toEqual([['a', '2', '', '']]);
    expect(tableOf(info, 'Choices')).toEqual([['X']]);
  });

  it('stops at 200 pkg-refs and 100 choices', async () => {
    const refs = Array.from({ length: 201 }, (_, i) => `<pkg-ref id="r${i}"/>`).join('');
    const choices = Array.from({ length: 101 }, (_, i) => `<choice title="c${i}"/>`).join('');
    const info = await dist(`<installer-gui-script>${refs}${choices}</installer-gui-script>`);
    const ids = tableOf(info, 'Components').map((r) => r[0]);
    expect(ids).toHaveLength(200);
    expect(ids).not.toContain('r200');
    const titles = tableOf(info, 'Choices').map((r) => r[0]);
    expect(titles).toHaveLength(100);
    expect(titles).not.toContain('c100');
  });

  describe('certificates inside a signature element', () => {
    const signed = async (certificateText: string) =>
      rowsOf(
        await read(
          buildXar({
            rawToc: entryXml(
              '<signature style="RSA"><offset>0</offset><size>1</size>' +
                `<KeyInfo><X509Data><X509Certificate>${certificateText}</X509Certificate></X509Data></KeyInfo></signature>`,
            ),
          }),
        ),
        'Signature',
      );

    it('reports a signature but no signer when the certificate is not Base64', async () => {
      const rows = await signed('A');
      expect(rows['Status']).toContain('signature present, not verified');
      expect(rows['Signer']).toBeUndefined();
    });

    it('reports a signature but no signer when the certificate is not DER', async () => {
      const rows = await signed('QUJD');
      expect(rows['Status']).toContain('signature present, not verified');
      expect(rows['Signer']).toBeUndefined();
    });

    it('does not decode a certificate element larger than the certificate cap', async () => {
      const rows = await signed('QUJD'.repeat(40_000));
      expect(rows['Status']).toContain('signature present, not verified');
      expect(rows['Signer']).toBeUndefined();
    });
  });
});
