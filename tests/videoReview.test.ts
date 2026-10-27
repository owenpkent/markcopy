// @vitest-environment node
//
// The pure half of src/videoReview.ts: sidecar naming, validation and fps
// resolution. vscode is mocked only so the module can be imported.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('vscode', () => ({}));

import {
  addNoteText,
  cleanPoint,
  copyToast,
  isReviewAdd,
  isReviewDelete,
  isReviewRestore,
  isReviewSetDone,
  loadSidecar,
  localTimestamp,
  markdownName,
  newSidecarText,
  nextNoteNumber,
  pyFloat,
  removeNoteText,
  resolveFps,
  restoreNoteText,
  reviewAddError,
  reviewStem,
  setDoneText,
  sidecarName,
  MAX_NOTE_TEXT,
} from '../src/videoReview';
import { reviewMarkdown } from '../src/review/markdown';

const FIXTURES = join(__dirname, 'fixtures', 'review');

const BASE = `version: 1
source: clip.mp4
fps: 30
notes:
  - id: n1
    target: source
    at: 1
    kind: note
    done: false
    created: '2026-01-02T03:04:05'
`;

describe('sidecar path', () => {
  it('drops only the last extension, as the kit does', () => {
    expect(sidecarName('clip.mp4')).toBe('clip.review.yaml');
    expect(sidecarName('a.b.mov')).toBe('a.b.review.yaml');
    expect(sidecarName('noext')).toBe('noext.review.yaml');
    expect(sidecarName('.hidden')).toBe('.hidden.review.yaml');
    expect(markdownName('clip.mp4')).toBe('clip.review.md');
    expect(reviewStem('a.')).toBe('a.');
  });
});

describe('loadSidecar', () => {
  it('accepts every fixture and renders the kit markdown for it', () => {
    const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.review.yaml'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const loaded = loadSidecar(readFileSync(join(FIXTURES, name), 'utf8'));
      expect(loaded.readOnly, name).toBeNull();
      expect(loaded.file, name).toBeDefined();
      const md = readFileSync(join(FIXTURES, name.replace('.yaml', '.md')), 'utf8');
      expect(reviewMarkdown(loaded.file!), name).toBe(md);
    }
  });

  it('maps notes to what the webview shows', () => {
    const loaded = loadSidecar(BASE.replace('at: 1', 'at: 1\n    out: 2\n    text: Hi'));
    expect(loaded.notes).toEqual([
      {
        id: 'n1',
        at: 1,
        out: 2,
        text: 'Hi',
        kind: 'note',
        done: false,
        created: '2026-01-02T03:04:05',
      },
    ]);
    expect(loaded.fps).toBe(30);
  });

  it('rejects an extra field at the top level, in a note, and in the asset', () => {
    expect(loadSidecar(`${BASE}extra: 1\n`).readOnly).toMatch(/Unknown field "extra"/);
    expect(loadSidecar(BASE.replace('kind: note', 'kind: note\n    bogus: 1')).readOnly).toMatch(
      /unknown field "bogus"/,
    );
    expect(loadSidecar(`${BASE}asset:\n  mood: sad\n`).readOnly).toMatch(/asset/);
  });

  it('rejects out at or before at, and still lists the notes', () => {
    for (const out of ['1', '0.5']) {
      const loaded = loadSidecar(BASE.replace('at: 1', `at: 1\n    out: ${out}`));
      expect(loaded.file).toBeUndefined();
      expect(loaded.readOnly).toMatch(/greater than at/);
      expect(loaded.notes.map((n) => n.id)).toEqual(['n1']);
    }
  });

  it('allows keep and reject only with target source', () => {
    const keep = BASE.replace('kind: note', 'kind: keep');
    expect(loadSidecar(keep).readOnly).toBeNull();
    expect(loadSidecar(keep.replace('target: source', 'target: render')).readOnly).toMatch(
      /target source/,
    );
    expect(loadSidecar(BASE.replace('target: source', 'target: render')).readOnly).toBeNull();
  });

  it('opens version 2 read-only with its notes', () => {
    const loaded = loadSidecar(BASE.replace('version: 1', 'version: 2'));
    expect(loaded.readOnly).toMatch(/Version 2/);
    expect(loaded.file).toBeUndefined();
    expect(loaded.notes).toHaveLength(1);
    expect(loaded.fps).toBe(30);
  });

  it('opens malformed YAML read-only with no notes', () => {
    const loaded = loadSidecar('version: 1\nnotes: [unclosed\n  - : :');
    expect(loaded.readOnly).toMatch(/^Not valid YAML/);
    expect(loaded.notes).toEqual([]);
    expect(loadSidecar('').readOnly).toBeTruthy();
    expect(loadSidecar('- a\n- b\n').readOnly).toBeTruthy();
  });

  it('checks required fields and types', () => {
    expect(loadSidecar('version: 1\nfps: 30\n').readOnly).toMatch(/source/);
    expect(loadSidecar('version: 1\nsource: a.mp4\nfps: 0\n').readOnly).toMatch(/fps/);
    expect(loadSidecar(BASE.replace('done: false', 'done: "no"')).readOnly).toMatch(/done/);
    expect(loadSidecar(BASE.replace("created: '2026-01-02T03:04:05'", '')).readOnly).toMatch(
      /created/,
    );
    expect(loadSidecar(BASE.replace('at: 1', 'at: -1')).readOnly).toMatch(/at/);
  });
});

describe('resolveFps', () => {
  it('prefers the sidecar, then the probe, then 30', () => {
    expect(resolveFps(24, 29.97)).toEqual({ fps: 24, fpsSource: 'sidecar' });
    expect(resolveFps(undefined, 29.97)).toEqual({ fps: 29.97, fpsSource: 'probe' });
    expect(resolveFps(undefined, 0)).toEqual({ fps: 30, fpsSource: 'assumed' });
    expect(resolveFps(undefined, undefined)).toEqual({ fps: 30, fpsSource: 'pending' });
  });
});

describe('copyToast', () => {
  it('counts the notes', () => {
    expect(copyToast(3, 'clip.review.md')).toBe('Copied 3 notes, saved clip.review.md');
    expect(copyToast(1, 'clip.review.md')).toBe('Copied 1 note, saved clip.review.md');
  });
});

/** The text of a fixture under tests/fixtures/review. */
const fixture = (...parts: string[]) => readFileSync(join(FIXTURES, ...parts), 'utf8');
const CREATED = '2026-01-02T03:04:05';
const crlf = (s: string) => s.replace(/\n/g, '\r\n');

describe('golden edits against the kit', () => {
  interface Case {
    name: string;
    op: 'add' | 'done' | 'remove';
    args: {
      at?: number;
      out?: number;
      text?: string;
      id?: string;
      done?: boolean;
      point?: [number, number];
    };
  }
  const cases = JSON.parse(fixture('edit', 'cases.json')) as Case[];

  it('covers add, done and remove', () => {
    expect(new Set(cases.map((c) => c.op))).toEqual(new Set(['add', 'done', 'remove']));
  });

  for (const c of cases) {
    it(`${c.name}: the same bytes as the kit`, () => {
      const before = fixture('edit', `${c.name}.before.review.yaml`);
      const after = fixture('edit', `${c.name}.after.review.yaml`);
      let got: string | null;
      if (c.op === 'add') {
        const file = loadSidecar(before).file!;
        got = addNoteText(
          before,
          {
            at: c.args.at!,
            out: c.args.out,
            text: c.args.text!,
            point: c.args.point,
            created: CREATED,
          },
          file,
        ).text;
      } else if (c.op === 'done') {
        got = setDoneText(before, c.args.id!, c.args.done!);
      } else {
        got = removeNoteText(before, c.args.id!)?.text ?? null;
      }
      expect(got).toBe(after);
      // The result is a valid sidecar again.
      expect(loadSidecar(got!).readOnly).toBeNull();
    });
  }

  it('a removed note restores to the exact bytes it left', () => {
    for (const c of cases.filter((x) => x.op === 'remove')) {
      const before = fixture('edit', `${c.name}.before.review.yaml`);
      const gone = removeNoteText(before, c.args.id!)!;
      expect(restoreNoteText(gone.text, gone.removed), c.name).toBe(before);
    }
  });
});

describe('pins', () => {
  const pinned = (name: string) => {
    const file = loadSidecar(fixture('edit', `${name}.after.review.yaml`));
    return file.notes.at(-1)!;
  };

  it('writes the kit cleaned point, 4 decimals, in flow style', () => {
    expect(pinned('add-pin-clean').point).toEqual([0.1235, 1]);
    expect(fixture('edit', 'add-pin-edges.after.review.yaml')).toContain('  point: [0.0, 1.0]\n');
    expect(fixture('edit', 'add-pin-to-full.after.review.yaml')).toContain(
      '  point: [0.0001, 0.3333]\n',
    );
    expect(fixture('edit', 'add-pin-range.after.review.yaml')).toContain(
      '  out: 9.25\n  point: [0.5, 0.75]\n',
    );
  });

  it('passes a pin through to the page, also from a file that failed validation', () => {
    expect(pinned('add-pin').point).toEqual([0.42, 0.3]);
    const text = `version: 1
fps: 25
notes:
  - {id: n1, at: 1, text: a, point: [0.1, 0.2]}
  - {id: n2, at: 2, text: b, point: [2, 0.2]}
  - {id: n3, at: 3, text: c, point: [0.5]}
`;
    const loaded = loadSidecar(text);
    expect(loaded.readOnly).not.toBeNull();
    expect(loaded.notes.map((n) => n.point)).toEqual([[0.1, 0.2], undefined, undefined]);
  });

  it('markdown for a note MarkCopy pinned carries the Pin line', () => {
    const before = fixture('edit', 'add-pin.before.review.yaml');
    const next = addNoteText(
      before,
      { at: 2.5, text: 'Logo here.', point: [0.42, 0.3], created: CREATED },
      loadSidecar(before).file!,
    ).text;
    const md = reviewMarkdown(loadSidecar(next).file!);
    expect(md).toContain(
      '## n3  00:00:02:15  note\n\nPin: 42% from left, 30% from top\n\nLogo here.',
    );
  });

  it('refuses a bad pin and accepts a good one', () => {
    const bounds = { durationSec: 10, fps: 25 };
    const base = { type: 'reviewAdd', at: 1, text: 'x' };
    const bad = (point: unknown) => reviewAddError({ ...base, point }, bounds);
    expect(reviewAddError({ ...base, point: [0, 1] }, bounds)).toBeNull();
    expect(reviewAddError({ ...base, point: undefined }, bounds)).toBeNull();
    for (const point of [
      null,
      [],
      [0.5],
      [0.1, 0.2, 0.3],
      [-0.01, 0.5],
      [0.5, 1.01],
      [Number.NaN, 0.5],
      [0.5, Infinity],
      ['0.5', '0.5'],
      '0.5,0.5',
      { 0: 0.5, 1: 0.5 },
    ]) {
      expect(bad(point), JSON.stringify(point)).toMatch(/pin must be two numbers from 0 to 1/);
    }
  });
});

describe('new sidecar', () => {
  it('is what the kit writes for Review.new', () => {
    const text = newSidecarText('empty.mp4', 30, 'dddddddddddd');
    expect(text).toBe(fixture('edit', 'add-first.before.review.yaml'));
    expect(text).toContain('fps: 30.0\n');
    expect(text).toContain('notes: []\n');
  });

  it('quotes an all-digit id and a source that would read as another type', () => {
    expect(newSidecarText('clip.mp4', 25, '123456789012')).toContain("id: '123456789012'\n");
    const loaded = loadSidecar(newSidecarText('yes', 25, 'abcdef012345'));
    expect(loaded.file?.source).toBe('yes');
  });
});

describe('id allocation', () => {
  const noMark = `version: 1
source: clip.mp4
fps: 30.0
notes:
- id: n1
  target: source
  at: 1.0
  kind: note
  done: false
  created: '${CREATED}'
- id: n5
  target: source
  at: 2.0
  kind: note
  done: false
  created: '${CREATED}'
`;

  it('starts one past the highest id when next_note_id is missing', () => {
    const file = loadSidecar(noMark).file!;
    expect(nextNoteNumber(file)).toBe(6);
    const next = addNoteText(noMark, { at: 3, text: 'x', created: CREATED }, file);
    expect(next.id).toBe('n6');
    // The key lands at the end, where the kit's dict puts a key it had to create.
    expect(next.text.endsWith('next_note_id: 7\n')).toBe(true);
    expect(loadSidecar(next.text).readOnly).toBeNull();
  });

  it('keeps the mark when it is higher than the ids present', () => {
    const marked = noMark.replace('notes:', 'next_note_id: 9\nnotes:');
    const file = loadSidecar(marked).file!;
    expect(nextNoteNumber(file)).toBe(9);
    const next = addNoteText(marked, { at: 3, text: 'x', created: CREATED }, file);
    expect(next.id).toBe('n9');
    expect(next.text).toContain('next_note_id: 10\n');
  });

  it('ignores ids that are not n<k>', () => {
    const odd = noMark.replace('id: n5', 'id: custom');
    expect(nextNoteNumber(loadSidecar(odd).file!)).toBe(2);
  });
});

describe('edits that must not disturb the file', () => {
  it('adds with the line ends the file already has', () => {
    const before = crlf(fixture('edit', 'add-point.before.review.yaml'));
    const file = loadSidecar(before).file!;
    const next = addNoteText(before, { at: 2.5, text: 'Cut on the beat.', created: CREATED }, file);
    expect(next.text).toBe(crlf(fixture('edit', 'add-point.after.review.yaml')));
  });

  it('deletes and flips in a CRLF file', () => {
    const three = crlf(fixture('edit', 'remove-middle.before.review.yaml'));
    expect(removeNoteText(three, 'n2')!.text).toBe(
      crlf(fixture('edit', 'remove-middle.after.review.yaml')),
    );
    const doneBefore = crlf(fixture('edit', 'done-true.before.review.yaml'));
    expect(setDoneText(doneBefore, 'n1', true)).toBe(
      crlf(fixture('edit', 'done-true.after.review.yaml')),
    );
  });

  it('keeps comments and an indented list', () => {
    const text = `# hand notes
version: 1
source: clip.mp4
fps: 25
notes:
  - id: n1 # first
    target: source
    at: 1
    kind: note
    done: false
    created: '${CREATED}'
`;
    const added = addNoteText(
      text,
      { at: 2, text: 'b', created: CREATED },
      loadSidecar(text).file!,
    );
    expect(added.text.startsWith('# hand notes\n')).toBe(true);
    expect(added.text).toContain('  - id: n1 # first\n');
    expect(added.text).toContain('  - id: n2\n    target: source\n    at: 2.0\n');
    expect(loadSidecar(added.text).readOnly).toBeNull();
    expect(setDoneText(text, 'n1', true)).toBe(text.replace('done: false', 'done: true'));
  });

  it('returns null for an id that is not there', () => {
    const before = fixture('edit', 'done-true.before.review.yaml');
    expect(setDoneText(before, 'n99', true)).toBeNull();
    expect(removeNoteText(before, 'n99')).toBeNull();
  });

  it('restores at the old index, clamped, without touching next_note_id', () => {
    const before = fixture('edit', 'remove-first.before.review.yaml');
    const gone = removeNoteText(before, 'n3')!;
    expect(gone.removed).toMatchObject({ id: 'n3', index: 2 });
    // The list shrank meanwhile: index 2 is clamped to the end.
    const shorter = removeNoteText(gone.text, 'n1')!.text;
    const back = restoreNoteText(shorter, gone.removed);
    expect(loadSidecar(back).notes.map((n) => n.id)).toEqual(['n2', 'n3']);
    expect(back).toContain('next_note_id: 4\n');
    // The first note goes back to the front.
    const first = removeNoteText(before, 'n1')!;
    expect(loadSidecar(restoreNoteText(first.text, first.removed)).notes[0].id).toBe('n1');
  });

  it('refuses a flow-style list of notes rather than guess', () => {
    const flow = `version: 1\nsource: c.mp4\nfps: 25\nnotes: [{id: n1, target: source, at: 1, kind: note, done: false, created: '${CREATED}'}]\n`;
    const file = loadSidecar(flow).file!;
    expect(() => addNoteText(flow, { at: 2, text: 'x', created: CREATED }, file)).toThrow(
      /cannot edit safely/,
    );
  });
});

describe('PyYAML number and time formats', () => {
  it('always gives a float a fraction, and uses Python exponent form', () => {
    expect(pyFloat(2)).toBe('2.0');
    expect(pyFloat(0)).toBe('0.0');
    expect(pyFloat(2.5)).toBe('2.5');
    expect(pyFloat(29.97)).toBe('29.97');
    expect(pyFloat(100000)).toBe('100000.0');
    expect(pyFloat(0.0001)).toBe('0.0001');
    expect(pyFloat(0.00005)).toBe('5.0e-05');
    expect(pyFloat(1.5e-7)).toBe('1.5e-07');
    expect(pyFloat(1e16)).toBe('1.0e+16');
  });

  it('writes the local time without a zone', () => {
    expect(localTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02T03:04:05');
    expect(localTimestamp(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31T23:59:59');
  });

  it('quotes the created timestamp, so Python does not read it as a datetime', () => {
    const before = fixture('edit', 'add-point.before.review.yaml');
    const next = addNoteText(
      before,
      { at: 1, text: 'x', created: CREATED },
      loadSidecar(before).file!,
    );
    expect(next.text).toContain(`created: '${CREATED}'\n`);
  });
});

describe('edit validators', () => {
  const bounds = { durationSec: 10, fps: 25 };

  it('accepts a point and a range note', () => {
    expect(isReviewAdd({ type: 'reviewAdd', at: 1, text: 'x' }, bounds)).toBe(true);
    expect(isReviewAdd({ type: 'reviewAdd', at: 1, out: 2, text: '' }, bounds)).toBe(true);
    // An explicit undefined survives structured clone and means no out.
    expect(isReviewAdd({ type: 'reviewAdd', at: 0, out: undefined, text: 'x' }, bounds)).toBe(true);
  });

  it('rejects extra fields, non-finite and negative times, and a bad range', () => {
    const base = { type: 'reviewAdd', at: 1, text: 'x' };
    expect(isReviewAdd({ ...base, color: 'red' }, bounds)).toBe(false);
    expect(isReviewAdd({ ...base, at: -0.1 }, bounds)).toBe(false);
    expect(isReviewAdd({ ...base, at: Number.NaN }, bounds)).toBe(false);
    expect(isReviewAdd({ ...base, at: Infinity }, bounds)).toBe(false);
    expect(isReviewAdd({ ...base, at: '1' }, bounds)).toBe(false);
    expect(isReviewAdd({ ...base, out: 1 }, bounds)).toBe(false);
    expect(isReviewAdd({ ...base, out: 0.5 }, bounds)).toBe(false);
    expect(isReviewAdd({ ...base, out: Infinity }, bounds)).toBe(false);
    expect(isReviewAdd({ ...base, out: null }, bounds)).toBe(false);
    expect(isReviewAdd(null, bounds)).toBe(false);
    expect(isReviewAdd([], bounds)).toBe(false);
  });

  it('limits the text to 10,000 characters and requires a string', () => {
    const base = { type: 'reviewAdd', at: 1 };
    expect(isReviewAdd({ ...base, text: 'x'.repeat(MAX_NOTE_TEXT) }, bounds)).toBe(true);
    expect(reviewAddError({ ...base, text: 'x'.repeat(MAX_NOTE_TEXT + 1) }, bounds)).toMatch(
      /10,000/,
    );
    expect(isReviewAdd({ ...base, text: 5 }, bounds)).toBe(false);
    expect(isReviewAdd(base, bounds)).toBe(false);
  });

  it('keeps times within the duration plus one frame, when a duration is known', () => {
    const base = { type: 'reviewAdd', text: 'x' };
    expect(isReviewAdd({ ...base, at: 10.04 }, bounds)).toBe(true);
    expect(isReviewAdd({ ...base, at: 10.05 }, bounds)).toBe(false);
    expect(isReviewAdd({ ...base, at: 1, out: 10.05 }, bounds)).toBe(false);
    expect(isReviewAdd({ ...base, at: 1e6 }, { fps: 25 })).toBe(true);
    expect(isReviewAdd({ ...base, at: 1e6 }, { durationSec: 0, fps: 25 })).toBe(true);
  });

  it('checks ids against the notes and refuses extra fields', () => {
    const ids = ['n1', 'n2'];
    expect(isReviewSetDone({ type: 'reviewSetDone', id: 'n1', done: true }, ids)).toBe(true);
    expect(isReviewSetDone({ type: 'reviewSetDone', id: 'n9', done: true }, ids)).toBe(false);
    expect(isReviewSetDone({ type: 'reviewSetDone', id: 'n1', done: 'yes' }, ids)).toBe(false);
    expect(isReviewSetDone({ type: 'reviewSetDone', id: 'n1', done: true, x: 1 }, ids)).toBe(false);
    expect(isReviewSetDone({ type: 'reviewSetDone', id: 1, done: true }, ids)).toBe(false);
    expect(isReviewDelete({ type: 'reviewDelete', id: 'n2' }, ids)).toBe(true);
    expect(isReviewDelete({ type: 'reviewDelete', id: 'n3' }, ids)).toBe(false);
    expect(isReviewDelete({ type: 'reviewDelete', id: 'n2', force: true }, ids)).toBe(false);
    expect(isReviewDelete({ type: 'reviewDelete', id: ['n2'] }, ids)).toBe(false);
  });

  it('accepts a restore with no fields only', () => {
    expect(isReviewRestore({ type: 'reviewRestore' })).toBe(true);
    expect(isReviewRestore({ type: 'reviewRestore', id: 'n1' })).toBe(false);
    expect(isReviewRestore(undefined)).toBe(false);
  });
});

describe('cleanPoint', () => {
  // Expected values are Python's own round(v, 4), run against the kit's interpreter.
  it.each([
    [0.03125, 0.0312],
    [0.15625, 0.1562],
    [0.96875, 0.9688],
    [0.00005, 0.0001],
    [0.00015, 0.0001],
    [0.12345, 0.1235],
    [0.99995, 1],
    [0.5, 0.5],
    [0, 0],
    [1, 1],
  ])('rounds %d as Python does', (v, expected) => {
    expect(cleanPoint(v)).toBe(expected);
  });
});
