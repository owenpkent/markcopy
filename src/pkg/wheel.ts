// Python wheels (.whl).
//
// A wheel is a zip with a <name>-<version>.dist-info folder: METADATA is a
// mail-style header block (core metadata), WHEEL says how it was built, and
// entry_points.txt lists the commands it installs.
import { clip, printable } from '../binary/text';
import { formatNumber } from '../binary/html';
import { PackageError, propertySection, tableSection, type InfoSection } from './model';
import { readTextEntry, type ZipArchive, type ZipEntry, type ZipFlavour } from './zipRange';

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_SMALL_BYTES = 256 * 1024;
const MAX_HEADERS = 5000;
const MAX_VALUE_CHARS = 2000;
// A package with more than a few hundred requirements is unheard of.
const MAX_REPEATED = 2000;
const MAX_SCRIPT_LINES = 2000;
// Startup files are a line or two; this many are read, each to this size. A file
// over the size is reported as not inspected, never as inert.
const MAX_STARTUP_FILES = 20;
const MAX_STARTUP_BYTES = 16 * 1024;
const MAX_PARAGRAPH_CHARS = 2000;

type Headers = [string, string][];

/** RFC 822 style headers up to the first blank line, and everything after it. */
export function parseHeaders(text: string): {
  headers: Headers;
  body: string;
  /** More headers than MAX_HEADERS: the rest were not kept. */
  truncated: boolean;
} {
  const lines = text.split(/\r\n|\n|\r/);
  const headers: Headers = [];
  let truncated = false;
  let i = 0;
  for (; i < lines.length && lines[i] !== ''; i++) {
    const line = lines[i];
    if ((line[0] === ' ' || line[0] === '\t') && headers.length > 0) {
      const last = headers[headers.length - 1];
      if (last[1].length < MAX_VALUE_CHARS) {
        last[1] += `\n${line.trim()}`;
      }
    } else if (headers.length >= MAX_HEADERS) {
      truncated = true;
    } else {
      const colon = line.indexOf(':');
      if (colon > 0) {
        headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
      }
    }
  }
  return { headers, body: lines.slice(i + 1).join('\n'), truncated };
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

// Startup files, mirroring CPython's Lib/site.py (read at v3.15.2, with v3.14.0
// and v3.12.0 for the older behaviour):
//
// - Files are picked from a site-packages folder by `name.endswith(".pth")` or
//   `.start`, case-sensitively, skipping names that start with ".".
// - Content is decoded `utf-8-sig` (one BOM dropped) and split with
//   str.splitlines(), which breaks on more than \n and \r\n. A .pth that is not
//   valid UTF-8 is decoded with the locale encoding instead (3.13 and later;
//   3.12 always uses it); a .start that is not valid UTF-8 is dropped entirely,
//   and does not register, so it suppresses nothing.
// - 3.15 .pth: each line is strip()ped, blank and "#" lines skipped, and a line
//   that starts "import " or "import\t" is exec()ed (deprecated; planned to be
//   ignored from 3.18), unless a .start with the same path is registered.
// - 3.12 to 3.14 .pth: the line is NOT stripped before the "#" and "import "
//   tests, so an import line preceded by white space is read as a path.
// - 3.15 .start: each stripped line that is not blank or "#" is an entry point
//   called at startup. A readable .start registers even when empty or all
//   comments, and that suppresses the import lines of the matching .pth.
//   Python before 3.15 does not read .start files at all.

// Python's str.isspace() characters, which str.strip() removes.
const PY_SPACE = new Set<number>([
  9,
  10,
  11,
  12,
  13,
  0x1c,
  0x1d,
  0x1e,
  0x1f,
  0x20,
  0x85,
  0xa0,
  0x1680,
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000,
  ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
]);

function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && PY_SPACE.has(text.charCodeAt(start))) {
    start++;
  }
  while (end > start && PY_SPACE.has(text.charCodeAt(end - 1))) {
    end--;
  }
  return text.slice(start, end);
}

// str.splitlines() boundaries: \r\n, and \n \r \v \f, FS GS RS, NEL, LS, PS.
const LINE_BREAKS = new RegExp(
  `\r\n|[\n\r\v\f${String.fromCharCode(0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029)}]`,
);

function pyLines(text: string): string[] {
  const lines = text.split(LINE_BREAKS);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** utf-8-sig: a BOM is dropped, and invalid UTF-8 is reported rather than repaired. */
function strictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

const isImportLine = (line: string): boolean => /^import[ \t]/.test(line);

interface PthFacts {
  /** The first line that runs on every version that runs import lines. */
  always?: string;
  /** The first line that runs only on 3.15 and later, because of leading white space. */
  later?: string;
  /** An import line that holds a NUL byte, which exec() rejects. */
  rejected: boolean;
}

function pthFacts(text: string): PthFacts {
  const facts: PthFacts = { rejected: false };
  for (const line of pyLines(text)) {
    const stripped = pyStrip(line);
    if (stripped === '' || stripped[0] === '#' || !isImportLine(stripped)) {
      continue;
    }
    if (line.includes(String.fromCharCode(0))) {
      facts.rejected = true;
    } else if (isImportLine(line)) {
      facts.always ??= stripped;
    } else if (line[0] !== '#') {
      facts.later ??= stripped;
    }
  }
  return facts;
}

/** The folder a startup file installs into: the wheel root and the .data purelib and platlib folders. */
const startupKey = (name: string): string =>
  name.replace(/^[^/]+\.data\/(?:purelib|platlib)\//, '').replace(/\.(?:pth|start)$/, '');

type StartState = { kind: 'none' } | { kind: 'registered' } | { kind: 'unknown' };

export async function readWheel(zip: ZipArchive, distInfo: ZipEntry): Promise<ZipFlavour> {
  const warnings: string[] = [];
  const folder = distInfo.name.slice(0, distInfo.name.lastIndexOf('/') + 1);
  const read = async (name: string, max: number, what: string): Promise<string | undefined> => {
    const entry = zip.find(folder + name);
    return entry ? readTextEntry(zip, entry, max, warnings, what) : undefined;
  };

  const metadataText = await readTextEntry(zip, distInfo, MAX_METADATA_BYTES, warnings, 'METADATA');
  const { headers, body, truncated } = parseHeaders(metadataText ?? '');
  if (truncated) {
    warnings.push('METADATA has more headers than MarkCopy reads, so the lists may be incomplete.');
  }
  const first = (name: string): string | undefined => clean(headers.find(([n]) => n === name)?.[1]);
  const all = (name: string): string[] => {
    const found = headers.filter(([n]) => n === name);
    if (found.length > MAX_REPEATED) {
      warnings.push(
        `METADATA repeats ${name} more often than MarkCopy reads, so that list is incomplete.`,
      );
    }
    return found.slice(0, MAX_REPEATED).map(([, v]) => clean(v) ?? '');
  };

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
  // Wheels run no code when installed, but three things in them run later: .pth
  // and .start files that Python reads at every start (see the notes above
  // pyStrip), and scripts under <name>.data/scripts that are installed onto the
  // PATH. In a wheel the startup files sit at the root or under
  // <name>.data/purelib or platlib, which install into the same folder.
  const startupAll = zip.exactEntries.filter(
    (e) =>
      !e.isDirectory &&
      /^(?:[^/]+\.data\/(?:purelib|platlib)\/)?[^./][^/]*\.(?:pth|start)$/.test(e.name),
  );
  const startupSeen = startupAll.slice(0, MAX_STARTUP_FILES);
  const everyStart = new Set(
    startupAll.filter((e) => e.name.endsWith('.start')).map((e) => startupKey(e.name)),
  );
  // What each .start file turned out to be, for the .pth files beside it.
  const startState = new Map<string, StartState>();
  const startRows = new Map<string, string>();
  const bytesOf = new Map<string, Uint8Array | undefined>();
  for (const entry of startupSeen) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await zip.readEntry(entry, MAX_STARTUP_BYTES);
    } catch (error) {
      if (!(error instanceof PackageError)) {
        throw error;
      }
      warnings.push(`${entry.name} could not be read.`);
    }
    bytesOf.set(entry.name, bytes);
    if (!entry.name.endsWith('.start')) {
      continue;
    }
    const key = startupKey(entry.name);
    const text = bytes === undefined ? undefined : strictUtf8(bytes);
    if (bytes === undefined) {
      startState.set(key, { kind: 'unknown' });
      startRows.set(
        entry.name,
        'May run entry points on Python 3.15 and later: the file was not inspected (it is too large or could not be read)',
      );
    } else if (text === undefined) {
      // site.py drops a .start that is not UTF-8 before registering it.
      startState.set(key, { kind: 'none' });
      startRows.set(
        entry.name,
        'Not valid UTF-8, so Python 3.15 rejects the whole file: it runs nothing and does not affect a .pth of the same name',
      );
    } else {
      startState.set(key, { kind: 'registered' });
      const points = pyLines(text)
        .map(pyStrip)
        .filter((l) => l !== '' && l[0] !== '#');
      startRows.set(
        entry.name,
        points.length === 0
          ? 'No entry points. On Python 3.15 and later its presence still makes Python ignore the import lines of a .pth of the same name'
          : `Runs on Python 3.15 and later, at every start (${points.length} entry point${points.length === 1 ? '' : 's'}): ${points
              .slice(0, 3)
              .map((l) => clip(l, 120))
              .join(', ')}${points.length > 3 ? ', and more' : ''}`,
      );
    }
  }
  const startupRows: [string, string][] = [];
  for (const entry of startupSeen) {
    if (entry.name.endsWith('.start')) {
      startupRows.push([entry.name, printable(startRows.get(entry.name) ?? '')]);
      continue;
    }
    const bytes = bytesOf.get(entry.name);
    const key = startupKey(entry.name);
    // Whether a .start of the same name takes this file's import lines away on 3.15 and later.
    const beside: StartState =
      startState.get(key) ?? (everyStart.has(key) ? { kind: 'unknown' } : { kind: 'none' });
    const text = bytes === undefined ? undefined : strictUtf8(bytes);
    let what: string;
    const suppression = (): string =>
      beside.kind === 'registered'
        ? '; Python 3.15 and later skip it because a .start file of the same name is beside it'
        : beside.kind === 'unknown'
          ? '; whether a .start file of the same name makes Python 3.15 and later skip it was not established'
          : '';
    if (bytes === undefined) {
      what =
        'May run code at every Python start: the file was not inspected (it is too large or could not be read)';
    } else if (text === undefined) {
      what =
        'May run code at every Python start: the file is not valid UTF-8, so Python reads it in the system encoding and MarkCopy cannot tell what its lines say';
    } else {
      const facts = pthFacts(text);
      if (facts.always !== undefined) {
        what = `Runs code at every Python start (an import line, deprecated since 3.15): ${clip(facts.always, 160)}${suppression()}`;
      } else if (facts.later !== undefined) {
        what = `Runs on Python 3.15 and later (an import line after leading white space; earlier versions read it as a path): ${clip(facts.later, 160)}${suppression()}`;
      } else if (facts.rejected) {
        what =
          'An import line holds a NUL byte, which Python rejects, so it does not run; no other line runs code';
      } else {
        what = 'Path entries only: no line starts with import, so nothing here runs code';
      }
    }
    startupRows.push([entry.name, printable(what)]);
  }
  if (startupAll.length > startupSeen.length) {
    const rest = startupAll.length - startupSeen.length;
    startupRows.push([
      'Other startup files',
      `${formatNumber(rest)} more .pth or .start files were not inspected, so MarkCopy cannot say whether they run code`,
    ]);
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
      'Only a .pth line that starts with "import" runs code (the other lines add folders to the module path); Python deprecated these lines in 3.15 and plans to ignore them from 3.18. A .start file runs its entry points on Python 3.15 and later, and earlier versions do not read it. Read these files before installing the wheel.',
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
