// @vitest-environment node
//
// The pure half of src/videoReview.ts: sidecar naming, validation and fps
// resolution. vscode is mocked only so the module can be imported.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('vscode', () => ({}));

import {
  copyToast,
  loadSidecar,
  markdownName,
  resolveFps,
  reviewStem,
  sidecarName,
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
