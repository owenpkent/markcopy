// @vitest-environment node
//
// A RelativePattern's second argument is a glob, so a watched file name must
// have its metacharacters escaped or `photo[1].png` watches `photo1.png`.
import { describe, it, expect } from 'vitest';
import { escapeGlobName } from '../src/globEscape';

describe('escapeGlobName', () => {
  it('leaves an ordinary name alone', () => {
    expect(escapeGlobName('report.xlsx')).toBe('report.xlsx');
    expect(escapeGlobName('clip.review.yaml')).toBe('clip.review.yaml');
    expect(escapeGlobName('spaces and-dashes_ok.docx')).toBe('spaces and-dashes_ok.docx');
  });

  it('wraps every glob metacharacter in brackets, as VS Code documents', () => {
    expect(escapeGlobName('photo[1].png')).toBe('photo[[]1[]].png');
    expect(escapeGlobName('a*b.png')).toBe('a[*]b.png');
    expect(escapeGlobName('{x}.png')).toBe('[{]x[}].png');
    expect(escapeGlobName('q?.png')).toBe('q[?].png');
  });

  it('is idempotent on names that already contain escapes only by design', () => {
    // Escaping twice would double-wrap; callers escape exactly once.
    expect(escapeGlobName(escapeGlobName('a[1].png'))).not.toBe(escapeGlobName('a[1].png'));
  });
});
