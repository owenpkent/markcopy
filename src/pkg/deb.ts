// Debian packages (.deb, .udeb): an ar archive of `debian-binary`, a control
// archive and a data archive. Only the control archive is unpacked. It holds
// the package's fields, its maintainer scripts and (usually) a checksum list
// naming every file. The data archive can be gigabytes and is never opened.
import { formatBytes, formatNumber } from '../binary/html';
import type { RangeReader } from '../binary/reader';
import { printable } from '../binary/text';
import { listAr, type ArMember } from './ar';
import { gunzipBounded, readCompressed, unxzBounded, unzstdBounded, TOO_BIG } from './decompress';
import {
  PackageError,
  propertySection,
  tableSection,
  type InfoSection,
  type PackageInfo,
} from './model';
import { readTar, tarData } from './tar';

// Real control archives are a few kilobytes to a few hundred; a package with a
// very large file list reaches a few megabytes. These leave room for those and
// no more.
const CONTROL_COMPRESSED_MAX = 8 * 1024 * 1024;
const CONTROL_UNPACKED_MAX = 16 * 1024 * 1024;
// The `control` file itself is a page of fields.
const CONTROL_FILE_MAX = 1024 * 1024;
// Fields, and lines in the md5sums list, are counted up to these. The unpacked
// cap already bounds the work; these keep the loops' limits named.
const MAX_FIELDS = 500;
const MAX_FILE_LINES = 1_000_000;
// The checksum list is read up to this many bytes (about 200,000 files).
const MD5SUMS_MAX = 8 * 1024 * 1024;
const MAX_CONTROL_LINES = 50_000;
// One field value is shown at most this long (a Depends line can be long, a
// Description is capped separately).
const MAX_VALUE = 8 * 1024;
const MAX_DESCRIPTION = 64 * 1024;
// Relationship entries kept per field.
const MAX_RELATIONS = 5000;
const CONTENTS_LIMIT = 200;
const DEPENDENCY_LIMIT = 500;
const MAX_PATH = 1024;

const RELATION_FIELDS = [
  'Depends',
  'Pre-Depends',
  'Recommends',
  'Suggests',
  'Enhances',
  'Breaks',
  'Conflicts',
  'Replaces',
  'Provides',
];

// Shown first, in this order. Anything else in the file follows, as written.
const PACKAGE_FIELDS = [
  'Package',
  'Version',
  'Architecture',
  'Maintainer',
  'Installed-Size',
  'Section',
  'Priority',
  'Homepage',
  'Source',
  'Essential',
  'Multi-Arch',
  'Built-Using',
];

const SCRIPTS: [string, string][] = [
  ['preinst', 'Runs as root before the files are unpacked'],
  ['postinst', 'Runs as root after the files are unpacked'],
  ['prerm', 'Runs as root before the files are removed'],
  ['postrm', 'Runs as root after the files are removed'],
  ['config', 'Runs as root to ask configuration questions'],
  ['triggers', 'Registers triggers: the postinst script runs as root when a watched path changes'],
];

const COMPRESSION: Record<string, string> = {
  '': 'none',
  gz: 'gzip',
  xz: 'xz',
  zst: 'Zstandard',
  bz2: 'bzip2',
  lzma: 'LZMA',
};

interface Field {
  name: string;
  /** The first line's value, then each continuation line with its leading space removed. */
  lines: string[];
}

/** RFC 822-style fields of the first paragraph. Continuation lines start with a space or tab. */
export function parseControl(text: string): Field[] {
  const fields: Field[] = [];
  // Lines are walked in place with a cap: a megabyte of newlines would otherwise
  // make half a million empty strings.
  let at = 0;
  for (let n = 0; at < text.length && n < MAX_CONTROL_LINES; n++) {
    let end = text.indexOf('\n', at);
    if (end < 0) {
      end = text.length;
    }
    const line = text.slice(at, end);
    at = end + 1;
    if (line.trim() === '' && fields.length > 0) {
      break; // a blank line ends the paragraph
    }
    if (line.startsWith('#')) {
      continue;
    }
    if (/^[ \t]/.test(line)) {
      fields[fields.length - 1]?.lines.push(line.slice(1).replace(/\r$/, ''));
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    if (fields.length >= MAX_FIELDS) {
      break;
    }
    fields.push({
      name: line.slice(0, colon).trim(),
      lines: [line.slice(colon + 1).trim()],
    });
  }
  return fields;
}

/** One relationship field split on commas, with "a | b" alternatives kept in one entry. */
export function parseRelations(value: string): { packages: string; versions: string }[] {
  const out: { packages: string; versions: string }[] = [];
  for (const entry of value.split(',')) {
    if (out.length >= MAX_RELATIONS) {
      break;
    }
    const names: string[] = [];
    const versions: string[] = [];
    for (const alternative of entry.split('|')) {
      const match = /^\s*([^\s([<]+)\s*(?:\(([^)]*)\))?/.exec(alternative);
      if (match) {
        names.push(match[1]);
        versions.push(match[2]?.trim() ?? '');
      }
    }
    if (names.length === 0) {
      continue;
    }
    out.push({
      packages: names.join(' | '),
      versions: versions.some(Boolean)
        ? versions.map((v) => v || (versions.length > 1 ? 'any' : '')).join(' | ')
        : '',
    });
  }
  return out;
}

async function unpack(
  reader: RangeReader,
  member: ArMember,
  suffix: string,
): Promise<Uint8Array | undefined> {
  const data = await readCompressed(reader, member.offset, member.size, CONTROL_COMPRESSED_MAX);
  switch (suffix) {
    case '':
      if (data.length > CONTROL_UNPACKED_MAX) {
        throw new PackageError(TOO_BIG);
      }
      return data;
    case 'gz':
      return gunzipBounded(data, CONTROL_UNPACKED_MAX);
    case 'xz':
      return unxzBounded(data, CONTROL_UNPACKED_MAX);
    case 'zst':
      return unzstdBounded(data, CONTROL_UNPACKED_MAX);
    default:
      return undefined;
  }
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const description = (field: Field | undefined): { summary?: string; paragraphs: string[] } => {
  if (!field) {
    return { paragraphs: [] };
  }
  const summary = printable(field.lines[0]).trim();
  const paragraphs: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of field.lines.slice(1)) {
    length += line.length;
    if (length > MAX_DESCRIPTION) {
      break;
    }
    if (line.trim() === '.' || line.trim() === '') {
      if (current.length > 0) {
        paragraphs.push(printable(current.join('\n'), true));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    paragraphs.push(printable(current.join('\n'), true));
  }
  return { summary: summary || undefined, paragraphs };
};

const joined = (field: Field): string =>
  printable(field.lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE));

export async function readDeb(reader: RangeReader): Promise<PackageInfo> {
  const notDeb = 'it is an ar archive, but not a Debian package.';
  const listing = await listAr(reader);
  if (!listing) {
    throw new PackageError('it is not an ar archive.');
  }
  const { members } = listing;
  if (members[0]?.name !== 'debian-binary') {
    throw new PackageError(notDeb);
  }
  const controlMember = members.find((m) => /^control\.tar(\.[a-z0-9]+)?$/.test(m.name));
  const dataMember = members.find((m) => /^data\.tar(\.[a-z0-9]+)?$/.test(m.name));
  if (!controlMember) {
    throw new PackageError(notDeb);
  }

  const warnings: string[] = [];
  const sections: InfoSection[] = [];
  const suffixOf = (m: ArMember): string => m.name.split('.').slice(2).join('.');

  let format = 'Debian package';
  let title: string | undefined;
  let summary: string | undefined;
  const packageRows: [string, string | undefined][] = [];
  const tail: InfoSection[] = [];

  let formatVersion: string | undefined;
  try {
    formatVersion = printable(
      decode(await reader.upTo(members[0].offset, Math.min(members[0].size, 16))),
    ).trim();
  } catch {
    // The marker is informational; its absence does not stop the page.
  }

  let controlFiles: string[] = [];
  let unpacked: Uint8Array | undefined;
  const controlSuffix = suffixOf(controlMember);
  if (controlMember.truncated) {
    warnings.push('The file ends inside the control archive, so the package fields are not shown.');
  } else if (!(controlSuffix in COMPRESSION)) {
    warnings.push(`The control archive uses an unknown compression (${printable(controlSuffix)}).`);
  } else {
    try {
      unpacked = await unpack(reader, controlMember, controlSuffix);
      if (!unpacked) {
        warnings.push(
          `The control archive is ${COMPRESSION[controlSuffix]} compressed, which MarkCopy cannot read, so the package fields are not shown.`,
        );
      }
    } catch (error) {
      if (!(error instanceof PackageError)) {
        throw error;
      }
      warnings.push(`The control archive could not be unpacked: ${error.message}`);
    }
  }

  if (unpacked) {
    const tar = readTar(unpacked);
    controlFiles = tar.entries.filter((e) => e.type === '0' || e.type === '7').map((e) => e.name);
    const controlEntry = tar.entries.find((e) => e.name === 'control');
    const controlBytes = controlEntry && tarData(unpacked, controlEntry);
    if (!controlEntry || !controlBytes || controlEntry.size > CONTROL_FILE_MAX) {
      warnings.push('The control archive has no readable control file.');
    } else {
      const fields = parseControl(decode(controlBytes));
      if (fields.length === 0) {
        warnings.push('The control file holds no package fields.');
      }
      const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
      const get = (name: string): string | undefined => {
        const field = byName.get(name.toLowerCase());
        return field ? joined(field) : undefined;
      };

      const installedKiB = Number(get('Installed-Size'));
      for (const name of PACKAGE_FIELDS) {
        if (name === 'Installed-Size') {
          if (Number.isFinite(installedKiB) && get(name)) {
            packageRows.push(['Installed size', formatBytes(installedKiB * 1024)]);
          }
        } else {
          packageRows.push([name, get(name)]);
        }
      }
      const shown = new Set(
        [...PACKAGE_FIELDS, ...RELATION_FIELDS, 'Description'].map((n) => n.toLowerCase()),
      );
      for (const field of fields) {
        if (!shown.has(field.name.toLowerCase())) {
          packageRows.push([printable(field.name), joined(field)]);
        }
      }

      const name = get('Package');
      const version = get('Version');
      title = [name, version].filter(Boolean).join(' ') || undefined;
      if (get('Package-Type')?.toLowerCase() === 'udeb') {
        format = 'Debian installer package';
      }

      const text = description(byName.get('description'));
      summary = text.summary;
      if (text.paragraphs.length > 0) {
        sections.push({ kind: 'text', heading: 'Description', paragraphs: text.paragraphs });
      }

      const relations: string[][] = [];
      for (const relation of RELATION_FIELDS) {
        const value = get(relation);
        if (value) {
          for (const entry of parseRelations(value)) {
            relations.push([relation, entry.packages, entry.versions]);
          }
        }
      }
      sections.push(
        ...tableSection('Dependencies', ['Relation', 'Package', 'Version'], relations, {
          limit: DEPENDENCY_LIMIT,
          noun: 'relationships',
        }),
      );
    }

    const scripts = SCRIPTS.filter(([name]) => controlFiles.includes(name));
    if (scripts.length > 0) {
      sections.push(
        ...propertySection(
          'Maintainer scripts',
          scripts,
          'Installing a package runs these scripts as root. MarkCopy does not show or run them.',
        ),
      );
    }

    const sums = tar.entries.find((e) => e.name === 'md5sums');
    const sumBytes = sums && tarData(unpacked, sums);
    if (sumBytes) {
      const paths: string[][] = [];
      let count = 0;
      // Walk the lines in place: splitting the whole list builds a string per line,
      // and a file of empty lines would build millions.
      const listing = decode(sumBytes.subarray(0, MD5SUMS_MAX));
      if (sumBytes.length > MD5SUMS_MAX) {
        warnings.push('The file list is longer than MarkCopy will read, so it is cut short.');
      }
      let at = 0;
      for (let examined = 0; at < listing.length && examined < MAX_FILE_LINES; examined++) {
        let end = listing.indexOf('\n', at);
        if (end < 0) {
          end = listing.length;
        }
        // "<32 hex digits>  <path>"; a line is looked at only as far as a path can be shown.
        const line = listing.slice(at, Math.min(end, at + 40 + MAX_PATH));
        at = end + 1;
        const path = /^[0-9a-fA-F]{32}[ \t]+(\S.*)$/.exec(line)?.[1];
        if (path) {
          count++;
          if (paths.length < CONTENTS_LIMIT) {
            paths.push([printable(path.slice(0, MAX_PATH))]);
          }
        }
      }
      if (count > 0) {
        const lead = `The package lists ${formatNumber(count)} ${count === 1 ? 'file' : 'files'}.`;
        tail.push(
          ...tableSection('Contents', ['Path'], paths, {
            limit: CONTENTS_LIMIT,
            total: count,
            noun: 'files',
            lead,
          }),
        );
      }
    }
  } else {
    // The control archive could not be read; show what the ar container says.
    packageRows.push(['Control archive', `${printable(controlMember.name)}`]);
  }

  if (formatVersion) {
    packageRows.push(['Package format', formatVersion]);
  }
  if (controlFiles.length > 0) {
    packageRows.push([
      'Control files',
      controlFiles
        .slice(0, 30)
        .map((n) => printable(n.slice(0, 100)))
        .join(', '),
    ]);
  }
  if (dataMember) {
    const compression = COMPRESSION[suffixOf(dataMember)] ?? printable(suffixOf(dataMember));
    packageRows.push([
      'Package data',
      `${compression} compressed, ${formatBytes(dataMember.size)}${dataMember.truncated ? ' (the file ends before it does)' : ''}`,
    ]);
  } else {
    warnings.push('The package has no data archive.');
  }

  return {
    format,
    title,
    summary,
    sections: [...propertySection('Package', packageRows), ...sections, ...tail],
    warnings,
  };
}
