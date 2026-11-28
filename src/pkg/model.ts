// What every package reader produces, so one renderer draws them all.
//
// A reader's job ends at facts: it never writes markup. That keeps escaping in
// one place (src/binary/html.ts) and lets a format be tested as data.
import type { Row } from '../binary/html';

// The shared reader's error under this feature's name. See ReadError.
export { ReadError as PackageError } from '../binary/reader';

/** A two-column table of facts, in the order they should be read. */
export interface PropertySection {
  kind: 'properties';
  heading: string;
  rows: Row[];
  /** Small print under the table. */
  note?: string;
}

/** A grid: dependencies, files, partitions. */
export interface TableSection {
  kind: 'table';
  heading: string;
  /** A sentence above the grid, such as a count. */
  lead?: string;
  columns: string[];
  rows: string[][];
  /** Small print under the grid, such as "Showing the first 200 of 3,412 files." */
  note?: string;
}

/** Prose the package carries about itself: a long description, a licence note. */
export interface TextSection {
  kind: 'text';
  heading: string;
  paragraphs: string[];
}

export type InfoSection = PropertySection | TableSection | TextSection;

export interface PackageInfo {
  /** What kind of file this is, as a reader would say it: "Debian package", "Windows Installer package". */
  format: string;
  /** The package's own name and version, such as "curl 8.5.0-2". Shown in bold under the file name. */
  title?: string;
  /** One line saying what it is, from the package's summary or description. */
  summary?: string;
  sections: InfoSection[];
  /** Extra rows for the page's File section, such as how a zip's entries are encrypted. */
  fileRows?: Row[];
  /** Parts of the file that were present but could not be read. */
  warnings: string[];
}

/** Drop the rows whose value is missing or blank, so a reader can list every fact it looks for. */
export function rows(...pairs: [string, string | number | undefined | null][]): Row[] {
  const out: Row[] = [];
  for (const [label, value] of pairs) {
    if (value === undefined || value === null) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      out.push([label, text]);
    }
  }
  return out;
}

/** A property section, or nothing when no row has a value. */
export function propertySection(
  heading: string,
  pairs: [string, string | number | undefined | null][],
  note?: string,
): PropertySection[] {
  const list = rows(...pairs);
  return list.length > 0 ? [{ kind: 'properties', heading, rows: list, note }] : [];
}

/**
 * A grid of at most `limit` rows, with the small print that says how many were left out.
 * Nothing when there are no rows.
 */
export function tableSection(
  heading: string,
  columns: string[],
  all: string[][],
  options: { limit?: number; total?: number; noun?: string; lead?: string } = {},
): TableSection[] {
  if (all.length === 0) {
    return [];
  }
  const limit = options.limit ?? 200;
  const total = options.total ?? all.length;
  const shown = all.slice(0, limit);
  const noun = options.noun ?? 'rows';
  return [
    {
      kind: 'table',
      heading,
      lead: options.lead,
      columns,
      rows: shown,
      note:
        total > shown.length
          ? `Showing the first ${shown.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${noun}.`
          : undefined,
    },
  ];
}
