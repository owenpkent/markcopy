// Turns what a package reader found into the preview's markup.
//
// One renderer for every format: a reader returns facts (src/pkg/model.ts) and
// never markup, so escaping lives in src/binary/html.ts alone.
import { escapeHtml } from '../escape';
import { formatBytes, properties, table, type Row } from '../binary/html';
import { printable } from '../binary/text';
import type { InfoSection, PackageInfo } from './model';

export interface RenderOptions {
  fileName: string;
  fileSize: number;
  /** Lowercase hex. Absent when the host did not hash the file. */
  sha256?: string;
  /** Why there is no hash, to show in its place. */
  hashNote?: string;
}

const note = (text: string): string => `<p class="mc-exe-note">${escapeHtml(text)}</p>`;

// A grid this long, or with this many columns, is given the full width of the
// page. Shorter and narrower ones sit in one of its two columns beside the
// property tables (see .mc-exe in media/preview.css).
const WIDE_ROWS = 12;
const WIDE_COLUMNS = 3;

function body(part: InfoSection): string {
  switch (part.kind) {
    case 'properties':
      return properties(part.rows) + (part.note ? note(part.note) : '');
    case 'table':
      return (
        (part.lead ? `<p>${escapeHtml(part.lead)}</p>` : '') +
        table(part.columns, part.rows) +
        (part.note ? note(part.note) : '')
      );
    case 'text':
      return part.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  }
}

function block(heading: string, html: string, wide = false): string {
  return `<div class="mc-info-section${wide ? ' mc-info-wide' : ''}"><h2>${escapeHtml(heading)}</h2>${html}</div>`;
}

function section(part: InfoSection): string {
  const wide =
    part.kind === 'table' &&
    (part.rows.length > WIDE_ROWS || (part.columns.length >= WIDE_COLUMNS && part.rows.length > 1));
  return block(part.heading, body(part), wide);
}

export function renderPackageHtml(info: PackageInfo, options: RenderOptions): string {
  const parts: string[] = [`<h1>${escapeHtml(printable(options.fileName))}</h1>`];
  parts.push(
    info.title
      ? `<p><strong>${escapeHtml(info.title)}</strong><br>${escapeHtml(info.format)}</p>`
      : `<p>${escapeHtml(info.format)}</p>`,
  );
  if (info.summary) {
    parts.push(`<p>${escapeHtml(info.summary)}</p>`);
  }
  for (const warning of info.warnings) {
    parts.push(note(warning));
  }
  for (const part of info.sections) {
    parts.push(section(part));
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
  parts.push(block('File', properties(file)));
  // .mc-exe carries the layout the executable page already has: wrapping for
  // long values and the small print. .mc-pkg is there for anything this page
  // needs of its own.
  return `<div class="mc-exe mc-pkg">${parts.join('')}</div>`;
}
