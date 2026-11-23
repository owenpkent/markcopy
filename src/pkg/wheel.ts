// Python wheels (.whl).
//
// A wheel is a zip with a <name>-<version>.dist-info folder: METADATA is a
// mail-style header block (core metadata), WHEEL says how it was built, and
// entry_points.txt lists the commands it installs.
import { clip, printable } from '../binary/text';
import { asciiLower } from './ascii';
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

// Where a startup file installs. The wheel root goes to purelib or platlib as
// WHEEL's Root-Is-Purelib says; <name>.data/purelib and <name>.data/platlib name
// their folder. The wheel specification lets the two be different directories
// (for example /usr/lib and /usr/lib64 on Fedora), and site.py matches a .pth to
// its .start by the full path, so a .start in the other category pairs with
// nothing where the two differ and with the .pth where they are one directory.
type Dir = 'purelib' | 'platlib' | 'unknown';

interface Startup {
  entry: ZipEntry;
  /** "unknown" for a root file when WHEEL does not say where the root goes. */
  dir: Dir;
  /** The installed file name, without a .data folder in front. */
  base: string;
  isStart: boolean;
  /** Present once the entry was read; absent when it was too large, unreadable or past the cap. */
  text?: string;
  read: boolean;
  /** A .start that site.py registers; a .start that is not UTF-8 is rejected and registers nothing. */
  registered: boolean;
  points: string[];
  facts?: PthFacts;
  /**
   * What this copy amounts to, so copies that install to one path can be compared.
   * "unknown" never agrees with anything: the file was not read, or is a .pth in
   * a system encoding MarkCopy cannot decode.
   */
  verdict: string;
}

const STARTUP_NAME = /^(?:[^/]+\.data\/(purelib|platlib)\/)?([^./][^/]*\.(?:pth|start))$/;

/**
 * Where the wheel root installs. pip reads a missing header as platlib, but
 * another installer may not, so only a plain true or false in every copy of the
 * header establishes it.
 */
function rootDir(wheel: Headers): Dir {
  const values = wheel
    .filter(([name]) => name === 'root-is-purelib')
    .map(([, value]) => asciiLower(value.trim()));
  if (values.length > 0 && values.every((v) => v === 'true')) {
    return 'purelib';
  }
  if (values.length > 0 && values.every((v) => v === 'false')) {
    return 'platlib';
  }
  return 'unknown';
}

// File systems that ignore case keep one file for names that differ only by case.
const foldName = (base: string): string => base.toLowerCase();

const agree = (a: Startup, b: Startup): boolean =>
  a.verdict !== 'unknown' && a.verdict === b.verdict;

const ROOT_NOTE =
  ' (WHEEL has no readable Root-Is-Purelib, so the folder the wheel root installs into is not established)';

/**
 * Why a startup file's own outcome is not established, or undefined when a
 * definite statement is allowed. Several archive entries can install to one
 * path (a root copy and a .data copy, or the same name listed twice), and the
 * outcome then depends on which copy the installer leaves in place: pip installs
 * the root first and the .data folders after, replacing an existing file, but
 * another installer may differ, so no order is assumed. A definite statement is
 * made only when every copy that could land there leads to the same conclusion.
 */
function ambiguity(f: Startup, group: Startup[]): string | undefined {
  const same: Startup[] = [];
  const scheme: Startup[] = [];
  for (const g of group) {
    if (g === f) {
      continue;
    }
    if (g.base !== f.base) {
      return 'names that differ only by letter case are one file on a case-insensitive file system, so which copy is installed depends on the file system and the installer';
    }
    (g.dir === f.dir ? same : scheme).push(g);
  }
  const differs = (list: Startup[]): boolean => list.some((g) => !agree(f, g));
  if (same.length > 0 && differs(same)) {
    return 'the archive holds more than one copy that installs to this path and they differ, so the outcome depends on which copy the installer leaves in place (pip writes the .data copy last)';
  }
  if (scheme.length > 0 && differs(scheme)) {
    const root = f.dir === 'unknown' || scheme.some((g) => g.dir === 'unknown');
    return root
      ? `a differing copy may install into the same directory as this one or into another${ROOT_NOTE}, so the outcome depends on where the wheel root goes, on the installation scheme and on which copy the installer leaves in place`
      : 'a differing copy sits in the other of purelib and platlib, which are one directory on some systems and two on others, so the outcome depends on the installation scheme';
  }
  return undefined;
}

type Suppression =
  | 'none'
  | 'registered'
  | 'unknown'
  | 'unlisted'
  | 'case'
  | 'collision'
  | 'scheme'
  | 'scheme-root'
  | 'mixed'
  | 'mixed-root';

/** Whether a .start of the same name takes this .pth's import lines away on Python 3.15 and later. */
function suppression(pth: Startup, byName: Map<string, Startup[]>, complete: boolean): Suppression {
  const name = `${pth.base.slice(0, -'.pth'.length)}.start`;
  const group = byName.get(foldName(name)) ?? [];
  const same = group.filter((g) => g.base === name && g.dir === pth.dir);
  const scheme = group.filter((g) => g.base === name && g.dir !== pth.dir);
  const kinds = (list: Startup[]): Set<string> =>
    new Set(list.map((g) => (!g.read ? 'unknown' : g.registered ? 'registered' : 'none')));
  let state: Suppression;
  if (same.length + scheme.length === 0) {
    // A start file whose name differs only by case never matches the .pth's path.
    state = 'none';
  } else if (group.some((g) => g.base !== name)) {
    state = 'case';
  } else {
    // Every copy that could end up beside the .pth is weighed. Where purelib and
    // platlib are one directory all of them land there; where they differ only
    // the copies in the .pth's own folder do.
    const all = kinds([...same, ...scheme]);
    const rootUnknown = pth.dir === 'unknown' || scheme.some((g) => g.dir === 'unknown');
    if (all.has('unknown')) {
      // A copy that was not inspected supports no statement either way.
      state = 'unknown';
    } else if (all.size === 1 && all.has('none')) {
      state = 'none';
    } else if (all.size === 1) {
      // Every copy registers. In the .pth's own folder that holds on any scheme.
      state = same.length > 0 ? 'registered' : rootUnknown ? 'scheme-root' : 'scheme';
    } else if (scheme.length === 0) {
      state = 'collision';
    } else {
      state = rootUnknown ? 'mixed-root' : 'mixed';
    }
  }
  // Without a complete listing an unlisted copy of the .start may decide the
  // outcome: one that would suppress where none is listed, or one that is
  // rejected (or installs elsewhere) where a registering one is listed. Only the
  // states that already say the outcome is open, or why it is not known, stay.
  const open: Suppression[] = ['unknown', 'case', 'collision', 'mixed', 'mixed-root'];
  return !complete && !open.includes(state) ? 'unlisted' : state;
}

const SUPPRESSION_TEXT: Record<Suppression, string> = {
  none: '',
  registered: '; Python 3.15 and later skip it because a .start file of the same name is beside it',
  unknown:
    '; whether a .start file of the same name makes Python 3.15 and later skip it was not established',
  unlisted:
    '; whether a .start file of the same name makes Python 3.15 and later skip it is not established, because the archive listing is incomplete and a copy of that .start may be unlisted',
  case: '; whether a .start file of the same name makes Python 3.15 and later skip it is not established, because names that differ only by letter case are one file on a case-insensitive file system',
  collision:
    '; whether a .start file of the same name makes Python 3.15 and later skip it depends on which copy of that .start the installer leaves in place (pip writes the .data copy last)',
  scheme:
    '; whether Python 3.15 and later skip it depends on the installation scheme: a .start of the same name sits in the other of purelib and platlib, so it is skipped where they are one directory and runs where they differ',
  'scheme-root': `; whether Python 3.15 and later skip it is not established: a .start of the same name is in the archive, but whether it installs into the same directory as this file is not${ROOT_NOTE}; it is skipped where the two share a directory and runs where they do not`,
  mixed:
    '; whether Python 3.15 and later skip it depends on the installation scheme and on which copy the installer leaves in place: the archive holds differing .start files of the same name, at least one of them in the other of purelib and platlib',
  'mixed-root': `; whether Python 3.15 and later skip it is not established: the archive holds differing .start files of the same name, and which of them install into the same directory as this file is not${ROOT_NOTE}, so it depends on that, on the installation scheme and on which copy the installer leaves in place`,
};

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
      [
        'File list (RECORD)',
        hasRecord
          ? 'Yes'
          : zip.complete
            ? 'No'
            : 'Not found in the part of the archive that could be listed',
      ],
    ]),
  );
  // Wheels run no code when installed, but three things in them run later: .pth
  // and .start files that Python reads at every start (see the notes above
  // pyStrip), and scripts under <name>.data/scripts that are installed onto the
  // PATH. site.py lists only the site folder itself (os.listdir), so a startup
  // file counts only at the wheel root or directly under <name>.data/purelib or
  // platlib, never in a subfolder. Every archive entry is kept, duplicates
  // included, because entries that install to one path collide (see ambiguity).
  const root = rootDir(wheel);
  const startups: Startup[] = [];
  for (const entry of zip.entries) {
    const match = entry.exact && !entry.isDirectory ? STARTUP_NAME.exec(entry.name) : null;
    if (match) {
      startups.push({
        entry,
        dir: match[1] === undefined ? root : (match[1] as Dir),
        base: match[2],
        isStart: match[2].endsWith('.start'),
        read: false,
        registered: false,
        points: [],
        verdict: 'unknown',
      });
    }
  }
  const startupSeen = startups.slice(0, MAX_STARTUP_FILES);
  const byName = new Map<string, Startup[]>();
  for (const f of startups) {
    const key = foldName(f.base);
    const list = byName.get(key);
    if (list) {
      list.push(f);
    } else {
      byName.set(key, [f]);
    }
  }
  for (const f of startupSeen) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await zip.readEntry(f.entry, MAX_STARTUP_BYTES);
    } catch (error) {
      if (!(error instanceof PackageError)) {
        throw error;
      }
      warnings.push(`${f.entry.name} could not be read.`);
    }
    if (bytes === undefined) {
      continue;
    }
    f.read = true;
    f.text = strictUtf8(bytes);
    if (f.text === undefined) {
      // site.py drops a .start that is not UTF-8 before registering it. A .pth
      // that is not UTF-8 is read in the system encoding, which is not known here.
      f.verdict = f.isStart ? 'rejected' : 'unknown';
    } else if (f.isStart) {
      f.registered = true;
      f.points = pyLines(f.text)
        .map(pyStrip)
        .filter((l) => l !== '' && l[0] !== '#');
      f.verdict = `registered\n${f.points.join('\n')}`;
    } else {
      f.facts = pthFacts(f.text);
      f.verdict = `pth\n${f.facts.always ?? ''}\n${f.facts.later ?? ''}\n${f.facts.rejected}`;
    }
  }
  // A copy of a file may sit in the part of the directory that could not be listed.
  const unlistedCopy = zip.complete
    ? ''
    : '; the archive listing is incomplete, so another copy of this file that would change this may be unlisted';
  const definite = (f: Startup, what: string, reason: string | undefined): string =>
    reason === undefined && f.read && (f.isStart || f.text !== undefined)
      ? what + unlistedCopy
      : what;
  const startupRows: [string, string][] = [];
  for (const f of startupSeen) {
    const reason = ambiguity(f, byName.get(foldName(f.base)) ?? []);
    let what: string;
    if (f.isStart) {
      if (reason !== undefined) {
        what = `Whether it runs entry points on Python 3.15 and later is not established: ${reason}`;
      } else if (!f.read) {
        what =
          'May run entry points on Python 3.15 and later: the file was not inspected (it is too large or could not be read)';
      } else if (f.text === undefined) {
        what =
          'Not valid UTF-8, so Python 3.15 rejects the whole file: it runs nothing and does not affect a .pth of the same name';
      } else if (f.points.length === 0) {
        what =
          'No entry points. On Python 3.15 and later its presence still makes Python ignore the import lines of a .pth of the same name in the same folder';
      } else {
        what = `Runs on Python 3.15 and later, at every start (${f.points.length} entry point${f.points.length === 1 ? '' : 's'}): ${f.points
          .slice(0, 3)
          .map((l) => clip(l, 120))
          .join(', ')}${f.points.length > 3 ? ', and more' : ''}`;
      }
      startupRows.push([f.entry.name, printable(definite(f, what, reason))]);
      continue;
    }
    const skip = SUPPRESSION_TEXT[suppression(f, byName, zip.complete)];
    if (reason !== undefined) {
      what = `Whether it runs code at every Python start is not established: ${reason}`;
    } else if (!f.read) {
      what =
        'May run code at every Python start: the file was not inspected (it is too large or could not be read)';
    } else if (f.text === undefined) {
      what =
        'May run code at every Python start: the file is not valid UTF-8, so Python reads it in the system encoding and MarkCopy cannot tell what its lines say';
    } else {
      const facts = f.facts ?? { rejected: false };
      if (facts.always !== undefined) {
        what = `Runs code at every Python start (an import line, deprecated since 3.15): ${clip(facts.always, 160)}${skip}`;
      } else if (facts.later !== undefined) {
        what = `Runs on Python 3.15 and later (an import line after leading white space; earlier versions read it as a path): ${clip(facts.later, 160)}${skip}`;
      } else if (facts.rejected) {
        what =
          'An import line holds a NUL byte, which Python rejects, so it does not run; no other line runs code';
      } else {
        what = 'Path entries only: no line starts with import, so nothing here runs code';
      }
    }
    startupRows.push([f.entry.name, printable(definite(f, what, reason))]);
  }
  if (startups.length > startupSeen.length) {
    const rest = startups.length - startupSeen.length;
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
          dataScripts.length > 0
            ? `${dataScripts.length}${zip.complete ? '' : ' or more'} files under *.data/scripts`
            : undefined,
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
