import { describe, it, expect } from 'vitest';
import { escapeField, tableToDelimited, tableToMarkdown } from '../src/webview/table';
import { htmlToMarkdown } from '../src/webview/markdownConvert';

describe('escapeField (CSV, RFC 4180)', () => {
  it('leaves plain values unquoted', () => {
    expect(escapeField('abc', ',')).toBe('abc');
  });

  it('quotes values containing the delimiter', () => {
    expect(escapeField('a,b', ',')).toBe('"a,b"');
  });

  it('doubles inner quotes and wraps', () => {
    expect(escapeField('a"b', ',')).toBe('"a""b"');
  });

  it('quotes values containing a newline', () => {
    expect(escapeField('a\nb', ',')).toBe('"a\nb"');
  });
});

describe('escapeField (TSV)', () => {
  it('flattens tabs and newlines to spaces', () => {
    expect(escapeField('a\tb\nc', '\t')).toBe('a b c');
  });

  it('does not quote commas', () => {
    expect(escapeField('a,b', '\t')).toBe('a,b');
  });
});

describe('tableToDelimited', () => {
  function makeTable(): HTMLElement {
    document.body.innerHTML =
      '<table><thead><tr><th>Feature</th><th>Val</th></tr></thead>' +
      '<tbody><tr><td>CSV, x</td><td>Yes</td></tr></tbody></table>';
    return document.querySelector('table') as HTMLElement;
  }

  it('produces CSV with quoted cells and CRLF rows', () => {
    expect(tableToDelimited(makeTable(), ',')).toBe('Feature,Val\r\n"CSV, x",Yes');
  });

  it('produces TSV with tab separators', () => {
    expect(tableToDelimited(makeTable(), '\t')).toBe('Feature\tVal\r\nCSV, x\tYes');
  });

  // The CSV preview's row-number gutter is viewer chrome, not data.
  it('leaves cells marked data-mc-ignore out', () => {
    document.body.innerHTML =
      '<table><thead><tr><th data-mc-ignore="1"></th><th>Name</th></tr></thead>' +
      '<tbody><tr><th data-mc-ignore="1">1</th><td>Ada</td></tr></tbody></table>';
    const table = document.querySelector('table') as HTMLElement;
    expect(tableToDelimited(table, ',')).toBe('Name\r\nAda');
  });

  // A CSV grid's cell text is the file's own field; a Markdown table's is the
  // product of rendering. Only the latter's surrounding whitespace is noise.
  describe('whitespace', () => {
    const build = (cls: string): HTMLElement => {
      document.body.innerHTML = `<table class="${cls}"><tbody><tr><td>  pad  </td><td>b</td></tr></tbody></table>`;
      return document.querySelector('table') as HTMLElement;
    };

    it('keeps significant spaces in a CSV grid', () => {
      expect(tableToDelimited(build('mc-csv'), ',')).toBe('  pad  ,b');
    });

    it('still trims a Markdown table', () => {
      expect(tableToDelimited(build(''), ',')).toBe('pad,b');
    });
  });

  // CSV is positional, so a merged cell that occupies one slot in the DOM but
  // three in the grid has to become three fields. Emitting one shifts every
  // column after it left, silently, in a copy that looks plausible.
  describe('merged cells', () => {
    it('expands a colspan into the fields it stands for', () => {
      document.body.innerHTML =
        '<table><thead><tr><th>H</th><th>I</th><th>J</th></tr></thead>' +
        '<tbody><tr><td colspan="2">wide</td><td>3</td></tr></tbody></table>';
      const table = document.querySelector('table') as HTMLElement;
      expect(tableToDelimited(table, ',')).toBe('H,I,J\r\nwide,,3');
    });

    it('fills the rows a rowspan reaches into', () => {
      // Without placeholders the second row is one field short and its only
      // value lands under the wrong column.
      document.body.innerHTML =
        '<table><tbody>' +
        '<tr><td rowspan="2">tall</td><td>b1</td></tr>' +
        '<tr><td>b2</td></tr>' +
        '</tbody></table>';
      const table = document.querySelector('table') as HTMLElement;
      expect(tableToDelimited(table, ',')).toBe('tall,b1\r\n,b2');
    });

    it('does not take the rows of a nested table for its own', () => {
      document.body.innerHTML =
        '<table><tbody><tr><td>outer</td><td>' +
        '<table><tbody><tr><td>x</td><td>y</td></tr></tbody></table>' +
        '</td></tr></tbody></table>';
      const table = document.querySelector('table') as HTMLElement;
      // One row, two fields. The nested rows are not extra rows of this table.
      expect(tableToDelimited(table, ',').split('\r\n')).toHaveLength(1);
    });
  });
});

// Turndown joins GFM cells with '|' and escapes nothing inside them, so these
// go through the real converter rather than a stub: the bug lives in what
// Turndown does with the DOM, and a stub would not reproduce it.
describe('tableToMarkdown', () => {
  const convert = (html: string): Promise<string> => htmlToMarkdown(html);

  function build(body: string): HTMLElement {
    document.body.innerHTML = `<table>${body}</table>`;
    return document.querySelector('table') as HTMLElement;
  }

  it('escapes a pipe in the data instead of letting it end the cell', async () => {
    const table = build(
      '<thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>x|y</td><td>2</td></tr></tbody>',
    );
    const md = await tableToMarkdown(table, convert);
    expect(md).toContain('x\\|y');
    // Every row has the same number of cell separators, which is the property a
    // stray pipe breaks: the row would read as three columns against a two
    // column header and renderers drop or shift the extra.
    const bars = md
      .trim()
      .split('\n')
      // Escaped pipes are data, so they are removed before the separators are
      // counted rather than matched around.
      .map((line) => line.split('\\|').join('').split('|').length - 1);
    expect(new Set(bars).size).toBe(1);
  });

  it('flattens a line break rather than splitting the row across two lines', async () => {
    const table = build(
      '<thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>x<br>y</td><td>2</td></tr></tbody>',
    );
    const md = await tableToMarkdown(table, convert);
    expect(md.trim().split('\n')).toHaveLength(3); // header, delimiter, one body row
    expect(md).toContain('x y');
  });

  it('expands a merged cell so the columns line up', async () => {
    const table = build(
      '<thead><tr><th>H</th><th>I</th><th>J</th></tr></thead>' +
        '<tbody><tr><td colspan="2">wide</td><td>3</td></tr></tbody>',
    );
    const md = await tableToMarkdown(table, convert);
    const bars = md
      .trim()
      .split('\n')
      // Escaped pipes are data, so they are removed before the separators are
      // counted rather than matched around.
      .map((line) => line.split('\\|').join('').split('|').length - 1);
    expect(new Set(bars).size).toBe(1);
    expect(md).toContain('wide');
    expect(md).toContain('3');
  });
});
