// @vitest-environment node
//
// What the two file-information previews (executables and packages) do before
// and around a read: they open on a page that has read nothing, they read when
// asked (the button, the command, or the setting), and they keep that yes to
// the one page it was given. The scaffold they share is src/fileInfoEditor.ts;
// both subclasses are run through the same cases here, so neither can drift.
//
// vscode is mocked as in tests/exeEditor.test.ts (read the header of
// tests/ooxmlEditor.test.ts for why this needs the node environment). The
// reader is replaced with the task run in this process, wrapped in a spy: what
// is pinned here is when the host asks for a read, not the worker, which
// tests/isolate.test.ts and tests/fileInfoWorker.test.ts cover.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ confirm: true, change: [] as (() => void)[] }));

vi.mock('vscode', () => {
  return {
    Uri: {
      parse: (value: string) => ({ scheme: /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1] ?? '' }),
      joinPath: (base: { path: string }, ...segments: string[]) => ({
        path: `${base.path}/${segments.join('/')}`,
        fsPath: `${base.path}/${segments.join('/')}`,
      }),
    },
    env: { openExternal },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: (key: string, fallback: unknown) =>
          key === 'fileInfo.confirm' ? state.confirm : fallback,
      })),
      createFileSystemWatcher: vi.fn(() => ({
        onDidChange: (cb: () => void) => {
          state.change.push(cb);
          return { dispose: () => undefined };
        },
        onDidCreate: vi.fn(() => ({ dispose: () => undefined })),
        dispose: () => undefined,
      })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: () => undefined })),
      fs: { stat: vi.fn(), readFile: vi.fn() },
    },
    RelativePattern: class {
      constructor(
        public base: unknown,
        public pattern: string,
      ) {}
    },
    commands: { executeCommand: vi.fn() },
    window: { setStatusBarMessage: vi.fn() },
  };
});

import * as vs from 'vscode';
import { formatBytes } from '../src/binary/html';
import { ReadError } from '../src/binary/reader';
import { ExeEditorProvider } from '../src/exeEditor';
import {
  readFileInfo,
  type FileInfoEditorProvider,
  type FileInfoReader,
} from '../src/fileInfoEditor';
import { runFileInfoTask, type FileInfoResult } from '../src/fileInfoTask';
import { REDRAW_DELAY_MS } from '../src/ooxmlEditor';
import { PackageEditorProvider } from '../src/packageEditor';
import { buildPe, iconBitmap } from './pe/fixture';
import { buildElf } from './pkg/elfFixture';
import type * as vscode from 'vscode';

const dir = mkdtempSync(join(tmpdir(), 'markcopy-fileinfo-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SIZE = 12_345;

beforeEach(() => {
  state.confirm = true;
  state.change.length = 0;
  openExternal.mockClear();
  vi.mocked(vs.workspace.fs.stat).mockResolvedValue({ size: SIZE } as vscode.FileStat);
});

const fakeContext = {
  extensionUri: { path: '/ext', fsPath: '/ext' },
} as unknown as vscode.ExtensionContext;

function documentAt(fsPath: string): vscode.CustomDocument {
  const path = fsPath.replace(/\\/g, '/');
  return {
    uri: {
      scheme: 'file',
      path: path.startsWith('/') ? path : `/${path}`,
      fsPath,
      toString: () => `file:///${path}`,
    },
    dispose: () => undefined,
  } as unknown as vscode.CustomDocument;
}

interface Posted {
  type: string;
  kind?: string;
  html?: string;
  items?: { id: string; mime: string; base64: string }[];
}

function createPanel(): {
  panel: vscode.WebviewPanel;
  post: (msg: unknown) => Promise<void>;
  posted: () => Posted[];
  renders: () => Posted[];
  close: () => void;
} {
  let handler: ((msg: unknown) => unknown) | undefined;
  let close = (): void => undefined;
  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri: unknown) => uri,
    postMessage: vi.fn(),
    onDidReceiveMessage: (cb: (msg: unknown) => unknown) => {
      handler = cb;
      return { dispose: () => undefined };
    },
  };
  const posted = (): Posted[] => webview.postMessage.mock.calls.map(([msg]) => msg as Posted);
  return {
    panel: {
      webview,
      onDidDispose: (cb: () => void) => {
        close = cb;
        return { dispose: () => undefined };
      },
    } as unknown as vscode.WebviewPanel,
    post: async (msg) => {
      await handler?.(msg);
    },
    posted,
    renders: () => posted().filter((m) => m.type === 'render'),
    close: () => close(),
  };
}

const inProcess: FileInfoReader = (request) => runFileInfoTask(request);

interface Flavour {
  name: string;
  make: () => FileInfoEditorProvider;
  kind: 'exe' | 'package';
  file: string;
  valid: () => Uint8Array;
  /** A string the reader's own page shows for `valid()`, and the waiting page does not. */
  inside: string;
}

const FLAVOURS: Flavour[] = [
  {
    name: 'executable',
    make: () => new ExeEditorProvider(fakeContext, vi.fn(), vi.fn(), vi.fn()),
    kind: 'exe',
    file: 'tool.exe',
    valid: () =>
      buildPe({
        version: { fileVersion: [3, 1, 4, 1], strings: [['FileDescription', 'Pie Tool']] },
      }),
    inside: 'Pie Tool',
  },
  {
    name: 'package',
    make: () => new PackageEditorProvider(fakeContext, vi.fn(), vi.fn(), vi.fn()),
    kind: 'package',
    file: 'libdemo.so',
    valid: () => buildElf(),
    inside: 'ELF',
  },
];

/** Write `bytes` to a fresh folder under the temp dir, as `name`, and return the path. */
let folders = 0;
function fileWith(name: string, bytes: Uint8Array | string): string {
  const folder = join(dir, `f${++folders}`);
  mkdirSync(folder);
  const path = join(folder, name);
  writeFileSync(path, bytes);
  return path;
}

function withSpy(provider: FileInfoEditorProvider, reader: FileInfoReader = inProcess) {
  const spy = vi.fn(reader);
  provider.reader = spy;
  return spy;
}

describe.each(FLAVOURS)('file information page: $name', (flavour) => {
  describe('before the file is read', () => {
    it('shows the name, the size and the button, and reads nothing', async () => {
      const provider = flavour.make();
      const spy = withSpy(provider);
      const path = fileWith(flavour.file, flavour.valid());
      const { panel, post, renders } = createPanel();
      await provider.resolveCustomEditor(documentAt(path), panel);

      await post({ type: 'ready' });

      expect(renders()).toHaveLength(1);
      const html = renders()[0].html!;
      expect(renders()[0].kind).toBe(flavour.kind);
      expect(html).toContain(`<h1>${flavour.file}</h1>`);
      expect(html).toContain(formatBytes(SIZE));
      expect(html).toContain(
        '<button type="button" class="mc-info-read" data-mc-action="read-file">Read this file</button>',
      );
      expect(html).not.toContain(flavour.inside);
      expect(html).not.toContain(createHash('sha256').update(flavour.valid()).digest('hex'));
      expect(spy).not.toHaveBeenCalled();
    });

    it('is the same page whether the file is valid or garbage, because it is not looked at', async () => {
      const htmlFor = async (bytes: Uint8Array | string): Promise<string> => {
        const provider = flavour.make();
        const spy = withSpy(provider);
        const { panel, post, renders } = createPanel();
        await provider.resolveCustomEditor(documentAt(fileWith(flavour.file, bytes)), panel);
        await post({ type: 'ready' });
        expect(spy).not.toHaveBeenCalled();
        return renders()[0].html!;
      };

      const valid = await htmlFor(flavour.valid());
      const garbage = await htmlFor('not what the name says, and not anything else either\n');

      expect(garbage).toBe(valid);
    });

    it('escapes markup in the file name and drops a bidirectional override', async () => {
      const provider = flavour.make();
      withSpy(provider);
      const rlo = String.fromCharCode(0x202e);
      const { panel, post, renders } = createPanel();
      // Nothing is read, so the file need not exist (or be creatable: a real
      // file system refuses some of these characters in a name).
      const name = `<img src=x onerror=alert(1)>${rlo}fdp.exe`;
      await provider.resolveCustomEditor(documentAt(join(dir, name)), panel);

      await post({ type: 'ready' });

      const html = renders()[0].html!;
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain(rlo);
    });

    it('ignores openExternal, so the file can never be handed to the OS', async () => {
      const provider = flavour.make();
      withSpy(provider);
      const { panel, post } = createPanel();
      await provider.resolveCustomEditor(
        documentAt(fileWith(flavour.file, flavour.valid())),
        panel,
      );

      await post({ type: 'ready' });
      await post({ type: 'openExternal' });
      await post({ type: 'readFile' });
      await post({ type: 'openExternal' });

      expect(openExternal).not.toHaveBeenCalled();
    });
  });

  describe('when the button is pressed', () => {
    it('reads the file once and renders its page, with the SHA-256 of its bytes', async () => {
      const provider = flavour.make();
      const spy = withSpy(provider);
      const bytes = flavour.valid();
      const path = fileWith(flavour.file, bytes);
      const { panel, post, renders } = createPanel();
      await provider.resolveCustomEditor(documentAt(path), panel);
      await post({ type: 'ready' });

      await post({ type: 'readFile' });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        kind: flavour.kind,
        fileName: flavour.file,
        path,
      });
      expect(renders()).toHaveLength(2);
      const page = renders()[1];
      expect(page.kind).toBe(flavour.kind);
      expect(page.html).not.toContain('mc-info-waiting');
      expect(page.html).not.toContain('could not preview');
      expect(page.html).toContain(createHash('sha256').update(bytes).digest('hex'));
    });

    it('posts the file icon as a media message after the page, for an executable that has one', async () => {
      if (flavour.kind !== 'exe') {
        return;
      }
      const provider = flavour.make();
      withSpy(provider);
      const icon = {
        id: 1,
        width: 16,
        height: 16,
        bitCount: 32,
        data: iconBitmap({
          width: 16,
          height: 16,
          bitCount: 32,
          rgba: Array.from({ length: 256 }, () => [9, 8, 7, 255]),
        }),
      };
      const { panel, post, posted } = createPanel();
      await provider.resolveCustomEditor(
        documentAt(fileWith('icon.exe', buildPe({ icons: [icon] }))),
        panel,
      );
      await post({ type: 'ready' });
      expect(posted().some((m) => m.type === 'media')).toBe(false);

      await post({ type: 'readFile' });

      const types = posted().map((m) => m.type);
      expect(types.indexOf('media')).toBeGreaterThan(types.lastIndexOf('render'));
      const media = posted().filter((m) => m.type === 'media');
      expect(media).toHaveLength(1);
      expect(media[0].items?.[0]).toMatchObject({ id: 'm1', mime: 'image/png' });
    });
  });

  describe('with markcopy.fileInfo.confirm off', () => {
    it('reads on ready, and never shows the waiting page', async () => {
      state.confirm = false;
      const provider = flavour.make();
      const spy = withSpy(provider);
      const { panel, post, renders } = createPanel();
      await provider.resolveCustomEditor(
        documentAt(fileWith(flavour.file, flavour.valid())),
        panel,
      );

      await post({ type: 'ready' });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(renders()).toHaveLength(1);
      expect(renders()[0].html).not.toContain('mc-info-waiting');
      expect(renders()[0].html).not.toContain('mc-info-read');
    });
  });

  describe('confirmation is per page', () => {
    it('leaves a second page waiting when the first is confirmed', async () => {
      const provider = flavour.make();
      const spy = withSpy(provider);
      const first = createPanel();
      const second = createPanel();
      const firstPath = fileWith(flavour.file, flavour.valid());
      const secondPath = fileWith(`other-${flavour.file}`, flavour.valid());
      await provider.resolveCustomEditor(documentAt(firstPath), first.panel);
      await provider.resolveCustomEditor(documentAt(secondPath), second.panel);
      await first.post({ type: 'ready' });
      await second.post({ type: 'ready' });

      await first.post({ type: 'readFile' });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ path: firstPath });
      expect(first.renders().at(-1)!.html).not.toContain('mc-info-waiting');
      expect(second.renders()).toHaveLength(1);
      expect(second.renders()[0].html).toContain('mc-info-waiting');
    });
  });

  describe('readFileInfo, which the command calls', () => {
    it('answers undefined for a file with no open page', () => {
      const uri = documentAt(join(dir, 'nobody', flavour.file)).uri;
      expect(readFileInfo(uri)).toBeUndefined();
    });

    it('reads an open page and resolves what it then shows', async () => {
      const provider = flavour.make();
      const spy = withSpy(provider);
      const document = documentAt(fileWith(flavour.file, flavour.valid()));
      const { panel, post, renders } = createPanel();
      await provider.resolveCustomEditor(document, panel);
      await post({ type: 'ready' });
      expect(renders()[0].html).toContain('mc-info-waiting');

      const outcome = await readFileInfo(document.uri);

      expect(outcome).toEqual({ state: 'read', warnings: expect.any(Number) });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(renders().at(-1)!.html).not.toContain('mc-info-waiting');
    });

    it('resolves failed, with the notice, for a file that is not the format', async () => {
      const provider = flavour.make();
      withSpy(provider);
      const document = documentAt(
        fileWith(flavour.file, 'plain text that is not the format its name says, at all\n'),
      );
      const { panel, post, renders } = createPanel();
      await provider.resolveCustomEditor(document, panel);
      await post({ type: 'ready' });

      const outcome = await readFileInfo(document.uri);

      expect(outcome?.state).toBe('failed');
      expect(outcome?.message).toBeTruthy();
      expect(renders().at(-1)!.html).toContain('MarkCopy could not preview this file');
    });

    it('answers undefined again once the panel is disposed', async () => {
      const provider = flavour.make();
      withSpy(provider);
      const document = documentAt(fileWith(flavour.file, flavour.valid()));
      const { panel, post, close } = createPanel();
      await provider.resolveCustomEditor(document, panel);
      await post({ type: 'ready' });
      expect(readFileInfo(document.uri)).toBeDefined();

      close();

      expect(readFileInfo(document.uri)).toBeUndefined();
    });
  });

  describe('when the reader fails', () => {
    async function pageAfter(reader: FileInfoReader): Promise<string> {
      const provider = flavour.make();
      withSpy(provider, reader);
      const { panel, post, renders } = createPanel();
      await provider.resolveCustomEditor(
        documentAt(fileWith(flavour.file, flavour.valid())),
        panel,
      );
      await post({ type: 'ready' });
      await post({ type: 'readFile' });
      return renders().at(-1)!.html!;
    }

    it('shows a ReadError message as it is written, such as the heap limit', async () => {
      const message =
        'reading it needed more than the 256 MB MarkCopy allows a preview, so MarkCopy stopped.';

      const html = await pageAfter(() => Promise.reject(new ReadError(message)));

      expect(html).toContain(`MarkCopy could not preview this file: ${message}`);
    });

    it('shows an expected failure from the task as it is written', async () => {
      const html = await pageAfter(() =>
        Promise.resolve<FileInfoResult>({ ok: false, expected: true, message: 'it is cut short.' }),
      );

      expect(html).toContain('MarkCopy could not preview this file: it is cut short.');
    });

    it('puts the generic lead-in on a failure that is not a ReadError', async () => {
      const html = await pageAfter(() =>
        Promise.resolve<FileInfoResult>({ ok: false, expected: false, message: 'boom' }),
      );

      expect(html).toContain('something went wrong reading it (boom)');
    });
  });

  describe('when the file changes after it was confirmed', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reads again without asking again', async () => {
      vi.useFakeTimers();
      const provider = flavour.make();
      const spy = withSpy(provider);
      const { panel, post, renders } = createPanel();
      await provider.resolveCustomEditor(
        documentAt(fileWith(flavour.file, flavour.valid())),
        panel,
      );
      await post({ type: 'ready' });
      await post({ type: 'readFile' });
      expect(spy).toHaveBeenCalledTimes(1);

      for (const cb of state.change) {
        cb();
      }
      await vi.advanceTimersByTimeAsync(REDRAW_DELAY_MS + 1);
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(renders()).toHaveLength(3));

      expect(renders().at(-1)!.html).not.toContain('mc-info-waiting');
    });

    it('keeps waiting, reading nothing, when it was never confirmed', async () => {
      vi.useFakeTimers();
      const provider = flavour.make();
      const spy = withSpy(provider);
      const { panel, post, renders } = createPanel();
      await provider.resolveCustomEditor(
        documentAt(fileWith(flavour.file, flavour.valid())),
        panel,
      );
      await post({ type: 'ready' });

      for (const cb of state.change) {
        cb();
      }
      await vi.advanceTimersByTimeAsync(REDRAW_DELAY_MS + 1);
      await vi.waitFor(() => expect(renders()).toHaveLength(2));

      expect(spy).not.toHaveBeenCalled();
      expect(renders().at(-1)!.html).toContain('mc-info-waiting');
    });
  });

  // The host does not open the file to hash it: the worker hashes it through
  // the handle it reads the metadata from, so the two cannot describe different
  // files when the path is replaced between them (see digestHandle). What the
  // page shows is therefore exactly what the reader returned.
  describe('where the hash and size come from', () => {
    it('shows the reader digest, and opens nothing itself, for a path that does not exist', async () => {
      const provider = flavour.make();
      const sha256 = 'ab'.repeat(32);
      const spy = withSpy(provider, async (request) => {
        const result = await runFileInfoTask({
          kind: request.kind,
          fileName: request.fileName,
          bytes: flavour.valid(),
        });
        return result.ok ? { ...result, digest: { size: 777, sha256 } } : result;
      });
      const { panel, post, renders } = createPanel();
      await provider.resolveCustomEditor(documentAt(join(dir, 'gone', flavour.file)), panel);
      await post({ type: 'ready' });

      await post({ type: 'readFile' });

      const html = renders().at(-1)!.html!;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(html).not.toContain('could not preview');
      expect(html).not.toContain('mc-info-waiting');
      expect(html).toContain(sha256);
      if (flavour.kind === 'package') {
        expect(html).toContain(formatBytes(777));
      }
    });

    it('shows the reader note when it could not hash', async () => {
      const provider = flavour.make();
      withSpy(provider, async (request) => {
        const result = await runFileInfoTask({
          kind: request.kind,
          fileName: request.fileName,
          bytes: flavour.valid(),
        });
        return result.ok
          ? { ...result, digest: { size: 5, hashNote: 'Could not be computed' } }
          : result;
      });
      const { panel, post, renders } = createPanel();
      await provider.resolveCustomEditor(documentAt(join(dir, 'gone', flavour.file)), panel);
      await post({ type: 'ready' });
      await post({ type: 'readFile' });

      expect(renders().at(-1)!.html).toContain('Could not be computed');
    });

    it('gives the reader a time allowance that grows with the size of the file', async () => {
      const allowanceFor = async (size: number): Promise<number | undefined> => {
        vi.mocked(vs.workspace.fs.stat).mockResolvedValue({ size } as vscode.FileStat);
        const provider = flavour.make();
        const spy = withSpy(provider);
        const { panel, post } = createPanel();
        await provider.resolveCustomEditor(
          documentAt(fileWith(flavour.file, flavour.valid())),
          panel,
        );
        await post({ type: 'ready' });
        await post({ type: 'readFile' });
        return spy.mock.calls[0][1];
      };

      const small = await allowanceFor(0);
      const large = await allowanceFor(64 * 1024 * 1024);

      expect(small).toBeTypeOf('number');
      expect(large).toBeGreaterThan(small!);
    });
  });
});
