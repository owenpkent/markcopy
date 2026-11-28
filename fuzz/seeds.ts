// Writes the seed corpus for the pe, pkg and focused reader fuzz targets from the unit tests'
// fixture builders, so no binary of unknown origin is committed. Run through
// scripts/make-fuzz-seeds.js (npm-free: it bundles this file with esbuild and
// runs it with node); the output directory is the first command-line argument.
//
//   fuzz/corpus/pe/<name>.exe          a raw PE image
//   fuzz/corpus/pkg/<format>-<name>.seed   one byte choosing the SHAPES entry
//                                          in fuzz/targets/pkg.fuzz.ts, then the file
//   fuzz/corpus/cpio/, dex/, go-buildinfo/, signer/, ooxml-encrypted/
//                                          one byte choosing the stage, then the input,
//                                          as each of those targets reads it
//   fuzz/corpus/file-source/               every seed above, as the file-source
//                                          target reads it: a pkg seed as it is,
//                                          a PE image after a 0xff byte
//
// Everything here is deterministic, so a rerun writes identical bytes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHAPES } from './targets/pkg.fuzz';
import { createHash } from 'node:crypto';
import { gzipSync } from 'fflate';
import {
  buildLeafCertificate,
  buildPe,
  buildRichStub,
  buildSignedData,
  iconBitmap,
  pngStub,
  rsaSpki,
  tlv,
  type PeSpec,
} from '../tests/pe/fixture';
import { buildDex } from '../tests/pkg/dexFixture';
import { buildCfb } from '../tests/pkg/cfbFixture';
import { inlineBlock, pointerBlock, SAMPLE_LINES } from '../tests/binary/goFixture';
import { buildElf } from '../tests/pkg/elfFixture';
import {
  buildClassFileLike,
  buildFat,
  buildMacho,
  buildVersion,
  CPU,
  dylib,
  dylinker,
  encryption,
  linkedit,
  LC,
  main,
  rpath,
  segment,
  sourceVersion,
  uuid,
  ver,
  versionMin,
} from '../tests/pkg/machoFixture';
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
import * as fx from '../tests/pkg/encryptionFixture';
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

// ---- Files that are more than one format (the polyglot target) -------------

const polyglotDir = join(out, 'polyglot');
mkdirSync(polyglotDir, { recursive: true });
const NAMES = ['fuzz.bin', 'fuzz.apk', 'fuzz.jar', 'fuzz.exe', 'fuzz.pdf', 'fuzz.pkg'];

/** A seed for the polyglot target: a mode byte, a flags byte (the name for mode 1), then the file. */
function polyglot(name: string, mode: number, flags: number, bytes: Uint8Array): void {
  const seed = Buffer.concat([Uint8Array.of(mode, flags), bytes]);
  if (seed.length > MAX_BYTES) {
    skipped.push(`polyglot/${name} (${seed.length} bytes)`);
    return;
  }
  writeFileSync(join(polyglotDir, name), seed);
  console.log(`polyglot/${name}\t${seed.length}`);
}
const cat = (...parts: Uint8Array[]): Uint8Array => Buffer.concat(parts);
const aZip = (prefix?: Uint8Array, comment?: string): Uint8Array =>
  buildZip([{ name: 'a.txt', data: 'hello' }], { prefix, comment });
/** A minimal PDF with a classic cross-reference table at exact byte offsets (as tests/pkg/polyglot.test.ts builds it). */
function aPdf(): Uint8Array {
  const bodies = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>'];
  let text = '%PDF-1.4\n';
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = text.length;
  text += 'xref\n0 3\n0000000000 65535 f \n';
  for (const offset of offsets) {
    text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  text += `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}
const NAME_AT = (name: string): number => NAMES.indexOf(name);
polyglot('msi-then-zip', 1, NAME_AT('fuzz.bin'), cat(buildMsi(), aZip()));
polyglot('rpm-then-zip', 1, NAME_AT('fuzz.bin'), cat(buildRpm(), aZip()));
polyglot('elf-then-zip', 1, NAME_AT('fuzz.bin'), cat(buildElf(), aZip()));
polyglot(
  'elf-then-zip-long-comment',
  1,
  NAME_AT('fuzz.bin'),
  cat(buildElf(), aZip(undefined, 'c'.repeat(600))),
);
polyglot('zip-then-pe', 1, NAME_AT('fuzz.jar'), cat(aZip(), buildPe()));
polyglot('pe-then-zip', 1, NAME_AT('fuzz.exe'), cat(buildPe(), aZip()));
polyglot('deb-then-pdf', 1, NAME_AT('fuzz.pdf'), cat(buildDeb({ dataSize: 64 }), aPdf()));
polyglot('zip-with-pdf-comment', 1, NAME_AT('fuzz.pdf'), aZip(aPdf(), 'startxref 0 %%EOF'));
polyglot(
  'sevenzip-then-zip',
  1,
  NAME_AT('fuzz.bin'),
  cat(fx.sevenZipEncoded([[fx.AES_CODER(19), fx.LZMA]]), aZip()),
);
polyglot('kdbx-then-zip', 1, NAME_AT('fuzz.bin'), cat(fx.kdbx3(), aZip()));
polyglot('luks-then-pdf', 1, NAME_AT('fuzz.pdf'), cat(fx.luks1({ slots: [100000] }), aPdf()));
polyglot('alpine-apk', 1, NAME_AT('fuzz.apk'), buildApk());
polyglot('pe-overlay-zip', 2, 0, buildPe({ overlay: aZip() }));
polyglot('pe-overlay-junk', 2, 0, buildPe({ overlay: 200 }));
polyglot(
  'pe-signed-overlay-zip',
  2,
  0x40,
  buildPe({ certificate: buildSignedData(signer), overlay: aZip() }),
);
polyglot('signatures-zip-pdf-pe', 3, 0, cat(aPdf(), aZip(), buildPe().subarray(0, 0x200)));
polyglot('signatures-zip64-style', 3, 0, aZip(undefined, 'PK\x06\x07'));
polyglot('signatures-pdf', 3, 0, aPdf());
// A shaped pkg file with an empty zip end record appended: mode 0, flags 1, then a SHAPES index and the file.
const elfShape = SHAPES.findIndex((s) => s.format === 'elf');
polyglot('shaped-elf-plus-zip-end', 0, 1, cat(Uint8Array.of(elfShape), buildElf()));

// ---- Readers with a target of their own, and what the pe and pkg shapes reach ----

const focusedDirs = new Map<string, string>();

/** A seed for a target that has no file-source counterpart: a stage byte, then the input. */
function only(target: string, name: string, stage: number, bytes: Uint8Array): void {
  let dir = focusedDirs.get(target);
  if (dir === undefined) {
    dir = join(out, target);
    mkdirSync(dir, { recursive: true });
    focusedDirs.set(target, dir);
  }
  const seed = new Uint8Array(bytes.length + 1);
  seed[0] = stage;
  seed.set(bytes, 1);
  if (seed.length > MAX_BYTES) {
    skipped.push(`${target}/${name} (${seed.length} bytes)`);
    return;
  }
  writeFileSync(join(dir, name), seed);
  console.log(`${target}/${name}\t${seed.length}`);
}

// ---- Encrypted containers and key files ----------------------------------------
//
// Built from tests/pkg/encryptionFixture.ts. Every salt, IV, nonce and wrapped key in them is the
// marker byte 0xab, which the page oracle (fuzz/targets/binaryOracle.ts) looks for in a page.

/** The `which`-th shape of a format (a format with two shapes, such as RAR 5 and RAR 4). */
function pkgNth(format: string, which: number, seedName: string, bytes: Uint8Array): void {
  const indexes = SHAPES.flatMap((s, i) => (s.format === format ? [i] : []));
  const seed = new Uint8Array(bytes.length + 1);
  seed[0] = indexes[which];
  seed.set(bytes, 1);
  emit(pkgDir, `${format}-${seedName}.seed`, seed);
}
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

// 7-Zip
pkgNth('7z', 0, 'encrypted-header', fx.sevenZipEncoded([[fx.AES_CODER(19), fx.LZMA]]));
pkgNth('7z', 0, 'encrypted-folder', fx.sevenZipPlain([[fx.AES_CODER(18), fx.LZMA]]));
pkgNth('7z', 0, 'mixed-folders', fx.sevenZipPlain([[fx.AES_CODER(), fx.LZMA], [fx.LZMA]]));
pkgNth('7z', 0, 'compressed-header', fx.sevenZipEncoded([[fx.LZMA]]));
pkgNth('7z', 0, 'folder-count-lies', fx.sevenZipPlain([[fx.LZMA]], 9));

// RAR 5 (shape 0) and RAR 4 (shape 1)
pkgNth(
  'rar',
  0,
  'rar5-encrypted-headers',
  fx.rar5(fx.rar5Main(), fx.rar5EncryptionHeader(15), fx.rar5End()),
);
pkgNth(
  'rar',
  0,
  'rar5-encrypted-file',
  fx.rar5(fx.rar5Main(), fx.rar5File('a.txt', { kdf: 15 }), fx.rar5File('b.txt'), fx.rar5End()),
);
pkgNth(
  'rar',
  0,
  'rar5-odd-version',
  fx.rar5(fx.rar5Main(), fx.rar5File('c.txt', { kdf: 30, version: 3 })),
);
pkgNth('rar', 1, 'rar4-password-headers', fx.rar4(fx.rar4Main(true), fx.rar4End()));
pkgNth(
  'rar',
  1,
  'rar4-encrypted-file',
  fx.rar4(fx.rar4Main(), fx.rar4File('a.txt', true), fx.rar4End()),
);

// LUKS: version 1 slots, and version 2 with its JSON area
pkgNth('luks', 0, 'luks1-slots', fx.luks1({ slots: [200000, undefined, 150000] }));
pkgNth('luks', 0, 'luks1-no-key-size', fx.luks1({ keyBytes: 0 }));
const luksJson = {
  keyslots: {
    '0': {
      type: 'luks2',
      key_size: 64,
      af: { type: 'luks1', stripes: 4000, hash: 'sha256' },
      area: {
        type: 'raw',
        encryption: 'aes-xts-plain64',
        key_size: 64,
        offset: '32768',
        size: '258048',
      },
      kdf: {
        type: 'argon2id',
        time: 4,
        memory: 1048576,
        cpus: 4,
        salt: 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=',
      },
    },
    '1': {
      type: 'luks2',
      key_size: 64,
      area: { type: 'raw', encryption: 'aes-xts-plain64', key_size: 64 },
      kdf: { type: 'pbkdf2', hash: 'sha256', iterations: 1000000, salt: 'q6urq6urq6urq6ur' },
    },
    '2': {
      type: 'luks2',
      key_size: 32,
      area: { encryption: 'aes-cbc-essiv:sha256' },
      kdf: { type: 'argon2i', time: 1, memory: 64, cpus: 1 },
    },
  },
  tokens: {
    '0': { type: 'luks2-keyring', keyslots: ['0'] },
    '1': { type: 'systemd-tpm2', keyslots: ['1'] },
  },
  segments: {
    '0': {
      type: 'crypt',
      offset: '16777216',
      size: 'dynamic',
      iv_tweak: '0',
      encryption: 'aes-xts-plain64',
      sector_size: 4096,
    },
  },
  digests: {
    '0': {
      type: 'pbkdf2',
      keyslots: ['0', '1'],
      segments: ['0'],
      hash: 'sha256',
      iterations: 1000,
      salt: 'q6urq6ur',
      digest: 'q6urq6ur',
    },
  },
  config: { json_size: '12288', keyslots_size: '4161536' },
};
pkgNth('luks', 0, 'luks2-json', fx.luks2(luksJson, { headerSize: 6144 }));
pkgNth(
  'luks',
  0,
  'luks2-json-damaged',
  fx.luks2('{"keyslots": {"0": {"type": "luks2", "kdf": ', { headerSize: 6144 }),
);
pkgNth(
  'luks',
  0,
  'luks2-wrong-types',
  fx.luks2(
    { keyslots: { '0': { kdf: { type: 5, time: 'x' } } }, tokens: [] },
    { headerSize: 6144 },
  ),
);

// KeePass
pkgNth('kdbx', 0, 'kdbx3-aes', fx.kdbx3());
pkgNth(
  'kdbx',
  0,
  'kdbx3-twofish',
  fx.kdbx3({ cipher: fx.TWOFISH_CIPHER, compression: 0, rounds: 1_000_000 }),
);
pkgNth(
  'kdbx',
  0,
  'kdbx4-argon2id',
  fx.kdbx4(
    fx.variantDictionary([
      fx.dictBytes('$UUID', fx.hex(fx.ARGON2ID)),
      fx.dictU64('I', 2),
      fx.dictU64('M', 67108864),
      fx.dictU32('P', 4),
      fx.dictU32('V', 0x13),
      fx.dictBytes('S', fx.secret(32)),
    ]),
  ),
);
pkgNth(
  'kdbx',
  0,
  'kdbx4-aes-kdf',
  fx.kdbx4(
    fx.variantDictionary([
      fx.dictBytes('$UUID', fx.hex(fx.AES_KDF_V4)),
      fx.dictU64('R', 60000),
      fx.dictBytes('S', fx.secret(32)),
    ]),
    { cipher: fx.CHACHA_CIPHER },
  ),
);
pkgNth('kdbx', 0, 'kdbx4-no-kdf', fx.kdbx4(undefined));

// age, binary header (shape 0) and armored (shape 1)
const ageStanzas = [
  '-> X25519 ' + 'A'.repeat(43),
  '-> scrypt ' + 'q6urq6urq6urq6urq6urq6' + ' 18',
  '-> ssh-ed25519 abcdefgh ' + 'B'.repeat(43),
  '-> plugin-fido2 x',
];
pkgNth('age', 0, 'stanzas', text(fx.ageFile(ageStanzas)));
pkgNth(
  'age',
  0,
  'scrypt-bad-work-factor',
  text(fx.ageFile(['-> scrypt ' + 'q6urq6urq6urq6urq6urq6' + ' 99'])),
);
pkgNth(
  'age',
  1,
  'armored',
  text(
    fx
      .armor('AGE ENCRYPTED FILE', fx.enc(fx.ageFile(['-> X25519 ' + 'A'.repeat(43)])))
      .replace('=AAAA\n', ''),
  ),
);

// OpenPGP: armored messages (shape 0) and keys (shape 1), and a binary file named .gpg (shape 2)
const KEY_ID = '829b606631645531';
const pgpMessage = [
  ...fx.newPacket(1, fx.pkesk(KEY_ID, 1)),
  ...fx.newPacket(3, fx.skesk4(9, fx.s2kIterated(8, 0xff))),
  ...fx.newPacket(18, fx.SEIPD1),
];
pkgNth('pgp', 0, 'armored-message', text(fx.armor('PGP MESSAGE', pgpMessage, ['Version: test'])));
pkgNth(
  'pgp',
  0,
  'armored-signed-message',
  text('-----BEGIN PGP MESSAGE-----\n\n=AAAA\n-----END PGP MESSAGE-----\n'),
);
pkgNth(
  'pgp',
  1,
  'armored-public-key',
  text(fx.armor('PGP PUBLIC KEY BLOCK', fx.newPacket(6, [4, ...fx.secret(20)]))),
);
pkgNth('pgp', 2, 'binary-message', Uint8Array.from(pgpMessage));
pkgNth(
  'pgp',
  2,
  'binary-old-format',
  Uint8Array.from([...fx.newPacket(1, fx.pkesk(KEY_ID, 16)), ...fx.oldPacket(18, fx.SEIPD1)]),
);

// PKCS #12
const shroudedKey = fx.bag(fx.OID.shroudedKeyBag, fx.encryptedPrivateKeyInfo(fx.pbes2()));
pkgNth(
  'pkcs12',
  0,
  'modern',
  fx.pfx(
    [fx.safeContentsData([shroudedKey]), fx.safeContentsEncrypted(fx.pbes2({ iterations: 10000 }))],
    {
      algorithm: fx.OID.sha256,
      iterations: 10000,
    },
  ),
);
pkgNth(
  'pkcs12',
  0,
  'legacy-3des-rc2',
  fx.pfx(
    [
      fx.safeContentsEncrypted(fx.legacyPbe(fx.OID.tripleDesP12, 2048)),
      fx.safeContentsEncrypted(fx.legacyPbe(fx.OID.rc2_40P12, 2048)),
    ],
    { algorithm: fx.OID.sha1 },
  ),
);
pkgNth(
  'pkcs12',
  0,
  'scrypt-key',
  fx.pfx([
    fx.safeContentsData([
      fx.bag(fx.OID.shroudedKeyBag, fx.encryptedPrivateKeyInfo(fx.pbes2Scrypt())),
    ]),
  ]),
);
pkgNth(
  'pkcs12',
  0,
  'plain',
  fx.pfx([
    fx.safeContentsData([
      fx.bag(fx.OID.keyBag, fx.seq(fx.derInt(0))),
      fx.bag(fx.OID.certBag, fx.seq(fx.derInt(1))),
    ]),
  ]),
);

// PEM
pkgNth(
  'pem',
  0,
  'encrypted-pkcs8',
  text(
    fx.pem('ENCRYPTED PRIVATE KEY', fx.encryptedPrivateKeyInfo(fx.pbes2({ iterations: 600000 }))),
  ),
);
pkgNth('pem', 0, 'encrypted-pkcs8-not-der', text(fx.pem('ENCRYPTED PRIVATE KEY', fx.secret(40))));
pkgNth(
  'pem',
  1,
  'openssh-bcrypt',
  text(fx.pem('OPENSSH PRIVATE KEY', fx.openssh('aes256-ctr', 'bcrypt', 16))),
);
pkgNth('pem', 1, 'openssh-plain', text(fx.pem('OPENSSH PRIVATE KEY', fx.openssh('none', 'none'))));
pkgNth(
  'pem',
  2,
  'certificate-and-key',
  text(fx.pem('CERTIFICATE', fx.secret(40)) + fx.pem('PRIVATE KEY', fx.secret(40))),
);
pkgNth(
  'pem',
  3,
  'legacy-encrypted-rsa',
  text(
    fx.pem('RSA PRIVATE KEY', fx.secret(40), [
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,ABABABABABABABABABABABABABABABAB',
    ]),
  ),
);

// key-encodings target: stage 0 DER or BER, 1 base64 (the second byte is the output cap), 2 PEM text, 3 armor and age text.
const modernPfx = fx.pfx(
  [fx.safeContentsData([shroudedKey]), fx.safeContentsEncrypted(fx.pbes2())],
  {
    algorithm: fx.OID.sha256,
    iterations: 10000,
  },
);
only('key-encodings', 'der-pfx', 0, modernPfx);
only('key-encodings', 'der-pbes2', 0, Uint8Array.from(fx.encryptedPrivateKeyInfo(fx.pbes2())));
only(
  'key-encodings',
  'der-pbes2-scrypt',
  0,
  Uint8Array.from(fx.encryptedPrivateKeyInfo(fx.pbes2Scrypt())),
);
only(
  'key-encodings',
  'ber-indefinite',
  0,
  Uint8Array.from([
    0x30, 0x80, 0x02, 0x01, 0x03, 0x24, 0x80, 0x04, 0x02, 0xab, 0xab, 0x00, 0x00, 0x00, 0x00,
  ]),
);
only(
  'key-encodings',
  'der-deep',
  0,
  Uint8Array.from([...new Array<number>(14).fill(0x30), ...new Array<number>(14).fill(0x00)]),
);
only('key-encodings', 'base64-plain', 1, cat(Uint8Array.of(64), text('QUJDREVGRw==\nQUJD')));
only(
  'key-encodings',
  'base64-whitespace-and-stop',
  1,
  cat(Uint8Array.of(8), text('QU JD\tRE\r\nRkc* more')),
);
only(
  'key-encodings',
  'pem-two-blocks',
  2,
  text(
    fx.pem('CERTIFICATE', fx.secret(40)) +
      fx.pem('RSA PRIVATE KEY', fx.secret(40), [
        'Proc-Type: 4,ENCRYPTED',
        'DEK-Info: AES-128-CBC,ABABABABABABABABABABABABABABABAB',
      ]),
  ),
);
only('key-encodings', 'pem-header-only', 2, text('-----BEGIN X-----\nA: b\n\n-----END X-----\n'));
only('key-encodings', 'armor-pgp', 3, text(fx.armor('PGP MESSAGE', pgpMessage, ['Version: test'])));
only(
  'key-encodings',
  'age-armor',
  3,
  text(fx.armor('AGE ENCRYPTED FILE', fx.enc(fx.ageFile(ageStanzas))).replace('=AAAA\n', '')),
);
only('key-encodings', 'age-binary', 3, text(fx.ageFile(ageStanzas)));

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24];
/** A little-endian length, then the bytes: the framing of the APK signing block. */
const lp = (...parts: ArrayLike<number>[]): Uint8Array => {
  const body = parts.flatMap((p) => [...p]);
  return Uint8Array.from([...le32(body.length), ...body]);
};

// PE: a Rich header, long section names, a load configuration, the Go build
// information in .data, and the Authenticode image hash.
pe('rich-header', {
  dosStub: buildRichStub({
    entries: [
      { productId: 0x0102, build: 33808, count: 3 },
      { productId: 0x0105, build: 29913, count: 41 },
      { productId: 0x0001, build: 0, count: 120 },
    ],
  }),
});
const richStray = buildRichStub({
  entries: [{ productId: 0x0091, build: 30729, count: 1 }],
  strayDword: true,
});
pe('rich-header-stray-dword', { dosStub: richStray });
pe('long-section-names', {
  symbols: { count: 3, strings: ['.debug_info_long', '.eh_frame_hdr'] },
  sectionNames: ['/4', '/21'],
});
pe('load-config-guard', {
  plus: true,
  machine: 0x8664,
  dllCharacteristics: 0x4160,
  loadConfig: { cookie: 0x2b992ddfa232n, cfCount: 5n, guardFlags: 0x10500 },
  exDllCharacteristics: 1,
});
pe('load-config-safeseh', {
  loadConfig: { cookie: 0x4000n, seHandlerTable: 0x405000, seHandlerCount: 3, guardFlags: 0x100 },
});
pe('go-inline', { plus: true, data: inlineBlock({ info: SAMPLE_LINES }) });
pe('go-pointers-64', {
  plus: true,
  data: (rva) => pointerBlock({ info: SAMPLE_LINES })(0x140000000 + rva),
});
pe('go-pointers-32', {
  data: (rva) => pointerBlock({ pointerSize: 4, info: SAMPLE_LINES })(0x400000 + rva),
});

const oidOf = (...bytes: number[]): Uint8Array => tlv(0x06, Uint8Array.from(bytes));
const SHA256_OID = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const SHA1_OID = [0x2b, 0x0e, 0x03, 0x02, 0x1a];
const SPC_INDIRECT_DATA = [0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x04];
const algorithmOf = (id: number[]): Uint8Array => tlv(0x30, oidOf(...id), tlv(0x05));

/** A SignedData whose contentInfo stores `digest` under `algorithm`, with one signer (as tests/pe/imageHash.test.ts builds it). */
function signedWith(algorithm: number[], digest: Uint8Array): Uint8Array {
  const info = tlv(
    0x30,
    tlv(0x02, Uint8Array.of(1)),
    tlv(0x30, tlv(0x30), tlv(0x02, Uint8Array.of(5))),
    algorithmOf(SHA256_OID),
    algorithmOf(SHA256_OID),
    tlv(0x04, Uint8Array.of(1, 2, 3, 4)),
  );
  const indirect = tlv(
    0x30,
    tlv(0x30, oidOf(0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x0f)),
    tlv(0x30, algorithmOf(algorithm), tlv(0x04, digest)),
  );
  return tlv(
    0x30,
    oidOf(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02),
    tlv(
      0xa0,
      tlv(
        0x30,
        tlv(0x02, Uint8Array.of(1)),
        tlv(0x31, algorithmOf(algorithm)),
        tlv(0x30, oidOf(...SPC_INDIRECT_DATA), tlv(0xa0, indirect)),
        tlv(0x31, info),
      ),
    ),
  );
}

/** The Authenticode digest of a PE file: everything but the checksum, the security directory entry and the certificate table. */
function imageDigest(file: Uint8Array, algorithm: string): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const optional = view.getUint32(0x3c, true) + 24;
  const plus = view.getUint16(optional, true) === 0x20b;
  const checksum = optional + 64;
  const directory = optional + (plus ? 112 : 96) + 4 * 8;
  const table = view.getUint32(directory, true);
  const tableSize = view.getUint32(directory + 4, true);
  return createHash(algorithm)
    .update(file.subarray(0, checksum))
    .update(file.subarray(checksum + 4, directory))
    .update(file.subarray(directory + 8, table))
    .update(file.subarray(table + tableSize))
    .digest();
}

/** A signed image whose stored digest is right for its own bytes, or all zeros when `right` is false. */
function signedImage(
  algorithm: number[],
  name: string,
  right: boolean,
  spec: PeSpec = {},
): Uint8Array {
  const length = createHash(name).update('').digest().length;
  const first = buildPe({ ...spec, certificate: signedWith(algorithm, new Uint8Array(length)) });
  const digest = right ? imageDigest(first, name) : new Uint8Array(length);
  return buildPe({ ...spec, certificate: signedWith(algorithm, digest) });
}

emit(peDir, 'image-hash-match.exe', signedImage(SHA256_OID, 'sha256', true, { overlay: 300 }));
emit(peDir, 'image-hash-differs.exe', signedImage(SHA256_OID, 'sha256', false));
emit(peDir, 'image-hash-sha1.exe', signedImage(SHA1_OID, 'sha1', true, { plus: true }));

// signer: PKCS #7 (stage 0), a bare certificate (1), an APK signing block value as v2 (2) and v3 (3).
const leaf = (name: string, key = rsaSpki(2048)): Uint8Array =>
  buildLeafCertificate({
    subject: { commonName: name, organization: 'Acme' },
    issuer: { commonName: `${name} CA` },
    key,
  });
only('signer', 'pkcs7-signed-data', 0, buildSignedData(signer));
only('signer', 'pkcs7-image-hash', 0, signedWith(SHA256_OID, new Uint8Array(32).fill(7)));
only('signer', 'pkcs7-printable-strings', 0, buildSignedData({ ...signer, stringTag: 0x13 }));
only('signer', 'certificate-rsa', 1, leaf('Acme'));
only('signer', 'certificate-rsa-4096', 1, leaf('Acme 4096', rsaSpki(4096)));
const apkSigner = (v3: boolean, certificate: Uint8Array, algorithm = 0x0103): Uint8Array => {
  const digests = lp(lp(le32(algorithm), lp([1, 2, 3])));
  const signedData = lp(digests, lp(lp(certificate)), v3 ? [...le32(24), ...le32(0x7fffffff)] : []);
  const signatures = lp(lp(le32(algorithm), lp([9, 9, 9])));
  return lp(signedData, v3 ? [...le32(24), ...le32(0x7fffffff)] : [], signatures, lp([7, 7]));
};
const apkBlock = (...signers: Uint8Array[]): Uint8Array => lp(...signers.map((s) => [...s]));
only('signer', 'apk-v2', 2, apkBlock(apkSigner(false, leaf('Acme v2'))));
only('signer', 'apk-v3-ecdsa', 3, apkBlock(apkSigner(true, leaf('Acme v3'), 0x0201)));
only(
  'signer',
  'apk-v2-two-signers',
  2,
  apkBlock(apkSigner(false, leaf('A')), apkSigner(false, leaf('B'), 0x0421)),
);

// ELF: extended counts, GNU property notes, Go build information and the Go build ID.
{
  const wideField = { phnum: 56, shnum: 60, shstrndx: 62, shoff: 40 };
  const withExtendedPhnum = buildElf({ interp: LD, needed: ['libc.so.6'] });
  const view = new DataView(withExtendedPhnum.buffer);
  const zero = Number(view.getBigUint64(wideField.shoff, true));
  const real = view.getUint16(wideField.phnum, true);
  view.setUint16(wideField.phnum, 0xffff, true);
  view.setUint32(zero + 44, real, true);
  pkg('fuzz.so', 'elf', 'extended-phnum', withExtendedPhnum);
  const withExtendedShnum = buildElf({ interp: LD, needed: ['libc.so.6'] });
  const view2 = new DataView(withExtendedShnum.buffer);
  const zero2 = Number(view2.getBigUint64(wideField.shoff, true));
  const total = view2.getUint16(wideField.shnum, true);
  const names = view2.getUint16(wideField.shstrndx, true);
  view2.setUint16(wideField.shnum, 0, true);
  view2.setUint16(wideField.shstrndx, 0xffff, true);
  view2.setBigUint64(zero2 + 32, BigInt(total), true);
  view2.setUint32(zero2 + 40, names, true);
  pkg('fuzz.so', 'elf', 'extended-shnum', withExtendedShnum);
}
{
  const X86 = 0xc0000002;
  const ARM = 0xc0000000;
  pkg(
    'fuzz.so',
    'elf',
    'gnu-property-x86',
    buildElf({
      needed: ['libc.so.6'],
      propertySegment: true,
      properties: [{ type: X86, data: le32(3) }],
    }),
  );
  pkg(
    'fuzz.so',
    'elf',
    'gnu-property-arm',
    buildElf({
      machine: 183,
      needed: ['libc.so.6'],
      properties: [
        { type: ARM, data: le32(3) },
        { type: 0x1, data: [1, 2, 3, 4], size: 0x10 },
      ],
    }),
  );
}
const goSection = (data: Uint8Array) => ({ name: '.go.buildinfo', align: 16, data });
pkg(
  'fuzz.so',
  'elf',
  'go-inline',
  buildElf({
    type: 2,
    goBuildId: 'abc/def',
    sections: [goSection(inlineBlock({ info: SAMPLE_LINES }))],
  }),
);
pkg(
  'fuzz.so',
  'elf',
  'go-segment-no-sections',
  buildElf({
    type: 2,
    loadFlags: 6,
    noSections: true,
    sections: [goSection(inlineBlock({ info: SAMPLE_LINES }))],
  }),
);

// Mach-O: more load commands, encryption, and a Java class file that has the fat magic.
pkg(
  'fuzz.dylib',
  'macho',
  'commands',
  buildMacho({
    cputype: CPU.ARM64,
    flags: 0x200000,
    commands: [
      segment('__TEXT', { sections: ['__text'] }),
      dylinker(),
      uuid(MACHO_UUID),
      buildVersion(1, ver(14), ver(14, 2), [[3, ver(1000)]]),
      sourceVersion(1, 2, 3, 4, 5),
      main(0x1000),
      rpath('@executable_path/../Frameworks'),
      dylib(LC.LOAD_WEAK_DYLIB, '/usr/lib/libz.1.dylib'),
      dylib(LC.REEXPORT_DYLIB, '/usr/lib/libx.dylib'),
      linkedit(LC.CODE_SIGNATURE, 0x3000, 0x400),
    ],
  }),
);
pkg(
  'fuzz.dylib',
  'macho',
  'legacy-version-min-encrypted',
  buildMacho({
    wide: false,
    cputype: CPU.X86,
    commands: [
      versionMin(LC.VERSION_MIN_IPHONEOS, ver(9), ver(9, 3)),
      encryption(LC.ENCRYPTION_INFO, 1),
    ],
  }),
);
pkg(
  'fuzz.dylib',
  'macho',
  'encrypted-64',
  buildMacho({ commands: [encryption(LC.ENCRYPTION_INFO_64, 1)] }),
);
pkg('fuzz.universal', 'macho', 'java-class', buildClassFileLike(52, 0, 2048));
pkg('fuzz.universal', 'macho', 'java-class-small-count', buildClassFileLike(2, 0, 2048));
pkg(
  'fuzz.universal',
  'macho',
  'universal-wide',
  buildFat([{ bytes: machoLibrary, cputype: CPU.ARM64 }], { wide: true, align: 0x400 }),
);

// RPM: a payload the check walks (gzip, then zstd), with the real digests stored.
const hexField = (n: number): string => n.toString(16).toUpperCase().padStart(8, '0');
const padTo4 = (n: number): number => (4 - (n % 4)) % 4;
/** One "newc" cpio member: a 110-byte header, the NUL-ended name padded to 4, the data padded to 4. */
function cpioMember(name: string, data = '', magic = '070701'): Uint8Array {
  const nameBytes = ascii(`${name}\0`);
  const body = ascii(data);
  const fields = [1, 0o100644, 0, 0, 1, 0, body.length, 0, 0, 0, 0, nameBytes.length, 0];
  const nameAt = 110 + nameBytes.length + padTo4(110 + nameBytes.length);
  const member = new Uint8Array(nameAt + body.length + padTo4(body.length));
  member.set(ascii(`${magic}${fields.map(hexField).join('')}`), 0);
  member.set(nameBytes, 110);
  member.set(body, nameAt);
  return member;
}
const cpio = (names: string[], magic = '070701'): Uint8Array =>
  cat(
    ...names.map((n, i) => cpioMember(n, 'x'.repeat(i * 3 + 1), magic)),
    cpioMember('TRAILER!!!', '', magic),
  );
/** A zstd frame of raw blocks, which any decoder accepts (as tests/pkg/rpmPayload.test.ts builds it). */
function zstdRaw(data: Uint8Array): Uint8Array {
  const head = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0, 0, 0, 0]);
  new DataView(head.buffer).setUint32(5, data.length, true);
  const word = (data.length << 3) | 1;
  return cat(head, Uint8Array.of(word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff), data);
}
const PAYLOAD_PATHS = ['./usr/bin/tree', './usr/share/doc/tree', './usr/share/doc/tree/README'];
const PAYLOAD_FILES = [
  { dir: '/usr/bin/', name: 'tree', size: 100 },
  { dir: '/usr/share/doc/', name: 'tree', size: 0, mode: 0o040755 },
  { dir: '/usr/share/doc/tree/', name: 'README', size: 12 },
];
pkg(
  'fuzz.rpm',
  'rpm',
  'payload-gzip',
  buildRpm({
    files: PAYLOAD_FILES,
    payload: gzipSync(cpio(PAYLOAD_PATHS)),
    main: [str(1125, 'gzip')],
    digests: true,
  }),
);
pkg(
  'fuzz.rpm',
  'rpm',
  'payload-zstd-differs',
  buildRpm({
    files: PAYLOAD_FILES,
    payload: zstdRaw(cpio(PAYLOAD_PATHS.slice(1))),
    main: [str(1125, 'zstd')],
    digests: true,
  }),
);

// APK: DEX files (stored digests right and wrong), a signing block, and zip encryption labels.
const apkWith = (entries: FixtureEntry[], options = {}): Uint8Array =>
  buildZip(
    [{ name: 'AndroidManifest.xml', data: buildAxml(androidManifest) }, ...entries],
    options,
  );
pkg(
  'fuzz.apk',
  'zip',
  'dex-two-files',
  apkWith([
    { name: 'classes.dex', data: buildDex({ classes: 10, methods: 65536, strings: 7 }) },
    {
      name: 'classes2.dex',
      data: buildDex({ classes: 5, methods: 100, strings: 3, version: '039' }),
    },
  ]),
);
pkg(
  'fuzz.apk',
  'zip',
  'dex-bad-digests',
  apkWith([{ name: 'classes.dex', data: buildDex({ badChecksum: true, badSignature: true }) }]),
);
pkg(
  'fuzz.apk',
  'zip',
  'dex-deflated-endian',
  apkWith([
    { name: 'classes.dex', data: buildDex({ endian: 0x78563412, size: 0x400 }), method: 8 },
  ]),
);
pkg(
  'fuzz.apk',
  'zip',
  'signing-block-v2-v3',
  apkWith([{ name: 'classes.dex', data: buildDex() }], {
    signingBlockPairs: [
      { id: 0x7109871a, value: apkBlock(apkSigner(false, leaf('Acme v2'))) },
      { id: 0xf05368c0, value: apkBlock(apkSigner(true, leaf('Acme v3'), 0x0201)) },
    ],
  }),
);
const aesField = (version: number, strength: number, method: number): Uint8Array =>
  Uint8Array.from([0x01, 0x99, 0x07, 0x00, version, 0, 0x41, 0x45, strength, method, 0]);
pkg(
  'fuzz.jar',
  'zip',
  'aes-encrypted',
  buildZip([
    {
      name: 'a.txt',
      data: 'secret',
      encrypted: true,
      methodNumber: 99,
      centralExtra: aesField(2, 3, 8),
    },
    {
      name: 'b.txt',
      data: 'secret',
      encrypted: true,
      methodNumber: 99,
      centralExtra: aesField(1, 1, 0),
    },
    { name: 'c.txt', data: 'secret', encrypted: true },
    { name: 'd.txt', data: 'secret', encrypted: true, flagBits: 0x40 },
  ]),
);

// cpio target: stage 0 walks the bytes as cpio, 1 gzip, 2 zstd, 3 xz; the second byte is the piece size.
const SPLIT = 7;
const cpioNames = ['./usr/bin/tree', './etc/tree.conf', './usr/share/doc/tree/README', './a'];
only('cpio', 'walk-newc', 0, cat(Uint8Array.of(SPLIT), cpio(cpioNames)));
only('cpio', 'walk-crc', 0, cat(Uint8Array.of(SPLIT), cpio(cpioNames, '070702')));
only('cpio', 'walk-no-trailer', 0, cat(Uint8Array.of(3), cpio(cpioNames).subarray(0, 300)));
only('cpio', 'walk-odc-format', 0, cat(Uint8Array.of(SPLIT), cpio(cpioNames, '070707')));
only('cpio', 'gzip', 1, cat(Uint8Array.of(SPLIT), gzipSync(cpio(cpioNames))));
only('cpio', 'zstd', 2, cat(Uint8Array.of(SPLIT), zstdRaw(cpio(cpioNames))));
only('cpio', 'zstd-vector', 2, cat(Uint8Array.of(SPLIT), b64(VECTOR_ZST)));
only('cpio', 'xz-vector', 3, cat(Uint8Array.of(SPLIT), b64(VECTOR_XZ)));

// dex target: stage 0 stored, 1 deflated, 2 stored with a second file.
only('dex', 'valid', 0, buildDex({ classes: 3, methods: 20, strings: 9 }));
only('dex', 'valid-deflated', 1, buildDex({ size: 0x400, classes: 1 }));
only('dex', 'two-files', 2, buildDex({ size: 0x300, version: '038' }));
only('dex', 'bad-checksum', 0, buildDex({ badChecksum: true }));
only('dex', 'bad-signature', 0, buildDex({ badSignature: true }));
only('dex', 'declared-size-lies', 0, buildDex({ declaredSize: 0x10000 }));
only('dex', 'big-endian-tag', 0, buildDex({ endian: 0x78563412 }));
only('dex', 'header-only', 0, buildDex({ size: 0x70 }));

// go-buildinfo target: stage 0 module text, 1 the section as it is, 2 the section with the magic written over its start.
const BASE_GO = 0x400000;
only('go-buildinfo', 'modinfo-lines', 0, cat(ascii(SAMPLE_LINES.map((l) => `${l}\n`).join(''))));
only(
  'go-buildinfo',
  'modinfo-quoted',
  0,
  ascii('path\tx\nbuild\t-ldflags="-s -w"\nbuild\tvcs.revision=abc\nmod\tm\t(devel)\t\n'),
);
only('go-buildinfo', 'inline', 1, inlineBlock({ info: SAMPLE_LINES }));
only('go-buildinfo', 'inline-version-only', 1, inlineBlock());
only('go-buildinfo', 'inline-big', 2, inlineBlock({ info: SAMPLE_LINES, big: true }));
only('go-buildinfo', 'pointers-64', 1, pointerBlock({ info: SAMPLE_LINES })(BASE_GO));
only(
  'go-buildinfo',
  'pointers-32',
  1,
  pointerBlock({ pointerSize: 4, info: SAMPLE_LINES })(BASE_GO),
);
// The longest "Module replaced by" row the reader assembles: a 512-character path, a space and a 512-character version.
only(
  'go-buildinfo',
  'replacement-at-limit',
  1,
  inlineBlock({ info: ['mod	m	v1.0.0	', `=>	${'p'.repeat(512)}	v${'1'.repeat(511)}`] }),
);
only(
  'go-buildinfo',
  'long-length',
  1,
  inlineBlock({ info: SAMPLE_LINES, declaredInfoLength: 1 << 30 }),
);

// ooxml-encrypted target: stage 0 an EncryptionInfo stream, 1 a whole file.
const encryptionInfo = (major: number, minor: number, body: Uint8Array): Uint8Array =>
  cat(Uint8Array.of(major, 0, minor, 0), body);
const agileXml = ascii(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password"><keyData saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512" saltValue="AAAAAAAAAAAAAAAAAAAAAA=="/></encryption>',
);
const agile = encryptionInfo(4, 4, cat(Uint8Array.of(0x40, 0, 0, 0), agileXml));
const standardHeader = new Uint8Array(32);
new DataView(standardHeader.buffer).setUint32(0, 20, true);
new DataView(standardHeader.buffer).setUint32(12, 0x6610, true);
const standard = encryptionInfo(3, 2, cat(Uint8Array.of(0x24, 0, 0, 0), standardHeader));
const extensible = encryptionInfo(3, 3, Uint8Array.of(0, 0, 0, 0));
only('ooxml-encrypted', 'info-agile', 0, agile);
only('ooxml-encrypted', 'info-standard', 0, standard);
only('ooxml-encrypted', 'info-extensible', 0, extensible);
only(
  'ooxml-encrypted',
  'info-agile-single-quotes',
  0,
  encryptionInfo(
    4,
    4,
    cat(
      Uint8Array.of(0x40, 0, 0, 0),
      ascii("<keyData keyBits = '128' cipherAlgorithm = 'AES' hashAlgorithm='SHA1'/>"),
    ),
  ),
);
// The input that made describeEncryptionInfo print a control character from a cipher name.
only(
  'ooxml-encrypted',
  'control-char-in-cipher-name',
  0,
  encryptionInfo(
    4,
    4,
    cat(
      Uint8Array.of(0x40, 0, 0, 0),
      ascii("<keyData keyBits = '128' cipherAlgorithm = 'A\u0012ES' hashAlgorithm='SHA'/>"),
    ),
  ),
);
const lockedFile = (info: Uint8Array): Uint8Array =>
  buildCfb({
    streams: [
      { name: 'EncryptionInfo', data: info },
      { name: 'EncryptedPackage', data: new Uint8Array(64).fill(0xaa) },
    ],
  });
only('ooxml-encrypted', 'file-agile', 1, lockedFile(agile));
only('ooxml-encrypted', 'file-standard', 1, lockedFile(standard));
only('ooxml-encrypted', 'file-short-info', 1, lockedFile(Uint8Array.of(4, 0)));
if (skipped.length > 0) {
  console.log(`SKIPPED (over ${MAX_BYTES} bytes): ${skipped.join(', ')}`);
}
