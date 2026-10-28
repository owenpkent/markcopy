// @vitest-environment node
//
// Host-side coverage for src/gifEditor.ts: which settings the viewer's menu may
// write, and what the saveFrame handler accepts. vscode is mocked just enough
// for resolveCustomEditor to run, as in tests/videoEditor.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const configUpdate = vi.hoisted(() => vi.fn(async () => undefined));
const showSaveDialog = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn(async () => undefined));
const stat = vi.hoisted(() => vi.fn(async () => ({ size: 3 })));
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
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    env: { openExternal: vi.fn() },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: (_key: string, fallback: unknown) => fallback,
        inspect: () => undefined,
        update: configUpdate,
      })),
      fs: { stat, readFile, writeFile },
      onDidChangeConfiguration: vi.fn(() => ({ dispose: () => undefined })),
    },
    window: { showSaveDialog, showErrorMessage: vi.fn() },
  };
});

import { GifEditorProvider, isGifSetting } from '../src/gifEditor';
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
  const panel = { webview, onDidDispose: () => ({ dispose: () => undefined }) };
  return {
    panel: panel as unknown as vscode.WebviewPanel,
    webview,
    posted,
    send: async (msg: unknown) => {
      await handler?.(msg);
    },
  };
}

async function open() {
  const provider = new GifEditorProvider({
    extensionUri: { path: '/ext', fsPath: '/ext' },
  } as unknown as vscode.ExtensionContext);
  const document = provider.openCustomDocument({
    path: '/pics/anim.gif',
    fsPath: '/pics/anim.gif',
  } as vscode.Uri);
  const harness = createPanel();
  await provider.resolveCustomEditor(document, harness.panel);
  return harness;
}

beforeEach(() => {
  vi.clearAllMocks();
  stat.mockResolvedValue({ size: 3 });
});

describe('isGifSetting', () => {
  it('allows only a valid theme', () => {
    expect(isGifSetting('theme', 'dark')).toBe(true);
    expect(isGifSetting('theme', 'neon')).toBe(false);
    expect(isGifSetting('theme', 1)).toBe(false);
    expect(isGifSetting('video.loop', true)).toBe(false);
    expect(isGifSetting('video.ffmpegPath', 'C:/evil.exe')).toBe(false);
  });
});

describe('GifEditorProvider', () => {
  it('writes only the theme setting', async () => {
    const { send } = await open();
    await send({ type: 'updateSetting', key: 'video.ffmpegPath', value: 'C:/evil.exe' });
    await send({ type: 'updateSetting', key: 'video.loop', value: true });
    await send({ type: 'updateSetting', key: 'theme', value: 'neon' });
    expect(configUpdate).not.toHaveBeenCalled();

    await send({ type: 'updateSetting', key: 'theme', value: 'green' });
    expect(configUpdate).toHaveBeenCalledTimes(1);
    expect(configUpdate).toHaveBeenCalledWith('theme', 'green', 1);
  });

  it('sends the file as base64 with its name, path and size', async () => {
    const { send, posted } = await open();
    await send({ type: 'ready' });
    expect(posted.find((m) => m.type === 'load')).toEqual({
      type: 'load',
      name: 'anim.gif',
      path: '/pics/anim.gif',
      size: 3,
      data: 'R0lG',
    });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('refuses a file above the size cap without reading it', async () => {
    stat.mockResolvedValue({ size: 65 * 1024 * 1024 });
    const { send, posted } = await open();
    await send({ type: 'ready' });
    expect(readFile).not.toHaveBeenCalled();
    expect(posted.find((m) => m.type === 'error')?.message).toContain('limit for GIF previews');
  });

  it('ignores a saveFrame with no data', async () => {
    const { send } = await open();
    await send({ type: 'saveFrame', name: 'a.png' });
    await send({ type: 'saveFrame', name: 'a.png', data: '' });
    await send({ type: 'saveFrame', name: 'a.png', data: 42 });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('saves a frame beside the GIF and confirms it', async () => {
    showSaveDialog.mockResolvedValue({ path: '/pics/out.png' });
    const { send, posted } = await open();
    await send({ type: 'saveFrame', name: 'anim-frame-003.png', data: 'iVBORw0K' });
    expect(showSaveDialog.mock.calls[0][0].defaultUri.path).toContain('anim-frame-003.png');
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
    expect(webview.html).toContain('id="mc-canvas"');
  });

  it('links preview.css, which styles the context menu and toast', async () => {
    const { webview } = await open();
    expect(webview.html).toMatch(/<link href="[^"]*preview\.css[^"]*" rel="stylesheet"/);
  });
});
