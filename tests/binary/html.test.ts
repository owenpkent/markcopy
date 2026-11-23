import { describe, expect, it } from 'vitest';
import { formatBytesShort, formatNumber, properties, table } from '../../src/binary/html';

// formatBytes itself is covered in tests/pe/render.test.ts.

describe('formatNumber', () => {
  it('groups thousands with commas whatever the machine locale', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});

describe('formatBytesShort', () => {
  it('drops the exact count in brackets', () => {
    expect(formatBytesShort(1536)).toBe('1.50 KB');
    expect(formatBytesShort(5 * 1024 ** 3)).toBe('5.00 GB');
    expect(formatBytesShort(10 * 1024)).toBe('10.0 KB');
  });

  it('keeps the plain count below 1 KB', () => {
    expect(formatBytesShort(0)).toBe('0 bytes');
    expect(formatBytesShort(1)).toBe('1 byte');
    expect(formatBytesShort(1023)).toBe('1,023 bytes');
  });
});

describe('table', () => {
  it('writes a head and a body', () => {
    expect(table(['A', 'B'], [['1', '2']])).toBe(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
  });

  it('writes an empty body for no rows', () => {
    expect(table(['A'], [])).toBe(
      '<table><thead><tr><th>A</th></tr></thead><tbody></tbody></table>',
    );
  });

  it('escapes headers and cells', () => {
    const html = table(['<img src=x onerror=1>'], [['<img src=x onerror=1>', 'a & b']]);
    expect(html).not.toContain('<img');
    expect(html).toContain('<th>&lt;img src=x onerror=1&gt;</th>');
    expect(html).toContain('<td>&lt;img src=x onerror=1&gt;</td>');
    expect(html).toContain('<td>a &amp; b</td>');
  });
});

describe('properties', () => {
  // The header is kept for the table copies and hidden by the stylesheet,
  // which finds the table by this class.
  it('is a Property and Value table, marked for the stylesheet', () => {
    expect(properties([['Name', 'curl']])).toBe(
      '<table class="mc-info-props"><thead><tr><th>Property</th><th>Value</th></tr></thead><tbody><tr><td>Name</td><td>curl</td></tr></tbody></table>',
    );
  });

  it('escapes labels and values', () => {
    const html = properties([['<b>', '<img src=x onerror=1>']]);
    expect(html).toContain('<td>&lt;b&gt;</td>');
    expect(html).toContain('<td>&lt;img src=x onerror=1&gt;</td>');
    expect(html).not.toContain('<img');
  });
});
