// @vitest-environment node
//
// Regression coverage for the sound copy surviving a webview reload in
// src/videoEditor.ts. A reload inside the same panel starts over from `ready`
// and, once the original reports `playable` again, finds the session's one
// sound offer already spent. Before the fix `ready` always loaded the original,
// so the reader was left with the silent file and the finished copy sat unused
// on disk.
//
// vscode is mocked for the same reason as tests/ooxmlEditor.test.ts (and needs
// the node environment for the reason given in tests/externalLink.test.ts):
// each stand-in is just enough to let resolveCustomEditor run. The ffmpeg side
// of src/videoProxy.ts is replaced so no process is spawned, while the pure
// helpers (silentAudio and the label functions) stay real, so the probe below
// has to look silent to the real predicate for the sound offer to be made.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const configUpdate = vi.hoisted(() => vi.fn(async () => undefined));

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
        get: (key: string, fallback: unknown) => (key === 'video.transcode' ? 'auto' : fallback),
        inspect: () => undefined,
        update: configUpdate,
      })),
      fs: { stat: vi.fn(async () => ({ size: 1 })) },
      onDidChangeConfiguration: vi.fn(() => ({ dispose: () => undefined })),
    },
    window: { showSaveDialog: vi.fn(), showErrorMessage: vi.fn() },
  };
});

const tools = vi.hoisted(() => ({
  findFfmpeg: vi.fn(),
  probeSource: vi.fn(),
  transcode: vi.fn(),
  ensureProxyDir: vi.fn(),
  removeQuietly: vi.fn(),
  proxyDir: vi.fn(),
}));

vi.mock('../src/videoProxy', async (importOriginal) => ({
  ...(await importOriginal<typeof VideoProxy>()),
  ...tools,
}));

import { VideoEditorProvider } from '../src/videoEditor';
import type * as vscode from 'vscode';
import type * as VideoProxy from '../src/videoProxy';

/** A fake panel whose webview records what the host posts and replays what it is sent. */
function createPanel(): {
  panel: vscode.WebviewPanel;
  posted: Array<Record<string, unknown>>;
  send: (msg: unknown) => Promise<void>;
} {
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
    posted,
    send: async (msg: unknown) => {
      await handler?.(msg);
    },
  };
}

describe('VideoEditorProvider sound copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tools.findFfmpeg.mockResolvedValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
    tools.probeSource.mockResolvedValue({
      durationSec: 5,
      width: 1920,
      height: 1080,
      frameRate: 24,
      hasAlpha: false,
      hasAudio: true,
      audioCodec: 'aac',
      codec: 'h264',
      profile: 'High',
    });
    tools.transcode.mockResolvedValue(undefined);
    tools.ensureProxyDir.mockResolvedValue('/proxies');
    tools.removeQuietly.mockResolvedValue(undefined);
    tools.proxyDir.mockReturnValue('/proxies');
  });

  it('restores the finished sound copy when the webview reloads', async () => {
    const provider = new VideoEditorProvider({
      extensionUri: { path: '/ext', fsPath: '/ext' },
    } as unknown as vscode.ExtensionContext);
    const document = provider.openCustomDocument({
      path: '/videos/clip.mp4',
      fsPath: '/videos/clip.mp4',
    } as vscode.Uri);
    const { panel, posted, send } = createPanel();
    await provider.resolveCustomEditor(document, panel);

    // First life of the webview: the original loads, reports itself playable,
    // and the host builds the sound copy and swaps it in.
    await send({ type: 'ready' });
    await send({ type: 'playable' });
    const loads = () => posted.filter((m) => m.type === 'load');
    expect(loads()).toHaveLength(2);
    expect(loads()[0].src).toBe('webview:/videos/clip.mp4');
    expect(loads()[0].proxyNote).toBeUndefined();

    // The webview reloads: back to `ready`, and the original plays again.
    await send({ type: 'ready' });
    await send({ type: 'playable' });

    const last = loads().at(-1);
    expect(last?.src).toMatch(/^webview:[\\/]proxies[\\/]clip-/);
    expect(last?.src).not.toBe('webview:/videos/clip.mp4');
    expect(last?.proxyNote).toBe('ffmpeg copy · sound re-encoded to MP3');
    // The second `playable` is the spent offer, not a second encode.
    expect(tools.transcode).toHaveBeenCalledTimes(1);
  });

  it('writes only the settings the viewer menus can send', async () => {
    const provider = new VideoEditorProvider({
      extensionUri: { path: '/ext', fsPath: '/ext' },
    } as unknown as vscode.ExtensionContext);
    const document = provider.openCustomDocument({
      path: '/videos/clip.mp4',
      fsPath: '/videos/clip.mp4',
    } as vscode.Uri);
    const { panel, send } = createPanel();
    await provider.resolveCustomEditor(document, panel);

    // The ffmpeg path is executed by the host later, so a webview must not set it.
    await send({ type: 'updateSetting', key: 'video.ffmpegPath', value: 'C:/evil.exe' });
    await send({ type: 'updateSetting', key: 'video.autoplay', value: 'yes' });
    await send({ type: 'updateSetting', key: 'theme', value: 'neon' });
    expect(configUpdate).not.toHaveBeenCalled();

    await send({ type: 'updateSetting', key: 'video.autoplay', value: true });
    await send({ type: 'updateSetting', key: 'video.loop', value: false });
    await send({ type: 'updateSetting', key: 'theme', value: 'dark' });
    expect(configUpdate).toHaveBeenCalledTimes(3);
    expect(configUpdate).toHaveBeenCalledWith('video.autoplay', true, 1);
  });
});
