// @vitest-environment node
//
// Audio Notes, the pure half: the shared sidecar code with `media: audio`, the
// clock timestamps, the Markdown and the add validator. Fixtures under
// tests/fixtures/review/audio are written by the okstudio-video-kit (see
// tests/fixtures/review/generate.py audio); CI only compares.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addNoteText,
  loadSidecar,
  markdownName,
  newAudioSidecarText,
  newImageSidecarText,
  noteYaml,
  removeNoteText,
  restoreNoteText,
  reviewFileError,
  sidecarName,
} from '../src/review/sidecar';
import { reviewMarkdown } from '../src/review/markdown';
import { secondsToClock } from '../src/review/timecode';
import { MAX_NOTE_TEXT, audioReviewAddError, isAudioReviewAdd } from '../src/review/validate';

const DIR = join(__dirname, 'fixtures', 'review', 'audio');
const fixture = (...parts: string[]) => readFileSync(join(DIR, ...parts), 'utf8');
const CREATED = '2026-01-02T03:04:05';

describe('audio sidecar names', () => {
  it('uses the whole file name, like an image and unlike a video', () => {
    expect(sidecarName('song.mp3', 'audio')).toBe('song.mp3.review.yaml');
    expect(markdownName('song.mp3', 'audio')).toBe('song.mp3.review.md');
    expect(sidecarName('a.b.FLAC', 'audio')).toBe('a.b.FLAC.review.yaml');
    expect(sidecarName('song.mp4')).toBe('song.review.yaml');
  });
});

describe('secondsToClock', () => {
  it('writes HH:MM:SS.mmm, milliseconds half up, as the kit does', () => {
    expect(secondsToClock(0)).toBe('00:00:00.000');
    expect(secondsToClock(1.5)).toBe('00:00:01.500');
    expect(secondsToClock(59.9995)).toBe('00:01:00.000');
    expect(secondsToClock(59.9994)).toBe('00:00:59.999');
    expect(secondsToClock(0.0005)).toBe('00:00:00.001');
    expect(secondsToClock(3661.25)).toBe('01:01:01.250');
    expect(secondsToClock(360000)).toBe('100:00:00.000');
    expect(secondsToClock(-3)).toBe('00:00:00.000');
  });
});

describe('audio review files', () => {
  const head = 'version: 1\nsource: s.mp3\nmedia: audio\n';
  const note = (extra = '') =>
    `${head}notes:\n- id: n1\n  target: source\n  at: 1\n  kind: note\n  done: false\n  created: x\n${extra}`;

  it('loads the kit full audio review and renders the kit markdown for it', () => {
    const loaded = loadSidecar(fixture('full.mp3.review.yaml'));
    expect(loaded.readOnly).toBeNull();
    expect(loaded.media).toBe('audio');
    expect(loaded.fps).toBeUndefined();
    expect(loaded.notes).toHaveLength(8);
    expect(loaded.notes[1]).toMatchObject({ id: 'n2', at: 72.5, out: 75, kind: 'reject' });
    expect(loaded.notes[4].done).toBe(true);
    expect(reviewMarkdown(loaded.file!)).toBe(fixture('full.mp3.review.md'));
  });

  it('loads the empty review and renders the kit markdown for it', () => {
    const loaded = loadSidecar(fixture('empty.mp3.review.yaml'));
    expect(loaded.readOnly).toBeNull();
    expect(loaded.notes).toEqual([]);
    expect(reviewMarkdown(loaded.file!)).toBe(fixture('empty.mp3.review.md'));
    expect(fixture('empty.mp3.review.yaml')).toBe(newAudioSidecarText('empty.mp3', 'dddddddddddd'));
  });

  it('writes a new sidecar like the image one, with media audio and no fps', () => {
    const text = newAudioSidecarText('song.mp3', 'abcdef012345');
    expect(text).toBe(newImageSidecarText('song.mp3', 'abcdef012345').replace('image', 'audio'));
    expect(text).toContain('source: song.mp3\nmedia: audio\nnext_note_id: 1\n');
    expect(text).not.toContain('fps');
  });

  it('puts the heading times, the meta line and the range the kit way', () => {
    const md = fixture('full.mp3.review.md');
    expect(md).toContain('audio, status in_progress, rating 2/5, keywords vocal, mix');
    expect(md).toContain('## n2  00:01:12.500 to 00:01:15.000  reject');
    expect(md).toContain('## n4  00:01:00.000  note');
    expect(md).toContain('## n6  01:01:01.250 to 01:01:40.000  note');
    expect(md).not.toMatch(/fps|Pin:|Area:/);
  });

  it('accepts an audio file with or without fps, and an empty drawing', () => {
    expect(reviewFileError({ version: 1, source: 's.mp3', media: 'audio' })).toBeNull();
    expect(reviewFileError({ version: 1, source: 's.mp3', media: 'audio', fps: 25 })).toBeNull();
    expect(reviewFileError({ version: 1, source: 's.mp3', media: 'audio', fps: 0 })).toBe(
      '"fps" must be a positive number',
    );
    expect(loadSidecar(note('  drawing: []\n')).readOnly).toBeNull();
  });

  it('enforces the kit audio rules on notes', () => {
    expect(loadSidecar(note()).readOnly).toBeNull();
    expect(loadSidecar(note('  point: [0.1, 0.2]\n')).readOnly).toBe(
      'notes[0] has "point", which an audio review does not use',
    );
    expect(loadSidecar(note('  region: [0.1, 0.2, 0.3, 0.4]\n')).readOnly).toBe(
      'notes[0] has "region", which an audio review does not use',
    );
    expect(
      loadSidecar(note('  drawing:\n  - tool: line\n    points: [[0, 0], [1, 1]]\n')).readOnly,
    ).toBe('notes[0] has a drawing, which an audio review does not use');
    expect(loadSidecar(note().replace('target: source', 'target: render')).readOnly).toBe(
      'notes[0].target must be source in an audio review',
    );
    expect(loadSidecar(note().replace('  at: 1\n', '')).readOnly).toBe('notes[0] is missing "at"');
    expect(loadSidecar(note('  out: 0.5\n')).readOnly).toBe('notes[0].out must be greater than at');
    expect(loadSidecar(note('  out: 2\n')).readOnly).toBeNull();
  });

  it('still refuses an unknown media', () => {
    expect(reviewFileError({ version: 1, source: 's', media: 'podcast' })).toBe(
      '"media" must be video, image or audio',
    );
  });
});

describe('golden audio edits against the kit', () => {
  interface Case {
    name: string;
    base: 'empty' | 'full';
    op: 'add' | 'remove';
    args: { at?: number; out?: number; text?: string; id?: string };
  }
  const cases = JSON.parse(fixture('edit', 'cases.json')) as Case[];

  it('covers add and remove, a range, a time that rounds and one over an hour', () => {
    expect(new Set(cases.map((c) => c.op))).toEqual(new Set(['add', 'remove']));
    expect(cases.some((c) => c.args.out !== undefined)).toBe(true);
    expect(cases.some((c) => c.args.at === 59.9995)).toBe(true);
    expect(cases.some((c) => (c.args.at ?? 0) > 3600)).toBe(true);
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
          { at: c.args.at!, out: c.args.out, text: c.args.text!, created: CREATED },
          file,
        ).text;
      } else {
        got = removeNoteText(before, c.args.id!)?.text ?? null;
      }
      expect(got).toBe(after);
      const loaded = loadSidecar(got!);
      expect(loaded.readOnly).toBeNull();
      expect(loaded.media).toBe('audio');
    });
  }

  it('a removed note restores to the exact bytes it left', () => {
    for (const c of cases.filter((x) => x.op === 'remove')) {
      const before = fixture('edit', `${c.name}.before.review.yaml`);
      const gone = removeNoteText(before, c.args.id!)!;
      expect(restoreNoteText(gone.text, gone.removed), c.name).toBe(before);
    }
  });

  it('writes the audio keys in the kit order: a time, no pin, an empty drawing', () => {
    const lines = noteYaml({ id: 'n1', at: 1.5, out: 3, text: 't', created: CREATED }, 'audio');
    expect(lines.split('\n').map((l) => l.split(':')[0].trim())).toEqual([
      '- id',
      'target',
      'at',
      'kind',
      'text',
      'done',
      'applied_op',
      'checkpoint',
      'drawing',
      'created',
      'out',
      '',
    ]);
    expect(lines).toContain('  drawing: []\n');
  });
});

describe('audioReviewAddError', () => {
  const ok = { type: 'reviewAdd', at: 3.5, text: 'x' };

  it('accepts a point, a range and empty text', () => {
    expect(audioReviewAddError(ok)).toBeNull();
    expect(audioReviewAddError({ ...ok, out: 4 })).toBeNull();
    expect(audioReviewAddError({ ...ok, at: 0, text: '' })).toBeNull();
    expect(isAudioReviewAdd({ ...ok, at: 100000 })).toBe(true);
  });

  it('refuses a bad time or range', () => {
    for (const bad of [
      { ...ok, at: -1 },
      { ...ok, at: Number.NaN },
      { ...ok, at: Infinity },
      { ...ok, at: '3' },
      { type: 'reviewAdd', text: 'x' },
      { ...ok, out: 3.5 },
      { ...ok, out: 2 },
      { ...ok, out: Number.NaN },
    ]) {
      expect(audioReviewAddError(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it('refuses a pin, an area, a drawing, a target and any other key', () => {
    for (const extra of [
      { point: [0.5, 0.5] },
      { region: [0, 0, 1, 1] },
      { drawing: [] },
      { target: 'render' },
      { fps: 30 },
      { color: 'red' },
    ]) {
      expect(audioReviewAddError({ ...ok, ...extra })).toMatch(/unexpected field/);
    }
  });

  it('refuses bad text and non-objects', () => {
    expect(audioReviewAddError({ ...ok, text: 5 })).toMatch(/note text/);
    expect(audioReviewAddError({ ...ok, text: 'x'.repeat(MAX_NOTE_TEXT + 1) })).toMatch(
      /note text/,
    );
    expect(audioReviewAddError({ ...ok, text: 'x'.repeat(MAX_NOTE_TEXT) })).toBeNull();
    for (const bad of [null, undefined, 3, 'x', []]) {
      expect(audioReviewAddError(bad)).toBe('That note is not valid');
    }
  });

  it('bounds by the duration only when it is known', () => {
    expect(audioReviewAddError({ ...ok, at: 90 })).toBeNull();
    expect(audioReviewAddError({ ...ok, at: 90 }, 60)).toBe(
      'That time is past the end of the audio',
    );
    expect(audioReviewAddError({ ...ok, at: 10, out: 90 }, 60)).toMatch(/past the end/);
    expect(audioReviewAddError({ ...ok, at: 60 }, 60)).toBeNull();
    expect(audioReviewAddError({ ...ok, at: 90 }, 0)).toBeNull();
  });
});
