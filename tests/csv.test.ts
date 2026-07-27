import { describe, it, expect } from 'vitest';
import { isNumeric, parseDelimited, renderCsvHtml, sniffDelimiter } from '../src/csv';

const cellsOf = (text: string, delimiter = ','): string[][] =>
  parseDelimited(text, delimiter).records.map((r) => r.cells);

describe('parseDelimited (RFC 4180)', () => {
  it('splits plain rows and fields', () => {
    expect(cellsOf('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps the delimiter inside a quoted field', () => {
    expect(cellsOf('"a,b",c')).toEqual([['a,b', 'c']]);
  });

  it('unescapes a doubled quote', () => {
    expect(cellsOf('"say ""hi""",c')).toEqual([['say "hi"', 'c']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(cellsOf('"line1\nline2",b')).toEqual([['line1\nline2', 'b']]);
  });

  it('treats a bare quote mid-field as data', () => {
    expect(cellsOf('a"b,c')).toEqual([['a"b', 'c']]);
  });

  it('handles CRLF, LF, and a lone CR as record separators', () => {
    expect(cellsOf('a\r\nb\nc\rd')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('does not emit an empty record for a trailing newline', () => {
    expect(cellsOf('a,b\n')).toEqual([['a', 'b']]);
  });

  it('preserves empty fields', () => {
    expect(cellsOf('a,,c')).toEqual([['a', '', 'c']]);
  });

  it('skips blank lines between records', () => {
    expect(cellsOf('a,b\n\n\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('strips a UTF-8 BOM from the first field', () => {
    expect(cellsOf('﻿id,name')).toEqual([['id', 'name']]);
  });

  it('returns no records for empty input', () => {
    expect(cellsOf('')).toEqual([]);
  });

  it('parses tab-separated text', () => {
    expect(cellsOf('a\tb\nc\td', '\t')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('parseDelimited source lines', () => {
  it('records the line each row starts on', () => {
    const { records } = parseDelimited('h1,h2\na,b\nc,d', ',');
    expect(records.map((r) => r.line)).toEqual([0, 1, 2]);
  });

  it('accounts for newlines inside quoted fields', () => {
    // Row 2 starts on line 3 because row 1's quoted field spans two lines.
    const { records } = parseDelimited('h1,h2\n"multi\nline",b\nc,d', ',');
    expect(records.map((r) => r.line)).toEqual([0, 1, 3]);
  });

  it('skips over blank lines when numbering', () => {
    const { records } = parseDelimited('a\n\n\nb', ',');
    expect(records.map((r) => r.line)).toEqual([0, 3]);
  });
});

describe('parseDelimited truncation', () => {
  const text = Array.from({ length: 10 }, (_, i) => `r${i},x`).join('\n');

  it('stops building records at the cap but still counts the rest', () => {
    const { records, dropped } = parseDelimited(text, ',', 4);
    expect(records).toHaveLength(4);
    expect(dropped).toBe(6);
  });

  it('reports nothing dropped when the cap is not reached', () => {
    expect(parseDelimited(text, ',', 100).dropped).toBe(0);
  });

  it('counts records past the cap that contain quoted newlines', () => {
    const { records, dropped } = parseDelimited('a\n"x\ny"\nb', ',', 1);
    expect(records).toHaveLength(1);
    expect(dropped).toBe(2);
  });
});

describe('sniffDelimiter', () => {
  it('detects commas', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('detects tabs', () => {
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('detects semicolons', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
  });

  it('detects pipes', () => {
    expect(sniffDelimiter('a|b|c\n1|2|3')).toBe('|');
  });

  it('prefers the delimiter that yields consistent column counts', () => {
    // Commas appear more often, but only the semicolon splits every row evenly.
    expect(sniffDelimiter('a,x;b\nc;d,y,z\ne;f')).toBe(';');
  });

  it('ignores a delimiter that only appears inside quotes', () => {
    expect(sniffDelimiter('"a;b"\t c\n"d;e"\tf')).toBe('\t');
  });

  it('falls back to comma for single-column files', () => {
    expect(sniffDelimiter('alpha\nbeta\ngamma')).toBe(',');
  });

  it('falls back to comma for empty input', () => {
    expect(sniffDelimiter('')).toBe(',');
  });
});

describe('isNumeric', () => {
  it.each(['1', '-2.5', '+3', '1,234', '1,234.56', '$1,200', '-$4', '12%', '(1,234.50)', '1e3'])(
    'treats %s as numeric',
    (v) => expect(isNumeric(v)).toBe(true),
  );

  it.each(['', 'abc', '1abc', '12-34', 'N/A', '-'])('treats %s as non-numeric', (v) =>
    expect(isNumeric(v)).toBe(false),
  );
});

describe('renderCsvHtml', () => {
  const sample = 'name,qty\nWidget,3\nGadget,12';

  function render(text: string, opts = {}): Document {
    const html = renderCsvHtml(text, opts).html;
    document.body.innerHTML = html;
    return document;
  }

  it('puts the first row in a <thead> by default', () => {
    const doc = render(sample);
    expect(Array.from(doc.querySelectorAll('thead th[scope="col"]'), (e) => e.textContent)).toEqual(
      ['name', 'qty'],
    );
    expect(doc.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('renders every row as data when headerRow is off', () => {
    const doc = render(sample, { headerRow: false });
    expect(doc.querySelector('thead')).toBeNull();
    expect(doc.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('numbers the rows in a gutter marked to stay off the clipboard', () => {
    const doc = render(sample);
    const gutters = Array.from(doc.querySelectorAll('tbody .mc-csv-gutter'));
    expect(gutters.map((g) => g.textContent)).toEqual(['1', '2']);
    expect(gutters.every((g) => g.hasAttribute('data-mc-ignore'))).toBe(true);
  });

  it('emits one <col> per cell, gutter included', () => {
    const doc = render(sample);
    const cols = doc.querySelectorAll('colgroup > col');
    const cells = doc.querySelectorAll('thead tr > *');
    expect(cols).toHaveLength(3);
    expect(cols).toHaveLength(cells.length);
  });

  it('right-aligns numeric cells only', () => {
    const doc = render(sample);
    const row = doc.querySelectorAll('tbody tr')[0];
    expect(row.querySelectorAll('td')[0].className).toBe('');
    expect(row.querySelectorAll('td')[1].className).toBe('mc-csv-num');
  });

  it('maps body rows back to their source lines', () => {
    const doc = render(sample);
    expect(
      Array.from(doc.querySelectorAll('tbody tr'), (r) => r.getAttribute('data-source-line')),
    ).toEqual(['1', '2']);
  });

  it('leaves the sticky header row unmapped so scroll sync does not pin to it', () => {
    const doc = render(sample);
    expect(doc.querySelector('thead tr')?.hasAttribute('data-source-line')).toBe(false);
    expect(doc.querySelector('table')?.getAttribute('data-source-line')).toBe('0');
  });

  it('pads ragged rows out to the widest one', () => {
    const doc = render('a,b,c\n1\n2,3,4,5');
    const widths = Array.from(
      doc.querySelectorAll('tbody tr'),
      (r) => r.querySelectorAll('td').length,
    );
    expect(widths).toEqual([4, 4]);
  });

  it('escapes HTML in cell values', () => {
    const doc = render('h\n<img src=x onerror=alert(1)>');
    const cell = doc.querySelector('tbody td') as HTMLElement;
    expect(cell.querySelector('img')).toBeNull();
    expect(cell.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('escapes quotes in the header title attribute', () => {
    const doc = render('say "hi"\nx');
    expect(doc.querySelector('thead th[scope="col"]')?.getAttribute('title')).toBe('say "hi"');
  });

  it('truncates at maxRows and says how many rows are hidden', () => {
    const text = 'h\n' + Array.from({ length: 50 }, (_, i) => `r${i}`).join('\n');
    const doc = render(text, { maxRows: 10 });
    expect(doc.querySelectorAll('tbody tr')).toHaveLength(10);
    expect(doc.querySelector('.mc-csv-note')?.textContent).toContain('first 10 of 50 rows');
  });

  it('keeps the truncation notice outside the table so copies stay clean', () => {
    const doc = render('h\na\nb\nc', { maxRows: 1 });
    expect(doc.querySelector('table .mc-csv-note')).toBeNull();
    expect(doc.querySelector('.mc-csv-wrap > .mc-csv-note')).not.toBeNull();
  });

  it('does not spend the row budget on the header', () => {
    const doc = render('h\na\nb', { maxRows: 2 });
    expect(doc.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(doc.querySelector('.mc-csv-note')).toBeNull();
  });

  it('reports the detected delimiter and shape', () => {
    const result = renderCsvHtml('a\tb\n1\t2');
    expect(result.delimiter).toBe('\t');
    expect(result.rows).toBe(1);
    expect(result.columns).toBe(2);
  });

  it('honors an explicit delimiter over detection', () => {
    const result = renderCsvHtml('a;b\n1;2', { delimiter: ',' });
    expect(result.delimiter).toBe(',');
    expect(result.columns).toBe(1);
  });

  it('shows a message instead of an empty table for an empty file', () => {
    const doc = render('');
    expect(doc.querySelector('table')).toBeNull();
    expect(doc.querySelector('.mc-csv-note')?.textContent).toBe('This file is empty.');
  });
});
