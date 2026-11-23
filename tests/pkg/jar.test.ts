import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseJarManifest } from '../../src/pkg/jar';
import { buildSignedData } from '../pe/fixture';
import {
  buildZip,
  expectSafe,
  hasSection,
  html,
  readZip,
  section,
  tableRows,
  value,
  type FixtureEntry,
} from './zipFixture';

const RLO = String.fromCharCode(0x202e);

/** Wrap one header as the Jar specification says: 72 bytes a line, continuations start with a space. */
function wrap(line: string): string {
  let out = line.slice(0, 72);
  for (let at = 72; at < line.length; at += 71) {
    out += `\r\n ${line.slice(at, at + 71)}`;
  }
  return out;
}

const manifest = (headers: [string, string][], extra = ''): string =>
  `${['Manifest-Version: 1.0', ...headers.map(([n, v]) => wrap(`${n}: ${v}`))].join('\r\n')}\r\n\r\n${extra}`;

/** The first eight bytes of a class file plus filler: magic, minor, major. */
const classFile = (major: number, minor = 0): Uint8Array =>
  Uint8Array.from([
    0xca,
    0xfe,
    0xba,
    0xbe,
    minor >> 8,
    minor & 0xff,
    major >> 8,
    major & 0xff,
    0,
    0,
    0,
    0,
  ]);

const jar = (headers: [string, string][], more: FixtureEntry[] = []): Uint8Array =>
  buildZip([{ name: 'META-INF/MANIFEST.MF', data: manifest(headers) }, ...more]);

describe('parseJarManifest', () => {
  it('joins continuation lines and stops at the first blank line', () => {
    const parsed = parseJarManifest(
      'Manifest-Version: 1.0\r\nClass-Path: a.jar b\r\n .jar c.jar\r\n\r\nName: x/Y.class\r\nSHA-256-Digest: zz\r\n',
    );
    expect(parsed).toEqual([
      ['Manifest-Version', '1.0'],
      ['Class-Path', 'a.jar b.jar c.jar'],
    ]);
  });

  it('keeps the first of a repeated header, whatever its case', () => {
    expect(parseJarManifest('Main-Class: A\nmain-class: B\n')).toEqual([['Main-Class', 'A']]);
  });

  it('accepts bare line feeds and carriage returns', () => {
    expect(parseJarManifest('A: 1\nB: 2\rC: 3')).toEqual([
      ['A', '1'],
      ['B', '2'],
      ['C', '3'],
    ]);
  });

  it('stops collecting at the attribute cap', () => {
    const lines = Array.from({ length: 800 }, (_, i) => `H${i}: v`).join('\n');
    expect(parseJarManifest(lines).length).toBe(500);
  });
});

describe('readZipPackage: a Java archive', () => {
  const headers: [string, string][] = [
    ['Main-Class', 'com.example.App'],
    ['Implementation-Title', 'Example App'],
    ['Implementation-Version', '2.3.4'],
    ['Implementation-Vendor', 'Example Corp'],
    ['Specification-Title', 'Example Spec'],
    ['Specification-Version', '2'],
    ['Specification-Vendor', 'Spec Corp'],
    ['Bundle-SymbolicName', 'com.example.app'],
    ['Bundle-Version', '2.3.4.RELEASE'],
    ['Bundle-Name', 'Example Bundle'],
    ['Automatic-Module-Name', 'com.example.app'],
    ['Multi-Release', 'true'],
    ['Created-By', '17.0.2 (Eclipse Adoptium)'],
    ['Build-Jdk-Spec', '17'],
    ['Class-Path', 'lib/one.jar lib/two.jar lib/three.jar lib/four.jar lib/five.jar lib/six.jar'],
    ['Launcher-Agent-Class', 'com.example.Agent'],
    ['Premain-Class', 'com.example.Premain'],
    ['Add-Opens', 'java.base/java.lang'],
    ['Spring-Boot-Version', '3.2.1'],
  ];
  const pom = 'groupId=com.example\nartifactId=app\nversion=2.3.4\n';
  const entries: FixtureEntry[] = [
    { name: 'com/example/App.class', data: classFile(61), method: 8 },
    { name: 'com/example/Other.class', data: classFile(61) },
    { name: 'module-info.class', data: classFile(53) },
    { name: 'META-INF/maven/com.example/app/pom.properties', data: pom },
    { name: 'META-INF/maven/com.example/app/pom.xml', data: '<project/>' },
  ];

  it('reads every manifest attribute the page shows', async () => {
    const info = await readZip(jar(headers, entries), 'app.jar');
    expect(info.format).toBe('Java archive (JAR)');
    expect(info.title).toBe('Example App 2.3.4');
    expect(value(info, 'Package', 'Title')).toBe('Example App');
    expect(value(info, 'Package', 'Version')).toBe('2.3.4');
    expect(value(info, 'Package', 'Vendor')).toBe('Example Corp');
    expect(value(info, 'Package', 'Specification')).toBe('Example Spec');
    expect(value(info, 'Package', 'Specification version')).toBe('2');
    expect(value(info, 'Package', 'Specification vendor')).toBe('Spec Corp');
    expect(value(info, 'Package', 'OSGi symbolic name')).toBe('com.example.app');
    expect(value(info, 'Package', 'OSGi bundle version')).toBe('2.3.4.RELEASE');
    expect(value(info, 'Package', 'OSGi bundle name')).toBe('Example Bundle');
    expect(value(info, 'Package', 'Module name')).toBe('com.example.app');
    expect(value(info, 'Package', 'Created by')).toBe('17.0.2 (Eclipse Adoptium)');
    expect(value(info, 'Package', 'Built with JDK')).toBe('17');
    expect(value(info, 'Java', 'Main class')).toBe('com.example.App');
    expect(value(info, 'Java', 'Launcher agent')).toBe('com.example.Agent');
    expect(value(info, 'Java', 'Premain agent')).toBe('com.example.Premain');
    expect(value(info, 'Java', 'Opens packages to reflection')).toContain('Yes');
    expect(value(info, 'Java', 'Multi-release')).toBe('true');
  });

  it('rejoins a Class-Path that was wrapped across lines', async () => {
    const info = await readZip(jar(headers, entries));
    expect(value(info, 'Java', 'Class path')).toBe(
      'lib/one.jar lib/two.jar lib/three.jar lib/four.jar lib/five.jar lib/six.jar',
    );
  });

  it('lists the remaining attributes verbatim, and not the ones already shown', async () => {
    const info = await readZip(jar(headers, entries));
    expect(tableRows(info, 'Other manifest attributes')).toEqual([
      ['Spring-Boot-Version', '3.2.1'],
    ]);
  });

  it('reads the Maven coordinates, class count, module and class file version', async () => {
    const info = await readZip(jar(headers, entries));
    expect(value(info, 'Package', 'Maven coordinates')).toBe('com.example:app:2.3.4');
    expect(value(info, 'Java', 'Classes')).toBe('3');
    expect(value(info, 'Java', 'Java module')).toContain('Yes');
    expect(value(info, 'Java', 'Class file version')).toBe('61.0 (Java 17)');
    expect(info.summary).toContain('3 classes');
  });

  it('takes the title from the Maven artifact when the manifest has no name', async () => {
    const info = await readZip(jar([], entries.slice(3)));
    expect(info.title).toBe('app 2.3.4');
  });

  it('maps class file versions to releases, early and preview ones included', async () => {
    const cases: [number, number, string][] = [
      [45, 3, '45.3 (Java 1.1)'],
      [49, 0, '49.0 (Java 5)'],
      [52, 0, '52.0 (Java 8)'],
      [65, 65535, '65.65535 (Java 21), compiled with preview features'],
    ];
    for (const [major, minor, expected] of cases) {
      const info = await readZip(jar([], [{ name: 'A.class', data: classFile(major, minor) }]));
      expect(value(info, 'Java', 'Class file version')).toBe(expected);
    }
  });

  it('omits the version when the first class is not a class file', async () => {
    const info = await readZip(jar([], [{ name: 'A.class', data: 'not a class file at all' }]));
    expect(value(info, 'Java', 'Classes')).toBe('1');
    expect(hasSection(info, 'Java') && value(info, 'Java', 'Class file version')).toBeFalsy();
  });

  it('calls out a web archive and an enterprise archive', async () => {
    const war = await readZip(jar([], [{ name: 'WEB-INF/web.xml', data: '<web-app/>' }]), 'a.war');
    expect(war.format).toBe('Java web archive (WAR)');
    expect(value(war, 'Java', 'Web application')).toContain('Yes');
    const ear = await readZip(
      jar([], [{ name: 'META-INF/application.xml', data: '<application/>' }]),
    );
    expect(ear.format).toBe('Java enterprise archive (EAR)');
    expect(value(ear, 'Java', 'Enterprise application')).toContain('Yes');
  });

  it('reports a JAR signing block and the name in it', async () => {
    const der = buildSignedData({
      subject: { commonName: 'Example Signer', organization: 'Example Corp' },
      issuer: { commonName: 'Example CA' },
    });
    const info = await readZip(
      jar(headers, [
        { name: 'META-INF/CERT.RSA', data: der },
        { name: 'META-INF/CERT.SF', data: 'Signature-Version: 1.0\n' },
      ]),
    );
    expect(value(info, 'Signature', 'Status')).toContain('JAR signing');
    expect(value(info, 'Signature', 'Signer')).toBe('Example Signer');
    expect(value(info, 'Signature', 'Issued by')).toBe('Example CA');
    // The caveat travels with every signature section.
    expect((section(info, 'Signature') as { note?: string }).note).toContain('does not check');
  });

  it('still reports a signature block that is not PKCS #7, without a name', async () => {
    const info = await readZip(jar([], [{ name: 'META-INF/X.EC', data: 'junk' }]));
    expect(value(info, 'Signature', 'Status')).toContain('present');
    expect(value(info, 'Signature', 'Signer')).toBeUndefined();
  });

  it('has no Signature section when unsigned', async () => {
    expect(hasSection(await readZip(jar(headers, entries)), 'Signature')).toBe(false);
  });

  it('reads a deflated manifest', async () => {
    const bytes = buildZip([{ name: 'META-INF/MANIFEST.MF', data: manifest(headers), method: 8 }]);
    expect(value(await readZip(bytes), 'Java', 'Main class')).toBe('com.example.App');
  });

  it('is a plain archive, not a Java one, without a manifest', async () => {
    const info = await readZip(buildZip([{ name: 'readme.txt', data: 'hi' }]), 'x.jar');
    expect(info.format).toBe('Zip archive');
    expect(hasSection(info, 'Contents')).toBe(true);
  });
});

describe('readZipPackage: the Contents table', () => {
  it('leads with the counts and sizes, and caps the rows', async () => {
    const files = Array.from({ length: 250 }, (_, i) => ({ name: `f/${i}.txt`, data: 'abcd' }));
    const info = await readZip(buildZip([{ name: 'f/' }, ...files]));
    const contents = section(info, 'Contents') as {
      lead?: string;
      note?: string;
      rows: string[][];
    };
    expect(contents.rows.length).toBe(200);
    expect(contents.lead).toContain('250 entries');
    expect(contents.lead).toContain('1,000 bytes uncompressed');
    expect(contents.note).toBe('Showing the first 200 of 250 files.');
    expect(contents.rows[0]).toEqual(['f/0.txt', '4 bytes']);
  });
});

describe('readZipPackage: hostile Java archives', () => {
  it('turns a manifest bomb into a warning and still shows the page', async () => {
    const bomb = deflateSync(new Uint8Array(6 * 1024 * 1024).fill(0x41));
    const bytes = buildZip([
      { name: 'META-INF/MANIFEST.MF', data: bomb, declaredSize: 20, methodNumber: 8 },
      { name: 'A.class', data: classFile(52) },
    ]);
    const info = await readZip(bytes);
    expect(info.warnings).toContain('The manifest could not be read.');
    expect(value(info, 'Java', 'Classes')).toBe('1');
  });

  it('warns about an encrypted manifest', async () => {
    const info = await readZip(
      buildZip([{ name: 'META-INF/MANIFEST.MF', data: 'x', encrypted: true }]),
    );
    expect(info.warnings).toContain('The manifest could not be read.');
  });

  it('escapes markup and strips direction overrides from every shown value', async () => {
    const info = await readZip(
      jar([
        ['Implementation-Title', '<img src=x onerror=1>'],
        ['Main-Class', `evil${RLO}piz.App`],
        ['Evil-Header', '<script>alert(1)</script>'],
      ]),
    );
    const page = html(info);
    expect(page).toContain('&lt;img src=x onerror=1&gt;');
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain('<script>alert');
    expect(page).not.toContain(RLO);
    expect(value(info, 'Java', 'Main class')).toBe('evilpiz.App');
  });

  it('cuts a very long attribute value', async () => {
    const info = await readZip(jar([['Import-Package', 'p.'.repeat(30000)]]));
    const cell = tableRows(info, 'Other manifest attributes')[0][1];
    expect(cell.length).toBeLessThanOrEqual(303);
  });

  it('survives truncation and corruption', async () => {
    const der = buildSignedData({ subject: { commonName: 'S' }, issuer: { commonName: 'I' } });
    const bytes = jar(
      [
        ['Main-Class', 'A'],
        ['Implementation-Title', 'T'],
      ],
      [
        { name: 'A.class', data: classFile(52) },
        { name: 'META-INF/maven/g/a/pom.properties', data: 'groupId=g\nartifactId=a\n' },
        { name: 'META-INF/K.RSA', data: der },
      ],
    );
    await expectSafe(bytes, 'x.jar');
  });
});
