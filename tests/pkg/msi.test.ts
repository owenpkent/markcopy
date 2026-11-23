// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader, ReadError } from '../../src/binary/reader';
import { formatBytes } from '../../src/binary/html';
import { readMsi, decodeStreamName } from '../../src/pkg/msi';
import { PackageError, type PackageInfo, type InfoSection } from '../../src/pkg/model';
import { renderPackageHtml } from '../../src/pkg/render';
import { tlv } from '../pe/fixture';
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
    expect(f('Platform (from the summary template)')).toBe('x64 (64-bit)');
    expect(f('Languages')).toBe('English (US) (1033), German (1031)');
    expect(f('Install scope (from ALLUSERS)')).toBe('ALLUSERS=1: the per-machine context');
    expect(f('Minimum installer version')).toBe('5.0');
    expect(f('Elevation (summary flag)')).toBe('Can be required');
    expect(f('Source files (summary flag)')).toBe('Compressed');
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
      const f = (label: string) => field(info, 'What the tables define', label);
      expect(f('File table rows')).toBe('12');
      expect(f('Component table rows')).toBe('7');
      expect(f('Feature table rows')).toBe('2');
      expect(f('Registry table rows')).toBe('0');
      expect(f('ServiceInstall table rows')).toBe('1');
      expect(f('CustomAction table rows')).toBe('4');
      expect(f('LaunchCondition table rows')).toBe('1');
      expect(f('Shortcut table rows')).toBeUndefined();
      expect(f('Binary table')).toBe('present');
    }
  });

  it('shows presence instead of a count when a table is not a whole number of rows', async () => {
    const info = await read({
      ...rich,
      tables: [{ name: 'File', columns: ['s', 's', 'i4'], rows: 3, extra: 1 }],
    });
    expect(field(info, 'What the tables define', 'File table rows')).toBe('present');
  });

  it('states the install context the properties declare, cell by cell', async () => {
    // From Microsoft's ALLUSERS and MSIINSTALLPERUSER pages: unset ALLUSERS is
    // per-user, 1 is per-machine, 2 hands the choice to Windows Installer 5.0's
    // MSIINSTALLPERUSER (1 per-user, empty per-machine); the property is ignored
    // unless ALLUSERS is 2.
    const scope = async (properties: Record<string, string>) =>
      field(
        await read({
          properties: { ProductName: 'P', ...properties },
          summary: { pageCount: 500 },
        }),
        'Package',
        'Install scope (from ALLUSERS)',
      );
    const older = 'earlier Windows Installer versions ignore MSIINSTALLPERUSER';
    expect(await scope({})).toBe('ALLUSERS not set: the per-user context');
    expect(await scope({ ALLUSERS: '' })).toBe('ALLUSERS not set: the per-user context');
    expect(await scope({ ALLUSERS: '1' })).toBe('ALLUSERS=1: the per-machine context');
    expect(await scope({ ALLUSERS: '2', MSIINSTALLPERUSER: '1' })).toBe(
      `ALLUSERS=2 and MSIINSTALLPERUSER=1: requests per-user (Windows Installer 5.0 and later; ${older})`,
    );
    expect(await scope({ ALLUSERS: '2', MSIINSTALLPERUSER: '' })).toBe(
      `ALLUSERS=2 and MSIINSTALLPERUSER empty: requests per-machine (Windows Installer 5.0 and later; ${older})`,
    );
    expect(await scope({ ALLUSERS: '2' })).toMatch(
      /^ALLUSERS=2, MSIINSTALLPERUSER not set: dual-purpose/,
    );
    expect(await scope({ ALLUSERS: '2', MSIINSTALLPERUSER: 'x' })).toMatch(
      /not a documented value/,
    );
    expect(await scope({ ALLUSERS: '7' })).toBe('ALLUSERS="7": not a documented value');
    // Ignored unless ALLUSERS is 2, so it changes nothing here.
    expect(await scope({ ALLUSERS: '1', MSIINSTALLPERUSER: '1' })).toBe(
      'ALLUSERS=1: the per-machine context',
    );
    expect(await scope({ MSIINSTALLPERUSER: '1' })).toBe('ALLUSERS not set: the per-user context');
    // Never says elevation changes a per-user declaration.
    expect(await scope({ ALLUSERS: '2', MSIINSTALLPERUSER: '1' })).not.toMatch(/elevat/i);
  });

  it('names the platforms and the elevation and compression flags', async () => {
    const platform = async (template: string) =>
      field(
        await read({ summary: { template } }),
        'Package',
        'Platform (from the summary template)',
      );
    expect(await platform('Intel;1033')).toBe('x86 (32-bit)');
    expect(await platform('x64;1033')).toBe('x64 (64-bit)');
    expect(await platform('Arm64;1033')).toBe('ARM64 (64-bit)');
    expect(await platform('Intel64;1033')).toBe('Itanium (64-bit)');
    expect(await platform('Odd;1033')).toBe('Odd');

    const words = async (wordCount: number) => read({ summary: { wordCount, pageCount: 301 } });
    const a = await words(8 | 2);
    expect(field(a, 'Package', 'Elevation (summary flag)')).toBe('Not required');
    expect(field(a, 'Package', 'Source files (summary flag)')).toBe('Compressed');
    expect(field(a, 'Package', 'Minimum installer version')).toBe('3.1');
    const b = await words(1 | 4);
    expect(field(b, 'Package', 'Elevation (summary flag)')).toBe('Can be required');
    expect(field(b, 'Package', 'Source files (summary flag)')).toBe('Uncompressed');
    expect(field(b, 'Package', 'Source is (summary flag)')).toBe('An administrative image');
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

  const oid = (...b: number[]) => tlv(0x06, Uint8Array.from(b));
  const SIGNED_DATA_OID = oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02);
  const DATA_OID = oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01);
  const noSigners = tlv(
    0x30,
    SIGNED_DATA_OID,
    tlv(0xa0, tlv(0x30, tlv(0x02, Uint8Array.of(1)), tlv(0x31), tlv(0x30, DATA_OID), tlv(0x31))),
  );
  const bareCertificate = tlv(
    0x30,
    tlv(0x30, tlv(0x02, Uint8Array.of(1))),
    tlv(0x30, oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b), tlv(0x05)),
    tlv(0x03, Uint8Array.of(0, 9, 9)),
  );

  it.each([
    ['garbage', new Uint8Array(20).fill(7)],
    ['a bare certificate', bareCertificate],
    ['SignedData with no signers', noSigners],
  ])('claims no signature for a DigitalSignature stream holding %s', async (_label, signature) => {
    const info = await read({ signature, signatureEx: true });
    expect(section(info, 'Signature')).toBeUndefined();
    expect(info.warnings.join(' ')).toMatch(/not a recognised signature/);
  });

  it('claims nothing for MsiDigitalSignatureEx on its own', async () => {
    const info = await read({ signatureEx: true });
    expect(section(info, 'Signature')).toBeUndefined();
    expect(info.warnings).toEqual([]);
  });

  it('warns when the signature stream is over the read cap', async () => {
    const info = await read({ signature: new Uint8Array(300 * 1024) });
    expect(section(info, 'Signature')).toBeUndefined();
    expect(info.warnings.join(' ')).toMatch(/could not be read/);
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

  const moduleTables = [
    { name: 'ModuleSignature', columns: ['s', 'i2', 's'] as ('s' | 'i2')[], rows: 1 },
    { name: 'ModuleComponents', columns: ['s', 's', 'i2'] as ('s' | 'i2')[], rows: 2 },
  ];
  const merged = 'Merged modules (ModuleSignature rows)';

  it('calls a database a merge module only with the module evidence and none against', async () => {
    // One ModuleSignature row, ModuleComponents, no Feature table, no ProductCode.
    const info = await read({ tables: moduleTables });
    expect(info.format).toBe('Windows Installer merge module');
    expect(field(info, 'What the tables define', merged)).toBeUndefined();
  });

  it('keeps a product installer with merged-module inventory a package', async () => {
    const info = await read({
      properties: { ProductName: 'P', ProductCode: '{11111111-2222-3333-4444-555555555555}' },
      tables: [
        { name: 'Feature', columns: ['s', 's', 's', 's', 'i2', 'i2', 's', 'i2'], rows: 2 },
        { name: 'ModuleSignature', columns: ['s', 'i2', 's'], rows: 2 },
        moduleTables[1],
      ],
    });
    expect(info.format).toBe('Windows Installer package');
    expect(field(info, 'What the tables define', merged)).toBe('2');
  });

  it('keeps a one-row ModuleSignature package a package when a contrary sign is present', async () => {
    const withFeature = await read({
      tables: [...moduleTables, { name: 'Feature', columns: ['s', 'i2'], rows: 1 }],
    });
    expect(withFeature.format).toBe('Windows Installer package');
    const withProduct = await read({
      properties: { ProductCode: '{11111111-2222-3333-4444-555555555555}' },
      tables: moduleTables,
    });
    expect(withProduct.format).toBe('Windows Installer package');
    const twoRows = await read({ tables: [{ ...moduleTables[0], rows: 2 }, moduleTables[1]] });
    expect(twoRows.format).toBe('Windows Installer package');
    const noComponents = await read({ tables: [moduleTables[0]] });
    expect(noComponents.format).toBe('Windows Installer package');
  });

  it('leaves a patch template out of the platform and language rows', async () => {
    const info = await read({
      clsid: CLSID_PATCH,
      noPool: true,
      summary: { template: '{11111111-2222-3333-4444-555555555555}' },
    });
    expect(field(info, 'Package', 'Platform (from the summary template)')).toBeUndefined();
    expect(field(info, 'Package', 'Languages')).toBeUndefined();
  });

  const patchRead = (summary: MsiSpec['summary']) =>
    read({ clsid: CLSID_PATCH, noPool: true, summary });
  const pkg = (info: PackageInfo, label: string) => field(info, 'Package', label);

  it('reads a patch Word Count as the minimum installer version, with no package flags', async () => {
    // The reviewer's fixture: Word Count 4 and no Page Count.
    const info = await patchRead({ wordCount: 4 });
    expect(pkg(info, 'Minimum installer version')).toBe('3.0');
    expect(pkg(info, 'Source is (summary flag)')).toBeUndefined();
    expect(pkg(info, 'Source files (summary flag)')).toBeUndefined();
    expect(pkg(info, 'Elevation (summary flag)')).toBeUndefined();
    expect(JSON.stringify(info.sections)).not.toContain('An administrative image');
    expect(JSON.stringify(info.sections)).not.toContain('Uncompressed');
  });

  it.each([
    [2, '1.2'],
    [3, '2.0'],
    [4, '3.0'],
    [5, '3.1'],
    // Not on the Word Count page; from the Patchwiz.dll Properties table page.
    [6, '4.0'],
  ])('maps patch Word Count %i to Windows Installer %s', async (wordCount, version) => {
    const info = await patchRead({ wordCount });
    expect(pkg(info, 'Minimum installer version')).toBe(version);
  });

  it('says a patch Word Count of 1 is the MSPATCH default, not a version', async () => {
    const info = await patchRead({ wordCount: 1 });
    expect(pkg(info, 'Minimum installer version')).toBe(
      'Not stated (Word Count 1, the default: MSPATCH was used to create the patch)',
    );
  });

  it('shows an undocumented patch Word Count as such, never as the package bit field', async () => {
    for (const wordCount of [0, 7, 12]) {
      const info = await patchRead({ wordCount });
      expect(pkg(info, 'Minimum installer version')).toBe(
        `Word Count ${wordCount}: not a documented value`,
      );
      expect(pkg(info, 'Elevation (summary flag)')).toBeUndefined();
      expect(pkg(info, 'Source files (summary flag)')).toBeUndefined();
      expect(pkg(info, 'Source is (summary flag)')).toBeUndefined();
    }
  });

  it('ignores a patch Page Count, which is Null for a patch', async () => {
    const info = await patchRead({ wordCount: 3, pageCount: 500 });
    expect(pkg(info, 'Minimum installer version')).toBe('2.0');
  });

  it('reads a patch Template as product codes and Revision Number as patch codes', async () => {
    const a = '{11111111-2222-3333-4444-555555555555}';
    const b = '{66666666-7777-8888-9999-000000000000}';
    const c = '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}';
    const d = '{12345678-1234-1234-1234-123456789ABC}';
    const info = await patchRead({
      template: `${a};${b}`,
      revision: `${c}${d}`,
      keywords: 'https://example.test/one;\\\\server\\share',
      lastSavedBy: 'T1;T2',
      subject: 'Hotfix for Example',
    });
    expect(pkg(info, 'Applies to product codes (from the summary template)')).toBe(`${a}, ${b}`);
    expect(pkg(info, 'Patch code')).toBe(c);
    expect(pkg(info, 'Obsoletes patches')).toBeUndefined();
    expect(pkg(info, 'Obsolete patches (legacy list in the summary)')).toBe(
      `${d} (used when the patch has no MsiPatchSequence sequencing information, and this patch has none)`,
    );
    expect(pkg(info, 'Package code')).toBeUndefined();
    expect(pkg(info, 'Patch sources (from Keywords)')).toBe(
      'https://example.test/one, \\\\server\\share',
    );
    expect(pkg(info, 'Transforms applied, in order (from Last Saved By)')).toBe('T1, T2');
    expect(pkg(info, 'Patch description (from Subject)')).toBe('Hotfix for Example');
    expect(pkg(info, 'Product name')).toBeUndefined();
    expect(info.title).toBe('Hotfix for Example');
  });

  it('says Windows Installer 3.0 ignores the legacy obsolete list when MsiPatchSequence has rows', async () => {
    // The reviewer's fixture: minimum installer 3.0, the patch code and an older
    // patch code, and an MsiPatchSequence row with Attributes 0.
    const c = '{AAAAAAAA-1111-2222-3333-444444444444}';
    const d = '{12345678-1234-1234-1234-123456789ABC}';
    const sequence = (rows: number) =>
      read({
        clsid: CLSID_PATCH,
        summary: { wordCount: 4, revision: `${c}${d}` },
        tables: [{ name: 'MsiPatchSequence', columns: ['s', 's', 's', 'i4'], rows }],
      });
    const label = 'Obsolete patches (legacy list in the summary)';
    const withRows = await sequence(1);
    expect(pkg(withRows, 'Patch code')).toBe(c);
    expect(pkg(withRows, label)).toBe(
      `${d} (Windows Installer 3.0 and later ignore this list, because this patch has sequencing information in an MsiPatchSequence table)`,
    );
    expect(pkg(withRows, 'Obsoletes patches')).toBeUndefined();
    const empty = await sequence(0);
    expect(pkg(empty, label)).toContain('this patch has none');
    const unmeasured = await read({
      clsid: CLSID_PATCH,
      summary: { wordCount: 4, revision: `${c}${d}` },
      tables: [{ name: 'MsiPatchSequence', columns: ['s', 's', 's', 'i4'], rows: 1, extra: 3 }],
    });
    expect(pkg(unmeasured, label)).toContain('could not be read');
    expect(pkg(unmeasured, label)).not.toContain('this patch has none');
  });

  it('shows a patch Revision Number that is not a run of GUIDs as it is', async () => {
    const info = await patchRead({ revision: 'not a guid' });
    expect(pkg(info, 'Revision number (from the summary)')).toBe('not a guid');
    expect(pkg(info, 'Patch code')).toBeUndefined();
  });

  it('gives a transform its own definitions', async () => {
    const info = await read({
      clsid: CLSID_TRANSFORM,
      noPool: true,
      summary: {
        template: 'Intel;1033',
        revision: [
          '{11111111-2222-3333-4444-555555555555} 1.0.0',
          '{66666666-7777-8888-9999-000000000000} 2.0.0',
          '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}',
        ].join(';'),
        subject: 'Original Product',
        lastSavedBy: 'Intel;1031',
        pageCount: 301,
        wordCount: 2,
        charCount: 0x00110002,
      },
    });
    expect(info.format).toBe('Windows Installer transform');
    expect(pkg(info, 'Platform (from the summary template)')).toBe('x86 (32-bit)');
    expect(pkg(info, 'Languages')).toBe('English (US) (1033)');
    expect(pkg(info, 'Original product (code and version)')).toBe(
      '{11111111-2222-3333-4444-555555555555} 1.0.0',
    );
    expect(pkg(info, 'New product (code and version)')).toBe(
      '{66666666-7777-8888-9999-000000000000} 2.0.0',
    );
    expect(pkg(info, 'Upgrade code')).toBe('{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}');
    expect(pkg(info, 'Package code')).toBeUndefined();
    expect(pkg(info, 'Minimum installer version to process')).toBe('3.1');
    expect(pkg(info, 'Transform flags (from Character Count)')).toBe(
      'Validation 0x0011, error conditions 0x0002 (not decoded)',
    );
    expect(pkg(info, 'Platform and language after the transform (from Last Saved By)')).toBe(
      'Intel;1031',
    );
    expect(pkg(info, 'Original product name (from Subject)')).toBe('Original Product');
    // Word Count is Null in a transform, so it gives no package flags.
    expect(pkg(info, 'Source files (summary flag)')).toBeUndefined();
    expect(pkg(info, 'Elevation (summary flag)')).toBeUndefined();
  });

  it('does not accept a non-ASCII look-alike as a platform', async () => {
    // A dotless i in "intel" is not the ASCII letter, so it is not the x86 platform.
    const lookAlike = 'INTEL'.replace('I', String.fromCharCode(0x131));
    const info = await read({ summary: { template: `${lookAlike};1033` } });
    const shown = pkg(info, 'Platform (from the summary template)');
    expect(shown).not.toBe('x86 (32-bit)');
    expect(shown).toMatch(/NTEL$/);
    // Upper-case ASCII still folds.
    const plain = await read({ summary: { template: 'INTEL;1033' } });
    expect(pkg(plain, 'Platform (from the summary template)')).toBe('x86 (32-bit)');
  });

  it('leaves an ordinary package summary rows as they were', async () => {
    const info = await read({
      summary: { template: 'x64;1033', pageCount: 500, wordCount: 1 | 4, revision: '{X}' },
    });
    expect(pkg(info, 'Package code')).toBe('{X}');
    expect(pkg(info, 'Minimum installer version')).toBe('5.0');
    expect(pkg(info, 'Source files (summary flag)')).toBe('Uncompressed');
    expect(pkg(info, 'Source is (summary flag)')).toBe('An administrative image');
    expect(pkg(info, 'Elevation (summary flag)')).toBe('Can be required');
    expect(pkg(info, 'Patch code')).toBeUndefined();
    expect(pkg(info, 'Transform flags (from Character Count)')).toBeUndefined();
  });

  it('recognises a package by its string pool when the CLSID is missing', async () => {
    const info = await read({ clsid: '{00000000-0000-0000-0000-000000000000}' });
    expect(info.format).toBe('Windows Installer database');
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

  /** A pool from 4 byte records given as [word, word] pairs after the code page header. */
  const poolOf = (...records: [number, number][]): Uint8Array => {
    const out = new Uint8Array(4 + records.length * 4);
    const view = new DataView(out.buffer);
    view.setUint16(0, 1252, true);
    records.forEach(([a, b], i) => {
      view.setUint16(4 + i * 4, a, true);
      view.setUint16(6 + i * 4, b, true);
    });
    return out;
  };
  const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];

  it('gives a string over 64 KB one ID, with its length in the second record', async () => {
    // IDs: 1 = "ProductName", 2 = 70,000 bytes (0x11170: low word 0x1170, high word 1),
    // 3 = "Acme". The long string is [0, reference count 5] then [low, high]; the
    // reference count differs from the high word so the two cannot be confused.
    const data = Uint8Array.from([
      ...ascii('ProductName'),
      ...new Array<number>(70000).fill(0x78),
      ...ascii('Acme'),
    ]);
    const info = await read({
      poolBytes: poolOf([11, 1], [0, 5], [0x1170, 1], [4, 1]),
      dataBytes: data,
      propertyBytes: Uint8Array.from([1, 0, 3, 0]),
    });
    expect(field(info, 'Package', 'Product name')).toBe('Acme');
  });

  it('cuts a long string to a displayable length', async () => {
    const data = Uint8Array.from([...ascii('ProductName'), ...new Array<number>(70000).fill(0x78)]);
    const info = await read({
      poolBytes: poolOf([11, 1], [0, 2], [0x1170, 1]),
      dataBytes: data,
      propertyBytes: Uint8Array.from([1, 0, 2, 0]),
    });
    expect(field(info, 'Package', 'Product name')).toBe('x'.repeat(2048));
  });

  it('gives an empty pool record an ID of its own', async () => {
    // Record 1 is empty (two zero words) and is still string 1; "ProductName" is 2, "Zed" is 3.
    const info = await read({
      poolBytes: poolOf([0, 0], [11, 1], [3, 1]),
      dataBytes: Uint8Array.from([...ascii('ProductName'), ...ascii('Zed')]),
      propertyBytes: Uint8Array.from([2, 0, 3, 0]),
    });
    expect(field(info, 'Package', 'Product name')).toBe('Zed');
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

describe('readMsi: amplification bounds', () => {
  /** A pool whose first string is 8 KB and whose other strings are five-digit names. */
  function bigPool(names: number): { pool: Uint8Array; data: Uint8Array } {
    const pool = new Uint8Array(4 * (names + 2));
    const view = new DataView(pool.buffer);
    view.setUint16(0, 1252, true);
    view.setUint16(4, 8192, true);
    view.setUint16(6, 1, true);
    for (let i = 0; i < names; i++) {
      view.setUint16(8 + i * 4, 5, true);
      view.setUint16(10 + i * 4, 1, true);
    }
    const data = new Uint8Array(8192 + names * 5).fill(0x61);
    return { pool, data };
  }

  const heap = () => {
    globalThis.gc?.();
    return process.memoryUsage().heapUsed;
  };

  it('decodes a string once however many Property rows name it, and caps the rows', async () => {
    const rowsInFile = 20000;
    const { pool, data } = bigPool(rowsInFile);
    const property = new Uint8Array(rowsInFile * 4);
    const view = new DataView(property.buffer);
    for (let i = 0; i < rowsInFile; i++) {
      view.setUint16(i * 2, 2 + i, true);
      view.setUint16(rowsInFile * 2 + i * 2, 1, true);
    }
    const before = heap();
    const info = await read({ poolBytes: pool, dataBytes: data, propertyBytes: property });
    expect(heap() - before).toBeLessThan(64 * 1024 * 1024);
    expect(info.warnings.join(' ')).toMatch(/20,000 rows; only the first 5,000 were read/);
    expect(field(info, 'Package', 'Properties in database')).toBe('20,000');
  });

  it('gives up on _Columns past its row cap and shows presence instead of counts', async () => {
    const rows = 60000;
    const { pool, data } = bigPool(1);
    const columns = new Uint8Array(rows * 8);
    const view = new DataView(columns.buffer);
    for (let i = 0; i < rows; i++) {
      view.setUint16(i * 2, 1, true);
    }
    const before = heap();
    const info = await read({
      poolBytes: pool,
      dataBytes: data,
      columnsBytes: columns,
      tables: [{ name: 'File', columns: ['s', 'i4'], rows: 3 }],
    });
    expect(heap() - before).toBeLessThan(64 * 1024 * 1024);
    expect(field(info, 'What the tables define', 'File table rows')).toBe('present');
  });

  it('stops decoding once the budget of kept characters is spent', async () => {
    // 2,000 distinct 2,048-character values would be 4 M characters; the budget is 2 M.
    const count = 2000;
    const pool = new Uint8Array(4 * (2 * count + 1));
    const view = new DataView(pool.buffer);
    for (let i = 1; i <= 2 * count; i++) {
      view.setUint16(i * 4, i <= count ? 8 : 4096, true);
      view.setUint16(i * 4 + 2, 1, true);
    }
    const data = new Uint8Array(count * 8 + count * 4096).fill(0x61);
    const property = new Uint8Array(count * 4);
    const pv = new DataView(property.buffer);
    for (let i = 0; i < count; i++) {
      pv.setUint16(i * 2, 1 + i, true);
      pv.setUint16(count * 2 + i * 2, count + 1 + i, true);
    }
    const info = await read({ poolBytes: pool, dataBytes: data, propertyBytes: property });
    expect(info.warnings.join(' ')).toMatch(/more text than MarkCopy reads/);
  });

  it('keeps the Embedded files list bounded when the directory names thousands of streams', async () => {
    const streams = Array.from({ length: 5000 }, (_, i) => ({ name: `Extra${i}`, size: 1 }));
    const info = await read({ streams });
    const embedded = section(info, 'Embedded files');
    expect(embedded?.kind === 'table' && embedded.rows.length).toBe(200);
    expect(embedded?.kind === 'table' && embedded.note).toBe(
      'Showing the first 200 of 5,000 streams.',
    );
  });
});
