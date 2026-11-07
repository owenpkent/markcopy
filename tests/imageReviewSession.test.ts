// @vitest-environment node
//
// Host-side coverage for src/imageReview.ts and the shared session in
// src/review/session.ts, against an in-memory vscode.workspace.fs.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { posix } from 'node:path';

const files = vi.hoisted(() => new Map<string, string>());
const hooks = vi.hoisted(() => ({
  change: undefined as undefined | (() => void),
  patterns: [] as Array<{ base: { path: string }; pattern: string }>,
  disposed: 0,
  setting: false,
}));
const clipboard = vi.hoisted(() => ({ text: undefined as string | undefined }));
const failWrites = vi.hoisted(() => ({ on: false }));

vi.mock('vscode', () => {
  const asUri = (path: string) => ({ path, fsPath: path, toString: () => path });
  const notFound = (path: string) =>
    Object.assign(new Error(`ENOENT ${path}`), { code: 'FileNotFound' });
  return {
    Uri: {
      joinPath: (base: { path: string }, ...segments: string[]) =>
        asUri(posix.join(base.path, ...segments)),
    },
    RelativePattern: class {
      constructor(
        public base: { path: string },
        public pattern: string,
      ) {
        hooks.patterns.push({ base, pattern });
      }
    },
    env: {
      clipboard: {
        writeText: async (t: string) => {
          clipboard.text = t;
        },
      },
    },
    workspace: {
      getConfiguration: () => ({
        get: (_k: string, fallback: boolean) => hooks.setting || fallback,
      }),
      fs: {
        readFile: async (uri: { path: string }) => {
          const text = files.get(uri.path);
          if (text === undefined) {
            throw notFound(uri.path);
          }
          return Buffer.from(text, 'utf8');
        },
        writeFile: async (uri: { path: string }, bytes: Uint8Array) => {
          if (failWrites.on) {
            throw new Error('disk full');
          }
          files.set(uri.path, Buffer.from(bytes).toString('utf8'));
        },
        rename: async (from: { path: string }, to: { path: string }) => {
          const text = files.get(from.path);
          if (text === undefined) {
            throw notFound(from.path);
          }
          files.delete(from.path);
          files.set(to.path, text);
        },
        delete: async (uri: { path: string }) => {
          files.delete(uri.path);
        },
        stat: async (uri: { path: string }) => {
          if (!files.has(uri.path)) {
            throw notFound(uri.path);
          }
          return { size: files.get(uri.path)!.length };
        },
      },
      createFileSystemWatcher: () => ({
        onDidChange: (cb: () => void) => {
          hooks.change = cb;
          return { dispose: () => undefined };
        },
        onDidCreate: () => ({ dispose: () => undefined }),
        onDidDelete: () => ({ dispose: () => undefined }),
        dispose: () => {
          hooks.disposed++;
        },
      }),
    },
  };
});

import type * as vscode from 'vscode';
import { ImageReviewSession } from '../src/imageReview';
import { ReviewSession } from '../src/videoReview';
import { newImageSidecarText, newSidecarText } from '../src/review/sidecar';
import { reviewMarkdown } from '../src/review/markdown';
import { loadSidecar } from '../src/review/sidecar';

const IMAGE = '/pics/photo.png';
const SIDECAR = '/pics/photo.png.review.yaml';
const MARKDOWN = '/pics/photo.png.review.md';

type Posted = Record<string, unknown>;

function make(path = IMAGE) {
  const posted: Posted[] = [];
  const webview = {
    postMessage: vi.fn(async (m: Posted) => {
      posted.push(m);
      return true;
    }),
  } as unknown as vscode.Webview;
  const source = { path, fsPath: path } as vscode.Uri;
  const session = new ImageReviewSession(source, webview);
  const states = () => posted.filter((m) => m.type === 'review');
  const last = () =>
    states().at(-1) as Posted & {
      notes: Array<Posted>;
      readOnly: string | null;
      restorable: string | null;
      added: string | null;
      sidecar: string | null;
    };
  return { session, posted, states, last, webview, source };
}

const tmpFiles = () => [...files.keys()].filter((k) => k.endsWith('.tmp'));

beforeEach(() => {
  files.clear();
  hooks.change = undefined;
  hooks.patterns.length = 0;
  hooks.disposed = 0;
  hooks.setting = false;
  clipboard.text = undefined;
  failWrites.on = false;
});

describe('ImageReviewSession', () => {
  it('serializes adds from two panels on one image, so neither note is lost', async () => {
    hooks.setting = true;
    const a = make();
    const b = make();
    await a.session.onReady();
    await b.session.onReady();
    // Both start before either has written: without a shared queue both read an
    // empty file, both allocate n1, and the second write silently replaces the first.
    await Promise.all([
      a.session.add({ type: 'reviewAdd', text: 'from A' }),
      b.session.add({ type: 'reviewAdd', text: 'from B' }),
    ]);
    const loaded = loadSidecar(files.get(SIDECAR)!);
    expect(loaded.notes.map((n) => [n.id, n.text])).toEqual([
      ['n1', 'from A'],
      ['n2', 'from B'],
    ]);
    expect(a.states().some((m) => m.added === 'n1')).toBe(true);
    expect(b.states().some((m) => m.added === 'n2')).toBe(true);
    expect([...a.posted, ...b.posted].some((m) => m.type === 'reviewError')).toBe(false);
  });

  it('stays off with no sidecar and the setting off', async () => {
    const { session, posted } = make();
    await session.onReady();
    expect(posted).toEqual([]);
    expect(hooks.patterns).toEqual([]);
  });

  it('turns on with the setting, with no file: an empty state', async () => {
    hooks.setting = true;
    const { session, last } = make();
    await session.onReady();
    expect(last()).toEqual({
      type: 'review',
      sidecar: null,
      notes: [],
      readOnly: null,
      restorable: null,
      added: null,
    });
  });

  it('turns on when a sidecar exists, and watches it by its full name', async () => {
    files.set(SIDECAR, newImageSidecarText('photo.png', 'aaaaaaaaaaaa'));
    const { session, last } = make();
    await session.onReady();
    expect(last()).toMatchObject({ sidecar: 'photo.png.review.yaml', notes: [], readOnly: null });
    expect(hooks.patterns).toHaveLength(1);
    expect(hooks.patterns[0].base.path).toBe('/pics');
    expect(hooks.patterns[0].pattern).toBe('photo.png.review.yaml');
  });

  it('turns on for an unreadable sidecar, which is still a sidecar', async () => {
    files.set(SIDECAR, 'version: [');
    const { session, last } = make();
    await session.onReady();
    expect(last().readOnly).toMatch(/Not valid YAML/);
  });

  it('reviewEnable posts the state once and does not duplicate the watcher', async () => {
    const { session, states } = make();
    await session.enable();
    await session.enable();
    expect(states()).toHaveLength(2);
    expect(hooks.patterns).toHaveLength(1);
  });

  it('the first add creates the sidecar and the Markdown', async () => {
    const { session, last } = make();
    await session.enable();
    await session.add({ type: 'reviewAdd', text: 'Dust here', point: [0.25, 0.5] });
    const yaml = files.get(SIDECAR)!;
    expect(yaml).toMatch(
      /^version: 1\nid: [0-9a-f]{12}\nsource: photo\.png\nmedia: image\nnext_note_id: 2\n/,
    );
    expect(yaml).not.toContain('fps');
    expect(yaml).toContain('  text: Dust here\n');
    expect(yaml).toContain('  point: [0.25, 0.5]\n');
    expect(yaml).toMatch(/created: '\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d'\n/);
    const loaded = loadSidecar(yaml);
    expect(loaded.readOnly).toBeNull();
    expect(files.get(MARKDOWN)).toBe(reviewMarkdown(loaded.file!));
    expect(files.get(MARKDOWN)).toContain('## n1  pin 25% from left, 50% from top  note');
    expect(tmpFiles()).toEqual([]);
    expect(last()).toMatchObject({
      sidecar: 'photo.png.review.yaml',
      added: 'n1',
      readOnly: null,
      notes: [{ id: 'n1', text: 'Dust here', point: [0.25, 0.5] }],
    });
  });

  it('adds a region and a whole-image note with fresh ids, in order', async () => {
    const { session, last } = make();
    await session.enable();
    await Promise.all([
      session.add({ type: 'reviewAdd', text: 'Area', region: [0.1, 0.2, 0.3, 0.4] }),
      session.add({ type: 'reviewAdd', text: 'Whole' }),
    ]);
    expect(last().notes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(last().notes[0]).toMatchObject({ region: [0.1, 0.2, 0.3, 0.4] });
    expect(last().notes[1]).not.toHaveProperty('point');
    expect(files.get(MARKDOWN)).toContain('## n1  area 10%, 20%, 30% x 40%  note');
    expect(files.get(MARKDOWN)).toContain('## n2  whole image  note');
  });

  it('answers an invalid add with reviewError failed add, and writes nothing', async () => {
    const { session, posted } = make();
    await session.enable();
    const bad: unknown[] = [
      { type: 'reviewAdd', text: 'x', at: 3 },
      { type: 'reviewAdd', text: 'x', point: [2, 2] },
      { type: 'reviewAdd', text: 'x', point: [0.5, 0.5], region: [0.1, 0.1, 0.2, 0.2] },
      { type: 'reviewAdd', text: 'x', region: [0.9, 0.9, 0.5, 0.5] },
      { type: 'reviewAdd', text: 5 },
      null,
    ];
    for (const msg of bad) {
      await session.add(msg);
    }
    const errors = posted.filter((m) => m.type === 'reviewError');
    expect(errors).toHaveLength(bad.length);
    for (const e of errors) {
      expect(e).toMatchObject({ failed: 'add' });
    }
    expect(files.has(SIDECAR)).toBe(false);
    expect(files.has(MARKDOWN)).toBe(false);
  });

  it('answers a failed write with failed add', async () => {
    const { session, posted } = make();
    await session.enable();
    failWrites.on = true;
    await session.add({ type: 'reviewAdd', text: 'x' });
    expect(posted.at(-1)).toMatchObject({ type: 'reviewError', failed: 'add' });
    expect(String(posted.at(-1)?.message)).toContain('disk full');
    expect(files.has(SIDECAR)).toBe(false);
  });

  it('deletes and restores a note, keeping the file bytes', async () => {
    const { session, last } = make();
    await session.enable();
    await session.add({ type: 'reviewAdd', text: 'One', point: [0.1, 0.1] });
    await session.add({ type: 'reviewAdd', text: 'Two', region: [0.2, 0.2, 0.2, 0.2] });
    const before = files.get(SIDECAR)!;

    await session.delete({ type: 'reviewDelete', id: 'n1' });
    expect(last().notes.map((n) => n.id)).toEqual(['n2']);
    expect(last().restorable).toBe('n1');
    expect(files.get(MARKDOWN)).not.toContain('One');

    await session.restore({ type: 'reviewRestore' });
    expect(last().notes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(last().restorable).toBeNull();
    expect(files.get(SIDECAR)).toBe(before);
    expect(files.get(MARKDOWN)).toContain('One');
  });

  it('refuses to delete an unknown note, extra keys, or a restore with nothing held', async () => {
    const { session, posted } = make();
    await session.enable();
    await session.add({ type: 'reviewAdd', text: 'One' });
    const before = files.get(SIDECAR);
    await session.delete({ type: 'reviewDelete', id: 'n9' });
    await session.delete({ type: 'reviewDelete', id: 'n1', extra: 1 });
    await session.restore({ type: 'reviewRestore' });
    expect(posted.filter((m) => m.type === 'reviewError')).toHaveLength(3);
    expect(files.get(SIDECAR)).toBe(before);
  });

  it('copies: writes the Markdown, fills the clipboard and toasts', async () => {
    const { session, posted } = make();
    await session.enable();
    await session.add({ type: 'reviewAdd', text: 'One' });
    await session.add({ type: 'reviewAdd', text: 'Two' });
    files.delete(MARKDOWN);
    await session.copy();
    expect(clipboard.text).toBe(files.get(MARKDOWN));
    expect(clipboard.text).toContain('# Review notes: photo.png');
    expect(posted.at(-1)).toEqual({
      type: 'toast',
      message: 'Copied 2 notes, saved photo.png.review.md',
    });
  });

  it('a copy with no sidecar says there is nothing to copy', async () => {
    const { session, posted } = make();
    await session.enable();
    await session.copy();
    expect(posted.at(-1)).toMatchObject({
      type: 'reviewError',
      message: 'There are no notes to copy yet',
    });
    expect(clipboard.text).toBeUndefined();
  });

  it('refuses edits and copy on a read-only (invalid) file, and leaves it alone', async () => {
    const bad = 'version: 2\nsource: photo.png\nmedia: image\n';
    files.set(SIDECAR, bad);
    const { session, posted, last } = make();
    await session.onReady();
    expect(last().readOnly).toMatch(/Version 2/);
    await session.add({ type: 'reviewAdd', text: 'x' });
    await session.delete({ type: 'reviewDelete', id: 'n1' });
    await session.copy();
    const errors = posted.filter((m) => m.type === 'reviewError');
    expect(errors).toHaveLength(3);
    expect(String(errors[0].message)).toContain('read-only');
    expect(errors[0]).toMatchObject({ failed: 'add' });
    expect(errors[1]).not.toHaveProperty('failed');
    expect(files.get(SIDECAR)).toBe(bad);
    expect(files.has(MARKDOWN)).toBe(false);
    expect(clipboard.text).toBeUndefined();
  });

  it('treats a video sidecar as not an image review', async () => {
    const video = newSidecarText('photo.png', 25, 'bbbbbbbbbbbb');
    files.set(SIDECAR, video);
    const { session, posted, last } = make();
    await session.onReady();
    expect(last().readOnly).toMatch(/^Not an image review/);
    expect(last().notes).toEqual([]);
    await session.add({ type: 'reviewAdd', text: 'x' });
    expect(posted.at(-1)).toMatchObject({ type: 'reviewError', failed: 'add' });
    expect(files.get(SIDECAR)).toBe(video);
  });

  it('a video panel treats an image sidecar as not a video review', async () => {
    const path = '/pics/photo.png';
    const image = newImageSidecarText('photo.png', 'cccccccccccc');
    files.set('/pics/photo.review.yaml', image);
    const posted: Posted[] = [];
    const webview = {
      postMessage: vi.fn(async (m: Posted) => {
        posted.push(m);
        return true;
      }),
    } as unknown as vscode.Webview;
    const session = new ReviewSession(
      { path: path.replace('.png', '.mp4'), fsPath: path } as vscode.Uri,
      webview,
      async () => ({ fps: 25, durationSec: 10 }),
    );
    await session.onReady();
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'review')).toBe(true));
    expect(posted.find((m) => m.type === 'review')).toMatchObject({
      readOnly: expect.stringMatching(/^Not a video review/),
      notes: [],
    });
    await session.add({ type: 'reviewAdd', at: 1, text: 'x' });
    expect(files.get('/pics/photo.review.yaml')).toBe(image);
  });

  it('warns when another program replaces the notes', async () => {
    const { session, posted } = make();
    await session.enable();
    await session.add({ type: 'reviewAdd', text: 'Mine' });
    files.set(SIDECAR, newImageSidecarText('photo.png', 'dddddddddddd'));
    hooks.change?.();
    await vi.waitFor(() =>
      expect(posted.some((m) => m.message === 'Notes were replaced by another program')).toBe(true),
    );
  });

  it('does not post again for its own write', async () => {
    const { session, states } = make();
    await session.enable();
    await session.add({ type: 'reviewAdd', text: 'Mine' });
    const count = states().length;
    hooks.change?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(states()).toHaveLength(count);
  });

  it('posts a changed file from outside', async () => {
    const { session, last } = make();
    await session.enable();
    files.set(SIDECAR, newImageSidecarText('photo.png', 'eeeeeeeeeeee'));
    hooks.change?.();
    await vi.waitFor(() => expect(last().sidecar).toBe('photo.png.review.yaml'));
  });

  it('stops after dispose', async () => {
    const { session, posted } = make();
    await session.enable();
    session.dispose();
    expect(hooks.disposed).toBe(1);
    const count = posted.length;
    await session.add({ type: 'reviewAdd', text: 'late' });
    await session.enable();
    expect(posted).toHaveLength(count);
    expect(files.has(SIDECAR)).toBe(false);
  });

  it('names the sidecar after the whole file name for an odd name', async () => {
    const { session } = make('/pics/a.b.jpeg');
    await session.enable();
    await session.add({ type: 'reviewAdd', text: 'x' });
    expect(files.has('/pics/a.b.jpeg.review.yaml')).toBe(true);
    expect(files.has('/pics/a.b.jpeg.review.md')).toBe(true);
  });
});
