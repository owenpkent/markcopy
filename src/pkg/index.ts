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
import { clip } from '../binary/text';
import { readAlpineApk } from './alpine';
import { readDeb } from './deb';
import { looksLikeDmg, readDmg } from './dmg';
import { readElf } from './elf';
import type { InfoSection, PackageInfo } from './model';
import { readMsi } from './msi';
import { readRpm } from './rpm';
import { readXar } from './xar';
import { readZipPackage } from './zipFormats';

export { PackageError, type PackageInfo, type InfoSection } from './model';
export { renderPackageHtml, type RenderOptions } from './render';

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
    fileRows: info.fileRows
      ?.slice(0, MAX_ROWS)
      .map((row): [string, string] => [
        take(row[0], MAX_HEADLINE_CHARS),
        take(row[1], MAX_VALUE_CHARS),
      ]),
    warnings,
  };
}

export async function readPackage(source: ByteSource, fileName: string): Promise<PackageInfo> {
  return bound(await identify(source, fileName));
}

async function identify(source: ByteSource, fileName: string): Promise<PackageInfo> {
  const reader = new RangeReader(source, LIMITS);
  if (reader.size === 0) {
    throw new ReadError('it is empty.');
  }
  const head = await reader.upTo(0, 16);
  const bytes = (...expected: number[]): boolean => expected.every((b, i) => head[i] === b);
  const text = (expected: string): boolean =>
    [...expected].every((c, i) => head[i] === c.charCodeAt(0));

  if (bytes(0x7f, 0x45, 0x4c, 0x46)) {
    return readElf(reader);
  }
  if (bytes(0xed, 0xab, 0xee, 0xdb)) {
    return readRpm(reader);
  }
  if (text('!<arch>\n')) {
    return readDeb(reader);
  }
  if (bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    return readMsi(reader);
  }
  if (text('xar!')) {
    return readXar(reader);
  }
  if (text('PK\x03\x04') || text('PK\x05\x06')) {
    return readZipPackage(reader, fileName);
  }
  // An Alpine package is gzip, which says nothing about what is inside, so the
  // name has to vouch for it before it is unpacked.
  if (bytes(0x1f, 0x8b) && /\.apk$/i.test(fileName)) {
    return readAlpineApk(reader);
  }
  // A disk image is recognised by its trailer, not its first bytes.
  if (await looksLikeDmg(reader)) {
    return readDmg(reader);
  }
  throw new ReadError('it is not a package format this preview reads.');
}
