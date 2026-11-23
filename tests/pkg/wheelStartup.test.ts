// Where a wheel's startup files install, and what happens when several archive
// entries install to one path. The behaviour of site.py comes from CPython
// v3.15.2 Lib/site.py: only the site folder itself is listed, and a .pth is
// matched to its .start by the full path.
import { describe, expect, it } from 'vitest';
import { buildZip, hasSection, readZip, value, type FixtureEntry } from './zipFixture';

const METADATA = 'Name: demo-pkg\nVersion: 1.4.0\n';
const DATA = 'demo_pkg-1.4.0.data';
const PURE = 'Wheel-Version: 1.0\nRoot-Is-Purelib: true\n';
const SKIPPED = 'Python 3.15 and later skip it because';
const DEPENDS = 'depends on which copy';

type Info = Awaited<ReturnType<typeof readZip>>;
const rowFor = (info: Info, name: string): string => value(info, 'Code that runs', name) ?? '';
const quiet = (name: string): FixtureEntry => ({ name, data: '# nothing\n' });
const pth: FixtureEntry = { name: 'demo.pth', data: 'import math\n' };

const build = (wheelText: string | undefined, files: FixtureEntry[]): Uint8Array =>
  buildZip([
    { name: 'demo_pkg-1.4.0.dist-info/METADATA', data: METADATA },
    ...(wheelText === undefined
      ? []
      : [{ name: 'demo_pkg-1.4.0.dist-info/WHEEL', data: wheelText }]),
    ...files,
  ]);

describe('readZipPackage: where a wheel installs its startup files', () => {
  it('keeps purelib and platlib apart: a .start in the other one depends on the scheme', async () => {
    const info = await readZip(build(PURE, [pth, quiet(`${DATA}/platlib/demo.start`)]));
    expect(rowFor(info, 'demo.pth')).toContain('depends on the installation scheme');
    expect(rowFor(info, 'demo.pth')).not.toContain(SKIPPED);
    expect(rowFor(info, 'demo.pth')).toContain('Runs code');
  });

  it('assigns the root to purelib when Root-Is-Purelib is true', async () => {
    const info = await readZip(build(PURE, [pth, quiet(`${DATA}/purelib/demo.start`)]));
    expect(rowFor(info, 'demo.pth')).toContain(SKIPPED);
  });

  it('assigns the root to platlib when Root-Is-Purelib is false', async () => {
    const wheelText = 'Wheel-Version: 1.0\nRoot-Is-Purelib: false\n';
    const same = await readZip(build(wheelText, [pth, quiet(`${DATA}/platlib/demo.start`)]));
    expect(rowFor(same, 'demo.pth')).toContain(SKIPPED);
    const other = await readZip(build(wheelText, [pth, quiet(`${DATA}/purelib/demo.start`)]));
    expect(rowFor(other, 'demo.pth')).toContain('depends on the installation scheme');
    expect(rowFor(other, 'demo.pth')).not.toContain(SKIPPED);
  });

  it('does not establish the root folder when Root-Is-Purelib is missing or unreadable', async () => {
    for (const wheelText of [
      'Wheel-Version: 1.0\n',
      'Wheel-Version: 1.0\nRoot-Is-Purelib: maybe\n',
      'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nRoot-Is-Purelib: false\n',
      undefined,
    ]) {
      for (const folder of ['purelib', 'platlib']) {
        const info = await readZip(build(wheelText, [pth, quiet(`${DATA}/${folder}/demo.start`)]));
        expect(rowFor(info, 'demo.pth')).toContain(
          'whether it installs into the same directory as this file is not',
        );
        expect(rowFor(info, 'demo.pth')).toContain('Root-Is-Purelib');
        expect(rowFor(info, 'demo.pth')).not.toContain(SKIPPED);
      }
    }
  });

  it('reads only the site folder: a startup file in a subfolder is not one', async () => {
    const info = await readZip(
      build(PURE, [
        { name: 'sub/demo.pth', data: 'import math\n' },
        { name: `${DATA}/purelib/sub/demo.pth`, data: 'import math\n' },
        { name: `${DATA}/purelib/sub/demo.start`, data: 'a:b\n' },
      ]),
    );
    expect(hasSection(info, 'Code that runs')).toBe(false);
  });
});

describe('readZipPackage: startup files that install to one path', () => {
  const badStart: FixtureEntry = { name: `${DATA}/purelib/demo.start`, data: Uint8Array.of(0xff) };
  const goodStart: FixtureEntry = { name: 'demo.start', data: '# comment\n' };

  it('does not pick a copy by archive order: an invalid .data copy beside a readable root copy', async () => {
    const info = await readZip(build(PURE, [badStart, goodStart, pth]));
    expect(rowFor(info, 'demo.pth')).toContain(DEPENDS);
    expect(rowFor(info, 'demo.pth')).not.toContain(SKIPPED);
    expect(rowFor(info, 'demo.pth')).toContain('pip writes the .data copy last');
    expect(rowFor(info, 'demo.start')).toContain('not established');
    expect(rowFor(info, badStart.name)).toContain('not established');
  });

  it('gives the same result when the entries are in the other order', async () => {
    const one = await readZip(build(PURE, [badStart, goodStart, pth]));
    const other = await readZip(build(PURE, [pth, goodStart, badStart]));
    for (const name of ['demo.pth', 'demo.start', badStart.name]) {
      expect(rowFor(other, name)).toBe(rowFor(one, name));
    }
  });

  it('treats two entries with the identical name as colliding copies', async () => {
    const info = await readZip(
      build(PURE, [{ name: 'demo.start', data: Uint8Array.of(0xff) }, goodStart, pth]),
    );
    expect(rowFor(info, 'demo.pth')).toContain(DEPENDS);
    expect(rowFor(info, 'demo.pth')).not.toContain(SKIPPED);
    expect(rowFor(info, 'demo.start')).toContain('not established');
  });

  it('keeps the definite statement when every copy leads to the same conclusion', async () => {
    const agreeing = await readZip(
      build(PURE, [{ name: `${DATA}/purelib/demo.start`, data: '# comment\n' }, goodStart, pth]),
    );
    expect(rowFor(agreeing, 'demo.pth')).toContain(SKIPPED);
    expect(rowFor(agreeing, 'demo.start')).toContain('No entry points');
    const rejected = await readZip(
      build(PURE, [badStart, { name: 'demo.start', data: Uint8Array.of(0xfe) }, pth]),
    );
    expect(rowFor(rejected, 'demo.pth')).toContain('Runs code');
    expect(rowFor(rejected, 'demo.pth')).not.toContain(DEPENDS);
    expect(rowFor(rejected, 'demo.pth')).not.toContain('skip');
    expect(rowFor(rejected, 'demo.start')).toContain('Not valid UTF-8');
  });

  it('does not decide a .pth pair with different import lines', async () => {
    const info = await readZip(
      build(PURE, [{ name: `${DATA}/purelib/demo.pth`, data: 'import other\n' }, pth]),
    );
    expect(rowFor(info, 'demo.pth')).toContain(DEPENDS);
    expect(rowFor(info, 'demo.pth')).not.toContain('Runs code at every');
    const same = await readZip(
      build(PURE, [{ name: `${DATA}/purelib/demo.pth`, data: 'import math\n' }, pth]),
    );
    expect(rowFor(same, 'demo.pth')).toContain('Runs code at every Python start');
  });

  it('does not rely on names that differ only by letter case being distinct files', async () => {
    const info = await readZip(
      build(PURE, [
        { name: 'demo.start', data: 'a:b\n' },
        { name: 'Demo.start', data: Uint8Array.of(0xff) },
        pth,
      ]),
    );
    expect(rowFor(info, 'demo.start')).toContain('letter case');
    expect(rowFor(info, 'Demo.start')).toContain('letter case');
    expect(rowFor(info, 'demo.pth')).toContain('letter case');
    expect(rowFor(info, 'demo.pth')).not.toContain(SKIPPED);
    const pair = await readZip(
      build(PURE, [
        { name: 'demo.pth', data: 'import a\n' },
        { name: 'DEMO.pth', data: 'lib\n' },
      ]),
    );
    expect(rowFor(pair, 'demo.pth')).toContain('letter case');
  });
});

describe('readZipPackage: .start copies split between purelib and platlib', () => {
  const pure = (data: Uint8Array | string): FixtureEntry => ({
    name: `${DATA}/purelib/demo.start`,
    data,
  });
  const plat = (data: Uint8Array | string): FixtureEntry => ({
    name: `${DATA}/platlib/demo.start`,
    data,
  });
  const ONE_DIRECTORY = 'skipped where they are one directory';

  it('skips on every scheme when the copy beside the .pth and the other one both register', async () => {
    const info = await readZip(build(PURE, [pth, pure('# a\n'), plat('# a\n')]));
    expect(rowFor(info, 'demo.pth')).toContain(SKIPPED);
  });

  it('runs on every scheme when every copy is rejected', async () => {
    const info = await readZip(
      build(PURE, [pth, pure(Uint8Array.of(0xff)), plat(Uint8Array.of(0xfe))]),
    );
    expect(rowFor(info, 'demo.pth')).toContain('Runs code');
    expect(rowFor(info, 'demo.pth')).not.toContain('skip');
  });

  it('does not call a rejected copy beside the .pth decisive when the other folder holds a valid one', async () => {
    // One directory: the two copies collide. Two directories: the rejected one is beside the .pth.
    const info = await readZip(build(PURE, [pth, pure(Uint8Array.of(0xff)), plat('# a\n')]));
    const row = rowFor(info, 'demo.pth');
    expect(row).toContain('depends on the installation scheme and on which copy');
    expect(row).not.toContain(SKIPPED);
    expect(row).not.toContain(ONE_DIRECTORY);
  });

  it('does not call a valid copy beside the .pth decisive when the other folder holds a rejected one', async () => {
    const info = await readZip(build(PURE, [pth, pure('# a\n'), plat(Uint8Array.of(0xff))]));
    const row = rowFor(info, 'demo.pth');
    expect(row).toContain('depends on the installation scheme and on which copy');
    expect(row).not.toContain(SKIPPED);
    expect(row).not.toContain(ONE_DIRECTORY);
  });

  it('says nothing about the scheme for a copy in the other folder that was not inspected', async () => {
    const big = new Uint8Array(20 * 1024).fill(0x23);
    const info = await readZip(build(PURE, [pth, plat(big)]));
    const row = rowFor(info, 'demo.pth');
    expect(row).toContain('was not established');
    expect(row).not.toContain(SKIPPED);
    expect(row).not.toContain(ONE_DIRECTORY);
  });
});

/** The archive with its last central-directory record's signature spoiled, so listing stops before it. */
function cutListing(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  for (let i = copy.length - 4; i >= 0; i--) {
    if (copy[i] === 0x50 && copy[i + 1] === 0x4b && copy[i + 2] === 0x01 && copy[i + 3] === 0x02) {
      copy[i + 2] = 0x7f;
      return copy;
    }
  }
  throw new Error('no central directory record');
}

describe('readZipPackage: startup verdicts that the archive does not settle', () => {
  it('does not say the import is skipped when the listing is incomplete, even with a matching pair in view', async () => {
    const bytes = build(PURE, [
      pth,
      { name: 'demo.start', data: '# comment\n' },
      quiet('later.txt'),
    ]);
    const info = await readZip(cutListing(bytes));
    const row = rowFor(info, 'demo.pth');
    expect(row).toContain('Runs code');
    expect(row).not.toContain(SKIPPED);
    expect(row).toContain(
      'the archive listing is incomplete and a copy of that .start may be unlisted',
    );
  });

  it('keeps an unknown root folder unknown instead of choosing the split-scheme outcome', async () => {
    const overCap = 'Wheel-Version: 1.0\nRoot-Is-Purelib: false\n' + '#'.repeat(300 * 1024) + '\n';
    for (const wheelText of ['Wheel-Version: 1.0\n', overCap]) {
      const info = await readZip(build(wheelText, [pth, quiet(`${DATA}/platlib/demo.start`)]));
      const row = rowFor(info, 'demo.pth');
      expect(row).toContain('whether it installs into the same directory as this file is not');
      expect(row).toContain('skipped where the two share a directory and runs where they do not');
      expect(row).not.toContain('runs where they differ');
      expect(row).not.toContain(SKIPPED);
    }
  });
});
