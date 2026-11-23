import { describe, expect, it } from 'vitest';
import {
  propertySection,
  rows,
  tableSection,
  type InfoSection,
  type PackageInfo,
} from '../../src/pkg/model';
import { renderPackageHtml } from '../../src/pkg/render';
import { signatureSection } from '../../src/pkg/signature';

const RLO = String.fromCharCode(0x202e);
const BEL = String.fromCharCode(7);
const HOSTILE = '<img src=x onerror=1>';
const ESCAPED = '&lt;img src=x onerror=1&gt;';

const base: PackageInfo = { format: 'Debian package', sections: [], warnings: [] };
const options = { fileName: 'curl.deb', fileSize: 2048 };

describe('renderPackageHtml: page frame', () => {
  it('names the file, shows the title over the format, and carries both wrapper classes', () => {
    const html = renderPackageHtml({ ...base, title: 'curl 8.5.0-2' }, options);
    expect(html).toContain('<h1>curl.deb</h1>');
    expect(html).toContain('<p><strong>curl 8.5.0-2</strong><br>Debian package</p>');
    expect(html.startsWith('<div class="mc-exe mc-pkg">')).toBe(true);
    expect(html.endsWith('</div>')).toBe(true);
  });

  it('shows the format alone when there is no title', () => {
    const html = renderPackageHtml(base, options);
    expect(html).toContain('<p>Debian package</p>');
    expect(html).not.toContain('<strong>');
  });

  it('shows the summary when there is one and nothing when there is not', () => {
    expect(renderPackageHtml({ ...base, summary: 'Transfers URLs' }, options)).toContain(
      '<p>Transfers URLs</p>',
    );
    expect(renderPackageHtml(base, options)).not.toContain('Transfers');
  });

  it('draws each warning as small print', () => {
    const html = renderPackageHtml(
      { ...base, warnings: ['The file list could not be read.', 'Second.'] },
      options,
    );
    expect(html).toContain('<p class="mc-exe-note">The file list could not be read.</p>');
    expect(html).toContain('<p class="mc-exe-note">Second.</p>');
  });
});

describe('renderPackageHtml: sections', () => {
  it('draws a property section as a Property and Value table, with its note', () => {
    const html = renderPackageHtml(
      {
        ...base,
        sections: [
          {
            kind: 'properties',
            heading: 'Package',
            rows: [['Name', 'curl']],
            note: 'Read from control.',
          },
        ],
      },
      options,
    );
    expect(html).toContain('<h2>Package</h2>');
    expect(html).toContain('<th>Property</th><th>Value</th>');
    expect(html).toContain('<td>Name</td><td>curl</td>');
    expect(html).toContain('<p class="mc-exe-note">Read from control.</p>');
  });

  it('draws a table section with its lead, columns, rows and note', () => {
    const html = renderPackageHtml(
      {
        ...base,
        sections: [
          {
            kind: 'table',
            heading: 'Contents',
            lead: '2 files, 3 KB.',
            columns: ['Path', 'Size'],
            rows: [
              ['a.txt', '1'],
              ['b.txt', '2'],
            ],
            note: 'Showing the first 2 of 9 files.',
          },
        ],
      },
      options,
    );
    expect(html).toContain('<h2>Contents</h2><p>2 files, 3 KB.</p>');
    expect(html).toContain('<th>Path</th><th>Size</th>');
    expect(html).toContain('<tr><td>a.txt</td><td>1</td></tr>');
    expect(html).toContain('<tr><td>b.txt</td><td>2</td></tr>');
    expect(html).toContain('<p class="mc-exe-note">Showing the first 2 of 9 files.</p>');
  });

  it('leaves out the lead and the note of a table section that has none', () => {
    const html = renderPackageHtml(
      {
        ...base,
        sections: [{ kind: 'table', heading: 'Dependencies', columns: ['Name'], rows: [['libc']] }],
      },
      options,
    );
    expect(html).toContain('<h2>Dependencies</h2><table>');
    expect(html).not.toContain('mc-exe-note');
  });

  it('draws a text section as one paragraph per entry', () => {
    const html = renderPackageHtml(
      {
        ...base,
        sections: [
          { kind: 'text', heading: 'Description', paragraphs: ['First.', 'Second.', 'Third.'] },
        ],
      },
      options,
    );
    expect(html).toContain('<h2>Description</h2><p>First.</p><p>Second.</p><p>Third.</p>');
  });

  it('keeps the sections in the order given, with File second', () => {
    const html = renderPackageHtml(
      {
        ...base,
        sections: [
          { kind: 'properties', heading: 'Package', rows: [['Name', 'x']] },
          { kind: 'text', heading: 'Description', paragraphs: ['d'] },
        ],
      },
      options,
    );
    const at = (h: string): number => html.indexOf(`<h2>${h}</h2>`);
    // The file's own facts come second, straight after the package's identity.
    expect(at('Package')).toBeLessThan(at('File'));
    expect(at('File')).toBeLessThan(at('Description'));
  });
});

describe('renderPackageHtml: File section', () => {
  it('shows the format and size, with the SHA-256 when given', () => {
    const sha = 'ab'.repeat(32);
    const html = renderPackageHtml(base, { ...options, sha256: sha });
    expect(html).toContain('<h2>File</h2>');
    expect(html).toContain('<td>Format</td><td>Debian package</td>');
    expect(html).toContain('<td>Size</td><td>2.00 KB (2,048 bytes)</td>');
    expect(html).toContain(`<td>SHA-256</td><td>${sha}</td>`);
  });

  it('shows the hash note in place of a hash that was not computed', () => {
    const html = renderPackageHtml(base, { ...options, hashNote: 'Not computed for big files' });
    expect(html).toContain('<td>SHA-256</td><td>Not computed for big files</td>');
  });

  it('prefers the hash to the note when both are given', () => {
    const html = renderPackageHtml(base, { ...options, sha256: 'cd'.repeat(32), hashNote: 'note' });
    expect(html).toContain('cdcd');
    expect(html).not.toContain('<td>note</td>');
  });

  it('has no SHA-256 row with neither', () => {
    expect(renderPackageHtml(base, options)).not.toContain('SHA-256');
  });
});

describe('renderPackageHtml: escaping and cleaning', () => {
  it('escapes every string the file can supply', () => {
    const html = renderPackageHtml(
      {
        format: HOSTILE,
        title: HOSTILE,
        summary: HOSTILE,
        warnings: [HOSTILE],
        sections: [
          { kind: 'properties', heading: HOSTILE, rows: [[HOSTILE, HOSTILE]], note: HOSTILE },
          {
            kind: 'table',
            heading: HOSTILE,
            lead: HOSTILE,
            columns: [HOSTILE],
            rows: [[HOSTILE]],
            note: HOSTILE,
          },
          { kind: 'text', heading: HOSTILE, paragraphs: [HOSTILE, HOSTILE] },
        ],
      },
      { fileName: HOSTILE, fileSize: 1, hashNote: HOSTILE },
    );
    expect(html).not.toContain('<img');
    expect(html).toContain(ESCAPED);
    // h1, title, format (twice), summary, warning, the section parts, the
    // File format row and the hash note: each one is escaped.
    expect(html.split(ESCAPED).length - 1).toBeGreaterThanOrEqual(18);
  });

  it('strips control and bidirectional characters from the file name', () => {
    const html = renderPackageHtml(base, {
      fileName: `evil${RLO}bed.deb${BEL}`,
      fileSize: 1,
    });
    expect(html).toContain('<h1>evilbed.deb</h1>');
    expect(html).not.toContain(RLO);
    expect(html).not.toContain(BEL);
  });
});

describe('model helpers', () => {
  it('rows drops undefined, null, empty and whitespace-only values and keeps 0', () => {
    expect(
      rows(
        ['a', undefined],
        ['b', null],
        ['c', ''],
        ['d', '  \t '],
        ['e', 0],
        ['f', ' kept '],
        ['g', 7],
      ),
    ).toEqual([
      ['e', '0'],
      ['f', 'kept'],
      ['g', '7'],
    ]);
  });

  it('propertySection returns nothing when every value is empty', () => {
    expect(
      propertySection('Package', [
        ['a', undefined],
        ['b', ' '],
      ]),
    ).toEqual([]);
  });

  it('propertySection returns one section with its note otherwise', () => {
    expect(
      propertySection(
        'Package',
        [
          ['a', 'x'],
          ['b', ''],
        ],
        'small',
      ),
    ).toEqual([{ kind: 'properties', heading: 'Package', rows: [['a', 'x']], note: 'small' }]);
  });

  const many = (n: number): string[][] => Array.from({ length: n }, (_, i) => [`f${i}`]);

  it('tableSection returns nothing for no rows, even with a total', () => {
    expect(tableSection('Contents', ['Path'], [])).toEqual([]);
    expect(tableSection('Contents', ['Path'], [], { total: 50 })).toEqual([]);
  });

  it('tableSection keeps every row and adds no note when they fit', () => {
    const [section] = tableSection('Contents', ['Path'], many(3), { lead: '3 files.' });
    expect(section.rows).toHaveLength(3);
    expect(section.note).toBeUndefined();
    expect(section.lead).toBe('3 files.');
  });

  it('tableSection caps at 200 by default and says how many were left out', () => {
    const [section] = tableSection('Contents', ['Path'], many(1500), { noun: 'files' });
    expect(section.rows).toHaveLength(200);
    expect(section.note).toBe('Showing the first 200 of 1,500 files.');
  });

  it('tableSection honours a custom limit and the default noun', () => {
    const [section] = tableSection('Deps', ['Name'], many(10), { limit: 4 });
    expect(section.rows).toHaveLength(4);
    expect(section.note).toBe('Showing the first 4 of 10 rows.');
  });

  it('tableSection uses a total larger than the rows it was given', () => {
    const [section] = tableSection('Contents', ['Path'], many(5), {
      total: 1234567,
      noun: 'files',
    });
    expect(section.rows).toHaveLength(5);
    expect(section.note).toBe('Showing the first 5 of 1,234,567 files.');
  });
});

describe('signatureSection', () => {
  const signer = {
    subject: 'Contoso Ltd',
    organization: 'Contoso Ltd',
    issuer: 'Contoso CA',
    notBefore: '2024-01-01',
    notAfter: '2026-01-01',
  };

  it('names the scheme and says it was not verified', () => {
    const section = signatureSection('JAR signing', signer);
    expect(section.heading).toBe('Signature');
    expect(section.rows[0]).toEqual([
      'Status',
      'JAR signing signature present, not verified by MarkCopy',
    ]);
    expect(section.rows).toContainEqual(['Signer', 'Contoso Ltd']);
    expect(section.rows).toContainEqual(['Issued by', 'Contoso CA']);
    expect(section.rows).toContainEqual(['Certificate valid', '2024-01-01 to 2026-01-01']);
  });

  it('hides the organization when it equals the subject and shows it when it differs', () => {
    expect(signatureSection('x', signer).rows.map((r) => r[0])).not.toContain('Organization');
    const other = signatureSection('x', { ...signer, organization: 'Contoso Group' });
    expect(other.rows).toContainEqual(['Organization', 'Contoso Group']);
  });

  it('always carries the caveat that nothing was checked', () => {
    for (const section of [signatureSection('x', signer), signatureSection('x')]) {
      expect(section.note).toContain('does not check the signature');
    }
  });

  it('works with no signer: just the status row', () => {
    const section = signatureSection('APK Signature Scheme v2');
    expect(section.rows).toEqual([
      ['Status', 'APK Signature Scheme v2 signature present, not verified by MarkCopy'],
    ]);
  });
});

// The page lays its sections out in two columns (media/preview.css): each is
// wrapped, and a grid that is long or has several columns takes the full width.
describe('renderPackageHtml: sections for the two-column layout', () => {
  const grid = (columns: string[], count: number): InfoSection => ({
    kind: 'table',
    heading: `Grid ${columns.length}x${count}`,
    columns,
    rows: Array.from({ length: count }, (_, i) => columns.map((c) => `${c}${i}`)),
  });
  const html = renderPackageHtml(
    {
      format: 'Test package',
      sections: [
        { kind: 'properties', heading: 'Package', rows: [['Name', 'demo']] },
        { kind: 'text', heading: 'Description', paragraphs: ['A demo.'] },
        grid(['Library'], 5),
        grid(['Library'], 13),
        grid(['Relation', 'Package', 'Version'], 4),
        grid(['Path', 'Size'], 13),
        grid(['Identifier', 'Version', 'Location', 'Size'], 2),
        { kind: 'properties', heading: 'Signature', rows: [['Status', 'present']] },
      ],
      warnings: [],
    },
    { fileName: 'demo.deb', fileSize: 10 },
  );

  it('keeps property tables, text and short narrow grids in the columns', () => {
    expect(html).toContain('<div class="mc-info-section"><h2>Package</h2>');
    expect(html).toContain('<div class="mc-info-section"><h2>Description</h2>');
    expect(html).toContain('<div class="mc-info-section"><h2>Grid 1x5</h2>');
    expect(html).toContain('<div class="mc-info-section"><h2>Grid 3x4</h2>');
    expect(html).toContain('<div class="mc-info-section"><h2>File</h2>');
  });

  it('gives a long grid, or one with four or more columns, the full width', () => {
    expect(html).toContain('<div class="mc-info-section mc-info-wide"><h2>Grid 1x13</h2>');
    expect(html).toContain('<div class="mc-info-section mc-info-wide"><h2>Grid 2x13</h2>');
    expect(html).toContain('<div class="mc-info-section mc-info-wide"><h2>Grid 4x2</h2>');
  });

  // A full-width grid ends the two columns above it, so a short section after
  // one would sit alone in half a page.
  it('puts every section that fits a column before the full-width grids', () => {
    const at = (h: string): number => html.indexOf(`<h2>${h}</h2>`);
    const firstWide = Math.min(at('Grid 1x13'), at('Grid 2x13'), at('Grid 4x2'));
    for (const heading of ['Package', 'File', 'Description', 'Grid 1x5', 'Grid 3x4', 'Signature']) {
      expect(at(heading)).toBeGreaterThan(-1);
      expect(at(heading)).toBeLessThan(firstWide);
    }
    // Among themselves the full-width grids keep the order the reader gave.
    expect(at('Grid 1x13')).toBeLessThan(at('Grid 2x13'));
    expect(at('Grid 2x13')).toBeLessThan(at('Grid 4x2'));
  });

  it('marks a long grid of one or two columns as a list, and no other', () => {
    expect(html).toContain('<h2>Grid 1x13</h2><table class="mc-info-list">');
    expect(html).toContain('<h2>Grid 2x13</h2><table class="mc-info-list mc-info-pairs">');
    expect(html).toContain('<h2>Grid 1x5</h2><table>');
    expect(html).toContain('<h2>Grid 4x2</h2><table>');
  });
});
