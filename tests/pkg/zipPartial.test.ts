// A page says something is absent, or that nothing happens, only when the
// central directory was listed to the end. Each archive here is real bytes whose
// last central-directory record has been damaged, so the reader lists every
// entry before it and stops there: the same result as a directory cut short by
// the reader's size cap, where the last record is never reached.
import { describe, expect, it } from 'vitest';
import { buildSignedData } from '../pe/fixture';
import { buildAxml } from './axmlFixture';
import { buildZip, hasSection, readZip, section, value, type FixtureEntry } from './zipFixture';

const signedBy = (name: string): Uint8Array =>
  buildSignedData({ subject: { commonName: name }, issuer: { commonName: 'CA' } });

const SF = 'Signature-Version: 1.0\n';
const MANIFEST: FixtureEntry = { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\n' };
const androidManifest = buildAxml({
  name: 'manifest',
  attrs: [{ name: 'package', type: 'string', value: 'com.example.app' }],
  children: [],
});

/** The archive with its last central-directory record's signature spoiled, so listing stops before it. */
function cutDirectory(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  for (let i = copy.length - 4; i >= 0; i--) {
    if (copy[i] === 0x50 && copy[i + 1] === 0x4b && copy[i + 2] === 0x01 && copy[i + 3] === 0x02) {
      copy[i + 2] = 0x7f;
      return copy;
    }
  }
  throw new Error('no central directory record');
}

/** Pad the listing with ordinary entries so the dropped record is the only one that matters. */
const ordinary = (count: number): FixtureEntry[] =>
  Array.from({ length: count }, (_, i) => ({ name: `res/file${i}.txt`, data: 'x' }));

const status = (info: Awaited<ReturnType<typeof readZip>>): string =>
  value(info, 'Signature', 'Status') ?? '';

describe('a partial listing does not declare an APK manifest absent', () => {
  const entries = (last: FixtureEntry): FixtureEntry[] => [
    { name: 'AndroidManifest.xml', data: androidManifest },
    { name: 'META-INF/CERT.SF', data: SF },
    { name: 'META-INF/CERT.RSA', data: signedBy('Release') },
    ...ordinary(20),
    last,
  ];

  it('says a complete listing without the manifest is not a v1 signature', async () => {
    const info = await readZip(buildZip(entries({ name: 'res/last.txt', data: 'x' })));
    expect(status(info)).toContain('has no META-INF/MANIFEST.MF, so it is not a v1 signature');
  });

  it('says the prerequisites were not established when the manifest may be in the unlisted part', async () => {
    const info = await readZip(cutDirectory(buildZip(entries(MANIFEST))));
    expect(status(info)).toContain('could not be established');
    expect(status(info)).not.toContain('is not a v1 signature');
    expect(info.warnings.join(' ')).toContain('could be listed');
    expect(info.warnings.join(' ')).not.toContain('The archive has no META-INF/MANIFEST.MF');
  });
});

describe('a partial listing does not say a signature block has no .SF', () => {
  const jar = (entries: FixtureEntry[]): Uint8Array =>
    buildZip([MANIFEST, ...ordinary(10), ...entries]);

  it('says a block with no .SF in a complete listing does not form a signature', async () => {
    const info = await readZip(jar([{ name: 'META-INF/DEMO.RSA', data: signedBy('Demo') }]));
    expect(status(info)).toContain('has no signature file, so it does not form a signature');
  });

  it('says it is not known when the .SF may be unlisted', async () => {
    const info = await readZip(
      cutDirectory(
        jar([
          { name: 'META-INF/DEMO.RSA', data: signedBy('Demo') },
          { name: 'META-INF/DEMO.SF', data: SF },
        ]),
      ),
    );
    expect(status(info)).toContain('whether it forms a signature is not known');
    expect(status(info)).not.toContain('so it does not form a signature');
    expect(info.warnings.join(' ')).toContain('a matching file may be unlisted');
  });

  it('says a .SF with no block may have its block unlisted', async () => {
    const info = await readZip(
      cutDirectory(
        jar([
          { name: 'META-INF/DEMO.SF', data: SF },
          { name: 'META-INF/DEMO.RSA', data: signedBy('Demo') },
        ]),
      ),
    );
    expect(info.warnings.join(' ')).toContain('a block may be unlisted');
  });
});

describe('a partial listing does not declare a wheel inert', () => {
  const METADATA = 'Name: demo\nVersion: 1\n';
  const wheel = (extra: FixtureEntry[], last: FixtureEntry): Uint8Array =>
    buildZip([
      { name: 'demo-1.dist-info/METADATA', data: METADATA },
      { name: 'demo-1.dist-info/WHEEL', data: 'Wheel-Version: 1.0\nRoot-Is-Purelib: true\n' },
      ...extra,
      last,
    ]);
  const rows = (info: Awaited<ReturnType<typeof readZip>>): [string, string][] =>
    (section(info, 'Code that runs') as { rows: [string, string][] }).rows;

  it('does not say the file list is missing', async () => {
    const whole = await readZip(wheel([], { name: 'demo/a.py', data: 'x' }));
    expect(value(whole, 'Wheel', 'File list (RECORD)')).toBe('No');
    const cut = await readZip(
      cutDirectory(wheel([], { name: 'demo-1.dist-info/RECORD', data: 'demo/a.py,,\n' })),
    );
    expect(value(cut, 'Wheel', 'File list (RECORD)')).toContain('Not found in the part');
  });

  it('says a .start file that would suppress an import line may be unlisted', async () => {
    const pth: FixtureEntry = { name: 'demo.pth', data: 'import math\n' };
    const whole = await readZip(wheel([pth], { name: 'demo/a.py', data: 'x' }));
    expect(rows(whole)[0][1]).toContain('Runs code at every Python start');
    expect(rows(whole)[0][1]).not.toContain('incomplete');
    const cut = await readZip(cutDirectory(wheel([pth], { name: 'demo.start', data: '# none\n' })));
    expect(rows(cut)[0][1]).toContain('listing is incomplete');
    expect(rows(cut)[0][1]).toContain('may be unlisted');
  });

  it('counts scripts as a lower bound', async () => {
    const script: FixtureEntry = { name: 'demo-1.data/scripts/run', data: 'x' };
    const cut = await readZip(
      cutDirectory(wheel([script], { name: 'demo-1.data/scripts/other', data: 'x' })),
    );
    expect(value(cut, 'Code that runs', 'Scripts installed to the PATH')).toBe(
      '1 or more files under *.data/scripts',
    );
  });
});

describe('a partial listing does not declare a Java archive or a plain zip final', () => {
  it('says the class count is a lower bound in the summary', async () => {
    const entries: FixtureEntry[] = [
      MANIFEST,
      { name: 'a/A.class', data: 'x' },
      { name: 'a/B.class', data: 'x' },
    ];
    const whole = await readZip(buildZip(entries));
    expect(whole.summary).toContain('with 2 classes');
    const cut = await readZip(cutDirectory(buildZip(entries)));
    expect(cut.summary).toContain('with 1 or more classes');
  });

  it('says no package type was recognised only in the part that was listed', async () => {
    const entries: FixtureEntry[] = [
      { name: 'a.txt', data: 'x' },
      { name: 'b.txt', data: 'x' },
    ];
    const whole = await readZip(buildZip(entries));
    expect(whole.summary).toBe('A zip archive that is not a recognised package type.');
    const cut = await readZip(cutDirectory(buildZip(entries)));
    expect(cut.summary).toContain('in the part that could be listed');
  });

  it('says an APK is unsigned only for a complete listing', async () => {
    const entries: FixtureEntry[] = [
      { name: 'AndroidManifest.xml', data: androidManifest },
      MANIFEST,
      { name: 'res/a.txt', data: 'x' },
    ];
    const whole = await readZip(buildZip(entries));
    expect(status(whole)).toContain('Not signed');
    const cut = await readZip(cutDirectory(buildZip(entries)));
    expect(hasSection(cut, 'Signature')).toBe(true);
    expect(status(cut)).toContain('in the part of the archive that could be listed');
    expect(status(cut)).not.toContain('Not signed');
  });
});
