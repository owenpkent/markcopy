// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parsePdfMessage } from '../src/messages/pdf';
import { parseTexMessage } from '../src/messages/tex';
import {
  MAX_POSITIONS,
  POSITIONS_KEY,
  findPosition,
  isReset,
  savePosition,
  validatePosition,
  type PositionMemento,
} from '../src/pdfPosition';

function memento(initial?: unknown): PositionMemento & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  if (initial !== undefined) {
    data.set(POSITIONS_KEY, initial);
  }
  return {
    data,
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key, value) => {
      data.set(key, value);
    },
  };
}

const at = (page: number, extra = {}) => ({ page, y: 0.4, zoom: 1.5, fitWidth: false, ...extra });

describe('validatePosition', () => {
  it('accepts a well-formed position', () => {
    expect(validatePosition(at(7))).toEqual(at(7));
  });

  it('rejects bad pages, fractions, zooms and flags', () => {
    for (const bad of [
      at(0),
      at(-1),
      at(1.5),
      at(NaN),
      at(2_000_000),
      at(3, { y: -0.1 }),
      at(3, { y: 1.1 }),
      at(3, { y: Infinity }),
      at(3, { zoom: 0.1 }),
      at(3, { zoom: 40 }),
      at(3, { zoom: NaN }),
      at(3, { fitWidth: 1 }),
      at(3, { page: '3' }),
      null,
      [],
      'x',
    ]) {
      expect(validatePosition(bad)).toBeUndefined();
    }
  });
});

describe('isReset', () => {
  it('is the top of page 1 at 100 percent, not fit width', () => {
    expect(isReset({ page: 1, y: 0, zoom: 1, fitWidth: false })).toBe(true);
    expect(isReset({ page: 1, y: 0.5, zoom: 1, fitWidth: false })).toBe(false);
    expect(isReset({ page: 1, y: 0, zoom: 2, fitWidth: false })).toBe(false);
    expect(isReset({ page: 1, y: 0, zoom: 1, fitWidth: true })).toBe(false);
    expect(isReset({ page: 2, y: 0, zoom: 1, fitWidth: false })).toBe(false);
  });
});

describe('savePosition and findPosition', () => {
  it('round-trips a position by key', async () => {
    const m = memento();
    await savePosition(m, 'file:///a.pdf', at(4));
    expect(findPosition(m, 'file:///a.pdf')).toEqual(at(4));
    expect(findPosition(m, 'file:///b.pdf')).toBeUndefined();
  });

  it('deletes the entry when the reader is back at the top at the default zoom', async () => {
    const m = memento();
    await savePosition(m, 'k', at(4));
    await savePosition(m, 'k', { page: 1, y: 0, zoom: 1, fitWidth: false });
    expect(findPosition(m, 'k')).toBeUndefined();
  });

  it('writes nothing for an invalid position or key', async () => {
    const m = memento();
    await savePosition(m, 'k', at(0));
    await savePosition(m, '', at(2));
    await savePosition(m, 'x'.repeat(5000), at(2));
    await savePosition(m, 'k', { page: 1, y: 0, zoom: 1, fitWidth: false });
    expect(m.data.size).toBe(0);
  });

  it('keeps the most recently written MAX_POSITIONS entries', async () => {
    const m = memento();
    for (let i = 0; i < MAX_POSITIONS + 5; i++) {
      await savePosition(m, `k${i}`, at(2), 1000 + i);
    }
    // Touch the oldest survivor so it outlives a newer one.
    await savePosition(m, 'k5', at(3), 9000);
    await savePosition(m, 'new', at(2), 9001);
    const stored = m.data.get(POSITIONS_KEY) as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(MAX_POSITIONS);
    expect(findPosition(m, 'k0')).toBeUndefined();
    expect(findPosition(m, 'k5')).toEqual(at(3));
    expect(findPosition(m, 'k6')).toBeUndefined();
    expect(findPosition(m, 'new')).toEqual(at(2));
  });

  it('drops bad stored entries without losing good ones, and survives a bad root', () => {
    const good = { ...at(5), at: 1 };
    const m = memento({
      good,
      badPage: { ...at(5), page: 0, at: 1 },
      badZoom: { ...at(5), zoom: 1e9, at: 1 },
      noTime: at(5),
      junk: 'x',
      nothing: null,
    });
    expect(findPosition(m, 'good')).toEqual(at(5));
    for (const key of ['badPage', 'badZoom', 'noTime', 'junk', 'nothing']) {
      expect(findPosition(m, key)).toBeUndefined();
    }
    for (const root of ['nope', 5, [], null]) {
      expect(findPosition(memento(root), 'good')).toBeUndefined();
    }
  });
});

describe('savePosition message', () => {
  it('is accepted by the PDF parser with exactly the validated fields', () => {
    expect(parsePdfMessage({ type: 'savePosition', ...at(3), extra: 'x' })).toEqual({
      type: 'savePosition',
      ...at(3),
    });
  });

  it('is rejected when any field is invalid', () => {
    expect(parsePdfMessage({ type: 'savePosition', ...at(3, { y: 2 }) })).toBeUndefined();
    expect(parsePdfMessage({ type: 'savePosition', page: 3 })).toBeUndefined();
    expect(parsePdfMessage({ type: 'savePosition', ...at(3, { zoom: 99 }) })).toBeUndefined();
  });

  it('is not something the LaTeX preview acts on', () => {
    expect(parseTexMessage({ type: 'savePosition', ...at(3) })).toBeUndefined();
  });
});
