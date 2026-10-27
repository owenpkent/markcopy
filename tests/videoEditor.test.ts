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
import { posix } from 'node:path';

const configUpdate = vi.hoisted(() => vi.fn(async () => undefined));
// Files by path; a path not listed does not exist.
const files = vi.hoisted(() => new Map<string, string>());
const watcher = vi.hoisted(() => ({
  onDidChange: vi.fn(),
  onDidCreate: vi.fn(),
  onDidDelete: vi.fn(),
  dispose: vi.fn(),
}));
const reviewSetting = vi.hoisted(() => ({ on: false }));

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
        asUri(posix.normalize(`${base.path}/${segments.join('/')}`)),
    },
    RelativePattern: class {
      constructor(
        public base: unknown,
        public pattern: string,
      ) {}
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    env: { openExternal: vi.fn(), clipboard: { writeText: vi.fn(async () => undefined) } },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: (key: string, fallback: unknown) =>
          key === 'video.transcode' ? 'auto' : key === 'video.review' ? reviewSetting.on : fallback,
        inspect: () => undefined,
        update: configUpdate,
      })),
      createFileSystemWatcher: vi.fn(() => watcher),
      fs: {
        stat: vi.fn(async () => ({ size: 1 })),
        readFile: vi.fn(async (uri: { path: string }) => {
          const text = files.get(uri.path);
          if (text === undefined) {
            throw new Error('ENOENT');
          }
          return Buffer.from(text);
        }),
        writeFile: vi.fn(async (uri: { path: string }, data: Uint8Array) => {
          files.set(uri.path, Buffer.from(data).toString('utf8'));
        }),
        rename: vi.fn(async (from: { path: string }, to: { path: string }) => {
          files.set(to.path, files.get(from.path) ?? '');
          files.delete(from.path);
        }),
        delete: vi.fn(async (uri: { path: string }) => {
          files.delete(uri.path);
        }),
      },
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

import { isViewerSetting, VideoEditorProvider } from '../src/videoEditor';
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
      avgFrameRate: 24,
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

describe('VideoEditorProvider container offers', () => {
  const probeOf = (over: Record<string, unknown>) => ({
    durationSec: 5,
    width: 1920,
    height: 1080,
    frameRate: 24,
    avgFrameRate: 24,
    hasAlpha: false,
    hasAudio: true,
    audioCodec: 'aac',
    codec: 'h264',
    profile: '',
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tools.findFfmpeg.mockResolvedValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
    tools.transcode.mockResolvedValue(undefined);
    tools.ensureProxyDir.mockResolvedValue('/proxies');
    tools.removeQuietly.mockResolvedValue(undefined);
    tools.proxyDir.mockReturnValue('/proxies');
  });

  async function open(file: string) {
    const provider = new VideoEditorProvider({
      extensionUri: { path: '/ext', fsPath: '/ext' },
    } as unknown as vscode.ExtensionContext);
    const document = provider.openCustomDocument({
      path: `/videos/${file}`,
      fsPath: `/videos/${file}`,
    } as vscode.Uri);
    const harness = createPanel();
    await provider.resolveCustomEditor(document, harness.panel);
    return harness;
  }

  // The offer reads the transcode mode on its first configuration lookup after
  // the panel opens, so a one-shot override is enough to put it in `ask`.
  async function askMode(): Promise<void> {
    const vs = await import('vscode');
    vi.mocked(vs.workspace.getConfiguration).mockImplementationOnce(
      () =>
        ({
          get: (key: string, fallback: unknown) => (key === 'video.transcode' ? 'ask' : fallback),
          inspect: () => undefined,
          update: configUpdate,
        }) as never,
    );
  }

  it('flags a remuxable codec in the ask message, with the codec named', async () => {
    tools.probeSource.mockResolvedValue(probeOf({ codec: 'h264' }));
    const { posted, send } = await open('clip.mkv');
    await askMode();
    await send({ type: 'proxyRequest' });
    expect(posted.find((m) => m.state === 'ask')).toMatchObject({
      type: 'proxy',
      codec: 'H.264',
      remux: true,
    });
  });

  it('does not flag a codec that has to be re-encoded', async () => {
    tools.probeSource.mockResolvedValue(probeOf({ codec: 'vp8' }));
    const { posted, send } = await open('clip.webm');
    await askMode();
    await send({ type: 'proxyRequest' });
    expect(posted.find((m) => m.state === 'ask')).toMatchObject({ codec: 'VP8', remux: false });
  });

  it('repackages an H.264 mkv and says so in the status note', async () => {
    tools.probeSource.mockResolvedValue(probeOf({ codec: 'h264' }));
    const { posted, send } = await open('clip.mkv');
    await send({ type: 'proxyRequest' });
    const last = posted.filter((m) => m.type === 'load').at(-1);
    expect(last?.proxyNote).toBe('ffmpeg copy · repackaged as MP4');
    expect(last?.name).toBe('clip.mkv');
  });

  it('keeps the preview-copy note for a full re-encode', async () => {
    tools.probeSource.mockResolvedValue(probeOf({ codec: 'wmv2' }));
    const { posted, send } = await open('clip.wmv');
    await send({ type: 'proxyRequest' });
    expect(posted.filter((m) => m.type === 'load').at(-1)?.proxyNote).toBe('ffmpeg preview copy');
  });
});

describe('isViewerSetting', () => {
  it('accepts video.review booleans only', () => {
    expect(isViewerSetting('video.review', true)).toBe(true);
    expect(isViewerSetting('video.review', false)).toBe(true);
    expect(isViewerSetting('video.review', 'true')).toBe(false);
    expect(isViewerSetting('video.review', 1)).toBe(false);
    expect(isViewerSetting('video.ffmpegPath', true)).toBe(false);
  });
});

describe('VideoEditorProvider review mode', () => {
  const SIDECAR = `version: 1
source: clip.mp4
fps: 25
notes:
  - id: n1
    target: source
    at: 1
    kind: note
    text: Soft focus.
    done: false
    created: '2026-01-02T03:04:05'
`;

  beforeEach(() => {
    vi.clearAllMocks();
    files.clear();
    reviewSetting.on = false;
    tools.findFfmpeg.mockResolvedValue({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
    tools.probeSource.mockResolvedValue({
      durationSec: 5,
      width: 1920,
      height: 1080,
      frameRate: 60,
      avgFrameRate: 29.97,
      hasAlpha: false,
      hasAudio: false,
      audioCodec: '',
      codec: 'h264',
      profile: '',
    });
    tools.proxyDir.mockReturnValue('/proxies');
  });

  async function open() {
    const provider = new VideoEditorProvider({
      extensionUri: { path: '/ext', fsPath: '/ext' },
    } as unknown as vscode.ExtensionContext);
    const document = provider.openCustomDocument({
      path: '/videos/clip.mp4',
      fsPath: '/videos/clip.mp4',
    } as vscode.Uri);
    const harness = createPanel();
    await provider.resolveCustomEditor(document, harness.panel);
    return harness;
  }

  const reviews = (posted: Array<Record<string, unknown>>) =>
    posted.filter((m) => m.type === 'review');

  it('stays a plain preview without a sidecar or the setting', async () => {
    const { posted, send } = await open();
    await send({ type: 'ready' });
    expect(reviews(posted)).toHaveLength(0);
    expect(tools.probeSource).not.toHaveBeenCalled();
  });

  it('turns on for a sidecar, using its fps without probing', async () => {
    files.set('/videos/clip.review.yaml', SIDECAR);
    const { posted, send } = await open();
    await send({ type: 'ready' });
    expect(reviews(posted)).toMatchObject([
      { fps: 25, fpsSource: 'sidecar', sidecar: 'clip.review.yaml', readOnly: null },
    ]);
    expect(tools.probeSource).not.toHaveBeenCalled();
  });

  it('turns on from reviewEnable, pending until the probe lands', async () => {
    const { posted, send } = await open();
    await send({ type: 'ready' });
    await send({ type: 'reviewEnable' });
    await vi.waitFor(() => expect(reviews(posted)).toHaveLength(2));
    expect(reviews(posted)[0]).toMatchObject({ fpsSource: 'pending', sidecar: null, notes: [] });
    expect(reviews(posted)[1]).toMatchObject({ fpsSource: 'probe' });
    expect(reviews(posted)[1].fps).toBeCloseTo(29.97, 2);
  });

  it('turns on from the setting and probes even with transcoding off', async () => {
    const vs = await import('vscode');
    vi.mocked(vs.workspace.getConfiguration).mockImplementation(
      () =>
        ({
          get: (key: string, fallback: unknown) =>
            key === 'video.transcode' ? 'off' : key === 'video.review' ? true : fallback,
          inspect: () => undefined,
          update: configUpdate,
        }) as never,
    );
    const { posted, send } = await open();
    await send({ type: 'ready' });
    await vi.waitFor(() => expect(reviews(posted).at(-1)).toMatchObject({ fpsSource: 'probe' }));
  });

  it('assumes 30 when ffmpeg is missing', async () => {
    tools.findFfmpeg.mockResolvedValue(undefined);
    const { posted, send } = await open();
    await send({ type: 'ready' });
    await send({ type: 'reviewEnable' });
    await vi.waitFor(() =>
      expect(reviews(posted).at(-1)).toMatchObject({ fps: 30, fpsSource: 'assumed' }),
    );
  });

  it('reloads when the sidecar changes', async () => {
    files.set('/videos/clip.review.yaml', SIDECAR);
    const { posted, send } = await open();
    await send({ type: 'ready' });
    const onChange = watcher.onDidChange.mock.calls[0][0] as () => void;
    files.set('/videos/clip.review.yaml', 'version: 2\nsource: clip.mp4\nfps: 25\n');
    onChange();
    await vi.waitFor(() => expect(reviews(posted)).toHaveLength(2));
    expect(reviews(posted)[1].readOnly).toMatch(/Version 2/);
  });

  it('copies the notes: writes the markdown atomically, clipboard, toast', async () => {
    files.set('/videos/clip.review.yaml', SIDECAR);
    const { posted, send } = await open();
    await send({ type: 'ready' });
    await send({ type: 'reviewCopy' });
    const md = files.get('/videos/clip.review.md');
    expect(md).toContain('## n1  00:00:01:00  note');
    expect([...files.keys()].filter((k) => k.endsWith('.tmp'))).toEqual([]);
    const vs = await import('vscode');
    expect(vs.env.clipboard.writeText).toHaveBeenCalledWith(md);
    expect(posted.at(-1)).toEqual({
      type: 'toast',
      message: 'Copied 1 note, saved clip.review.md',
    });
  });

  it('reports an error instead of creating a file when there is no sidecar', async () => {
    const { posted, send } = await open();
    await send({ type: 'ready' });
    await send({ type: 'reviewCopy' });
    expect(posted.at(-1)?.type).toBe('reviewError');
    expect(files.size).toBe(0);
  });
});
