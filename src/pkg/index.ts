// Reading a package or installer's metadata: what it is, what version, who
// made it, what it needs and what is inside, without installing or running it.
//
// The format is decided by what the file holds, not by its name. An extension
// only chooses which editor VS Code opens; a .pkg that is not a macOS installer
// or a .apk that is an Alpine package rather than an Android one is read as
// what it is, and a file that is none of these gets a message saying so.
//
// Free of the `vscode` module, like src/pe, so every reader unit-tests and
// fuzzes directly.
import { RangeReader, ReadError, type ByteSource } from '../binary/reader';
import { findZipEnd, looksLikePdf, looksLikePe } from '../binary/signatures';
import { clip } from '../binary/text';
import { readAlpineApk } from './alpine';
import { readDeb } from './deb';
import { looksLikeDmg, readDmg } from './dmg';
import { readElf } from './elf';
import type { AlsoReading, InfoSection, PackageInfo } from './model';
import { readMsi } from './msi';
import { readRpm } from './rpm';
import { readXar } from './xar';
import { readZipPackage } from './zipFormats';

export { PackageError, type PackageInfo, type InfoSection } from './model';
export {
  renderPackageHtml,
  renderAlsoAlert,
  renderAlsoReading,
  alsoNotice,
  type RenderOptions,
} from './render';
export type { AlsoReading } from './model';

// Twice the executable reader's budget: an RPM header or a zip's central
// directory lists every file in the package, and for a large one that runs to
// megabytes that all have to be read to count them.
const LIMITS = { maxPages: 512, maxRead: 16 * 1024 * 1024 };

// What one page may hold, whatever reader made it. Each reader caps what it
// reads and keeps, and those caps are per table and per string: this is the
// one bound on their sum, applied to every format in one place, so a reader
// whose own caps multiply out to something large still cannot hand the
// renderer a page of hundreds of megabytes.
const MAX_SECTIONS = 40;
const MAX_ROWS = 500;
const MAX_COLUMNS = 8;
const MAX_VALUE_CHARS = 2048;
const MAX_PARAGRAPHS = 40;
const MAX_PARAGRAPH_CHARS = 8192;
const MAX_HEADLINE_CHARS = 512;
const MAX_WARNINGS = 20;
// Characters across the whole page. A real package's page is a few tens of
// thousands; two hundred file paths and a long description are well inside this.
const MAX_PAGE_CHARS = 1024 * 1024;

/** Cut a reader's result down to what a page may hold. Exported for tests. */
export function bound(info: PackageInfo): PackageInfo {
  let budget = MAX_PAGE_CHARS;
  let cut = false;
  const take = (text: unknown, max: number): string => {
    const value = clip(typeof text === 'string' ? text : '', Math.min(max, Math.max(budget, 1)));
    if (typeof text === 'string' && value.length < text.length) {
      cut = true;
    }
    budget -= value.length;
    return value;
  };
  const sections: InfoSection[] = [];
  for (const part of info.sections.slice(0, MAX_SECTIONS)) {
    if (budget <= 0) {
      cut = true;
      break;
    }
    const heading = take(part.heading, MAX_HEADLINE_CHARS);
    if (part.kind === 'text') {
      sections.push({
        kind: 'text',
        heading,
        paragraphs: part.paragraphs
          .slice(0, MAX_PARAGRAPHS)
          .map((p) => take(p, MAX_PARAGRAPH_CHARS)),
      });
      continue;
    }
    const rows: string[][] = [];
    for (const row of part.rows.slice(0, MAX_ROWS)) {
      if (budget <= 0) {
        cut = true;
        break;
      }
      rows.push(row.slice(0, MAX_COLUMNS).map((cell) => take(cell, MAX_VALUE_CHARS)));
    }
    if (part.rows.length > rows.length) {
      cut = true;
    }
    if (part.kind === 'properties') {
      sections.push({
        kind: 'properties',
        heading,
        rows: rows.map((row): [string, string] => [row[0] ?? '', row[1] ?? '']),
        note: part.note === undefined ? undefined : take(part.note, MAX_PARAGRAPH_CHARS),
      });
    } else {
      sections.push({
        kind: 'table',
        heading,
        lead: part.lead === undefined ? undefined : take(part.lead, MAX_PARAGRAPH_CHARS),
        columns: part.columns.slice(0, MAX_COLUMNS).map((c) => take(c, MAX_HEADLINE_CHARS)),
        rows,
        note: part.note === undefined ? undefined : take(part.note, MAX_PARAGRAPH_CHARS),
      });
    }
  }
  if (info.sections.length > sections.length) {
    cut = true;
  }
  const warnings = info.warnings.slice(0, MAX_WARNINGS).map((w) => clip(w, MAX_HEADLINE_CHARS));
  if (cut) {
    warnings.push(
      'This file holds more than the page shows: long values and long lists were cut short.',
    );
  }
  return {
    format: clip(info.format, MAX_HEADLINE_CHARS),
    title: info.title === undefined ? undefined : clip(info.title, MAX_HEADLINE_CHARS),
    summary: info.summary === undefined ? undefined : clip(info.summary, MAX_PARAGRAPH_CHARS),
    sections,
    // Already bounded when the second reading was made.
    also: info.also,
    warnings,
  };
}

/** What a probe is shown, and what it reads. */
interface Context {
  reader: RangeReader;
  /** The first bytes of the file, as many as 4 KiB. */
  head: Uint8Array;
  fileName: string;
}

interface Probe {
  /** The format as the page would call it. */
  name: string;
  /** The structural fact that makes this file match, for the notice: where the structure sits. */
  fact: string;
  /** Does the file have this format's structure? Cheap: the head and the last 64 KiB only. */
  matches(ctx: Context): boolean | Promise<boolean>;
  /**
   * Is this the format the page reads the file as? Defaults to `matches`. It differs
   * where the structure worth mentioning is not what has always chosen the reader.
   */
  selects?(ctx: Context): boolean | Promise<boolean>;
  /** The reader. Absent for a format that is only recognised, such as a PE or a PDF. */
  read?(reader: RangeReader, fileName: string): Promise<PackageInfo>;
}

const startsWith = (head: Uint8Array, expected: number[]): boolean =>
  expected.every((b, i) => head[i] === b);
const startsWithText = (head: Uint8Array, expected: string): boolean =>
  startsWith(
    head,
    [...expected].map((c) => c.charCodeAt(0)),
  );

// The order is the order the checks have always run in: the first probe that
// selects the file is the one read. A new format is one entry here, placed
// where its check belongs among the others. The probes after the last reader
// only recognise a structure, so a file that is also one of them says so.
const PROBES: Probe[] = [
  {
    name: 'ELF file',
    fact: 'it starts with the ELF signature',
    matches: ({ head }) => startsWith(head, [0x7f, 0x45, 0x4c, 0x46]),
    read: readElf,
  },
  {
    name: 'RPM package',
    fact: 'it starts with the RPM signature',
    matches: ({ head }) => startsWith(head, [0xed, 0xab, 0xee, 0xdb]),
    read: readRpm,
  },
  {
    name: 'Debian package',
    fact: 'it starts with the ar archive signature',
    matches: ({ head }) => startsWithText(head, '!<arch>\n'),
    read: readDeb,
  },
  {
    name: 'Windows Installer package',
    fact: 'it starts with the compound file signature',
    matches: ({ head }) => startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    read: readMsi,
  },
  {
    name: 'xar archive',
    fact: 'it starts with the xar signature',
    matches: ({ head }) => startsWithText(head, 'xar!'),
    read: readXar,
  },
  {
    name: 'zip archive',
    fact: 'its central directory ends at the end of the file',
    // A zip is chosen by its first bytes, as it always has been. As a second
    // structure it is the end-of-central-directory record in the last 64 KiB.
    selects: ({ head }) => startsWithText(head, 'PK\x03\x04') || startsWithText(head, 'PK\x05\x06'),
    matches: async ({ reader }) => (await findZipEnd(reader)) !== undefined,
    read: readZipPackage,
  },
  {
    name: 'Alpine package',
    fact: 'it starts with the gzip signature and is named .apk',
    // An Alpine package is gzip, which says nothing about what is inside, so
    // the name has to vouch for it before it is unpacked.
    matches: ({ head, fileName }) => startsWith(head, [0x1f, 0x8b]) && /\.apk$/i.test(fileName),
    read: (reader) => readAlpineApk(reader),
  },
  {
    // A disk image is recognised by its trailer, not its first bytes.
    name: 'disk image',
    fact: 'it has a disk image signature at its start or end',
    matches: ({ reader }) => looksLikeDmg(reader),
    read: (reader) => readDmg(reader),
  },
  {
    name: 'Windows executable',
    fact: 'it starts with MZ and its header points at a PE signature',
    matches: ({ reader }) => looksLikePe(reader),
  },
  {
    name: 'PDF document',
    fact: 'it has a PDF header in its first 1,024 bytes, and the last startxref in its last 64 KiB gives the offset of a cross-reference table or object',
    matches: ({ head, reader }) => looksLikePdf(reader, head),
  },
];

/** A probe that throws does not match. */
async function test(
  probe: Probe,
  ctx: Context,
  which: 'selects' | 'matches' = 'matches',
): Promise<boolean> {
  try {
    return await (probe[which] ?? probe.matches).call(probe, ctx);
  } catch {
    return false;
  }
}

async function identify(source: ByteSource, fileName: string): Promise<PackageInfo> {
  const reader = new RangeReader(source, LIMITS);
  if (reader.size === 0) {
    throw new ReadError('it is empty.');
  }
  const ctx: Context = { reader, head: await reader.upTo(0, 4096), fileName };
  let chosen = -1;
  for (let i = 0; i < PROBES.length; i++) {
    if (PROBES[i].read && (await test(PROBES[i], ctx, 'selects'))) {
      chosen = i;
      break;
    }
  }
  if (chosen < 0) {
    throw new ReadError('it is not a package format this preview reads.');
  }
  const primary = PROBES[chosen];
  const info = await primary.read!(reader, fileName);
  const others: Probe[] = [];
  for (let i = 0; i < PROBES.length; i++) {
    if (i !== chosen && (await test(PROBES[i], ctx))) {
      others.push(PROBES[i]);
    }
  }
  if (others.length === 0) {
    return info;
  }
  return { ...info, also: await readAlso(source, fileName, primary.name, others) };
}

/**
 * The second reading: one format only, the first other match that has a
 * reader, through a reader of its own so its page budget is separate from the
 * first reading's. It runs after the first has finished, and whatever it does
 * the page still shows.
 */
async function readAlso(
  source: ByteSource,
  fileName: string,
  primary: string,
  others: Probe[],
): Promise<AlsoReading> {
  const also: AlsoReading = {
    primary,
    matches: others.map((p) => ({ format: p.name, fact: p.fact })),
  };
  const next = others.find((p) => p.read);
  if (next) {
    also.read = next.name;
    try {
      also.info = bound(await next.read!(new RangeReader(source, LIMITS), fileName));
    } catch (err) {
      also.error = err instanceof Error ? err.message : String(err);
    }
  }
  return also;
}

export async function readPackage(source: ByteSource, fileName: string): Promise<PackageInfo> {
  return bound(await identify(source, fileName));
}

/**
 * What the data appended to an executable reads as, for the executable
 * preview: a zip whose central directory ends the file and starts inside the
 * data. Undefined when it is not one.
 */
export async function readAppended(
  source: ByteSource,
  fileName: string,
  overlayStart: number,
): Promise<AlsoReading | undefined> {
  const end = await findZipEnd(new RangeReader(source, LIMITS));
  if (!end || (end.directoryStart ?? end.eocd) < overlayStart) {
    return undefined;
  }
  const zip = PROBES.find((p) => p.name === 'zip archive')!;
  return readAlso(source, fileName, 'Windows executable', [zip]);
}
