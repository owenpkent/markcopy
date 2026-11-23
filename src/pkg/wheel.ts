// Python wheels (.whl).
//
// A wheel is a zip with a <name>-<version>.dist-info folder: METADATA is a
// mail-style header block (core metadata), WHEEL says how it was built, and
// entry_points.txt lists the commands it installs.
import { clip, printable } from '../binary/text';
import { formatNumber } from '../binary/html';
import { propertySection, tableSection, type InfoSection } from './model';
import { readTextEntry, type ZipArchive, type ZipEntry, type ZipFlavour } from './zipRange';

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_SMALL_BYTES = 256 * 1024;
const MAX_HEADERS = 5000;
const MAX_VALUE_CHARS = 2000;
// A package with more than a few hundred requirements is unheard of.
const MAX_REPEATED = 2000;
const MAX_SCRIPT_LINES = 2000;
// Startup files are a line or two; this many are read, each to this size.
const MAX_STARTUP_FILES = 20;
const MAX_STARTUP_BYTES = 16 * 1024;
const MAX_STARTUP_LINES = 200;
const MAX_PARAGRAPH_CHARS = 2000;

type Headers = [string, string][];

/** RFC 822 style headers up to the first blank line, and everything after it. */
export function parseHeaders(text: string): { headers: Headers; body: string } {
  const lines = text.split(/\r\n|\n|\r/);
  const headers: Headers = [];
  let i = 0;
  for (; i < lines.length && lines[i] !== ''; i++) {
    const line = lines[i];
    if ((line[0] === ' ' || line[0] === '\t') && headers.length > 0) {
      const last = headers[headers.length - 1];
      if (last[1].length < MAX_VALUE_CHARS) {
        last[1] += `\n${line.trim()}`;
      }
    } else if (headers.length < MAX_HEADERS) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
      }
    }
  }
  return { headers, body: lines.slice(i + 1).join('\n') };
}

const clean = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : printable(value.slice(0, MAX_VALUE_CHARS));

function entryPoints(text: string): string[][] {
  const rows: string[][] = [];
  let group = '';
  for (const raw of text.split(/\r\n|\n|\r/, MAX_SCRIPT_LINES)) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') {
      continue;
    }
    if (line[0] === '[' && line.endsWith(']')) {
      group = line.slice(1, -1).trim();
      continue;
    }
    const eq = line.indexOf('=');
    if ((group === 'console_scripts' || group === 'gui_scripts') && eq > 0) {
      rows.push([
        printable(line.slice(0, eq).trim()) + (group === 'gui_scripts' ? ' (windowed)' : ''),
        printable(line.slice(eq + 1).trim()),
      ]);
    }
  }
  return rows;
}

export async function readWheel(zip: ZipArchive, distInfo: ZipEntry): Promise<ZipFlavour> {
  const warnings: string[] = [];
  const folder = distInfo.name.slice(0, distInfo.name.lastIndexOf('/') + 1);
  const read = async (name: string, max: number, what: string): Promise<string | undefined> => {
    const entry = zip.find(folder + name);
    return entry ? readTextEntry(zip, entry, max, warnings, what) : undefined;
  };

  const metadataText = await readTextEntry(zip, distInfo, MAX_METADATA_BYTES, warnings, 'METADATA');
  const { headers, body } = parseHeaders(metadataText ?? '');
  const first = (name: string): string | undefined => clean(headers.find(([n]) => n === name)?.[1]);
  const all = (name: string): string[] =>
    headers
      .filter(([n]) => n === name)
      .slice(0, MAX_REPEATED)
      .map(([, v]) => clean(v) ?? '');

  // The folder name is "<name>-<version>.dist-info", a fallback for damaged metadata.
  const fromFolder = /^([^-]+)-([^-]+)\.dist-info\/$/.exec(folder);
  const name = first('name') ?? clean(fromFolder?.[1]);
  const version = first('version') ?? clean(fromFolder?.[2]);

  const classifiers = all('classifier');
  const classifierWith = (prefix: string): string =>
    classifiers
      .filter((c) => c.startsWith(prefix))
      .map((c) => c.slice(prefix.length).replace(/^[ :]+/, ''))
      .join('; ');
  const links = all('project-url').map((v): [string, string] => {
    const comma = v.indexOf(',');
    return comma > 0 ? [v.slice(0, comma).trim(), v.slice(comma + 1).trim()] : ['Link', v];
  });

  const wheelText = await read('WHEEL', MAX_SMALL_BYTES, 'WHEEL');
  const wheel = wheelText ? parseHeaders(wheelText).headers : [];
  const wheelFirst = (key: string): string | undefined =>
    clean(wheel.find(([n]) => n === key)?.[1]);
  const tags = wheel
    .filter(([n]) => n === 'tag')
    .slice(0, 100)
    .map(([, v]) => clean(v));

  const before: InfoSection[] = [
    ...propertySection('Package', [
      ['Name', name],
      ['Version', version],
      ['Author', first('author')],
      ['Author email', first('author-email')],
      ['Maintainer', first('maintainer')],
      ['Maintainer email', first('maintainer-email')],
      ['License', first('license-expression') ?? first('license')],
      ['Homepage', first('home-page')],
      ['Requires Python', first('requires-python')],
      ['Keywords', first('keywords')],
      ['Provides extras', all('provides-extra').join(', ')],
      ['Programming languages', classifierWith('Programming Language ::')],
      ['License classifiers', classifierWith('License ::')],
      ['Classifiers', classifiers.length > 0 ? formatNumber(classifiers.length) : undefined],
      ['Metadata version', first('metadata-version')],
    ]),
  ];
  // The long description is the project's README; only its opening is shown.
  const long = (headers.find(([n]) => n === 'description')?.[1] ?? body).trim();
  // A README very often opens with badges, an image, a heading or a rule
  // rather than a sentence, so the opening is the first paragraph that starts
  // with a letter or a digit and is not just a title over its underline.
  const opening = printable(long.slice(0, MAX_VALUE_CHARS * 4), true)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .find(
      (paragraph) => /^[\p{L}\p{N}]/u.test(paragraph) && !/\n[=\-~^"#*]{3,}\s*$/.test(paragraph),
    )
    ?.slice(0, MAX_PARAGRAPH_CHARS);
  if (opening) {
    before.push({ kind: 'text', heading: 'Description', paragraphs: [opening] });
  }
  before.push(
    ...tableSection(
      'Links',
      ['Label', 'URL'],
      links.map(([a, b]) => [a, b]),
      { noun: 'links' },
    ),
  );

  const dependencies = all('requires-dist').map((v) => {
    const semi = v.indexOf(';');
    return semi >= 0 ? [v.slice(0, semi).trim(), v.slice(semi + 1).trim()] : [v.trim(), ''];
  });
  before.push(
    ...tableSection('Dependencies', ['Requirement', 'Condition'], dependencies, {
      noun: 'requirements',
    }),
  );

  const hasRecord = zip.find(`${folder}RECORD`) !== undefined;
  before.push(
    ...propertySection('Wheel', [
      ['Wheel version', wheelFirst('wheel-version')],
      ['Built by', wheelFirst('generator')],
      ['Pure Python', wheelFirst('root-is-purelib')],
      ['Tags', tags.join(', ')],
      ['File list (RECORD)', hasRecord ? 'Yes' : 'No'],
    ]),
  );
  // Wheels run no code when installed, but three things in them run later.
  // Python's site module (docs.python.org/3.15/library/site.html) reads, from
  // site-packages at every start: name.pth, whose lines starting "import" and a
  // space or tab are executed (deprecated in 3.15); and, from 3.15, name.start,
  // whose lines each name a pkg.mod:callable that is called. An import line in a
  // .pth is ignored when a .start of the same base name is beside it. In a wheel
  // these files sit at the root or under <name>.data/purelib or platlib. Scripts
  // under <name>.data/scripts are installed onto the PATH.
  const startup = zip.exactEntries
    .filter((e) => /^(?:[^/]+\.data\/(?:purelib|platlib)\/)?[^/]+\.(?:pth|start)$/.test(e.name))
    .slice(0, MAX_STARTUP_FILES);
  const startNames = new Set(startup.filter((e) => e.name.endsWith('.start')).map((e) => e.name));
  const startupRows: [string, string][] = [];
  for (const entry of startup) {
    const isStart = entry.name.endsWith('.start');
    const text = await readTextEntry(zip, entry, MAX_STARTUP_BYTES, warnings, entry.name);
    const lines = (text ?? '').split(/\r\n|\n|\r/, MAX_STARTUP_LINES);
    let what: string;
    if (text === undefined) {
      what = isStart
        ? 'Runs entry points on Python 3.15 and later (not inspected)'
        : 'May run code on every Python start (not inspected)';
    } else if (isStart) {
      const points = lines.map((l) => l.trim()).filter((l) => l !== '' && l[0] !== '#');
      what = `Runs on Python 3.15 and later, at every start: ${
        points.length === 0
          ? 'no entry points'
          : points
              .slice(0, 3)
              .map((l) => clip(l, 120))
              .join(', ')
      }`;
    } else {
      const call = lines.find((l) => /^import[ \t]/.test(l));
      const ignored = startNames.has(`${entry.name.slice(0, -3)}start`);
      what =
        call === undefined
          ? 'Path entries only: nothing here runs code'
          : ignored
            ? 'Has an import line, which Python 3.15 and later ignore because a .start file of the same name is beside it'
            : `Runs code at every Python start (an import line, deprecated since 3.15): ${clip(call, 160)}`;
    }
    startupRows.push([entry.name, printable(what)]);
  }
  const dataScripts = zip.exactEntries.filter(
    (e) => !e.isDirectory && /^[^/]+\.data\/scripts\//i.test(e.name),
  );
  before.push(
    ...propertySection(
      'Code that runs',
      [
        ...startupRows,
        [
          'Scripts installed to the PATH',
          dataScripts.length > 0 ? `${dataScripts.length} files under *.data/scripts` : undefined,
        ],
      ],
      'Only a .pth line that starts with "import" runs code (the other lines add folders to the module path). A .start file runs its entry points on Python 3.15 and later. Read these files before installing the wheel.',
    ),
  );
  const scriptsText = await read('entry_points.txt', MAX_SMALL_BYTES, 'entry_points.txt');
  if (scriptsText) {
    before.push(
      ...tableSection('Commands', ['Command', 'Runs'], entryPoints(scriptsText), {
        noun: 'commands',
      }),
    );
  }

  return {
    format: 'Python wheel',
    title: name ? `${name}${version ? ` ${version}` : ''}` : undefined,
    summary: first('summary'),
    before,
    after: [],
    warnings,
  };
}
