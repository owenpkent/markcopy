// Alpine packages (.apk that begins with gzip): two or three gzip streams
// concatenated into one file. An optional signature archive, then the control
// archive (`.PKGINFO` and any install scripts), then the data archive that
// holds the files. The first two are tar segments with no end-of-archive
// block, so the three read as one tar stream once inflated.
//
// Only the front of the file is inflated, and only until the control entries
// have been seen. The data archive is never decompressed.
import { formatBytes } from '../binary/html';
import type { RangeReader } from '../binary/reader';
import { printable } from '../binary/text';
import { ByteSink, DAMAGED, gunzipUntil, readCompressed, TOO_BIG } from './decompress';
import {
  PackageError,
  propertySection,
  tableSection,
  type InfoSection,
  type PackageInfo,
} from './model';
import { signatureSection } from './signature';
import { readTar, tarData, type TarResult } from './tar';

// The signature and control streams are a few kilobytes to a few hundred, and
// they come first. Four MiB of the file is more than enough to hold both.
const COMPRESSED_MAX = 4 * 1024 * 1024;
// Output kept while looking for `.PKGINFO`. A control archive past this is not one.
const UNPACKED_MAX = 4 * 1024 * 1024;
// `.PKGINFO` itself: a few KB, and a package with a thousand dependencies still fits.
const PKGINFO_MAX = 1024 * 1024;
const MAX_LINES = 20_000;
const MAX_VALUE = 2000;
const MAX_RELATIONS = 5000;
const TABLE_LIMIT = 500;

const NOT_ALPINE = 'it is a gzip archive, but not an Alpine package.';

const SCRIPTS: Record<string, string> = {
  '.pre-install': 'Runs as root before the files are installed',
  '.post-install': 'Runs as root after the files are installed',
  '.pre-upgrade': 'Runs as root before an upgrade',
  '.post-upgrade': 'Runs as root after an upgrade',
  '.pre-deinstall': 'Runs as root before the files are removed',
  '.post-deinstall': 'Runs as root after the files are removed',
  '.trigger': 'Runs as root when a watched directory changes',
};

/** `key = value` lines, with repeated keys kept in order. Comments start with `#`. */
export function parsePkgInfo(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && i < MAX_LINES; i++) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/.exec(lines[i]);
    if (match && !lines[i].trimStart().startsWith('#')) {
      const list = out.get(match[1]) ?? [];
      list.push(match[2].slice(0, MAX_VALUE));
      out.set(match[1], list);
    }
  }
  return out;
}

function utc(value: string | undefined): string | undefined {
  const seconds = Number(value);
  if (!value || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime())
    ? undefined
    : `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** "name>=1.2", "so:libc.so.6", "!conflict": the name and the comparison with its version. */
function splitRelation(value: string): { name: string; version: string; conflict: boolean } {
  const conflict = value.startsWith('!');
  const match = /^!?([^<>=~]+)(?:([<>=~]+)(.*))?$/.exec(value);
  if (!match) {
    return { name: value, version: '', conflict };
  }
  return {
    name: match[1],
    version: match[2] ? `${match[2]}${match[3] ?? ''}` : '',
    conflict,
  };
}

const rowsFor = (label: string, values: string[] | undefined, conflictLabel?: string): string[][] =>
  (values ?? []).slice(0, MAX_RELATIONS).map((value) => {
    const { name, version, conflict } = splitRelation(value);
    return [conflict && conflictLabel ? conflictLabel : label, printable(name), printable(version)];
  });

export async function readAlpineApk(reader: RangeReader): Promise<PackageInfo> {
  const head = await reader.upTo(0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) {
    throw new PackageError('it is not a gzip archive.');
  }
  const data = await readCompressed(
    reader,
    0,
    Math.min(reader.size, COMPRESSED_MAX),
    COMPRESSED_MAX,
  );

  const sink = new ByteSink();
  // What the control archive holds, kept from the last look at the tar so far.
  let tar: TarResult = { entries: [], next: 0, stop: 'more' };
  const look = (): boolean => {
    tar = readTar(sink.bytes());
    const info = tar.entries.findIndex((e) => e.name === '.PKGINFO');
    if (info < 0 || !tar.entries[info].complete) {
      return false;
    }
    // Control scripts follow `.PKGINFO`; the first plain path is the data archive.
    return tar.stop !== 'more' || tar.entries.slice(info).some((e) => !e.name.startsWith('.'));
  };
  try {
    gunzipUntil(data, UNPACKED_MAX, (chunk) => {
      sink.append(chunk);
      return look();
    });
  } catch (error) {
    if (
      !(error instanceof PackageError) ||
      (error.message !== TOO_BIG && error.message !== DAMAGED)
    ) {
      throw error;
    }
  }
  look();

  const bytes = sink.bytes();
  const entry = tar.entries.find((e) => e.name === '.PKGINFO');
  const raw = entry && tarData(bytes, entry);
  if (!entry || !raw) {
    throw new PackageError(NOT_ALPINE);
  }

  const warnings: string[] = [];
  if (entry.size > PKGINFO_MAX) {
    warnings.push('The package information is larger than MarkCopy will read.');
  }
  const info = parsePkgInfo(new TextDecoder().decode(raw.subarray(0, PKGINFO_MAX)));
  const one = (key: string): string | undefined => {
    const value = info.get(key)?.[0];
    return value === undefined ? undefined : printable(value);
  };
  const name = one('pkgname');
  if (!name) {
    throw new PackageError(NOT_ALPINE);
  }
  const version = one('pkgver');
  const installed = Number(one('size'));

  const sections: InfoSection[] = [
    ...propertySection('Package', [
      ['Name', name],
      ['Version', version],
      ['Architecture', one('arch')],
      ['Maintainer', one('maintainer')],
      ['Packager', one('packager')],
      ['License', one('license')],
      ['URL', one('url')],
      ['Origin', one('origin')],
      ['Commit', one('commit')],
      [
        'Installed size',
        one('size') && Number.isFinite(installed) ? formatBytes(installed) : undefined,
      ],
      ['Built', utc(one('builddate'))],
      ['Data SHA-256', one('datahash')],
    ]),
  ];

  const relationRows = [
    ...rowsFor('Depends', info.get('depend'), 'Conflicts'),
    ...rowsFor('Replaces', info.get('replaces')),
    ...rowsFor('Installed if', info.get('install_if')),
  ];
  const relationTotal =
    (info.get('depend')?.length ?? 0) +
    (info.get('replaces')?.length ?? 0) +
    (info.get('install_if')?.length ?? 0);
  sections.push(
    ...tableSection('Dependencies', ['Relation', 'Package', 'Version'], relationRows, {
      limit: TABLE_LIMIT,
      total: relationTotal,
      noun: 'relationships',
    }),
    ...tableSection(
      'Provides',
      ['Relation', 'Package', 'Version'],
      rowsFor('Provides', info.get('provides')),
      {
        limit: TABLE_LIMIT,
        total: info.get('provides')?.length,
        noun: 'entries',
      },
    ),
  );

  // Control entries are dotfiles, up to the first plain path (the data archive).
  const control = tar.entries.slice(tar.entries.indexOf(entry));
  const firstData = control.findIndex((e) => !e.name.startsWith('.'));
  const dotfiles = (firstData < 0 ? control : control.slice(0, firstData)).map((e) => e.name);
  const scripts = dotfiles
    .filter((n) => n in SCRIPTS)
    .map((n): [string, string] => [n, SCRIPTS[n]]);
  const triggers = info.get('triggers')?.join(' ');
  sections.push(
    ...propertySection(
      'Scripts',
      [
        ...scripts,
        ['Trigger paths', triggers ? printable(triggers.slice(0, MAX_VALUE)) : undefined],
      ],
      'Installing a package runs these scripts as root. MarkCopy does not show or run them.',
    ),
  );

  const signed = tar.entries
    .slice(0, tar.entries.indexOf(entry))
    .find((e) => e.name.startsWith('.SIGN.'));
  if (signed) {
    const section = signatureSection('Alpine RSA');
    section.rows.push(['Key name', printable(signed.name.replace(/^\.SIGN\.[A-Za-z0-9]+\./, ''))]);
    sections.push(section);
  }

  return {
    format: 'Alpine package',
    title: [name, version].filter(Boolean).join(' '),
    summary: one('pkgdesc'),
    sections,
    warnings,
  };
}
