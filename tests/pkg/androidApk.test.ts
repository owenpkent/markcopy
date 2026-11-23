import { describe, expect, it } from 'vitest';
import { buildSignedData } from '../pe/fixture';
import { buildAxml, type AxmlAttr, type AxmlElement } from './axmlFixture';
import {
  buildZip,
  expectSafe,
  html,
  readZip,
  section,
  tableRows,
  value,
  type FixtureEntry,
  type ZipOptions,
} from './zipFixture';

const RLO = String.fromCharCode(0x202e);

const str = (name: string, resId: number, value: string): AxmlAttr => ({
  name,
  resId,
  type: 'string',
  value,
});
const int = (name: string, resId: number, value: number): AxmlAttr => ({
  name,
  resId,
  type: 'int',
  value,
});
const bool = (name: string, resId: number, value: boolean): AxmlAttr => ({
  name,
  resId,
  type: 'bool',
  value,
});
const NAME = 0x01010003;
const named = (
  tag: string,
  name: string,
  more: AxmlAttr[] = [],
  children: AxmlElement[] = [],
): AxmlElement => ({
  name: tag,
  attrs: [str('name', NAME, name), ...more],
  children,
});
const EXPORTED = 0x01010010;

const launcher: AxmlElement = {
  name: 'intent-filter',
  children: [
    named('action', 'android.intent.action.MAIN'),
    named('category', 'android.intent.category.LAUNCHER'),
  ],
};

function manifest(overrides: Partial<{ package: string; extra: AxmlElement[] }> = {}): AxmlElement {
  return {
    name: 'manifest',
    attrs: [
      { name: 'package', type: 'string', value: overrides.package ?? 'com.example.app', ns: '' },
      int('versionCode', 0x0101021b, 24),
      str('versionName', 0x0101021c, '2.4'),
      int('compileSdkVersion', 0x01010572, 34),
      str('compileSdkVersionCodename', 0x01010573, '14'),
    ],
    children: [
      {
        name: 'uses-sdk',
        attrs: [int('minSdkVersion', 0x0101020c, 24), int('targetSdkVersion', 0x01010270, 34)],
      },
      named('uses-permission', 'android.permission.INTERNET'),
      named('uses-permission', 'android.permission.WRITE_EXTERNAL_STORAGE', [
        int('maxSdkVersion', 0x01010271, 32),
      ]),
      named('uses-feature', 'android.hardware.camera', [bool('required', 0x0101028e, false)]),
      {
        name: 'uses-feature',
        attrs: [{ name: 'glEsVersion', resId: 0x01010281, type: 'hex', value: 0x30001 }],
      },
      {
        name: 'application',
        attrs: [
          { name: 'label', resId: 0x01010001, type: 'ref', value: 0x7f0f0001 },
          bool('debuggable', 0x0101000f, true),
          bool('allowBackup', 0x01010280, false),
          bool('usesCleartextTraffic', 0x010104ea, true),
        ],
        children: [
          named('activity', 'com.example.app.Main', [bool('exported', EXPORTED, true)], [launcher]),
          named('activity', 'com.example.app.Second', [bool('exported', EXPORTED, false)]),
          named('service', 'com.example.app.Sync', [bool('exported', EXPORTED, true)]),
          named('receiver', 'com.example.app.Boot'),
          named('provider', 'com.example.app.Files', [bool('exported', EXPORTED, false)]),
          ...(overrides.extra ?? []),
        ],
      },
    ],
  };
}

const dex = (size: number): Uint8Array => new Uint8Array(size).fill(1);

function apk(
  xml: Uint8Array = buildAxml(manifest()),
  extra: FixtureEntry[] = [],
  options: ZipOptions = {},
): Uint8Array {
  return buildZip(
    [
      { name: 'AndroidManifest.xml', data: xml },
      { name: 'classes.dex', data: dex(1000) },
      { name: 'classes2.dex', data: dex(2000) },
      { name: 'lib/arm64-v8a/libx.so', data: 'x' },
      { name: 'lib/x86_64/libx.so', data: 'x' },
      { name: 'res/a.png', data: 'x' },
      ...extra,
    ],
    options,
  );
}

describe('readZipPackage: an Android package', () => {
  it('reads the identity from the binary manifest', async () => {
    const info = await readZip(apk(), 'app.apk');
    expect(info.format).toBe('Android package (APK)');
    expect(info.title).toBe('com.example.app 2.4');
    expect(value(info, 'Package', 'Package name')).toBe('com.example.app');
    expect(value(info, 'Package', 'Version')).toBe('2.4');
    expect(value(info, 'Package', 'Version code')).toBe('24');
    expect(value(info, 'Package', 'Minimum Android API')).toBe('24');
    expect(value(info, 'Package', 'Target Android API')).toBe('34');
    expect(value(info, 'Package', 'Compiled against API')).toBe('34');
    expect(value(info, 'Package', 'Compile SDK codename')).toBe('14');
  });

  it('shows the label as a resource reference, and the flags', async () => {
    const info = await readZip(apk());
    expect(value(info, 'Package', 'App label')).toBe('(resource reference)');
    expect(value(info, 'Package', 'Debuggable')).toBe('Yes');
    expect(value(info, 'Package', 'Allows backup')).toBe('No');
    expect(value(info, 'Package', 'Allows cleartext traffic')).toBe('Yes');
  });

  it('finds the launcher activity and counts components and exports', async () => {
    const info = await readZip(apk());
    expect(value(info, 'Package', 'Launcher activity')).toBe('com.example.app.Main');
    expect(value(info, 'Components', 'Activities')).toBe('2 (1 marked exported)');
    expect(value(info, 'Components', 'Services')).toBe('1 (1 marked exported)');
    expect(value(info, 'Components', 'Broadcast receivers')).toBe('1 (0 marked exported)');
    expect(value(info, 'Components', 'Content providers')).toBe('1 (0 marked exported)');
  });

  it('lists permissions with their API limits, and features', async () => {
    const info = await readZip(apk());
    expect(tableRows(info, 'Permissions')).toEqual([
      ['android.permission.INTERNET', ''],
      ['android.permission.WRITE_EXTERNAL_STORAGE', 'API 32'],
    ]);
    expect(tableRows(info, 'Features')).toEqual([
      ['android.hardware.camera', 'No'],
      ['OpenGL ES 3.1', 'Yes'],
    ]);
  });

  it('counts the dex files and native ABIs', async () => {
    const info = await readZip(apk());
    expect(value(info, 'Code', 'Dalvik executables')).toBe('2 (2.93 KB)');
    expect(value(info, 'Code', 'Native libraries for')).toBe('arm64-v8a, x86_64');
  });

  it('puts Contents before Signature', async () => {
    const info = await readZip(apk());
    expect(info.sections.map((s) => s.heading).slice(-2)).toEqual(['Contents', 'Signature']);
  });

  it('reads a manifest whose attribute names were blanked, and a UTF-8 pool', async () => {
    const info = await readZip(apk(buildAxml(manifest(), { stripNames: true, utf8: true })));
    expect(value(info, 'Package', 'Version')).toBe('2.4');
    expect(value(info, 'Components', 'Activities')).toBe('2 (1 marked exported)');
  });

  it('reads a plain-text manifest', async () => {
    const xml =
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="a.b" android:versionName="9"><uses-sdk android:minSdkVersion="21"/><application android:label="@string/n"/></manifest>';
    const info = await readZip(apk(new TextEncoder().encode(xml)));
    expect(value(info, 'Package', 'Package name')).toBe('a.b');
    expect(value(info, 'Package', 'Minimum Android API')).toBe('21');
    expect(value(info, 'Package', 'App label')).toBe('(resource reference)');
  });

  it('is an Android package whatever the file is called', async () => {
    expect((await readZip(apk(), 'thing.zip')).format).toBe('Android package (APK)');
  });
});

describe('readZipPackage: Android signatures', () => {
  const der = buildSignedData({
    subject: { commonName: 'Android Debug', organization: 'Android' },
    issuer: { commonName: 'Android Debug CA' },
  });

  it('names the signer of a v1 signature', async () => {
    const info = await readZip(apk(undefined, [{ name: 'META-INF/CERT.RSA', data: der }]));
    expect(value(info, 'Signature', 'Status')).toContain('Scheme v1 ');
    expect(value(info, 'Signature', 'Signer')).toBe('Android Debug');
    expect(value(info, 'Signature', 'Issued by')).toBe('Android Debug CA');
  });

  it('reports v2 and v3 from the signing block, with no signer to read', async () => {
    const info = await readZip(apk(undefined, [], { signingBlockIds: [0x7109871a, 0xf05368c0] }));
    expect(value(info, 'Signature', 'Status')).toContain('Scheme v2, v3 ');
    expect(value(info, 'Signature', 'Signer')).toContain('Not read');
  });

  it('combines v1 and v2 and keeps the v1 name', async () => {
    const info = await readZip(
      apk(undefined, [{ name: 'META-INF/CERT.RSA', data: der }], { signingBlockIds: [0x7109871a] }),
    );
    expect(value(info, 'Signature', 'Status')).toContain('Scheme v1, v2 ');
    expect(value(info, 'Signature', 'Signer')).toBe('Android Debug');
  });

  it('names a newer scheme and an unknown one', async () => {
    const info = await readZip(apk(undefined, [], { signingBlockIds: [0x1b93ad61] }));
    expect(value(info, 'Signature', 'Status')).toContain('v3.1');
    const unknown = await readZip(apk(undefined, [], { signingBlockIds: [0x12345678] }));
    expect(value(unknown, 'Signature', 'Status')).toContain('v2 or later');
  });

  it('says so when the file is unsigned', async () => {
    const info = await readZip(apk());
    expect(value(info, 'Signature', 'Status')).toContain('Not signed');
  });

  it('carries the caveat on a real signature section only', async () => {
    const signed = await readZip(apk(undefined, [{ name: 'META-INF/CERT.RSA', data: der }]));
    expect((section(signed, 'Signature') as { note?: string }).note).toContain('does not check');
  });
});

describe('readZipPackage: a hostile Android package', () => {
  it('warns about a manifest that is not XML and still shows the package', async () => {
    const info = await readZip(apk(new TextEncoder().encode('garbage that is not xml')));
    expect(info.warnings.join(' ')).toContain('AndroidManifest.xml could not be read');
    expect(info.summary).toContain('manifest could not be read');
    expect(value(info, 'Code', 'Dalvik executables')).toBeDefined();
  });

  it('warns about an encrypted manifest', async () => {
    const info = await readZip(
      buildZip([{ name: 'AndroidManifest.xml', data: 'x', encrypted: true }]),
    );
    expect(info.warnings).toContain('AndroidManifest.xml could not be read.');
  });

  it('caps the permission list', async () => {
    const many = manifest();
    many.children.push(
      ...Array.from({ length: 2100 }, (_, i) => named('uses-permission', `p.${i}`)),
    );
    const info = await readZip(apk(buildAxml(many)));
    const table = section(info, 'Permissions') as { rows: string[][]; note?: string };
    expect(table.rows.length).toBe(200);
    expect(table.note).toBe('Showing the first 200 of 2,000 permissions.');
  });

  it('escapes markup and strips direction overrides', async () => {
    const xml = buildAxml(
      manifest({
        package: `<img src=x onerror=1>${RLO}`,
        extra: [named('activity', '<script>x</script>')],
      }),
    );
    const info = await readZip(apk(xml));
    const page = html(info);
    expect(page).toContain('&lt;img src=x onerror=1&gt;');
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain(RLO);
  });

  it('survives truncation and corruption', async () => {
    const der = buildSignedData({ subject: { commonName: 'S' }, issuer: { commonName: 'I' } });
    await expectSafe(
      apk(buildAxml(manifest()), [{ name: 'META-INF/C.RSA', data: der }], {
        signingBlockIds: [0x7109871a],
      }),
      'x.apk',
    );
  });
});

describe('readZipPackage: entry identity', () => {
  const real = buildAxml(manifest());
  const decoy = buildAxml(manifest({ package: 'decoy.app' }));
  const withCamera = buildAxml({
    ...manifest(),
    children: [...manifest().children, named('uses-permission', 'android.permission.CAMERA')],
  });

  it('does not let an earlier entry whose name cleans to the manifest name stand in for it', async () => {
    const bytes = buildZip([
      { name: `AndroidManifest${RLO}.xml`, data: decoy },
      { name: 'AndroidManifest.xml', data: withCamera },
    ]);
    const info = await readZip(bytes);
    expect(value(info, 'Package', 'Package name')).toBe('com.example.app');
    expect(tableRows(info, 'Permissions').map((r) => r[0])).toContain('android.permission.CAMERA');
    // The decoy is still listed, under its cleaned display name.
    expect(tableRows(info, 'Contents').map((r) => r[0])).toEqual([
      'AndroidManifest.xml',
      'AndroidManifest.xml',
    ]);
  });

  it('is not an Android package when only a decoy has the manifest name', async () => {
    const info = await readZip(buildZip([{ name: `AndroidManifest${RLO}.xml`, data: decoy }]));
    expect(info.format).toBe('Zip archive');
  });

  it('reads the last of two entries with exactly the same name, and warns', async () => {
    const info = await readZip(
      buildZip([
        { name: 'AndroidManifest.xml', data: decoy },
        { name: 'AndroidManifest.xml', data: real },
      ]),
    );
    expect(value(info, 'Package', 'Package name')).toBe('com.example.app');
    expect(info.warnings.join(' ')).toContain('more than once');
  });

  it('does not match a name that was cut for display', async () => {
    const info = await readZip(
      buildZip([{ name: `AndroidManifest.xml${'x'.repeat(600)}`, data: real }]),
    );
    expect(info.format).toBe('Zip archive');
  });
});
