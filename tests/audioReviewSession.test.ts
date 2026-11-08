// @vitest-environment node
//
// Host-side coverage for src/audioReview.ts and the shared session in
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
import { AudioReviewSession } from '../src/audioReview';
import { ImageReviewSession } from '../src/imageReview';
import { ReviewSession } from '../src/videoReview';
import {
  loadSidecar,
  newAudioSidecarText,
  newImageSidecarText,
  newSidecarText,
} from '../src/review/sidecar';
import { reviewMarkdown } from '../src/review/markdown';

const AUDIO = '/music/song.mp3';
const SIDECAR = '/music/song.mp3.review.yaml';
const MARKDOWN = '/music/song.mp3.review.md';

type Posted = Record<string, unknown>;

function make(path = AUDIO) {
  const posted: Posted[] = [];
  const webview = {
    postMessage: vi.fn(async (m: Posted) => {
      posted.push(m);
      return true;
    }),
  } as unknown as vscode.Webview;
  const source = { path, fsPath: path } as vscode.Uri;
  const session = new AudioReviewSession(source, webview);
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

beforeEach(() => {
  files.clear();
  hooks.change = undefined;
  hooks.patterns.length = 0;
  hooks.disposed = 0;
  hooks.setting = false;
  clipboard.text = undefined;
  failWrites.on = false;
});

const add = (at: number, text: string, out?: number) => ({
  type: 'reviewAdd',
  at,
  text,
  ...(out === undefined ? {} : { out }),
});

describe('AudioReviewSession', () => {
  it('stays off with no sidecar and the setting off', async () => {
    const { session, posted } = make();
    await session.onReady();
    expect(posted).toEqual([]);
    expect(hooks.patterns).toEqual([]);
  });

  it('turns on with the setting, with no file: an empty state with no frame rate', async () => {
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
    files.set(SIDECAR, newAudioSidecarText('song.mp3', 'aaaaaaaaaaaa'));
    const { session, last } = make();
    await session.onReady();
    expect(last()).toMatchObject({ sidecar: 'song.mp3.review.yaml', notes: [], readOnly: null });
    expect(hooks.patterns[0].base.path).toBe('/music');
    expect(hooks.patterns[0].pattern).toBe('song.mp3.review.yaml');
  });

  it('the first add creates the audio sidecar and the Markdown', async () => {
    const { session, last } = make();
    await session.enable();
    await session.add(add(72.5, 'Click in the vocal', 75));
    const yaml = files.get(SIDECAR)!;
    expect(yaml).toMatch(
      /^version: 1\nid: '?[0-9a-f]{12}'?\nsource: song\.mp3\nmedia: audio\nnext_note_id: 2\n/,
    );
    expect(yaml).not.toContain('fps');
    expect(yaml).toContain('  at: 72.5\n');
    expect(yaml).toContain('  out: 75.0\n');
    expect(yaml).toContain('  drawing: []\n');
    const loaded = loadSidecar(yaml);
    expect(loaded.readOnly).toBeNull();
    expect(loaded.media).toBe('audio');
    expect(files.get(MARKDOWN)).toBe(reviewMarkdown(loaded.file!));
    expect(files.get(MARKDOWN)).toContain('audio, status none');
    expect(files.get(MARKDOWN)).toContain('## n1  00:01:12.500 to 00:01:15.000  note');
    expect(last()).toMatchObject({
      sidecar: 'song.mp3.review.yaml',
      added: 'n1',
      notes: [{ id: 'n1', at: 72.5, out: 75, text: 'Click in the vocal' }],
    });
  });

  it('serializes adds from two panels on one file, so neither note is lost', async () => {
    hooks.setting = true;
    const a = make();
    const b = make();
    await a.session.onReady();
    await b.session.onReady();
    await Promise.all([a.session.add(add(1, 'from A')), b.session.add(add(2, 'from B'))]);
    expect(loadSidecar(files.get(SIDECAR)!).notes.map((n) => [n.id, n.text])).toEqual([
      ['n1', 'from A'],
      ['n2', 'from B'],
    ]);
  });

  it('refuses a bad add with reviewError failed add, and writes nothing', async () => {
    const { session, posted } = make();
    await session.enable();
    const bad: unknown[] = [
      { type: 'reviewAdd', text: 'x' },
      add(-1, 'x'),
      add(3, 'x', 2),
      { ...add(3, 'x'), point: [0.5, 0.5] },
      { ...add(3, 'x'), region: [0.1, 0.1, 0.2, 0.2] },
      { ...add(3, 'x'), drawing: [] },
      { ...add(3, 'x'), target: 'render' },
      { type: 'reviewAdd', at: Number.NaN, text: 'x' },
      { type: 'reviewAdd', at: 1, text: 5 },
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
  });

  it('answers a failed write with failed add', async () => {
    const { session, posted } = make();
    await session.enable();
    failWrites.on = true;
    await session.add(add(1, 'x'));
    expect(posted.at(-1)).toMatchObject({ type: 'reviewError', failed: 'add' });
    expect(files.has(SIDECAR)).toBe(false);
  });

  it('deletes and restores a note, keeping the file bytes', async () => {
    const { session, last } = make();
    await session.enable();
    await session.add(add(1, 'One'));
    await session.add(add(2, 'Two', 3));
    const before = files.get(SIDECAR)!;
    await session.delete({ type: 'reviewDelete', id: 'n1' });
    expect(last().notes.map((n) => n.id)).toEqual(['n2']);
    expect(last().restorable).toBe('n1');
    await session.restore({ type: 'reviewRestore' });
    expect(last().notes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(files.get(SIDECAR)).toBe(before);
  });

  it('copies: writes the Markdown, fills the clipboard and toasts', async () => {
    const { session, posted } = make();
    await session.enable();
    await session.add(add(1.5, 'One'));
    files.delete(MARKDOWN);
    await session.copy();
    expect(clipboard.text).toBe(files.get(MARKDOWN));
    expect(clipboard.text).toContain('## n1  00:00:01.500  note');
    expect(posted.at(-1)).toEqual({
      type: 'toast',
      message: 'Copied 1 note, saved song.mp3.review.md',
    });
  });

  it('refuses edits on a read-only (invalid) file, and leaves it alone', async () => {
    const bad =
      'version: 1\nsource: song.mp3\nmedia: audio\nnotes:\n- id: n1\n  target: render\n  at: 1\n  kind: note\n  done: false\n  created: x\n';
    files.set(SIDECAR, bad);
    const { session, posted, last } = make();
    await session.onReady();
    expect(last().readOnly).toBe('notes[0].target must be source in an audio review');
    await session.add(add(1, 'x'));
    expect(posted.at(-1)).toMatchObject({ type: 'reviewError', failed: 'add' });
    expect(files.get(SIDECAR)).toBe(bad);
  });

  it('treats a video or image sidecar as not an audio review', async () => {
    for (const other of [
      newSidecarText('song.mp3', 25, 'bbbbbbbbbbbb'),
      newImageSidecarText('song.mp3', 'cccccccccccc'),
    ]) {
      files.set(SIDECAR, other);
      const { session, posted, last } = make();
      await session.onReady();
      expect(last().readOnly).toMatch(/^Not an audio review/);
      await session.add(add(1, 'x'));
      expect(posted.at(-1)).toMatchObject({ type: 'reviewError', failed: 'add' });
      expect(files.get(SIDECAR)).toBe(other);
    }
  });

  it('the video and image panels call an audio sidecar not theirs', async () => {
    const audio = newAudioSidecarText('clip.mp4', 'dddddddddddd');
    files.set('/music/clip.review.yaml', audio);
    files.set('/music/clip.mp4.review.yaml', audio);
    const posted: Posted[] = [];
    const webview = {
      postMessage: vi.fn(async (m: Posted) => {
        posted.push(m);
        return true;
      }),
    } as unknown as vscode.Webview;
    const video = new ReviewSession(
      { path: '/music/clip.mp4', fsPath: '/music/clip.mp4' } as vscode.Uri,
      webview,
      async () => ({ fps: 25, durationSec: 10 }),
    );
    await video.onReady();
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'review')).toBe(true));
    expect(posted.find((m) => m.type === 'review')).toMatchObject({
      readOnly: 'Not a video review (this file is for an audio)',
    });
    posted.length = 0;
    const image = new ImageReviewSession(
      { path: '/music/clip.mp4', fsPath: '/music/clip.mp4' } as vscode.Uri,
      webview,
    );
    await image.onReady();
    expect(posted.find((m) => m.type === 'review')).toMatchObject({
      readOnly: 'Not an image review (this file is for an audio)',
    });
  });

  it('warns when another program replaces the notes, and stops after dispose', async () => {
    const { session, posted } = make();
    await session.enable();
    await session.add(add(1, 'Mine'));
    files.set(SIDECAR, newAudioSidecarText('song.mp3', 'eeeeeeeeeeee'));
    hooks.change?.();
    await vi.waitFor(() =>
      expect(posted.some((m) => m.message === 'Notes were replaced by another program')).toBe(true),
    );
    session.dispose();
    expect(hooks.disposed).toBe(1);
    const count = posted.length;
    await session.add(add(2, 'late'));
    expect(posted).toHaveLength(count);
  });

  it('names the sidecar after the whole file name for an odd name', async () => {
    const { session } = make('/music/a.b.FLAC');
    await session.enable();
    await session.add(add(1, 'x'));
    expect(files.has('/music/a.b.FLAC.review.yaml')).toBe(true);
    expect(files.has('/music/a.b.FLAC.review.md')).toBe(true);
  });
});
