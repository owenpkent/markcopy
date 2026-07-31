import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { renderWorkbookHtml, WorkbookError } from '../../src/xlsx';
import { columnName } from '../../src/xlsx/render';
import { columnOf } from '../../src/xlsx/sheet';
import { buildXlsx, row, sheetData } from './fixture';

/** Render a one-sheet workbook and return its HTML. */
function render(xml: string, spec: Partial<Parameters<typeof buildXlsx>[0]> = {}): string {
  return renderWorkbookHtml(buildXlsx({ sheets: [{ name: 'Sheet1', xml }], ...spec }), {
    maxRows: 5000,
    maxColumns: 200,
  }).html;
}

/** The text of every body cell, row by row. */
function cells(html: string): string[][] {
  return [...html.matchAll(/<tr>(?:(?!<\/tr>).)*<\/tr>/gs)]
    .map((m) => m[0])
    .filter((tr) => tr.includes('scope="row"'))
    .map((tr) => [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => c[1]));
}

describe('cell values', () => {
  it('reads shared strings by index', () => {
    const html = render(sheetData([row(1, '<c r="A1" t="s"><v>1</v></c>')]), {
      sharedStrings: ['<t>wrong</t>', '<t>right</t>'],
    });
    expect(cells(html)[0]).toEqual(['right']);
  });

  it('treats t="str" as the string itself, not an index', () => {
    // The classic bug. `str` is a formula's string result held verbatim in <v>;
    // reading it as a shared-string index renders an unrelated value or nothing.
    const html = render(sheetData([row(1, '<c r="A1" t="str"><f>A2</f><v>Widget</v></c>')]), {
      sharedStrings: ['<t>zero</t>', '<t>one</t>'],
    });
    expect(cells(html)[0]).toEqual(['Widget']);
  });

  it('shows a formula’s cached result and never the formula', () => {
    const html = render(sheetData([row(1, '<c r="A1"><f>SUM(B1:B9)</f><v>42</v></c>')]));
    expect(cells(html)[0]).toEqual(['42']);
    expect(html).not.toContain('SUM');
  });

  it('marks a formula with no cached result instead of showing a blank', () => {
    // openpyxl and xlsxwriter write these. A blank cell reads as lost data.
    const html = render(sheetData([row(1, '<c r="A1"><f>SUM(B1:B9)</f></c>')]));
    expect(html).toContain('mc-xlsx-nocalc');
  });

  it('reads inline strings', () => {
    const html = render(sheetData([row(1, '<c r="A1" t="inlineStr"><is><t>inline</t></is></c>')]));
    expect(cells(html)[0]).toEqual(['inline']);
  });

  it('renders booleans and error values as their display text', () => {
    const html = render(
      sheetData([row(1, '<c r="A1" t="b"><v>1</v></c><c r="B1" t="e"><v>#REF!</v></c>')]),
    );
    expect(cells(html)[0]).toEqual(['TRUE', '#REF!']);
  });

  it('places a cell with no r attribute one past the previous one', () => {
    // Legal OOXML that crashes several readers outright.
    const html = render(sheetData([row(1, '<c><v>1</v></c><c><v>2</v></c><c><v>3</v></c>')]));
    expect(cells(html)[0]).toEqual(['1', '2', '3']);
  });

  it('escapes cell text rather than letting it become markup', () => {
    const html = render(
      sheetData([
        row(1, '<c r="A1" t="inlineStr"><is><t>&lt;img src=x onerror=alert(1)&gt;</t></is></c>'),
      ]),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('number formats', () => {
  const styled = (code: string, value: string): string =>
    render(sheetData([row(1, `<c r="A1" s="0"><v>${value}</v></c>`)]), {
      numFmts: [{ id: 164, code }],
      cellXfs: [164],
    });

  it('renders a percent as a percent, not a fraction', () => {
    expect(cells(styled('0.00%', '0.15'))[0]).toEqual(['15.00%']);
  });

  it('renders a date from its serial', () => {
    expect(cells(styled('yyyy-mm-dd', '45000'))[0]).toEqual(['2023-03-15']);
  });

  it('reproduces the 1900 phantom leap day, because the file means that day', () => {
    expect(cells(styled('yyyy-mm-dd', '60'))[0]).toEqual(['1900-02-29']);
    expect(cells(styled('yyyy-mm-dd', '59'))[0]).toEqual(['1900-02-28']);
    expect(cells(styled('yyyy-mm-dd', '61'))[0]).toEqual(['1900-03-01']);
  });

  it('keeps elapsed time elapsed rather than wrapping it to a clock', () => {
    expect(cells(styled('[h]:mm:ss', '1.5'))[0]).toEqual(['36:00:00']);
    expect(cells(styled('h:mm:ss', '1.5'))[0]).toEqual(['12:00:00']);
  });

  it('resolves a builtin format id the file never declares', () => {
    const html = render(sheetData([row(1, '<c r="A1" s="0"><v>0.5</v></c>')]), {
      cellXfs: [9], // builtin 9 is 0%
    });
    expect(cells(html)[0]).toEqual(['50%']);
  });

  it('resolves the style through cellXfs, not cellStyleXfs', () => {
    // cellStyleXfs in the fixture is numFmtId 0 (General). Reading it instead of
    // cellXfs would render the raw 0.15 here.
    expect(cells(styled('0%', '0.15'))[0]).toEqual(['15%']);
  });

  it('shifts serials by 1462 in a 1904 workbook, and leaves plain numbers alone', () => {
    const dated = render(sheetData([row(1, '<c r="A1" s="0"><v>0</v></c>')]), {
      numFmts: [{ id: 164, code: 'yyyy-mm-dd' }],
      cellXfs: [164],
      date1904: true,
    });
    expect(cells(dated)[0]).toEqual(['1904-01-01']);
    // A currency value in the same workbook must not move by four years.
    const money = render(sheetData([row(1, '<c r="A1" s="0"><v>100</v></c>')]), {
      numFmts: [{ id: 164, code: '#,##0.00' }],
      cellXfs: [164],
      date1904: true,
    });
    expect(cells(money)[0]).toEqual(['100.00']);
  });

  it('falls back to the raw number when a format code is malformed', () => {
    // numfmt throws on these, and workbooks do contain them.
    expect(cells(styled('[[[bogus', '12.5'))[0]).toEqual(['12.5']);
  });
});

describe('structure', () => {
  it('keeps the sheet’s own row numbers when rows are sparse', () => {
    const html = render(
      sheetData([row(1, '<c r="A1"><v>1</v></c>'), row(5, '<c r="A5"><v>5</v></c>')]),
    );
    expect(html).toContain('scope="row">1<');
    expect(html).toContain('scope="row">5<');
    expect(html).not.toContain('scope="row">2<');
  });

  it('labels columns the way a spreadsheet does', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnOf('A1')).toBe(0);
    expect(columnOf('AA12')).toBe(26);
  });

  it('turns merges into colspan and drops the covered cells', () => {
    const html = render(
      `<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>` +
        sheetData([row(1, '<c r="A1" t="inlineStr"><is><t>wide</t></is></c>')]),
    );
    expect(html).toContain('colspan="2"');
    expect(cells(html)[0]).toEqual(['wide']);
  });

  it('hides rows, columns, and sheets the author hid', () => {
    const hiddenRow = render(
      sheetData([
        row(1, '<c r="A1"><v>1</v></c>'),
        row(2, '<c r="A2"><v>2</v></c>', ' hidden="1"'),
      ]),
    );
    expect(cells(hiddenRow)).toHaveLength(1);

    const hiddenCol = render(
      `<cols><col min="1" max="1" hidden="1"/></cols>` +
        sheetData([row(1, '<c r="A1"><v>1</v></c><c r="B1"><v>2</v></c>')]),
    );
    expect(cells(hiddenCol)[0]).toEqual(['2']);
  });

  it('opens the first visible sheet when the workbook starts with a hidden one', () => {
    const out = renderWorkbookHtml(
      buildXlsx({
        sheets: [
          { name: 'Hidden', xml: sheetData([row(1, '<c r="A1"><v>1</v></c>')]), hidden: true },
          { name: 'Visible', xml: sheetData([row(1, '<c r="A1"><v>2</v></c>')]) },
        ],
      }),
    );
    expect(out.activeIndex).toBe(1);
    expect(cells(out.html)[0]).toEqual(['2']);
    // The hidden sheet gets no tab either.
    expect(out.html).not.toContain('>Hidden<');
  });

  it('applies a column width from <cols>, which spans an inclusive range', () => {
    const html = render(
      `<cols><col min="1" max="2" width="20"/></cols>` +
        sheetData([row(1, '<c r="A1"><v>1</v></c><c r="B1"><v>2</v></c>')]),
    );
    // Both columns, not just the first, and the gutter col stays unsized.
    expect([...html.matchAll(/<col style="width:145px"/g)]).toHaveLength(2);
  });

  it('caps rows and says how many it is hiding', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      row(i + 1, `<c r="A${i + 1}"><v>${i}</v></c>`),
    );
    const out = renderWorkbookHtml(buildXlsx({ sheets: [{ name: 'S', xml: sheetData(many) }] }), {
      maxRows: 10,
    });
    expect(cells(out.html)).toHaveLength(10);
    expect(out.html).toContain('markcopy.xlsx.maxRows');
  });
});

describe('shared strings', () => {
  it('joins rich-text runs into one value', () => {
    const html = render(sheetData([row(1, '<c r="A1" t="s"><v>0</v></c>')]), {
      sharedStrings: ['<r><t>Hello </t></r><r><t>world</t></r>'],
    });
    expect(cells(html)[0]).toEqual(['Hello world']);
  });

  it('excludes phonetic guides, which would otherwise double the text', () => {
    // <rPh> holds furigana above Japanese text and contains <t> just like the
    // value does. Including it renders the reading twice.
    const html = render(sheetData([row(1, '<c r="A1" t="s"><v>0</v></c>')]), {
      sharedStrings: ['<t>東京</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh>'],
    });
    expect(cells(html)[0]).toEqual(['東京']);
  });
});

describe('hostile and malformed input', () => {
  it('refuses a file that is not a zip, naming the older format', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => renderWorkbookHtml(ole)).toThrow(WorkbookError);
    expect(() => renderWorkbookHtml(ole)).toThrow(/\.xls/);
  });

  it('refuses a workbook larger than the preview limit before unzipping it', () => {
    const big = new Uint8Array(30 * 1024 * 1024);
    big[0] = 0x50;
    big[1] = 0x4b;
    expect(() => renderWorkbookHtml(big)).toThrow(/larger than/);
  });

  it('does not expand entities, so a billion-laughs payload stays inert', () => {
    // saxes resolves only the five predefined XML entities and never expands ones
    // declared in a DTD, so this cannot blow up. The test pins that property: if
    // the parser is ever swapped for one that does expand them, this fails rather
    // than the extension host dying on a crafted file.
    const bomb =
      `<!DOCTYPE lolz [<!ENTITY lol "lol">` +
      `<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">` +
      `<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol3;</t></is></c></row></sheetData>` +
      `</worksheet>`;
    const bytes = buildXlsx({
      sheets: [{ name: 'S', xml: '<sheetData/>' }],
      extra: { 'xl/worksheets/sheet1.xml': bomb },
    });
    // Either it renders the unexpanded reference or it refuses. What it must not
    // do is expand to a gigabyte.
    let html = '';
    try {
      html = renderWorkbookHtml(bytes).html;
    } catch {
      return; // refusing is an acceptable outcome
    }
    expect(html.length).toBeLessThan(100_000);
  });

  it('ignores an external relationship rather than reaching off the machine', () => {
    // An externalLink or remote image target is an SSRF and, on Windows, a
    // credential-leak vector. Nothing here should follow one.
    const bytes = buildXlsx({
      sheets: [{ name: 'S', xml: sheetData([row(1, '<c r="A1"><v>1</v></c>')]) }],
      extra: {
        'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="\\\\evil.example.com\\share\\book.xlsx" TargetMode="External"/>
</Relationships>`,
      },
    });
    const html = renderWorkbookHtml(bytes).html;
    expect(html).not.toContain('evil.example.com');
  });

  it('reports a workbook with no sheets rather than rendering nothing', () => {
    const bytes = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      '_rels/.rels': strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
      'xl/workbook.xml': strToU8(
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>',
      ),
    });
    expect(() => renderWorkbookHtml(bytes)).toThrow(/no sheets/);
  });
});

describe('grid markup contract', () => {
  const html = render(sheetData([row(1, '<c r="A1"><v>1</v></c><c r="B1"><v>2</v></c>')]));

  it('is the CSV grid’s markup, so it inherits the copy and resize machinery', () => {
    expect(html).toContain('class="mc-csv-wrap"');
    expect(html).toContain('<table class="mc-csv mc-xlsx">');
  });

  it('has one col per rendered column plus the gutter', () => {
    // csvTable.ts sizes these when a divider is dragged, and a count that
    // disagrees with the header cells disables resizing silently.
    const cols = [...html.matchAll(/<col[ /]/g)];
    const headers = [...html.matchAll(/<th[^>]*scope="col"/g)];
    expect(cols).toHaveLength(headers.length + 1);
  });

  it('is never editable and never anchors scroll sync', () => {
    expect(html).not.toContain('data-mc-editable');
    expect(html).not.toContain('data-source-line');
  });
});
