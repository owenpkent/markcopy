import { describe, it, expect } from 'vitest';
import { planBlockEdit, EOL_CRLF, EOL_LF, MAX_BLOCK_EDIT_CHARS } from '../src/blockEdit';

function apply(doc: string, plan: ReturnType<typeof planBlockEdit>): string {
  if (!plan.ok) throw new Error('plan refused');
  return doc.slice(0, plan.start) + plan.text + doc.slice(plan.end);
}

describe('planBlockEdit', () => {
  const doc = 'a\nb\n\nc\nd';

  it('replaces the lines [start, end) and keeps the line break after them', () => {
    const plan = planBlockEdit(doc, EOL_LF, {
      startLine: 0,
      endLine: 2,
      original: 'a\nb',
      text: 'x',
    });
    expect(apply(doc, plan)).toBe('x\n\nc\nd');
  });

  it('handles the last line when the document has no trailing newline', () => {
    const plan = planBlockEdit(doc, EOL_LF, {
      startLine: 3,
      endLine: 5,
      original: 'c\nd',
      text: 'c\nd\ne',
    });
    expect(apply(doc, plan)).toBe('a\nb\n\nc\nd\ne');
  });

  it('keeps a trailing newline in place', () => {
    const withNl = 'a\nb\n';
    const plan = planBlockEdit(withNl, EOL_LF, {
      startLine: 1,
      endLine: 2,
      original: 'b',
      text: 'B',
    });
    expect(apply(withNl, plan)).toBe('a\nB\n');
  });

  it('writes the document EOL into a CRLF document', () => {
    const crlf = 'a\r\nb\r\n\r\nc';
    const plan = planBlockEdit(crlf, EOL_CRLF, {
      startLine: 0,
      endLine: 2,
      original: 'a\nb',
      text: 'x\ny\nz',
    });
    expect(apply(crlf, plan)).toBe('x\r\ny\r\nz\r\n\r\nc');
  });

  it('refuses when the document no longer matches the original', () => {
    const plan = planBlockEdit(doc, EOL_LF, {
      startLine: 0,
      endLine: 2,
      original: 'a\nCHANGED',
      text: 'x',
    });
    expect(plan).toEqual({ ok: false, reason: 'stale' });
  });

  it('rejects out-of-range and malformed requests', () => {
    const base = { startLine: 0, endLine: 1, original: 'a', text: 't' };
    const bad = (over: object) => planBlockEdit(doc, EOL_LF, { ...base, ...over });
    expect(bad({ startLine: -1 })).toEqual({ ok: false, reason: 'invalid' });
    expect(bad({ startLine: 2, endLine: 2 })).toEqual({ ok: false, reason: 'invalid' });
    expect(bad({ endLine: 6 })).toEqual({ ok: false, reason: 'invalid' });
    expect(bad({ startLine: 0.5 })).toEqual({ ok: false, reason: 'invalid' });
    expect(bad({ endLine: '1' })).toEqual({ ok: false, reason: 'invalid' });
    expect(bad({ original: 1 })).toEqual({ ok: false, reason: 'invalid' });
    expect(bad({ text: undefined })).toEqual({ ok: false, reason: 'invalid' });
    expect(bad({ text: 'x'.repeat(MAX_BLOCK_EDIT_CHARS + 1) })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('accepts the final line of a document', () => {
    expect(
      planBlockEdit(doc, EOL_LF, { startLine: 4, endLine: 5, original: 'd', text: 'D' }).ok,
    ).toBe(true);
  });
});
