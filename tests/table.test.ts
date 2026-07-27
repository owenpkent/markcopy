import { describe, it, expect } from 'vitest';
import { escapeField, tableToDelimited } from '../src/webview/table';

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
});
