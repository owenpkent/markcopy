import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { reviewMarkdown } from '../src/review/markdown';
import type { ReviewFile } from '../src/review/schema';

// Fixtures are written by tests/fixtures/review/generate.py with the kit; CI only compares.
const dir = join(__dirname, 'fixtures', 'review');

describe('reviewMarkdown', () => {
  it.each(['minimal', 'full'])('matches the kit export for %s byte for byte', (name) => {
    const file = parse(readFileSync(join(dir, `${name}.review.yaml`), 'utf8')) as ReviewFile;
    const expected = readFileSync(join(dir, `${name}.review.md`), 'utf8');
    expect(reviewMarkdown(file)).toBe(expected);
  });

  it('renders an empty file as a header and status line', () => {
    expect(reviewMarkdown({ version: 1, source: 'a.mp4', fps: 25 })).toBe(
      '# Review notes: a.mp4\n\nfps 25, status none\n',
    );
  });
});
