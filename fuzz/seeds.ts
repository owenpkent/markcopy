// Writes the seed corpus for the pe and pkg fuzz targets from the unit tests'
// fixture builders, so no binary of unknown origin is committed. Run through
// scripts/make-fuzz-seeds.js (npm-free: it bundles this file with esbuild and
// runs it with node); the output directory is the first command-line argument.
//
//   fuzz/corpus/pe/<name>.exe          a raw PE image
//   fuzz/corpus/pkg/<format>-<name>.seed   one byte choosing the SHAPES entry
//                                          in fuzz/targets/pkg.fuzz.ts, then the file
//   fuzz/corpus/file-source/               every seed above, as the file-source
//                                          target reads it: a pkg seed as it is,
//                                          a PE image after a 0xff byte
//
// Everything here is deterministic, so a rerun writes identical bytes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHAPES } from './targets/pkg.fuzz';
import { buildPe, buildSignedData, iconBitmap, pngStub, type PeSpec } from '../tests/pe/fixture';
import { buildElf } from '../tests/pkg/elfFixture';
import { buildFat, buildMacho, CPU, dylib, LC, segment, uuid } from '../tests/pkg/machoFixture';
import {
  bin,
  buildRpm,
  pgpSignatureV4,
  pgpSignatureV6,
  strings,
  str,
} from '../tests/pkg/rpmFixture';
import { b64, buildDeb, VECTOR_XZ, VECTOR_ZST } from '../tests/pkg/debFixture';
import { buildMsi, filetime, type MsiSpec } from '../tests/pkg/msiFixture';
import { buildCertificate, buildProduct, buildXar, packageInfoXml } from '../tests/pkg/xarFixture';
import { buildZip, type FixtureEntry } from '../tests/pkg/zipFixture';
import { buildAxml, type AxmlAttr, type AxmlElement } from '../tests/pkg/axmlFixture';
import { buildApk } from '../tests/pkg/alpineFixture';
import { buildDmg, buildEncryptedDmg } from '../tests/pkg/dmgFixture';

// fflate stamps gzip headers with the current time; pin it so a rerun gives identical bytes.
Date.now = (): number => 1700000000000;

const MAX_BYTES = 8 * 1024;
const out = process.argv[2];
if (!out) {
  throw new Error('usage: seeds <corpus directory>');
}
const peDir = join(out, 'pe');
const pkgDir = join(out, 'pkg');
const fileSourceDir = join(out, 'file-source');
mkdirSync(peDir, { recursive: true });
mkdirSync(pkgDir, { recursive: true });
mkdirSync(fileSourceDir, { recursive: true });

const skipped: string[] = [];

function emit(dir: string, name: string, bytes: Uint8Array): void {
  if (bytes.length > MAX_BYTES) {
    skipped.push(`${name} (${bytes.length} bytes)`);
    return;
  }
  writeFileSync(join(dir, name), bytes);
  // file-source reads an input whose first byte is 0xf0 or more as an executable.
  const forFileSource = dir === peDir ? Buffer.concat([Buffer.of(0xff), bytes]) : bytes;
  writeFileSync(join(fileSourceDir, dir === peDir ? `pe-${name}` : name), forFileSource);
  console.log(`${name}\t${bytes.length}`);
}

// ---- PE ----------------------------------------------------------------

const pe = (name: string, spec: PeSpec = {}): void => emit(peDir, `${name}.exe`, buildPe(spec));

const squareIcon = (id: number, side: number) => ({
  id,
  width: side,
  height: side,
  bitCount: 32,
  data: iconBitmap({
    width: side,
    height: side,
    bitCount: 32,
    rgba: Array.from(
      { length: side * side },
      () => [200, 100, 50, 255] as [number, number, number, number],
    ),
  }),
});

const signer = {
  subject: { commonName: 'Contoso Software', organization: 'Contoso Ltd' },
  issuer: { commonName: 'Contoso CA' },
  notBefore: '230615000000Z',
  notAfter: '260615235959Z',
};

pe('default');
pe('version-resource', {
  version: {
    fileVersion: [1, 2, 3, 4],
    productVersion: [5, 6, 7, 8],
    strings: [
      ['CompanyName', 'Contoso'],
      ['FileDescription', 'Contoso Tool'],
      ['FileVersion', '1.2.3.4'],
      ['ProductName', 'X'],
      ['LegalCopyright', 'Copyright (C) Contoso \u00a9 2024'],
    ],
    language: '040904B0',
  },
});
pe('manifest-admin', {
  manifest:
    '<assembly><requestedExecutionLevel level="requireAdministrator" uiAccess="false"/></assembly>',
});
pe('manifest-identity', {
  manifest: '<assembly><assemblyIdentity name="A.B" version="1.0.0.0"/></assembly>',
});
pe('icon-bitmap', { icons: [squareIcon(1, 16)] });
pe('icon-bitmaps-and-png', {
  icons: [
    squareIcon(5, 16),
    squareIcon(9, 32),
    { id: 12, width: 256, height: 256, bitCount: 32, data: pngStub(256, 256) },
  ],
});
pe('imports-delay-exports', {
  imports: [{ library: 'KERNEL32.dll', functions: 3 }],
  delayImports: [{ library: 'ole32.dll', functions: 1 }],
  exports: { dllName: 'x.dll', names: ['Alpha', 'Beta'] },
  dll: true,
});
pe('debug-rsds-repro', {
  debug: { guid: '11223344-5566-7788-99AA-BBCCDDEEFF00', age: 1, pdbPath: 'C:\\build\\tool.pdb' },
  repro: true,
});
pe('dotnet-clr', { clr: { runtime: 'v4.0.30319', flags: 0x1 } });
pe('dotnet-clr-signed-strong-name', { clr: { runtime: 'v4.0.30319', flags: 0x1 | 0x8 } });
pe('pe32plus', { plus: true, machine: 0x8664, largeAddressAware: true });
pe('pe32plus-arm64', { plus: true, machine: 0xaa64 });
pe('authenticode-signed', { certificate: buildSignedData(signer) });
pe('everything', {
  plus: true,
  machine: 0x8664,
  timestamp: 1700000000,
  version: { fileVersion: [10, 0, 19041, 1], strings: [['ProductName', 'Contoso']] },
  manifest:
    '<assembly><assemblyIdentity name="N"/><requestedExecutionLevel level="asInvoker"/></assembly>',
  icons: [squareIcon(1, 16)],
  imports: [{ library: 'KERNEL32.dll', functions: 2 }],
  exports: { dllName: 'x.dll', names: ['A'] },
  debug: { guid: '11223344-5566-7788-99AA-BBCCDDEEFF00', age: 2, pdbPath: 'x.pdb' },
  certificate: buildSignedData(signer),
});

// ---- pkg ---------------------------------------------------------------

/** The first SHAPES entry with this name and format. Never a hard-coded number. */
function shapeIndex(name: string, format: string): number {
  const at = SHAPES.findIndex((s) => s.name === name && s.format === format);
  if (at < 0) {
    throw new Error(`no shape ${name} (${format}) in fuzz/targets/pkg.fuzz.ts`);
  }
  return at;
}

function pkg(shapeName: string, format: string, seedName: string, bytes: Uint8Array): void {
  const seed = new Uint8Array(bytes.length + 1);
  seed[0] = shapeIndex(shapeName, format);
  seed.set(bytes, 1);
  emit(pkgDir, `${format}-${seedName}.seed`, seed);
}

// ELF
pkg('fuzz.so', 'elf', 'default', buildElf());
const LD = '/lib64/ld-linux-x86-64.so.2';
pkg(
  'fuzz.so',
  'elf',
  'library-soname-needed',
  buildElf({
    soname: 'libdemo.so.1',
    needed: ['libc.so.6', 'libm.so.6'],
    runpath: '$ORIGIN/lib',
    buildId: [0xde, 0xad, 0xbe, 0xef],
    abiTag: [0, 3, 2, 0],
    relro: true,
    flags: 0x8,
    sections: [
      { name: '.symtab', type: 2, data: 'abcd' },
      { name: '.debug_info', data: 'xyz' },
      {
        name: '.comment',
        data: 'GCC: (Debian 12.2.0) 12.2.0\0GCC: (Debian 12.2.0) 12.2.0\0clang version 15.0.0\0',
      },
      { name: '.gnu_debuglink', data: 'libdemo.debug\0\0\0\0\u0001\u0002\u0003\u0004' },
    ],
  }),
);
pkg(
  'fuzz.so',
  'elf',
  'pie-interp',
  buildElf({ interp: LD, needed: ['libc.so.6'], flags1: 0x08000001 }),
);
const squashfs = new Uint8Array(1000);
squashfs.set(new TextEncoder().encode('hsqs'), 0);
pkg(
  'fuzz.so',
  'elf',
  'appimage-type2',
  buildElf({ appImage: 2, interp: LD, needed: ['libc.so.6'], payload: squashfs }),
);

// Mach-O
const MACHO_UUID = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const machoLibrary = buildMacho({
  filetype: 6,
  commands: [
    segment('__TEXT'),
    dylib(LC.ID_DYLIB, '@rpath/libdemo.dylib'),
    dylib(LC.LOAD_DYLIB, '/usr/lib/libSystem.B.dylib'),
    uuid(MACHO_UUID),
  ],
});
pkg('fuzz.dylib', 'macho', 'default', machoLibrary);
pkg(
  'fuzz.universal',
  'macho',
  'universal',
  buildFat(
    [
      { bytes: machoLibrary, cputype: CPU.X86_64 },
      { bytes: buildMacho({ wide: false, big: true, cputype: CPU.PPC }), cputype: CPU.PPC },
    ],
    // Small enough for emit's 8 KiB limit, and still a power of two.
    { align: 0x400 },
  ),
);

// RPM
pkg('fuzz.rpm', 'rpm', 'default', buildRpm());
const KEY_B = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
pkg(
  'fuzz.rpm',
  'rpm',
  'signature-header',
  buildRpm({
    signature: [
      bin(268, pgpSignatureV4(1, KEY_B)),
      strings(278, [Buffer.from(pgpSignatureV6(22)).toString('base64')]),
      str(279, 'b'.repeat(64)),
    ],
  }),
);

// Debian
pkg(
  'fuzz.deb',
  'deb',
  'gz',
  buildDeb({ dataSize: 256, scripts: ['postinst'], md5sums: ['usr/bin/curl'] }),
);
pkg(
  'fuzz.deb',
  'deb',
  'xz',
  buildDeb({ compression: 'xz', controlBytes: b64(VECTOR_XZ), dataSize: 256 }),
);
pkg(
  'fuzz.deb',
  'deb',
  'zst',
  buildDeb({ compression: 'zst', controlBytes: b64(VECTOR_ZST), dataSize: 256 }),
);

// MSI
pkg('fuzz.msi', 'msi', 'default', buildMsi());
const msiRich: MsiSpec = {
  properties: {
    ProductName: 'Contoso Tool',
    ProductVersion: '2.1.0',
    Manufacturer: 'Contoso Ltd',
    ProductCode: '{11111111-2222-3333-4444-555555555555}',
    UpgradeCode: '{66666666-7777-8888-9999-000000000000}',
    ProductLanguage: '1033',
    ALLUSERS: '1',
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
    { name: 'CustomAction', columns: ['s', 'i2', 's', 's', 'i4'], rows: 4 },
  ],
  streams: [{ name: 'Data1.cab', size: 1000 }],
  storages: ['1031', '1036'],
};
pkg('fuzz.msi', 'msi', 'tables-summary', buildMsi(msiRich));
pkg('fuzz.msi', 'msi', 'signed', buildMsi({ ...msiRich, signature: signer, signatureEx: true }));

// macOS xar
pkg(
  'fuzz.pkg',
  'xar',
  'flat-package',
  buildXar({ files: [{ name: 'dir', children: [{ name: 'a.txt', data: 'hello' }] }] }),
);
pkg(
  'fuzz.pkg',
  'xar',
  'product',
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
    ],
  }),
);
pkg(
  'fuzz.pkg',
  'xar',
  'product-signed',
  buildProduct({
    certificate: buildCertificate(
      'Developer ID Installer: Example Inc',
      'Developer ID Certification Authority',
    ),
  }),
);
pkg(
  'fuzz.pkg',
  'xar',
  'pkgbuild-bundles',
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
          ],
        }),
      },
    ],
  }),
);

// zip family
const manifestLines = (headers: [string, string][]): string =>
  `${['Manifest-Version: 1.0', ...headers.map(([n, v]) => `${n}: ${v}`)].join('\r\n')}\r\n\r\n`;
const classFile = (major: number): Uint8Array =>
  Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, major >> 8, major & 0xff, 0, 0, 0, 0]);

pkg(
  'fuzz.jar',
  'zip',
  'jar-manifest',
  buildZip([
    {
      name: 'META-INF/MANIFEST.MF',
      data: manifestLines([
        ['Main-Class', 'com.example.App'],
        ['Implementation-Title', 'Example App'],
        ['Implementation-Version', '2.3.4'],
        ['Implementation-Vendor', 'Example Corp'],
        ['Bundle-SymbolicName', 'com.example.app'],
        ['Multi-Release', 'true'],
        ['Created-By', '17.0.2 (Eclipse Adoptium)'],
        ['Class-Path', 'lib/one.jar lib/two.jar'],
      ]),
    },
    { name: 'com/example/App.class', data: classFile(61), method: 8 },
    {
      name: 'META-INF/maven/com.example/app/pom.properties',
      data: 'groupId=com.example\nartifactId=app\nversion=2.3.4\n',
    },
  ]),
);

const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="demo" Version="1.2.3" Publisher="acme" TargetPlatform="win32-x64" />
    <DisplayName>Demo Extension</DisplayName>
    <Description xml:space="preserve">Does demo things.&#10;&#10;Second paragraph.</Description>
    <Tags>markdown,preview, csv</Tags>
    <Categories>Visualization,Other</Categories>
    <GalleryFlags>Public Preview</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.90.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/acme/demo.git" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>`;
const packageJson = {
  name: 'demo',
  displayName: 'Demo Extension',
  publisher: 'acme',
  version: '1.2.3',
  engines: { vscode: '^1.90.0' },
  main: './dist/extension.js',
  activationEvents: ['onLanguage:markdown', 'onCommand:demo.run'],
  contributes: {
    commands: [{ command: 'a' }, { command: 'b' }],
    customEditors: [{ viewType: 'v' }],
    configuration: { properties: { 'demo.a': {}, 'demo.b': {} } },
  },
};
pkg(
  'fuzz.vsix',
  'zip',
  'vsix-extension',
  buildZip([
    { name: 'extension.vsixmanifest', data: vsixManifest },
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'extension/package.json', data: JSON.stringify(packageJson) },
  ]),
);

const METADATA = [
  'Metadata-Version: 2.3',
  'Name: demo-pkg',
  'Version: 1.4.0',
  'Summary: A demo package',
  'Home-page: https://example.org/demo',
  'Author: Ada Lovelace',
  'Author-email: ada@example.org',
  'License-Expression: MIT',
  'Project-URL: Source, https://github.com/example/demo',
  'Classifier: Programming Language :: Python :: 3',
  'Classifier: License :: OSI Approved :: MIT License',
  'Requires-Python: >=3.9',
  'Provides-Extra: speed',
  'Requires-Dist: requests>=2.0',
  'Requires-Dist: orjson; extra == "speed"',
  '',
  'Demo is a small library.',
  '',
].join('\n');
const WHEEL = [
  'Wheel-Version: 1.0',
  'Generator: hatchling 1.21',
  'Root-Is-Purelib: true',
  'Tag: py3-none-any',
  '',
].join('\n');
pkg(
  'fuzz.whl',
  'zip',
  'wheel-dist-info',
  buildZip([
    { name: 'demo/__init__.py', data: 'x = 1\n' },
    { name: 'demo_pkg-1.4.0.dist-info/METADATA', data: METADATA },
    { name: 'demo_pkg-1.4.0.dist-info/WHEEL', data: WHEEL },
    {
      name: 'demo_pkg-1.4.0.dist-info/entry_points.txt',
      data: '[console_scripts]\ndemo = demo.cli:main\n',
    },
    { name: 'demo_pkg-1.4.0.dist-info/RECORD', data: 'demo/__init__.py,sha256=x,6\n' },
  ]),
);

const nuspec = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata minClientVersion="4.3.0">
    <id>Contoso.Widgets</id>
    <version>3.1.0-beta.2</version>
    <title>Widgets</title>
    <authors>Contoso, Ada</authors>
    <description>Widgets for everything.</description>
    <license type="expression">MIT</license>
    <projectUrl>https://contoso.example/widgets</projectUrl>
    <repository type="git" url="https://github.com/contoso/widgets" commit="abc123" />
    <tags>widgets ui contoso</tags>
    <dependencies>
      <group targetFramework="net6.0">
        <dependency id="Newtonsoft.Json" version="[13.0.1, )" exclude="Build" />
      </group>
      <group targetFramework=".NETStandard2.0" />
    </dependencies>
  </metadata>
</package>`;
pkg(
  'fuzz.nupkg',
  'zip',
  'nupkg-nuspec',
  buildZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'Contoso.Widgets.nuspec', data: nuspec },
    { name: 'lib/net6.0/Contoso.Widgets.dll', data: 'MZ' },
    { name: 'lib/netstandard2.0/Contoso.Widgets.dll', data: 'MZ' },
  ]),
);

// Android package: the binary manifest from buildAxml, as tests/pkg/androidApk.test.ts builds it.
const astr = (name: string, resId: number, value: string): AxmlAttr => ({
  name,
  resId,
  type: 'string',
  value,
});
const aint = (name: string, resId: number, value: number): AxmlAttr => ({
  name,
  resId,
  type: 'int',
  value,
});
const abool = (name: string, resId: number, value: boolean): AxmlAttr => ({
  name,
  resId,
  type: 'bool',
  value,
});
const NAME = 0x01010003;
const EXPORTED = 0x01010010;
const named = (
  tag: string,
  name: string,
  more: AxmlAttr[] = [],
  children: AxmlElement[] = [],
): AxmlElement => ({
  name: tag,
  attrs: [astr('name', NAME, name), ...more],
  children,
});
const launcher: AxmlElement = {
  name: 'intent-filter',
  children: [
    named('action', 'android.intent.action.MAIN'),
    named('category', 'android.intent.category.LAUNCHER'),
  ],
};
const androidManifest: AxmlElement = {
  name: 'manifest',
  attrs: [
    { name: 'package', type: 'string', value: 'com.example.app', ns: '' },
    aint('versionCode', 0x0101021b, 24),
    astr('versionName', 0x0101021c, '2.4'),
    aint('compileSdkVersion', 0x01010572, 34),
  ],
  children: [
    {
      name: 'uses-sdk',
      attrs: [aint('minSdkVersion', 0x0101020c, 24), aint('targetSdkVersion', 0x01010270, 34)],
    },
    named('uses-permission', 'android.permission.INTERNET'),
    named('uses-feature', 'android.hardware.camera', [abool('required', 0x0101028e, false)]),
    {
      name: 'application',
      attrs: [
        { name: 'label', resId: 0x01010001, type: 'ref', value: 0x7f0f0001 },
        abool('debuggable', 0x0101000f, true),
        abool('allowBackup', 0x01010280, false),
      ],
      children: [
        named('activity', 'com.example.app.Main', [abool('exported', EXPORTED, true)], [launcher]),
        named('service', 'com.example.app.Sync', [abool('exported', EXPORTED, true)]),
      ],
    },
  ],
};
const apkEntries = (xml: Uint8Array): FixtureEntry[] => [
  { name: 'AndroidManifest.xml', data: xml },
  { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\n' },
  { name: 'classes.dex', data: new Uint8Array(1000).fill(1) },
  { name: 'lib/arm64-v8a/libx.so', data: 'x' },
  { name: 'res/a.png', data: 'x' },
];
pkg('fuzz.apk', 'zip', 'android-axml', buildZip(apkEntries(buildAxml(androidManifest))));
pkg(
  'fuzz.apk',
  'zip',
  'android-axml-utf8-stripped',
  buildZip(apkEntries(buildAxml(androidManifest, { stripNames: true, utf8: true }))),
);

// Alpine
pkg('fuzz.apk', 'alpine', 'signed', buildApk());
pkg(
  'fuzz.apk',
  'alpine',
  'unsigned-scripts',
  buildApk({ signature: null, scripts: ['.post-install'] }),
);

// DMG
pkg('fuzz.dmg', 'dmg', 'default', buildDmg());
pkg('fuzz.dmg', 'dmg', 'encrypted-v2', buildEncryptedDmg(2));
pkg('fuzz.dmg', 'dmg', 'encrypted-v1', buildEncryptedDmg(1));

if (skipped.length > 0) {
  console.log(`SKIPPED (over ${MAX_BYTES} bytes): ${skipped.join(', ')}`);
}
