// @vitest-environment node
//
// bound() is the last thing between a reader's result and the renderer. Each
// reader caps what it reads, and those caps are per table and per string; this
// caps their sum. It is a backstop, tested as one: whatever a reader returns,
// the page is small.
import { describe, expect, it } from 'vitest';
import { bound, renderPackageHtml, type PackageInfo } from '../../src/pkg';

const page = (info: PackageInfo): string =>
  renderPackageHtml(bound(info), { fileName: 'x.pkg', fileSize: 1 });

const base: PackageInfo = { format: 'Test package', sections: [], warnings: [] };
const CUT = 'This file holds more than the page shows: long values and long lists were cut short.';

describe('bound', () => {
  it('leaves an ordinary page exactly as the reader made it', () => {
    const info: PackageInfo = {
      format: 'Debian package',
      title: 'hello 2.12',
      summary: 'a greeting',
      sections: [
        { kind: 'properties', heading: 'Package', rows: [['Name', 'hello']], note: 'n' },
        { kind: 'text', heading: 'Description', paragraphs: ['one', 'two'] },
        {
          kind: 'table',
          heading: 'Contents',
          lead: '2 files',
          columns: ['Path', 'Size'],
          rows: [
            ['usr/bin/hello', '1 byte'],
            ['usr/share/doc', '2 bytes'],
          ],
          note: undefined,
        },
      ],
      warnings: ['The file list could not be read.'],
    };
    expect(bound(info)).toEqual(info);
  });

  it('cuts a long cell, and says the page was cut', () => {
    const out = bound({
      ...base,
      sections: [{ kind: 'properties', heading: 'Package', rows: [['Name', 'x'.repeat(100_000)]] }],
    });
    const section = out.sections[0];
    expect(section.kind === 'properties' && section.rows[0][1].length).toBe(2048);
    expect(out.warnings).toContain(CUT);
  });

  it('cuts rows, columns, sections, paragraphs and warnings to their caps', () => {
    const out = bound({
      ...base,
      sections: [
        {
          kind: 'table',
          heading: 'Grid',
          columns: Array.from({ length: 20 }, (_, i) => `c${i}`),
          rows: Array.from({ length: 5000 }, () => Array.from({ length: 20 }, () => 'v')),
        },
        { kind: 'text', heading: 'Text', paragraphs: Array.from({ length: 500 }, () => 'p') },
        ...Array.from({ length: 100 }, (_, i) => ({
          kind: 'properties' as const,
          heading: `S${i}`,
          rows: [['k', 'v']] as [string, string][],
        })),
      ],
      warnings: Array.from({ length: 200 }, (_, i) => `w${i}`),
    });
    expect(out.sections).toHaveLength(40);
    const grid = out.sections[0];
    expect(grid.kind === 'table' && grid.rows).toHaveLength(500);
    expect(grid.kind === 'table' && grid.columns).toHaveLength(8);
    expect(grid.kind === 'table' && grid.rows[0]).toHaveLength(8);
    const text = out.sections[1];
    expect(text.kind === 'text' && text.paragraphs).toHaveLength(40);
    // Twenty of the reader's own, plus the one that says the page was cut.
    expect(out.warnings).toHaveLength(21);
    expect(out.warnings[20]).toBe(CUT);
  });

  it('holds the whole page to its budget however the reader spread the text', () => {
    // Every per-item cap respected, and still 40 sections of 500 rows of 8
    // cells of 2,048 characters: 327 MB if only the per-item caps applied.
    const info: PackageInfo = {
      ...base,
      title: 't'.repeat(10_000),
      summary: 's'.repeat(100_000),
      sections: Array.from({ length: 40 }, (_, i) => ({
        kind: 'table' as const,
        heading: `Section ${i}`,
        columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        rows: Array.from({ length: 500 }, () => Array.from({ length: 8 }, () => 'x'.repeat(2048))),
      })),
    };
    const out = bound(info);
    const cells = out.sections.flatMap((s) => (s.kind === 'text' ? s.paragraphs : s.rows.flat()));
    const total = cells.reduce((sum, cell) => sum + cell.length, 0);
    expect(total).toBeLessThanOrEqual(1024 * 1024 + 4096);
    expect(out.title).toHaveLength(512);
    expect(out.warnings).toContain(CUT);
    // And the markup built from it is a few megabytes at most, not hundreds.
    expect(page(info).length).toBeLessThan(4 * 1024 * 1024);
  });

  it('survives a reader that returns something other than strings', () => {
    const info = {
      ...base,
      sections: [
        {
          kind: 'properties',
          heading: 'Package',
          rows: [
            ['Name', undefined],
            [42, null],
          ],
        },
      ],
    } as unknown as PackageInfo;
    const out = bound(info);
    const section = out.sections[0];
    expect(section.kind === 'properties' && section.rows).toEqual([
      ['Name', ''],
      ['', ''],
    ]);
    expect(() => page(info)).not.toThrow();
  });
});
