// @vitest-environment node
//
// Image Notes, the pure half: the shared sidecar code with `media: image` and
// `region`, the Markdown, and the add validator. Fixtures under
// tests/fixtures/review/image are written by the okstudio-video-kit (see
// tests/fixtures/review/generate.py image); CI only compares.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addNoteText,
  cleanRegion,
  loadSidecar,
  markdownName,
  newImageSidecarText,
  newSidecarText,
  noteYaml,
  removeNoteText,
  reviewFileError,
  restoreNoteText,
  sidecarName,
} from '../src/review/sidecar';
import { reviewMarkdown } from '../src/review/markdown';
import {
  MAX_NOTE_TEXT,
  imageReviewAddError,
  isImageReviewAdd,
  isRegion,
} from '../src/review/validate';

const DIR = join(__dirname, 'fixtures', 'review', 'image');
const fixture = (...parts: string[]) => readFileSync(join(DIR, ...parts), 'utf8');
const CREATED = '2026-01-02T03:04:05';

describe('image sidecar names', () => {
  it('uses the whole file name, unlike a video', () => {
    expect(sidecarName('photo.png', 'image')).toBe('photo.png.review.yaml');
    expect(markdownName('photo.png', 'image')).toBe('photo.png.review.md');
    expect(sidecarName('a.b.jpeg', 'image')).toBe('a.b.jpeg.review.yaml');
    expect(sidecarName('clip.mp4')).toBe('clip.review.yaml');
    expect(markdownName('clip.mp4', 'video')).toBe('clip.review.md');
  });
});

describe('image review files', () => {
  const imageFile = (extra = '', note = '') =>
    `version: 1\nsource: p.png\nmedia: image\n${extra}notes:\n- id: n1\n  target: source\n  kind: note\n  done: false\n  created: x\n${note}`;

  it('loads the kit full image review', () => {
    const loaded = loadSidecar(fixture('full.png.review.yaml'));
    expect(loaded.readOnly).toBeNull();
    expect(loaded.media).toBe('image');
    expect(loaded.fps).toBeUndefined();
    expect(loaded.notes).toEqual([
      { id: 'n1', text: 'Whole picture is too warm.', kind: 'note', done: false, created: CREATED },
      {
        id: 'n2',
        text: 'Dust here.',
        kind: 'note',
        done: false,
        created: CREATED,
        author: 'Dana',
        point: [0.126, 0.5],
      },
      {
        id: 'n3',
        text: 'Re-light this corner.',
        kind: 'note',
        done: false,
        created: CREATED,
        region: [0.1, 0.25, 0.375, 0.5],
      },
      { id: 'n4', text: '', kind: 'note', done: false, created: CREATED },
      {
        id: 'n5',
        text: 'Fixed already.',
        kind: 'note',
        done: true,
        created: CREATED,
        region: [0, 0, 1, 1],
      },
    ]);
  });

  it('needs no fps, but an fps that is there must be above 0', () => {
    expect(loadSidecar(imageFile()).readOnly).toBeNull();
    expect(loadSidecar(imageFile('fps: 25\n')).readOnly).toBeNull();
    expect(loadSidecar(imageFile('fps: 0\n')).readOnly).toBe('"fps" must be a positive number');
    expect(loadSidecar(imageFile('fps: x\n')).readOnly).toBe('"fps" must be a positive number');
  });

  it('still needs fps for a video, with or without media: video', () => {
    for (const head of [
      'version: 1\nsource: v.mp4\n',
      'version: 1\nsource: v.mp4\nmedia: video\n',
    ]) {
      expect(loadSidecar(head).readOnly).toBe('Missing "fps"');
    }
    expect(reviewFileError({ version: 1, source: 'v.mp4', media: 'audio', fps: 1 })).toBe(
      '"media" must be video or image',
    );
  });

  it.each([
    ['at', '  at: 1.0\n', 'has "at"'],
    ['out', '  out: 2.0\n', 'has "out"'],
  ])('rejects %s on an image note', (_n, line, message) => {
    const loaded = loadSidecar(imageFile('', line));
    expect(loaded.readOnly).toContain(message);
    expect(loaded.file).toBeUndefined();
  });

  it('requires target source on an image note', () => {
    const text = imageFile().replace('target: source', 'target: render');
    expect(loadSidecar(text).readOnly).toBe('notes[0].target must be source in an image review');
  });

  it('still requires at on a video note', () => {
    const text = imageFile().replace('media: image\n', 'fps: 25.0\n');
    expect(loadSidecar(text).readOnly).toBe('notes[0] is missing "at"');
  });

  it('checks a region the way the kit does', () => {
    const withRegion = (region: unknown) => ({
      version: 1,
      source: 'p.png',
      media: 'image',
      notes: [{ id: 'n1', target: 'source', kind: 'note', done: false, created: 'x', region }],
    });
    const bad = (region: unknown) => reviewFileError(withRegion(region));
    expect(bad([0.1, 0.2, 0.3, 0.4])).toBeNull();
    expect(bad([0, 0, 1, 1])).toBeNull();
    // 1e-9 of slack on the far edges.
    expect(bad([0.5, 0.5, 0.5 + 1e-10, 0.5])).toBeNull();
    for (const region of [
      [0.1, 0.2, 0.3],
      [0.1, 0.2, 0.3, 0.4, 0.5],
      [0.1, 0.2, 0, 0.4],
      [0.1, 0.2, 0.3, 0],
      [0.1, 0.2, -0.1, 0.4],
      [0.8, 0.2, 0.3, 0.4],
      [0.1, 0.8, 0.3, 0.4],
      [0.5, 0.5, 0.5 + 1e-8, 0.5],
      [0.1, 0.2, 1.5, 0.4],
      [0.1, 0.2, '0.3', 0.4],
      'abc',
      { 0: 0.1 },
      null,
    ]) {
      expect(bad(region), JSON.stringify(region)).toMatch(/notes\[0\]\.region must be/);
    }
  });

  it('refuses a note with both a point and a region', () => {
    const text = imageFile('', '  point: [0.5, 0.5]\n  region: [0.1, 0.1, 0.2, 0.2]\n');
    expect(loadSidecar(text).readOnly).toBe('notes[0] has a point or a region, not both');
  });

  it('keeps unknown keys fatal', () => {
    expect(loadSidecar(imageFile('', '  colour: red\n')).readOnly).toContain('unknown field');
    expect(loadSidecar(imageFile('mode: x\n')).readOnly).toBe('Unknown field "mode"');
  });

  it('shows the notes of an invalid image file leniently, with no time needed', () => {
    const loaded = loadSidecar(imageFile('fps: 0\n'));
    expect(loaded.readOnly).not.toBeNull();
    expect(loaded.media).toBe('image');
    expect(loaded.notes.map((n) => n.id)).toEqual(['n1']);
  });

  it('reports the media of a video file and of one that does not parse', () => {
    expect(loadSidecar('version: 1\nsource: v.mp4\nfps: 25\n').media).toBe('video');
    expect(loadSidecar('version: 1\nsource: v.mp4\nmedia: video\nfps: 25\n').media).toBe('video');
    expect(loadSidecar('a: [').media).toBeUndefined();
  });

  it('accepts a region on a video note', () => {
    const text =
      'version: 1\nsource: v.mp4\nfps: 25.0\nnotes:\n- id: n1\n  target: source\n  at: 1.0\n' +
      '  kind: note\n  done: false\n  created: x\n  region: [0.1, 0.1, 0.5, 0.5]\n';
    expect(loadSidecar(text).readOnly).toBeNull();
  });
});

describe('isRegion', () => {
  it('is the schema plus the kit rules', () => {
    expect(isRegion([0, 0, 1, 1])).toBe(true);
    expect(isRegion([0.9, 0.9, 0.1, 0.1])).toBe(true);
    expect(isRegion([0.9, 0.9, 0.2, 0.1])).toBe(false);
    expect(isRegion([0.1, 0.1, 0, 0.1])).toBe(false);
    expect(isRegion([Number.NaN, 0, 1, 1])).toBe(false);
    expect(isRegion([0, 0, 1])).toBe(false);
    expect(isRegion(undefined)).toBe(false);
  });
});

describe('cleanRegion', () => {
  it('rounds like the kit, with ties to even', () => {
    expect(cleanRegion([0.03125, 0.09375, 0.15625, 0.21875])).toEqual([
      0.0312, 0.0938, 0.1562, 0.2188,
    ]);
    expect(cleanRegion([0.123456789, 0.99991, 0.50004, 0.00006])).toEqual([
      0.1235, 0.9999, 0.5, 0.0001,
    ]);
  });

  it('pulls a flush size back inside the picture', () => {
    expect(cleanRegion([0.3, 0.3, 0.7000000001, 0.7])).toEqual([0.3, 0.3, 0.7, 0.7]);
  });

  it('refuses a rectangle that rounds to no size, as the kit does', () => {
    expect(() => cleanRegion([0, 0.99996, 0.5, 0.00004])).toThrow();
  });
});

describe('newImageSidecarText', () => {
  it('is what the kit writes for Review.new with media image', () => {
    expect(newImageSidecarText('empty.png', 'dddddddddddd')).toBe(fixture('empty.png.review.yaml'));
  });

  it('writes no fps and puts media after source', () => {
    const text = newImageSidecarText('p.png', 'abcdef012345');
    expect(text).not.toContain('fps');
    expect(text.split('\n').slice(0, 5)).toEqual([
      'version: 1',
      'id: abcdef012345',
      'source: p.png',
      'media: image',
      'next_note_id: 1',
    ]);
    expect(loadSidecar(text).readOnly).toBeNull();
    expect(loadSidecar(text).media).toBe('image');
  });

  it('quotes an all-digit id and a source that would read as another type', () => {
    expect(newImageSidecarText('p.png', '123456789012')).toContain("id: '123456789012'\n");
    expect(loadSidecar(newImageSidecarText('yes', 'abcdef012345')).file?.source).toBe('yes');
  });

  it('leaves the video writer alone', () => {
    expect(newSidecarText('clip.mp4', 25, 'abcdef012345')).toContain('fps: 25.0\n');
  });
});

describe('golden image edits against the kit', () => {
  interface Case {
    name: string;
    base: 'empty' | 'full';
    args: { text: string; point?: [number, number]; region?: [number, number, number, number] };
  }
  const cases = JSON.parse(fixture('edit', 'cases.json')) as Case[];

  it('covers whole-image, pin and region notes', () => {
    expect(cases.some((c) => !c.args.point && !c.args.region)).toBe(true);
    expect(cases.some((c) => c.args.point)).toBe(true);
    expect(cases.some((c) => c.args.region)).toBe(true);
  });

  for (const c of cases) {
    it(`${c.name}: the same bytes as the kit`, () => {
      const before = fixture('edit', `${c.name}.before.review.yaml`);
      const after = fixture('edit', `${c.name}.after.review.yaml`);
      const file = loadSidecar(before).file!;
      const got = addNoteText(
        before,
        { text: c.args.text, point: c.args.point, region: c.args.region, created: CREATED },
        file,
      ).text;
      expect(got).toBe(after);
      const loaded = loadSidecar(got);
      expect(loaded.readOnly).toBeNull();
      expect(loaded.media).toBe('image');
    });
  }

  it('removes and restores an image note byte for byte', () => {
    const text = fixture('full.png.review.yaml');
    for (const id of ['n1', 'n3', 'n5']) {
      const gone = removeNoteText(text, id)!;
      expect(loadSidecar(gone.text).readOnly).toBeNull();
      expect(restoreNoteText(gone.text, gone.removed), id).toBe(text);
    }
  });

  it('writes the image keys in the kit order', () => {
    const lines = noteYaml({ id: 'n1', text: 't', created: CREATED, point: [0.5, 0.5] }, 'image');
    expect(lines.split('\n').map((l) => l.split(':')[0].trim())).toEqual([
      '- id',
      'target',
      'kind',
      'text',
      'done',
      'applied_op',
      'checkpoint',
      'drawing',
      'created',
      'point',
      '',
    ]);
  });
});

describe('image Markdown', () => {
  it('matches the kit export byte for byte', () => {
    const file = loadSidecar(fixture('full.png.review.yaml')).file!;
    expect(reviewMarkdown(file)).toBe(fixture('full.png.review.md'));
  });

  it('matches for an empty image review', () => {
    const file = loadSidecar(fixture('empty.png.review.yaml')).file!;
    expect(reviewMarkdown(file)).toBe(fixture('empty.png.review.md'));
    expect(reviewMarkdown(file)).toBe('# Review notes: empty.png\n\nimage, status none\n');
  });

  it('adds an Area line after the Pin line on video', () => {
    const file = loadSidecar(fixture('video-region.review.yaml')).file!;
    expect(reviewMarkdown(file)).toBe(fixture('video-region.review.md'));
  });

  it('rounds percentages half up', () => {
    const file = loadSidecar(fixture('empty.png.review.yaml')).file!;
    const md = reviewMarkdown({
      ...file,
      notes: [
        {
          id: 'n1',
          target: 'source',
          kind: 'note',
          done: false,
          created: CREATED,
          region: [0.125, 0.005, 0.375, 0.995],
        },
      ],
    });
    expect(md).toContain('## n1  area 13%, 1%, 38% x 100%  note');
  });
});

describe('image add validator', () => {
  const good = { type: 'reviewAdd', text: 'hello' };

  it('accepts a whole-image note, a pin and an area', () => {
    expect(imageReviewAddError(good)).toBeNull();
    expect(imageReviewAddError({ ...good, point: [0.5, 0.5] })).toBeNull();
    expect(imageReviewAddError({ ...good, region: [0.1, 0.1, 0.5, 0.5] })).toBeNull();
    expect(isImageReviewAdd({ ...good, text: '' })).toBe(true);
    expect(isImageReviewAdd({ ...good, text: 'x'.repeat(MAX_NOTE_TEXT) })).toBe(true);
  });

  it('refuses everything else', () => {
    const bad = (msg: unknown) => imageReviewAddError(msg);
    expect(bad(null)).toMatch(/not valid/);
    expect(bad('x')).toMatch(/not valid/);
    expect(bad([])).toMatch(/not valid/);
    expect(bad({ ...good, at: 1 })).toMatch(/unexpected field "at"/);
    expect(bad({ ...good, out: 2 })).toMatch(/unexpected field "out"/);
    expect(bad({ ...good, extra: 1 })).toMatch(/unexpected field "extra"/);
    expect(bad({ type: 'reviewAdd' })).toMatch(/text must be/);
    expect(bad({ ...good, text: 5 })).toMatch(/text must be/);
    expect(bad({ ...good, text: 'x'.repeat(MAX_NOTE_TEXT + 1) })).toMatch(/10,000/);
    expect(bad({ ...good, point: [0.5] })).toMatch(/pin must be/);
    expect(bad({ ...good, point: [1.5, 0.5] })).toMatch(/pin must be/);
    expect(bad({ ...good, point: null })).toMatch(/pin must be/);
    expect(bad({ ...good, region: [0.1, 0.1, 0, 0.5] })).toMatch(/area must be/);
    expect(bad({ ...good, region: [0.6, 0.1, 0.5, 0.5] })).toMatch(/area must be/);
    expect(bad({ ...good, region: [0.1, 0.1, 0.5] })).toMatch(/area must be/);
    expect(bad({ ...good, region: 'x' })).toMatch(/area must be/);
    expect(bad({ ...good, point: [0.5, 0.5], region: [0.1, 0.1, 0.5, 0.5] })).toMatch(/not both/);
  });
});
