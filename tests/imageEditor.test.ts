// @vitest-environment node
//
// Host-side coverage for src/imageEditor.ts: which settings the viewer's menu may
// write, and what the saveFrame handler accepts. vscode is mocked just enough
// for resolveCustomEditor to run, as in tests/videoEditor.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const configUpdate = vi.hoisted(() => vi.fn(async () => undefined));
const showSaveDialog = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn(async () => undefined));
const stat = vi.hoisted(() => vi.fn(async () => ({ size: 3 })));
const watcherHooks = vi.hoisted(() => ({
  change: undefined as undefined | (() => void),
  create: undefined as undefined | (() => void),
  remove: undefined as undefined | (() => void),
  dispose: undefined as undefined | (() => void),
  pattern: undefined as unknown,
}));
const readFile = vi.hoisted(() => vi.fn(async () => Uint8Array.from([0x47, 0x49, 0x46])));

vi.mock('vscode', () => {
  const asUri = (fsPath: string) => ({
    fsPath,
    path: fsPath,
    with: () => asUri(fsPath),
    toString: () => fsPath,
  });
  return {
    Uri: {
      file: (fsPath: string) => asUri(fsPath),
      joinPath: (base: { path: string }, ...segments: string[]) =>
        asUri(`${base.path}/${segments.join('/')}`),
    },
    RelativePattern: class {
      constructor(
        public base: unknown,
        public pattern: string,
      ) {}
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    env: { openExternal: vi.fn() },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: (_key: string, fallback: unknown) => fallback,
        inspect: () => undefined,
        update: configUpdate,
      })),
      getWorkspaceFolder: vi.fn((uri: { fsPath: string }) =>
        uri.fsPath.startsWith('/ws/') ? { uri: { fsPath: '/ws' } } : undefined,
      ),
      asRelativePath: vi.fn((uri: { fsPath: string }) => uri.fsPath.replace('/ws/', '')),
      fs: { stat, readFile, writeFile },
      createFileSystemWatcher: vi.fn((pattern: unknown) => {
        watcherHooks.pattern = pattern;
        const dispose = vi.fn();
        watcherHooks.dispose = dispose;
        const hook = (key: 'change' | 'create' | 'remove') => (cb: () => void) => {
          watcherHooks[key] = cb;
          return { dispose: () => undefined };
        };
        return {
          onDidChange: hook('change'),
          onDidCreate: hook('create'),
          onDidDelete: hook('remove'),
          dispose,
        };
      }),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: () => undefined })),
    },
    window: { showSaveDialog, showErrorMessage: vi.fn() },
  };
});

import { ImageEditorProvider, isImageSetting } from '../src/imageEditor';
import type * as vscode from 'vscode';

function createPanel() {
  let handler: ((msg: unknown) => unknown) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: (uri: { fsPath: string }) => ({
      with: () => ({ toString: () => `webview:${uri.fsPath}` }),
      toString: () => `webview:${uri.fsPath}`,
    }),
    postMessage: vi.fn(async (msg: Record<string, unknown>) => {
      posted.push(msg);
      return true;
    }),
    onDidReceiveMessage: (cb: (msg: unknown) => unknown) => {
      handler = cb;
      return { dispose: () => undefined };
    },
  };
  let onDispose: (() => void) | undefined;
  const panel = {
    webview,
    onDidDispose: (cb: () => void) => {
      onDispose = cb;
      return { dispose: () => undefined };
    },
  };
  return {
    panel: panel as unknown as vscode.WebviewPanel,
    webview,
    posted,
    dispose: () => onDispose?.(),
    send: async (msg: unknown) => {
      await handler?.(msg);
    },
  };
}

async function open(fsPath = '/pics/shot.png') {
  const provider = new ImageEditorProvider({
    extensionUri: { path: '/ext', fsPath: '/ext' },
  } as unknown as vscode.ExtensionContext);
  const document = provider.openCustomDocument({
    path: fsPath,
    fsPath,
  } as vscode.Uri);
  const harness = createPanel();
  await provider.resolveCustomEditor(document, harness.panel);
  return harness;
}

beforeEach(() => {
  vi.clearAllMocks();
  stat.mockResolvedValue({ size: 3 });
});

describe('isImageSetting', () => {
  it('allows a valid theme and a valid background, and nothing else', () => {
    expect(isImageSetting('theme', 'dark')).toBe(true);
    expect(isImageSetting('theme', 'neon')).toBe(false);
    expect(isImageSetting('theme', 1)).toBe(false);
    for (const value of ['checkerboard', 'light', 'dark', 'theme']) {
      expect(isImageSetting('image.background', value)).toBe(true);
    }
    expect(isImageSetting('image.background', 'pink')).toBe(false);
    expect(isImageSetting('image.background', true)).toBe(false);
    expect(isImageSetting('video.loop', true)).toBe(false);
    expect(isImageSetting('video.ffmpegPath', 'C:/evil.exe')).toBe(false);
  });
});

describe('ImageEditorProvider', () => {
  it('writes only the theme and the background', async () => {
    const { send } = await open();
    await send({ type: 'updateSetting', key: 'video.ffmpegPath', value: 'C:/evil.exe' });
    await send({ type: 'updateSetting', key: 'video.loop', value: true });
    await send({ type: 'updateSetting', key: 'theme', value: 'neon' });
    await send({ type: 'updateSetting', key: 'image.background', value: 'neon' });
    expect(configUpdate).not.toHaveBeenCalled();

    await send({ type: 'updateSetting', key: 'theme', value: 'green' });
    await send({ type: 'updateSetting', key: 'image.background', value: 'dark' });
    expect(configUpdate).toHaveBeenCalledTimes(2);
    expect(configUpdate).toHaveBeenCalledWith('theme', 'green', 1);
    expect(configUpdate).toHaveBeenCalledWith('image.background', 'dark', 1);
  });

  it('sends the file as base64 with its name, path and size', async () => {
    const { send, posted } = await open();
    await send({ type: 'ready' });
    expect(posted.find((m) => m.type === 'load')).toEqual({
      type: 'load',
      name: 'shot.png',
      path: '/pics/shot.png',
      relativePath: 'shot.png',
      background: 'checkerboard',
      size: 3,
      data: 'R0lG',
    });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('sends a workspace-relative path for a file inside a workspace folder', async () => {
    const { send, posted } = await open('/ws/docs/img/shot.png');
    await send({ type: 'ready' });
    expect(posted.find((m) => m.type === 'load')).toMatchObject({
      name: 'shot.png',
      relativePath: 'docs/img/shot.png',
    });
  });

  it('refuses a file above the size cap without reading it', async () => {
    stat.mockResolvedValue({ size: 65 * 1024 * 1024 });
    const { send, posted } = await open();
    await send({ type: 'ready' });
    expect(readFile).not.toHaveBeenCalled();
    expect(posted.find((m) => m.type === 'error')?.message).toContain('limit for image previews');
  });

  it('ignores a saveFrame with no data', async () => {
    const { send } = await open();
    await send({ type: 'saveFrame', name: 'a.png' });
    await send({ type: 'saveFrame', name: 'a.png', data: '' });
    await send({ type: 'saveFrame', name: 'a.png', data: 42 });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('saves a PNG beside the image and confirms it', async () => {
    showSaveDialog.mockResolvedValue({ path: '/pics/out.png' });
    const { send, posted } = await open();
    await send({ type: 'saveFrame', name: 'shot-copy.png', data: 'iVBORw0K' });
    expect(showSaveDialog.mock.calls[0][0].defaultUri.path).toContain('shot-copy.png');
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual({ type: 'toast', message: 'Frame saved' });
  });

  it('writes nothing when the save dialog is cancelled', async () => {
    showSaveDialog.mockResolvedValue(undefined);
    const { send } = await open();
    await send({ type: 'saveFrame', name: 'a.png', data: 'iVBORw0K' });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('serves a page whose CSP has no media-src and a nonced script', async () => {
    const { webview } = await open();
    expect(webview.html).toMatch(/script-src 'nonce-[^']+'/);
    expect(webview.html).not.toContain('media-src');
    expect(webview.html).toContain('img-src vscode-resource: blob: data:');
    expect(webview.html).not.toContain('connect-src');
    expect(webview.html).toContain('<div id="app"></div>');
    expect(webview.html).toContain('image.js');
  });

  it('links preview.css, which styles the context menu and toast', async () => {
    const { webview } = await open();
    expect(webview.html).toMatch(/<link href="[^"]*preview\.css[^"]*" rel="stylesheet"/);
  });

  describe('file watching', () => {
    it('watches exactly this file, by folder and base name', async () => {
      await open('/pics/shot.png');
      expect(watcherHooks.pattern).toMatchObject({ pattern: 'shot.png' });
    });

    it('reloads once when the file changes, however many events arrive', async () => {
      vi.useFakeTimers();
      try {
        const { send, posted } = await open();
        await send({ type: 'ready' });
        expect(posted.filter((m) => m.type === 'load')).toHaveLength(1);

        readFile.mockResolvedValueOnce(Uint8Array.from([1, 2, 3, 4]));
        stat.mockResolvedValue({ size: 4 });
        watcherHooks.change?.();
        watcherHooks.change?.();
        watcherHooks.create?.();
        await vi.advanceTimersByTimeAsync(150);
        const loads = posted.filter((m) => m.type === 'load');
        expect(loads).toHaveLength(2);
        expect(loads[1]).toMatchObject({ size: 4, data: 'AQIDBA==' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a deleted file', async () => {
      const { posted } = await open('/pics/gone.png');
      watcherHooks.remove?.();
      expect(posted).toContainEqual({ type: 'error', message: 'gone.png was deleted.' });
    });

    it('disposes the watcher with the panel and drops a pending reload', async () => {
      vi.useFakeTimers();
      try {
        const { posted, dispose } = await open();
        watcherHooks.change?.();
        dispose();
        await vi.advanceTimersByTimeAsync(150);
        expect(watcherHooks.dispose).toHaveBeenCalledTimes(1);
        expect(posted.filter((m) => m.type === 'load')).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
