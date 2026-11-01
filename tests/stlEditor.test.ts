// @vitest-environment node
//
// Host-side coverage for src/stlEditor.ts: which settings the viewer's menu may
// write, what the saveFrame handler accepts, and what the load message carries. vscode is mocked just enough
// for resolveCustomEditor to run, as in tests/videoEditor.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const configUpdate = vi.hoisted(() => vi.fn(async () => undefined));
const showSaveDialog = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn(async () => undefined));
const stat = vi.hoisted(() => vi.fn(async () => ({ size: 3 })));
const TRIANGLE = [
  'solid t',
  'facet normal 0 0 1',
  'outer loop',
  'vertex 0 0 0',
  'vertex 1 0 0',
  'vertex 0 1 0',
  'endloop',
  'endfacet',
  'endsolid t',
  '',
].join('\n');
const readFile = vi.hoisted(() => vi.fn(async () => new Uint8Array()));

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

import { StlEditorProvider, isStlSetting } from '../src/stlEditor';
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
  const provider = new StlEditorProvider({
    extensionUri: { path: '/ext', fsPath: '/ext' },
  } as unknown as vscode.ExtensionContext);
  const document = provider.openCustomDocument({
    path: '/models/part.stl',
    fsPath: '/models/part.stl',
  } as vscode.Uri);
  const harness = createPanel();
  await provider.resolveCustomEditor(document, harness.panel);
  return harness;
}

beforeEach(() => {
  vi.clearAllMocks();
  readFile.mockResolvedValue(new Uint8Array(Buffer.from(TRIANGLE)));
  stat.mockResolvedValue({ size: TRIANGLE.length });
});

describe('isStlSetting', () => {
  it('allows only a valid theme', () => {
    expect(isStlSetting('theme', 'dark')).toBe(true);
    expect(isStlSetting('theme', 'neon')).toBe(false);
    expect(isStlSetting('theme', 1)).toBe(false);
    expect(isStlSetting('video.loop', true)).toBe(false);
    expect(isStlSetting('video.ffmpegPath', 'C:/evil.exe')).toBe(false);
  });
});

describe('StlEditorProvider', () => {
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

  it('sends the file as base64 with its name, full path and colors', async () => {
    const { send, posted } = await open();
    await send({ type: 'ready' });
    expect(posted.find((m) => m.type === 'load')).toEqual({
      type: 'load',
      name: 'part.stl',
      path: '/models/part.stl',
      bytes: Buffer.from(TRIANGLE).toString('base64'),
      showGrid: true,
      meshColor: '#8ab4f8',
    });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('refuses a file above the size cap without reading it, still naming it', async () => {
    stat.mockResolvedValue({ size: 300 * 1024 * 1024 });
    const { send, posted } = await open();
    await send({ type: 'ready' });
    expect(readFile).not.toHaveBeenCalled();
    const error = posted.find((m) => m.type === 'error');
    expect(error?.message).toContain('limit for STL previews');
    expect(error).toMatchObject({ name: 'part.stl', path: '/models/part.stl' });
  });

  it('reports a file STL cannot be, with its name and path', async () => {
    readFile.mockResolvedValue(new Uint8Array(Buffer.from('not an stl at all')));
    const { send, posted } = await open();
    await send({ type: 'ready' });
    expect(posted.find((m) => m.type === 'load')).toBeUndefined();
    expect(posted.find((m) => m.type === 'error')).toMatchObject({
      name: 'part.stl',
      path: '/models/part.stl',
    });
  });

  it('names the file in the error when it cannot be read', async () => {
    stat.mockRejectedValue(new Error('gone'));
    const { send, posted } = await open();
    await send({ type: 'ready' });
    expect(posted.find((m) => m.type === 'error')).toMatchObject({
      name: 'part.stl',
      path: '/models/part.stl',
    });
  });

  it('ignores a saveFrame with no data', async () => {
    const { send } = await open();
    await send({ type: 'saveFrame', name: 'a.png' });
    await send({ type: 'saveFrame', name: 'a.png', data: '' });
    await send({ type: 'saveFrame', name: 'a.png', data: 42 });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('saves a view beside the model and confirms it', async () => {
    showSaveDialog.mockResolvedValue({ path: '/pics/out.png' });
    const { send, posted } = await open();
    await send({ type: 'saveFrame', name: 'part.png', data: 'iVBORw0K' });
    expect(showSaveDialog.mock.calls[0][0].defaultUri.path).toContain('part.png');
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual({ type: 'toast', message: 'Frame saved' });
  });

  it('writes nothing when the save dialog is cancelled', async () => {
    showSaveDialog.mockResolvedValue(undefined);
    const { send } = await open();
    await send({ type: 'saveFrame', name: 'a.png', data: 'iVBORw0K' });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('serves a page whose CSP is tight, with the menu and toast roots', async () => {
    const { webview } = await open();
    expect(webview.html).toMatch(/script-src 'nonce-[^']+'/);
    expect(webview.html).toContain("default-src 'none'");
    expect(webview.html).not.toContain('media-src');
    expect(webview.html).not.toContain('img-src');
    expect(webview.html).toContain('id="viewport"');
    expect(webview.html).toContain('id="mc-menu"');
    expect(webview.html).toContain('id="mc-toast"');
  });

  it('links preview.css, which styles the context menu and toast', async () => {
    const { webview } = await open();
    expect(webview.html).toMatch(/<link href="[^"]*preview\.css[^"]*" rel="stylesheet"/);
  });
});
