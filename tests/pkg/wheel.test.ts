import { describe, expect, it } from 'vitest';
import { parseHeaders } from '../../src/pkg/wheel';
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

const METADATA = [
  'Metadata-Version: 2.3',
  'Name: demo-pkg',
  'Version: 1.4.0',
  'Summary: A demo package',
  'Home-page: https://example.org/demo',
  'Author: Ada Lovelace',
  'Author-email: ada@example.org',
  'Maintainer: Charles B',
  'Maintainer-email: cb@example.org',
  'License-Expression: MIT',
  'Keywords: demo,example',
  'Project-URL: Source, https://github.com/example/demo',
  'Project-URL: Docs, https://demo.readthedocs.io',
  'Classifier: Programming Language :: Python :: 3',
  'Classifier: Programming Language :: Python :: 3.12',
  'Classifier: License :: OSI Approved :: MIT License',
  'Classifier: Topic :: Utilities',
  'Requires-Python: >=3.9',
  'Provides-Extra: speed',
  'Provides-Extra: test',
  'Requires-Dist: requests>=2.0',
  'Requires-Dist: colorama; sys_platform == "win32"',
  'Requires-Dist: orjson; extra == "speed"',
  '',
  'Demo is a small library.',
  '',
  'Second paragraph that must not appear.',
  '',
].join('\n');

const WHEEL = [
  'Wheel-Version: 1.0',
  'Generator: hatchling 1.21',
  'Root-Is-Purelib: true',
  'Tag: py3-none-any',
  'Tag: py2-none-any',
  '',
].join('\n');

const ENTRY_POINTS = [
  '[console_scripts]',
  'demo = demo.cli:main',
  'demo-admin = demo.admin:run [extra]',
  '',
  '[gui_scripts]',
  'demo-gui = demo.gui:main',
  '',
  '[demo.plugins]',
  'a = demo.a',
  '',
].join('\n');

const wheel = (metadata = METADATA, extra: Parameters<typeof buildZip>[0] = []): Uint8Array =>
  buildZip([
    { name: 'demo/__init__.py', data: 'x = 1\n' },
    { name: 'demo_pkg-1.4.0.dist-info/METADATA', data: metadata },
    { name: 'demo_pkg-1.4.0.dist-info/WHEEL', data: WHEEL },
    { name: 'demo_pkg-1.4.0.dist-info/entry_points.txt', data: ENTRY_POINTS },
    { name: 'demo_pkg-1.4.0.dist-info/RECORD', data: 'demo/__init__.py,sha256=x,6\n' },
    ...extra,
  ]);

describe('parseHeaders', () => {
  it('splits headers from the body and joins folded lines', () => {
    const { headers, body } = parseHeaders(
      'Name: a\nDescription: first\n        second\n\nbody text',
    );
    expect(headers).toEqual([
      ['name', 'a'],
      ['description', 'first\nsecond'],
    ]);
    expect(body).toBe('body text');
  });
});

describe('readZipPackage: a Python wheel', () => {
  it('reads the package identity from METADATA', async () => {
    const info = await readZip(wheel(), 'demo_pkg-1.4.0-py3-none-any.whl');
    expect(info.format).toBe('Python wheel');
    expect(info.title).toBe('demo-pkg 1.4.0');
    expect(info.summary).toBe('A demo package');
    expect(value(info, 'Package', 'Name')).toBe('demo-pkg');
    expect(value(info, 'Package', 'Version')).toBe('1.4.0');
    expect(value(info, 'Package', 'Author')).toBe('Ada Lovelace');
    expect(value(info, 'Package', 'Author email')).toBe('ada@example.org');
    expect(value(info, 'Package', 'Maintainer')).toBe('Charles B');
    expect(value(info, 'Package', 'License')).toBe('MIT');
    expect(value(info, 'Package', 'Homepage')).toBe('https://example.org/demo');
    expect(value(info, 'Package', 'Requires Python')).toBe('>=3.9');
    expect(value(info, 'Package', 'Keywords')).toBe('demo,example');
    expect(value(info, 'Package', 'Provides extras')).toBe('speed, test');
  });

  it('counts classifiers and picks out the language and licence ones', async () => {
    const info = await readZip(wheel());
    expect(value(info, 'Package', 'Classifiers')).toBe('4');
    expect(value(info, 'Package', 'Programming languages')).toBe('Python :: 3; Python :: 3.12');
    expect(value(info, 'Package', 'License classifiers')).toBe('OSI Approved :: MIT License');
  });

  it('lists project links', async () => {
    const info = await readZip(wheel());
    expect(tableRows(info, 'Links')).toEqual([
      ['Source', 'https://github.com/example/demo'],
      ['Docs', 'https://demo.readthedocs.io'],
    ]);
  });

  it('splits each requirement from its environment marker', async () => {
    const info = await readZip(wheel());
    expect(tableRows(info, 'Dependencies')).toEqual([
      ['requests>=2.0', ''],
      ['colorama', 'sys_platform == "win32"'],
      ['orjson', 'extra == "speed"'],
    ]);
  });

  it('shows only the first paragraph of the long description', async () => {
    const info = await readZip(wheel());
    expect(section(info, 'Description')).toMatchObject({
      paragraphs: ['Demo is a small library.'],
    });
    expect(html(info)).not.toContain('Second paragraph');
  });

  it('reads WHEEL and notes RECORD', async () => {
    const info = await readZip(wheel());
    expect(value(info, 'Wheel', 'Wheel version')).toBe('1.0');
    expect(value(info, 'Wheel', 'Built by')).toBe('hatchling 1.21');
    expect(value(info, 'Wheel', 'Pure Python')).toBe('true');
    expect(value(info, 'Wheel', 'Tags')).toBe('py3-none-any, py2-none-any');
    expect(value(info, 'Wheel', 'File list (RECORD)')).toBe('Yes');
    const bare = await readZip(
      buildZip([{ name: 'd-1.dist-info/METADATA', data: 'Name: d\nVersion: 1\n' }]),
    );
    expect(value(bare, 'Wheel', 'File list (RECORD)')).toBe('No');
  });

  it('lists console and windowed commands, and not other entry point groups', async () => {
    const info = await readZip(wheel());
    expect(tableRows(info, 'Commands')).toEqual([
      ['demo', 'demo.cli:main'],
      ['demo-admin', 'demo.admin:run [extra]'],
      ['demo-gui (windowed)', 'demo.gui:main'],
    ]);
  });

  it('reads a deflated wheel and ends the page with Contents', async () => {
    const info = await readZip(
      buildZip([{ name: 'six-1.0.dist-info/METADATA', data: METADATA, method: 8 }]),
    );
    expect(info.title).toBe('demo-pkg 1.4.0');
    expect(info.sections[info.sections.length - 1].heading).toBe('Contents');
  });

  it('takes the name from the folder when METADATA is damaged', async () => {
    const info = await readZip(
      buildZip([{ name: 'thing-2.0.dist-info/METADATA', data: 'x', encrypted: true }]),
    );
    expect(info.title).toBe('thing 2.0');
    expect(info.warnings).toContain('METADATA could not be read.');
  });

  it('is not a wheel when the dist-info is nested', async () => {
    const info = await readZip(buildZip([{ name: 'a/b-1.dist-info/METADATA', data: 'Name: b\n' }]));
    expect(info.format).toBe('Zip archive');
  });
});

describe('readZipPackage: a hostile wheel', () => {
  it('caps the requirements', async () => {
    const many = `Name: x\nVersion: 1\n${Array.from({ length: 2500 }, (_, i) => `Requires-Dist: p${i}`).join('\n')}\n`;
    const info = await readZip(wheel(many));
    const deps = section(info, 'Dependencies') as { rows: string[][]; note?: string };
    expect(deps.rows.length).toBe(200);
    expect(deps.note).toBe('Showing the first 200 of 2,000 requirements.');
    expect(info.warnings.join(' ')).toContain('repeats requires-dist more often');
  });

  it('cuts a huge description to its first paragraph and a bounded length', async () => {
    const info = await readZip(wheel(`Name: x\nVersion: 1\n\n${'word '.repeat(100000)}`));
    const text = section(info, 'Description') as { paragraphs: string[] };
    expect(text.paragraphs[0].length).toBeLessThanOrEqual(2000);
  });

  it('warns when METADATA is larger than the cap', async () => {
    const info = await readZip(wheel(`Name: x\nVersion: 1\n\n${'a'.repeat(1100 * 1024)}`));
    expect(info.warnings).toContain('METADATA could not be read.');
    expect(info.title).toBe('demo_pkg 1.4.0');
  });

  it('escapes markup and strips direction overrides', async () => {
    const info = await readZip(
      wheel(
        `Name: <img src=x onerror=1>\nVersion: 1\nAuthor: a${RLO}b\nRequires-Dist: <b>x</b>; python_version<"3"\nProject-URL: <i>L</i>, https://x\n`,
      ),
    );
    const page = html(info);
    expect(page).toContain('&lt;img src=x onerror=1&gt;');
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain('<b>x');
    expect(page).not.toContain('<i>L');
    expect(page).not.toContain(RLO);
    expect(hasSection(info, 'Wheel')).toBe(true);
  });

  it('survives truncation and corruption', async () => {
    await expectSafe(wheel(), 'x.whl');
  });
});

describe('readZipPackage: wheel entry identity', () => {
  it('uses the real METADATA, not an earlier entry that cleans to the same name', async () => {
    const info = await readZip(
      buildZip([
        { name: `d-1.dist-info/METADATA${RLO}`, data: 'Name: decoy\nVersion: 9\n' },
        { name: 'd-1.dist-info/METADATA', data: 'Name: real\nVersion: 1\n' },
      ]),
    );
    expect(info.title).toBe('real 1');
  });
});

describe('readZipPackage: what a wheel runs at startup', () => {
  const rowFor = (info: Awaited<ReturnType<typeof readZip>>, name: string): string =>
    value(info, 'Code that runs', name) ?? '';
  const withFiles = (...files: FixtureEntry[]): Promise<Awaited<ReturnType<typeof readZip>>> =>
    readZip(wheel(METADATA, files));

  it('lists a .start file as the only startup hook, with its Python version scope', async () => {
    const info = await withFiles({ name: 'demo.start', data: 'demo:initialize\n' });
    expect(rowFor(info, 'demo.start')).toContain('Python 3.15 and later');
    expect(rowFor(info, 'demo.start')).toContain('demo:initialize');
  });

  it('scans every line of a startup file, not the first 200', async () => {
    const pth = await withFiles({ name: 'demo.pth', data: `${'#\n'.repeat(200)}import math\n` });
    expect(rowFor(pth, 'demo.pth')).toContain('Runs code at every Python start');
    expect(rowFor(pth, 'demo.pth')).not.toContain('nothing here runs code');
    const start = await withFiles({
      name: 'demo.start',
      data: `${'#\n'.repeat(200)}demo:initialize\n`,
    });
    expect(rowFor(start, 'demo.start')).toContain('demo:initialize');
    expect(rowFor(start, 'demo.start')).not.toContain('No entry points');
  });

  it('counts entry points but shows only the first few', async () => {
    const info = await withFiles({
      name: 'many.start',
      data: Array.from({ length: 10 }, (_, i) => `m${i}:f`).join('\n'),
    });
    expect(rowFor(info, 'many.start')).toContain('10 entry points');
    expect(rowFor(info, 'many.start')).toContain('and more');
  });

  it('recognises an import line after leading white space as running on 3.15 and later only', async () => {
    for (const lead of ['  ', '\t', ' \t ']) {
      const info = await withFiles({ name: 'sp.pth', data: `${lead}import math\n` });
      const row = rowFor(info, 'sp.pth');
      expect(row).toContain('Runs on Python 3.15 and later');
      expect(row).toContain('earlier versions read it as a path');
      expect(row).not.toContain('nothing here runs code');
    }
  });

  it('says a plain import line runs on every version that runs import lines', async () => {
    const info = await withFiles({ name: 'a.pth', data: 'import\tos\n' });
    expect(rowFor(info, 'a.pth')).toContain('Runs code at every Python start');
    expect(rowFor(info, 'a.pth')).not.toContain('3.15 and later (an import');
  });

  it('follows str.splitlines, CRLF, a byte order mark and unusual line breaks', async () => {
    const crlf = await withFiles({ name: 'a.pth', data: 'lib\r\nimport x\r\n' });
    expect(rowFor(crlf, 'a.pth')).toContain('Runs code');
    const bom = await withFiles({
      name: 'b.pth',
      data: Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('import b\n')]),
    });
    expect(rowFor(bom, 'b.pth')).toContain('Runs code');
    const ls = await withFiles({
      name: 'c.pth',
      data: `lib${String.fromCharCode(0x2028)}import c\n`,
    });
    expect(rowFor(ls, 'c.pth')).toContain('Runs code');
    const fs = await withFiles({
      name: 'd.pth',
      data: `lib${String.fromCharCode(0x1c)}import d\n`,
    });
    expect(rowFor(fs, 'd.pth')).toContain('Runs code');
  });

  it('does not say a .pth with only path lines or comments runs code', async () => {
    const info = await withFiles({
      name: 'paths.pth',
      data: '# libs\nlib\n../other\nimports/dir\n  # note\n',
    });
    expect(rowFor(info, 'paths.pth')).toContain('Path entries only');
  });

  it('shows the first import line of a .pth that has one', async () => {
    const info = await withFiles({
      name: 'evil.pth',
      data: 'lib\nimport os; os.system("x")\nimport b\n',
    });
    expect(rowFor(info, 'evil.pth')).toContain('import os; os.system("x")');
    expect(rowFor(info, 'evil.pth')).not.toContain('import b');
  });

  it('notes an import line that holds a NUL byte as rejected', async () => {
    const info = await withFiles({ name: 'n.pth', data: `import os${String.fromCharCode(0)}x\n` });
    expect(rowFor(info, 'n.pth')).toContain('NUL');
  });

  it('skips the import lines of a .pth only when a readable .start of the same name is beside it', async () => {
    const pair = await withFiles(
      { name: 'demo.pth', data: 'import demo\n' },
      { name: 'demo.start', data: 'demo:go\n' },
    );
    expect(rowFor(pair, 'demo.pth')).toContain('Python 3.15 and later skip it');
    expect(rowFor(pair, 'demo.pth')).toContain('Runs code');
    expect(rowFor(pair, 'demo.start')).toContain('demo:go');

    // A .start that is not UTF-8 is rejected by site.py and suppresses nothing.
    const bad = await withFiles(
      { name: 'demo.pth', data: 'import math\n' },
      { name: 'demo.start', data: Uint8Array.from([0xff]) },
    );
    expect(rowFor(bad, 'demo.pth')).toContain('Runs code');
    expect(rowFor(bad, 'demo.pth')).not.toContain('skip');
    expect(rowFor(bad, 'demo.start')).toContain('Not valid UTF-8');

    // An empty or comment-only .start still registers.
    for (const content of ['', '# nothing\n\n']) {
      const quiet = await withFiles(
        { name: 'demo.pth', data: 'import math\n' },
        { name: 'demo.start', data: content },
      );
      expect(rowFor(quiet, 'demo.pth')).toContain('Python 3.15 and later skip it');
      expect(rowFor(quiet, 'demo.start')).toContain('No entry points');
    }
  });

  it('does not claim suppression when the matching .start was not inspected', async () => {
    const info = await withFiles(
      { name: 'demo.pth', data: 'import math\n' },
      { name: 'demo.start', data: `${'a:b\n'.repeat(5000)}` },
    );
    expect(rowFor(info, 'demo.pth')).toContain('was not established');
    expect(rowFor(info, 'demo.pth')).not.toContain('skip it because');
    expect(rowFor(info, 'demo.start')).toContain('not inspected');
  });

  it('matches the .start by exact name in the same install folder', async () => {
    const other = await withFiles(
      { name: 'demo.pth', data: 'import math\n' },
      { name: 'Demo.start', data: 'x:y\n' },
    );
    expect(rowFor(other, 'demo.pth')).not.toContain('skip');
    expect(rowFor(other, 'demo.pth')).not.toContain('not established');
    const sameFolder = await withFiles(
      { name: 'demo.pth', data: 'import math\n' },
      { name: 'demo_pkg-1.4.0.data/purelib/demo.start', data: 'x:y\n' },
    );
    expect(rowFor(sameFolder, 'demo.pth')).toContain('skip');
  });

  it('marks a .pth that is not UTF-8, or too large, as possibly running code', async () => {
    const latin = await withFiles({ name: 'l.pth', data: Uint8Array.from([0xe9, 0x0a]) });
    expect(rowFor(latin, 'l.pth')).toContain('May run code');
    const big = await withFiles({ name: 'big.pth', data: `${'a'.repeat(20000)}\n` });
    expect(rowFor(big, 'big.pth')).toContain('not inspected');
    expect(rowFor(big, 'big.pth')).not.toContain('nothing here runs code');
  });

  it('ignores hidden files and other suffix cases, as site.py does', async () => {
    const info = await withFiles(
      { name: '.hidden.pth', data: 'import x\n' },
      { name: 'UP.PTH', data: 'import y\n' },
    );
    expect(hasSection(info, 'Code that runs')).toBe(false);
  });

  it('says so when more startup files exist than were inspected', async () => {
    const files = Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.pth`, data: 'lib\n' }));
    const info = await readZip(wheel(METADATA, files));
    expect(rowFor(info, 'Other startup files')).toContain('5 more');
    expect(rowFor(info, 'Other startup files')).toContain('cannot say');
  });

  it('finds startup files under the .data purelib and platlib folders, and scripts', async () => {
    const info = await withFiles(
      { name: 'demo_pkg-1.4.0.data/purelib/x.pth', data: 'import x\n' },
      { name: 'demo_pkg-1.4.0.data/platlib/y.start', data: 'y:go\n' },
      { name: 'demo_pkg-1.4.0.data/scripts/run.sh', data: 'x' },
    );
    expect(rowFor(info, 'demo_pkg-1.4.0.data/purelib/x.pth')).toContain('Runs code');
    expect(rowFor(info, 'demo_pkg-1.4.0.data/platlib/y.start')).toContain('y:go');
    expect(rowFor(info, 'Scripts installed to the PATH')).toContain('1 files');
    expect((section(info, 'Code that runs') as { note?: string }).note).toContain(
      'Only a .pth line that starts with "import" runs code',
    );
  });

  it('has no Code that runs section for an ordinary wheel', async () => {
    expect(hasSection(await readZip(wheel()), 'Code that runs')).toBe(false);
  });
});
