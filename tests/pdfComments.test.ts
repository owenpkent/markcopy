import { describe, expect, it } from 'vitest';
import { parseComments, parseCommentsLenient } from '../src/pdfComments';

const comment = { id: 'c123_1', page: 1, xPct: 0.2, yPct: 1, text: 'A note' };

describe('PDF comments at the storage boundary', () => {
  it('keeps valid comments and removes unrelated fields', () => {
    expect(parseComments([{ ...comment, path: '/another-file' }])).toEqual([comment]);
    expect(parseComments([])).toEqual([]);
  });

  it.each([
    { page: 0 },
    { page: 1.2 },
    { xPct: NaN },
    { yPct: Infinity },
    { yPct: 1.01 },
    { id: 'quote"selector' },
    { id: '' },
    { text: {} },
    { text: 'x'.repeat(16_385) },
  ])('rejects invalid fields %j', (fields) => {
    expect(parseComments([{ ...comment, ...fields }])).toBeUndefined();
  });

  it('rejects duplicate IDs and excessive aggregate text', () => {
    expect(parseComments([comment, comment])).toBeUndefined();
    expect(
      parseComments(
        Array.from({ length: 17 }, (_, i) => ({
          ...comment,
          id: `c${i}`,
          text: 'x'.repeat(16_384),
        })),
      ),
    ).toBeUndefined();
  });

  it('keeps the valid entries of a partly invalid list and reports it as incomplete', () => {
    const other = { ...comment, id: 'c2' };
    expect(parseCommentsLenient([comment, { ...other, page: 0 }, other, comment])).toEqual({
      comments: [comment, other],
      complete: false,
    });
    expect(parseCommentsLenient([comment])).toEqual({ comments: [comment], complete: true });
    expect(parseCommentsLenient({})).toEqual({ comments: [], complete: false });
  });

  it('rejects excessive comment counts before walking entries', () => {
    expect(parseComments(new Array(2001))).toBeUndefined();
  });
});
