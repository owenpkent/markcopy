import { describe, expect, it } from 'vitest';
import {
  MAX_CELL_COLSPAN,
  MAX_CELL_ROWSPAN,
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  spanAttr,
  tableTooLarge,
} from '../src/ooxml/tableLimits';

describe('spanAttr', () => {
  it('reads a plain positive integer', () => {
    expect(spanAttr('1', 1000)).toBe(1);
    expect(spanAttr('7', 1000)).toBe(7);
    expect(spanAttr(' 3 ', 1000)).toBe(3);
  });

  it('means 1 for anything that is not one, as the HTML parser does', () => {
    for (const bad of [undefined, '', '0', '-1', '+2', '1e3', '2.5', 'abc', 'NaN', 'Infinity']) {
      expect(spanAttr(bad, 1000)).toBe(1);
    }
  });

  it('clamps to the maximum rather than rejecting', () => {
    expect(spanAttr('10000', MAX_CELL_COLSPAN)).toBe(MAX_CELL_COLSPAN);
    expect(spanAttr('999999999', MAX_CELL_ROWSPAN)).toBe(MAX_CELL_ROWSPAN);
  });

  it('never produces an unsafe number from a long digit string', () => {
    // Ten or more digits are rejected before parseInt, so a value that would
    // round in floating point never becomes a loop bound.
    expect(spanAttr('99999999999999999999', MAX_CELL_COLSPAN)).toBe(1);
    expect(spanAttr('1'.repeat(400), MAX_CELL_COLSPAN)).toBe(1);
  });
});

describe('tableTooLarge', () => {
  it('passes a grid within both limits', () => {
    expect(tableTooLarge(1, 1)).toBeUndefined();
    expect(tableTooLarge(MAX_TABLE_COLUMNS, 1)).toBeUndefined();
    expect(tableTooLarge(50, MAX_TABLE_CELLS / 50)).toBeUndefined();
  });

  it('names the column limit when the grid is too wide', () => {
    expect(tableTooLarge(MAX_TABLE_COLUMNS + 1, 1)).toMatch(/columns is more than the 1,000/);
  });

  it('names the cell budget when the grid is too big overall', () => {
    expect(tableTooLarge(100, MAX_TABLE_CELLS / 100 + 1)).toMatch(/cells this export can write/);
  });
});
