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

  it('lists a .start file as the only startup hook, with its Python version scope', async () => {
    const info = await readZip(
      wheel(METADATA, [{ name: 'demo.start', data: 'demo:initialize\n' }]),
    );
    expect(rowFor(info, 'demo.start')).toContain('Python 3.15 and later');
    expect(rowFor(info, 'demo.start')).toContain('demo:initialize');
  });

  it('says a matching .start makes the .pth import line inert on 3.15 and later', async () => {
    const info = await readZip(
      wheel(METADATA, [
        { name: 'demo.pth', data: 'import demo\n' },
        { name: 'demo.start', data: '# comment\n\ndemo:go\n' },
      ]),
    );
    expect(rowFor(info, 'demo.pth')).toContain('ignore');
    expect(rowFor(info, 'demo.pth')).not.toContain('Runs code');
    expect(rowFor(info, 'demo.start')).toContain('demo:go');
    expect(rowFor(info, 'demo.start')).not.toContain('comment');
  });

  it('does not say a .pth with only path lines runs code', async () => {
    const info = await readZip(
      wheel(METADATA, [{ name: 'paths.pth', data: '# libs\nlib\n../other\n' }]),
    );
    expect(rowFor(info, 'paths.pth')).toContain('Path entries only');
    expect(rowFor(info, 'paths.pth')).not.toContain('Runs code');
  });

  it('shows the first import line of a .pth that has one', async () => {
    const info = await readZip(
      wheel(METADATA, [{ name: 'evil.pth', data: 'lib\nimport os; os.system("x")\nimport b\n' }]),
    );
    expect(rowFor(info, 'evil.pth')).toContain('Runs code at every Python start');
    expect(rowFor(info, 'evil.pth')).toContain('import os; os.system("x")');
    expect(rowFor(info, 'evil.pth')).not.toContain('import b');
  });

  it('does not treat a line that merely starts with the letters import as code', async () => {
    const info = await readZip(wheel(METADATA, [{ name: 'a.pth', data: 'imports/dir\n' }]));
    expect(rowFor(info, 'a.pth')).toContain('Path entries only');
  });

  it('finds startup files under the .data purelib and platlib folders, and scripts', async () => {
    const info = await readZip(
      wheel(METADATA, [
        { name: 'demo_pkg-1.4.0.data/purelib/x.pth', data: 'import x\n' },
        { name: 'demo_pkg-1.4.0.data/platlib/y.start', data: 'y:go\n' },
        { name: 'demo_pkg-1.4.0.data/scripts/run.sh', data: 'x' },
      ]),
    );
    expect(rowFor(info, 'demo_pkg-1.4.0.data/purelib/x.pth')).toContain('Runs code');
    expect(rowFor(info, 'demo_pkg-1.4.0.data/platlib/y.start')).toContain('y:go');
    expect(rowFor(info, 'Scripts installed to the PATH')).toContain('1 files');
    expect((section(info, 'Code that runs') as { note?: string }).note).toContain(
      'Only a .pth line that starts with "import" runs code',
    );
  });

  it('marks a startup file larger than the read cap as not inspected', async () => {
    const info = await readZip(
      wheel(METADATA, [{ name: 'big.pth', data: `${'a'.repeat(20000)}\n` }]),
    );
    expect(rowFor(info, 'big.pth')).toContain('not inspected');
  });

  it('has no Code that runs section for an ordinary wheel', async () => {
    expect(hasSection(await readZip(wheel()), 'Code that runs')).toBe(false);
  });
});
