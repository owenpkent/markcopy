// Turns what a package reader found into the preview's markup.
//
// One renderer for every format: a reader returns facts (src/pkg/model.ts) and
// never markup, so escaping lives in src/binary/html.ts alone.
import { escapeHtml } from '../escape';
import {
  block,
  formatBytes,
  grid,
  LONG_GRID_ROWS,
  pageHead,
  properties,
  type Row,
} from '../binary/html';
import { printable } from '../binary/text';
import type { AlsoReading, InfoSection, PackageInfo } from './model';

export interface RenderOptions {
  fileName: string;
  fileSize: number;
  /** Lowercase hex. Absent when the host did not hash the file. */
  sha256?: string;
  /** Why there is no hash, to show in its place. */
  hashNote?: string;
}

const note = (text: string): string => `<p class="mc-exe-note">${escapeHtml(text)}</p>`;

// A grid with this many columns needs the page's full width however short it
// is. Narrower ones sit in one of the two columns beside the property tables
// (see .mc-exe in media/preview.css) unless they are long.
const WIDE_COLUMNS = 4;

function body(part: InfoSection): string {
  switch (part.kind) {
    case 'properties':
      return properties(part.rows) + (part.note ? note(part.note) : '');
    case 'table':
      return (
        (part.lead ? `<p>${escapeHtml(part.lead)}</p>` : '') +
        grid(part.columns, part.rows) +
        (part.note ? note(part.note) : '')
      );
    case 'text':
      return part.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  }
}

const isWide = (part: InfoSection): boolean =>
  part.kind === 'table' &&
  (part.rows.length > LONG_GRID_ROWS || part.columns.length >= WIDE_COLUMNS);

const section = (part: InfoSection): string => block(part.heading, body(part), isWide(part));

const NUMBERS = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];

/** The sentence at the top of a page whose file has more than one structure. */
export function alsoNotice(also: AlsoReading): string {
  const names = [also.primary, ...also.matches.map((m) => m.format)];
  const count = NUMBERS[names.length - 2] ?? String(names.length);
  const list =
    names.length === 2
      ? names.join(' and ')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  let tail = '';
  if (also.matches.length > 1) {
    tail = also.read
      ? ` Only one other format, ${also.read}, is read below.`
      : ' None of the other formats is read.';
  } else if (also.info) {
    tail = ' Both readings are shown below.';
  }
  return `This file has the structure of ${count} formats: ${list}.${tail}`;
}

/**
 * The notice at the top of a page whose file has more than one structure: the
 * formats, then where each other structure sits. A statement of structure,
 * with no judgement about why the file is built that way.
 */
export function renderAlsoAlert(also: AlsoReading): string {
  const facts = also.matches
    .map((m) => `<li>${escapeHtml(m.format)}: ${escapeHtml(m.fact)}.</li>`)
    .join('');
  return (
    '<div class="mc-info-alert" role="note">' +
    `<p><strong>${escapeHtml(alsoNotice(also))}</strong></p><ul>${facts}</ul></div>`
  );
}

/** The second reading, below the first: its own heading, then its sections. */
export function renderAlsoReading(also: AlsoReading): string {
  if (!also.read) {
    return '';
  }
  const heading = `Also read as: ${also.read}`;
  if (!also.info) {
    return block(
      heading,
      note(`It could not be read as ${also.read}: ${also.error ?? 'unknown error'}`),
      true,
    );
  }
  const info = also.info;
  const lines = [
    info.title
      ? `<p><strong>${escapeHtml(info.title)}</strong><br>${escapeHtml(info.format)}</p>`
      : `<p>${escapeHtml(info.format)}</p>`,
  ];
  if (info.summary) {
    lines.push(`<p>${escapeHtml(info.summary)}</p>`);
  }
  for (const warning of info.warnings) {
    lines.push(note(warning));
  }
  const parts = [block(heading, lines.join(''), true)];
  for (const part of [
    ...info.sections.filter((p) => !isWide(p)),
    ...info.sections.filter(isWide),
  ]) {
    parts.push(section(part));
  }
  return parts.join('');
}

export function renderPackageHtml(info: PackageInfo, options: RenderOptions): string {
  const lines = [
    info.title
      ? `<p><strong>${escapeHtml(info.title)}</strong><br>${escapeHtml(info.format)}</p>`
      : `<p>${escapeHtml(info.format)}</p>`,
  ];
  if (info.summary) {
    lines.push(`<p>${escapeHtml(info.summary)}</p>`);
  }
  const parts: string[] = [pageHead(printable(options.fileName), lines)];
  if (info.also) {
    parts.push(renderAlsoAlert(info.also));
  }
  for (const warning of info.warnings) {
    parts.push(note(warning));
  }
  // What the host knows about the file whatever is inside it.
  const file: Row[] = [
    ['Format', info.format],
    ['Size', formatBytes(options.fileSize)],
  ];
  if (options.sha256) {
    file.push(['SHA-256', options.sha256]);
  } else if (options.hashNote) {
    file.push(['SHA-256', options.hashNote]);
  }
  // The file's own facts go second, straight after the package's identity:
  // the size and the hash are what a reader checking a download came for, and
  // at the end they sat under two hundred rows of file list.
  const [first, ...rest] = info.sections;
  if (first) {
    parts.push(section(first));
  }
  parts.push(block('File', properties(file)));
  // Then everything else that fits a column, and the full-width grids last.
  // A full-width grid ends the two columns above it, so a short section left
  // after one (a signature under a file list) would sit alone in half a page.
  for (const part of [...rest.filter((p) => !isWide(p)), ...rest.filter(isWide)]) {
    parts.push(section(part));
  }
  if (info.also) {
    parts.push(renderAlsoReading(info.also));
  }
  // .mc-exe carries the layout the executable page already has: wrapping for
  // long values and the small print. .mc-pkg is there for anything this page
  // needs of its own.
  return `<div class="mc-exe mc-pkg">${parts.join('')}</div>`;
}
