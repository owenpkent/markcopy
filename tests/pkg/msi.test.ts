import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader, ReadError } from '../../src/binary/reader';
import { formatBytes } from '../../src/binary/html';
import { readMsi, decodeStreamName } from '../../src/pkg/msi';
import { PackageError, type PackageInfo, type InfoSection } from '../../src/pkg/model';
import { renderPackageHtml } from '../../src/pkg/render';
import { buildCfb } from './cfbFixture';
import {
  buildMsi,
  CLSID_PATCH,
  CLSID_TRANSFORM,
  filetime,
  packName,
  summaryStream,
  type MsiSpec,
} from './msiFixture';

const RLO = String.fromCharCode(0x202e);

const read = (spec: MsiSpec = {}) => readMsi(new RangeReader(bytesSource(buildMsi(spec))));

function section(info: PackageInfo, heading: string): InfoSection | undefined {
  return info.sections.find((s) => s.heading === heading);
}

/** One row of a property section, or undefined. */
function field(info: PackageInfo, heading: string, label: string): string | undefined {
  const s = section(info, heading);
  return s?.kind === 'properties' ? s.rows.find((r) => r[0] === label)?.[1] : undefined;
}

const signer = {
  subject: { commonName: 'Contoso Software', organization: 'Contoso Ltd' },
  issuer: { commonName: 'Contoso Code Signing CA' },
  notBefore: '230615000000Z',
  notAfter: '260615235959Z',
};

const rich: MsiSpec = {
  properties: {
    ProductName: 'Contoso Tool',
    ProductVersion: '2.1.0',
    Manufacturer: 'Contoso Ltd',
    ProductCode: '{11111111-2222-3333-4444-555555555555}',
    UpgradeCode: '{66666666-7777-8888-9999-000000000000}',
    ProductLanguage: '1033',
    ALLUSERS: '1',
    ARPCONTACT: 'Support Desk',
    ARPURLINFOABOUT: 'https://contoso.example/about',
    ARPHELPLINK: 'https://contoso.example/help',
    ARPCOMMENTS: 'A tool',
    REINSTALLMODE: 'amus',
    ARPNOMODIFY: '1',
    Extra1: 'x',
    Extra2: 'y',
  },
  summary: {
    title: 'Installation Database',
    subject: 'Contoso Tool Subject',
    author: 'Contoso Ltd',
    keywords: 'Installer, MSI',
    comments: 'This installer database installs Contoso Tool.',
    template: 'x64;1033,1031',
    revision: '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}',
    created: filetime(1700000000),
    saved: filetime(1700086400),
    pageCount: 500,
    wordCount: 2,
    application: 'WiX Toolset (4.0)',
  },
  tables: [
    { name: 'File', columns: ['s', 's', 's', 'i4', 's', 's', 'i2', 'i2'], rows: 12 },
    { name: 'Component', columns: ['s', 's', 's', 'i2', 's', 's'], rows: 7 },
    { name: 'Feature', columns: ['s', 's', 's', 's', 'i2', 'i2', 's', 'i2'], rows: 2 },
    { name: 'Registry', columns: ['s', 'i2', 's', 's', 's', 's'], rows: 0 },
    {
      name: 'ServiceInstall',
      columns: ['s', 's', 's', 's', 'i4', 'i4', 'i4', 's', 's', 's', 's', 's'],
      rows: 1,
    },
    { name: 'CustomAction', columns: ['s', 'i2', 's', 's', 'i4'], rows: 4 },
    { name: 'LaunchCondition', columns: ['s', 's'], rows: 1 },
    { name: 'Binary', columns: ['s', 'b'], rows: 2 },
  ],
  streams: [
    { name: 'Data1.cab', size: 5000 },
    { name: 'Binary.Check', size: 300 },
    { name: 'Binary.Fix', size: 200 },
    { name: 'Icon.app.ico', size: 100 },
    { name: 'MsiDigitalCertificate.Cert1', size: 40 },
  ],
  storages: ['1031', '1036'],
  signature: signer,
  signatureEx: true,
};

describe('decodeStreamName', () => {
  it('unpacks two characters per unit, one for a lone unit, and the table prefix', () => {
    // 'A' is symbol 10 and 'b' is symbol 37: value 10 + (37 << 6).
    expect(decodeStreamName(String.fromCharCode(0x3800 + 10 + (37 << 6)))).toEqual({
      name: 'Ab',
      table: false,
    });
    expect(decodeStreamName(String.fromCharCode(0x4800 + 1))).toEqual({ name: '1', table: false });
    expect(decodeStreamName(String.fromCharCode(0x4840, 0x4800 + 63))).toEqual({
      name: '_',
      table: true,
    });
  });

  it('keeps characters outside the alphabet and round-trips packed names', () => {
    for (const text of ['Binary.My Tool', 'Icon.a-b', 'x', '_StringPool', 'CustomAction']) {
      expect(decodeStreamName(packName(text, false)).name).toBe(text);
      expect(decodeStreamName(packName(text, true))).toEqual({ name: text, table: true });
    }
    const summary = String.fromCharCode(5) + 'SummaryInformation';
    expect(decodeStreamName(summary).name).toBe(summary);
  });
});

describe('readMsi: the package', () => {
  it('reads every field of the Package section', async () => {
    const info = await read(rich);
    expect(info.format).toBe('Windows Installer package');
    expect(info.title).toBe('Contoso Tool 2.1.0');
    expect(info.summary).toBe('Contoso Ltd');
    expect(info.warnings).toEqual([]);
    const f = (label: string) => field(info, 'Package', label);
    expect(f('Product name')).toBe('Contoso Tool');
    expect(f('Version')).toBe('2.1.0');
    expect(f('Manufacturer')).toBe('Contoso Ltd');
    expect(f('Product code')).toBe('{11111111-2222-3333-4444-555555555555}');
    expect(f('Upgrade code')).toBe('{66666666-7777-8888-9999-000000000000}');
    expect(f('Package code')).toBe('{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}');
    expect(f('Platform')).toBe('x64 (64-bit)');
    expect(f('Languages')).toBe('English (US) (1033), German (1031)');
    expect(f('Install scope')).toBe('Per-machine (all users)');
    expect(f('Minimum installer version')).toBe('5.0');
    expect(f('Needs elevation')).toBe('Yes');
    expect(f('Source files')).toBe('Compressed');
    expect(f('Created with')).toBe('WiX Toolset (4.0)');
    expect(f('Created')).toBe('2023-11-14 22:13:20 UTC');
    expect(f('Last saved')).toBe('2023-11-15 22:13:20 UTC');
    expect(f('Subject')).toBe('Contoso Tool Subject');
    expect(f('Comments')).toBe('This installer database installs Contoso Tool.');
    expect(f('Keywords')).toBe('Installer, MSI');
    expect(f('Contact')).toBe('Support Desk');
    expect(f('Website')).toBe('https://contoso.example/about');
    expect(f('Help link')).toBe('https://contoso.example/help');
    expect(f('Description')).toBe('A tool');
    expect(f('Reinstall mode')).toBe('amus');
    expect(f('Hides Modify')).toBe('Yes');
    expect(f('Hides Remove')).toBeUndefined();
    expect(f('Properties in database')).toBe('15');
  });

  it('counts rows from the table sizes and the column types', async () => {
    for (const wide of [false, true]) {
      const info = await read({ ...rich, wide });
      const f = (label: string) => field(info, 'What it installs', label);
      expect(f('Files installed')).toBe('12');
      expect(f('Components')).toBe('7');
      expect(f('Features')).toBe('2');
      expect(f('Registry values written')).toBe('0');
      expect(f('Services installed')).toBe('1');
      expect(f('Custom actions (code run during install)')).toBe('4');
      expect(f('Launch conditions')).toBe('1');
      expect(f('Shortcuts')).toBeUndefined();
      expect(f('Has binary resources')).toBe('Yes');
    }
  });

  it('shows presence instead of a count when a table is not a whole number of rows', async () => {
    const info = await read({
      ...rich,
      tables: [{ name: 'File', columns: ['s', 's', 'i4'], rows: 3, extra: 1 }],
    });
    expect(field(info, 'What it installs', 'Files installed')).toBe('Yes');
  });

  it('works out the install scope', async () => {
    const scope = async (properties: Record<string, string>) =>
      field(
        await read({ properties: { ProductName: 'P', ...properties } }),
        'Package',
        'Install scope',
      );
    expect(await scope({ ALLUSERS: '1' })).toBe('Per-machine (all users)');
    expect(await scope({})).toBe('Per-user');
    expect(await scope({ ALLUSERS: '2' })).toBe('Per-machine, or per-user when not elevated');
    expect(await scope({ ALLUSERS: '2', MSIINSTALLPERUSER: '1' })).toBe(
      'Per-user by default, per-machine when run elevated',
    );
  });

  it('names the platforms and the elevation and compression flags', async () => {
    const platform = async (template: string) =>
      field(await read({ summary: { template } }), 'Package', 'Platform');
    expect(await platform('Intel;1033')).toBe('x86 (32-bit)');
    expect(await platform('x64;1033')).toBe('x64 (64-bit)');
    expect(await platform('Arm64;1033')).toBe('ARM64 (64-bit)');
    expect(await platform('Intel64;1033')).toBe('Itanium (64-bit)');
    expect(await platform('Odd;1033')).toBe('Odd');

    const words = async (wordCount: number) => read({ summary: { wordCount, pageCount: 301 } });
    const a = await words(8 | 2);
    expect(field(a, 'Package', 'Needs elevation')).toBe('No');
    expect(field(a, 'Package', 'Source files')).toBe('Compressed');
    expect(field(a, 'Package', 'Minimum installer version')).toBe('3.1');
    const b = await words(1 | 4);
    expect(field(b, 'Package', 'Needs elevation')).toBe('Yes');
    expect(field(b, 'Package', 'Source files')).toBe('Uncompressed');
    expect(field(b, 'Package', 'Administrative image')).toBe('Yes');
  });

  it('falls back to the summary for a package with no Property rows', async () => {
    const info = await read({ summary: { subject: 'Subject Name', author: 'Some Author' } });
    expect(info.title).toBe('Subject Name');
    expect(info.summary).toBe('Some Author');
  });

  it('decodes a UTF-8 code page in the summary and the string pool, and wide comments', async () => {
    const info = await read({
      codePage: 65001,
      properties: { ProductName: 'Café Tool', Manufacturer: 'Müller' },
      summary: { codePage: 65001, subject: 'Café', wideComments: 'Wide 中 comment' },
    });
    expect(field(info, 'Package', 'Product name')).toBe('Café Tool');
    expect(field(info, 'Package', 'Manufacturer')).toBe('Müller');
    expect(field(info, 'Package', 'Subject')).toBe('Café');
    expect(field(info, 'Package', 'Comments')).toBe('Wide 中 comment');
  });

  it('reads a package with no summary stream', async () => {
    const info = await read({ summary: false, properties: { ProductName: 'Only Props' } });
    expect(info.title).toBe('Only Props');
    expect(field(info, 'Package', 'Created')).toBeUndefined();
  });
});

describe('readMsi: embedded files', () => {
  it('lists cabinets, groups the small streams, and counts storages', async () => {
    const info = await read(rich);
    const embedded = section(info, 'Embedded files');
    expect(embedded?.kind).toBe('table');
    if (embedded?.kind !== 'table') {
      return;
    }
    expect(embedded.columns).toEqual(['Stream', 'Size']);
    expect(embedded.rows).toEqual([
      ['Data1.cab', formatBytes(5000)],
      ['2 custom action binaries (Binary.*)', formatBytes(500)],
      ['1 icons (Icon.*)', formatBytes(100)],
      ['1 signature certificates and hashes (MsiDigital*)', formatBytes(40)],
      ['2 embedded storages (transforms or sub-packages)', ''],
    ]);
  });

  it('caps the list of other streams at 200', async () => {
    const streams = Array.from({ length: 250 }, (_, i) => ({ name: `Extra${i}`, size: 10 }));
    const info = await read({ streams });
    const embedded = section(info, 'Embedded files');
    expect(embedded?.kind === 'table' && embedded.rows.length).toBe(200);
    expect(embedded?.kind === 'table' && embedded.note).toBe(
      'Showing the first 200 of 250 streams.',
    );
  });
});

describe('readMsi: signature', () => {
  it('reports the signer and the hash extension, never a verdict', async () => {
    const info = await read(rich);
    expect(field(info, 'Signature', 'Status')).toBe(
      'Authenticode signature present, not verified by MarkCopy',
    );
    expect(field(info, 'Signature', 'Signer')).toBe('Contoso Software');
    expect(field(info, 'Signature', 'Issued by')).toBe('Contoso Code Signing CA');
    expect(field(info, 'Signature', 'Hash extension')).toBe('MsiDigitalSignatureEx present');
    const s = section(info, 'Signature');
    expect(s?.kind === 'properties' && s.note).toMatch(/does not check the signature/);
  });

  it('still reports a signature it cannot parse', async () => {
    const info = await read({ signature: new Uint8Array(20).fill(7) });
    expect(field(info, 'Signature', 'Status')).toMatch(/present/);
    expect(field(info, 'Signature', 'Signer')).toBeUndefined();
  });

  it('has no Signature section for an unsigned package', async () => {
    expect(section(await read({}), 'Signature')).toBeUndefined();
  });
});

describe('readMsi: what the file is', () => {
  it('names a patch and a transform by the root CLSID', async () => {
    const patch = await read({ clsid: CLSID_PATCH, noPool: true, summary: { title: 'A patch' } });
    expect(patch.format).toBe('Windows Installer patch');
    expect(patch.warnings).toEqual([]);
    const transform = await read({ clsid: CLSID_TRANSFORM, noPool: true });
    expect(transform.format).toBe('Windows Installer transform');
  });

  it('recognises a package by its string pool when the CLSID is missing', async () => {
    const info = await read({ clsid: '{00000000-0000-0000-0000-000000000000}' });
    expect(info.format).toBe('Windows Installer package');
  });

  it('says what an Office document or other compound file is not', async () => {
    const doc = buildCfb({ streams: [{ name: 'WordDocument', data: new Uint8Array(600) }] });
    const error = await readMsi(new RangeReader(bytesSource(doc))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PackageError);
    expect((error as Error).message).toBe(
      'it is an OLE compound file, but not a Windows Installer package.',
    );
  });

  it('rejects a file that is not a compound file', async () => {
    await expect(
      readMsi(new RangeReader(bytesSource(new Uint8Array(4096)))),
    ).rejects.toBeInstanceOf(PackageError);
  });

  it('warns when a package has no string table', async () => {
    const info = await read({ noPool: true });
    expect(info.warnings.join(' ')).toMatch(/no string table/);
  });
});

describe('readMsi: hostile files', () => {
  it('ignores string references that point outside the pool', async () => {
    const info = await read({
      properties: { ProductName: 'P' },
      propertyBytes: Uint8Array.from([0xff, 0xff, 0x00, 0x80, 0xfe, 0xff, 0xff, 0xff]),
    });
    expect(info.title).toBeUndefined();
    expect(info.warnings).toEqual([]);
  });

  it('survives pool entries whose lengths run past the string data', async () => {
    const pool = new Uint8Array(4 + 4 * 3);
    pool.set([0xe4, 0x04, 0, 0]);
    pool.set([0xff, 0xff, 1, 0, 0xff, 0xff, 1, 0, 0x0b, 0, 1, 0], 4);
    const info = await read({ poolBytes: pool, dataBytes: new Uint8Array(5) });
    expect(info.format).toBe('Windows Installer package');
  });

  it('reads a long string and cuts it to a displayable length', async () => {
    // Slot 1: "ProductName". Slots 2 and 3: a string of 65536 + 7 bytes (the
    // high word is the first slot's count, the low word the second's length).
    const pool = Uint8Array.from([0xe4, 0x04, 0, 0, 11, 0, 1, 0, 0, 0, 1, 0, 7, 0, 1, 0]);
    const name = new TextEncoder().encode('ProductName');
    const data = new Uint8Array(11 + 65543).fill(0x78);
    data.set(name, 0);
    const info = await read({
      poolBytes: pool,
      dataBytes: data,
      propertyBytes: Uint8Array.from([1, 0, 3, 0]),
    });
    expect(field(info, 'Package', 'Product name')).toBe('x'.repeat(2048));
  });

  it('survives a summary whose offsets point outside the stream', async () => {
    const summary = summaryStream({ title: 'T', subject: 'S' });
    const view = new DataView(summary.buffer);
    // The first (property ID, offset) pair sits at 56; send it far away, and claim a huge count.
    view.setUint32(60, 0x7fffffff, true);
    expect((await read({ summaryBytes: summary })).format).toBe('Windows Installer package');
    view.setUint32(52, 0xffffffff, true);
    expect((await read({ summaryBytes: summary })).format).toBe('Windows Installer package');
    expect((await read({ summaryBytes: new Uint8Array(10) })).format).toBe(
      'Windows Installer package',
    );
  });

  it('ignores a created date that is not a date', async () => {
    const info = await read({ summary: { created: 1n, saved: 0xffffffffffffffffn >> 1n } });
    expect(field(info, 'Package', 'Created')).toBeUndefined();
    expect(field(info, 'Package', 'Last saved')).toBeUndefined();
  });

  it('reports a package whose string stream is larger than it will read as a warning', async () => {
    const info = await read({ dataBytes: new Uint8Array(17 * 1024 * 1024) });
    expect(info.warnings.join(' ')).toMatch(/string table could not be read/);
    expect(info.format).toBe('Windows Installer package');
  });

  it('never throws anything but a ReadError on a truncated file', async () => {
    const bytes = buildMsi(rich);
    const lengths: number[] = [];
    for (let n = 0; n <= 1024; n++) {
      lengths.push(n);
    }
    for (let n = 1024; n < bytes.length; n += 47) {
      lengths.push(n);
    }
    for (const n of lengths) {
      try {
        await readMsi(new RangeReader(bytesSource(bytes.subarray(0, n))));
      } catch (error) {
        expect(error).toBeInstanceOf(ReadError);
      }
    }
  });
});

describe('readMsi: rendering', () => {
  it('escapes what the file says and strips text-direction overrides', async () => {
    const info = await read({
      // The string pool has its own code page, and the override is not a
      // character windows-1252 has: the pool has to say UTF-8 to carry it.
      codePage: 65001,
      properties: {
        ProductName: '<img src=x onerror=1>',
        Manufacturer: `Evil${RLO}Corp`,
      },
      summary: { codePage: 65001, comments: `Note${RLO} here` },
    });
    expect(field(info, 'Package', 'Manufacturer')).toBe('EvilCorp');
    const html = renderPackageHtml(info, { fileName: 'evil.msi', fileSize: 1234 });
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain(RLO);
    expect(html).toContain('Windows Installer package');
  });
});
