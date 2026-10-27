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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
// An error for the next readFile to throw, once: a transient failure on a file that is there.
const readFailure = vi.hoisted(() => ({ next: undefined as Error | undefined }));

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
          if (readFailure.next) {
            const err = readFailure.next;
            readFailure.next = undefined;
            throw err;
          }
          const text = files.get(uri.path);
          if (text === undefined) {
            // What a provider throws for a missing file: vscode.FileSystemError.FileNotFound.
            throw Object.assign(new Error('FileNotFound'), { code: 'FileNotFound' });
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
    readFailure.next = undefined;
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
    // The review setting is left on by an earlier test, so a probe's `review` may land after.
    expect(posted.filter((m) => m.type === 'reviewError')).toHaveLength(1);
    expect(files.size).toBe(0);
  });
});

describe('VideoEditorProvider review edits', () => {
  const SIDECAR = `version: 1
id: aaaaaaaaaaaa
source: clip.mp4
fps: 25.0
next_note_id: 2
asset:
  rating: 0
  status: none
  keywords: []
  notes: ''
notes:
- id: n1
  target: source
  at: 1.0
  kind: note
  text: Soft focus.
  done: false
  applied_op: null
  checkpoint: null
  drawing: []
  created: '2026-01-02T03:04:05'
`;
  const YAML = '/videos/clip.review.yaml';
  const MD = '/videos/clip.review.md';

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
      avgFrameRate: 24,
      hasAlpha: false,
      hasAudio: false,
      audioCodec: '',
      codec: 'h264',
      profile: '',
    });
    tools.proxyDir.mockReturnValue('/proxies');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function open(sidecar?: string) {
    if (sidecar !== undefined) {
      files.set(YAML, sidecar);
    }
    const provider = new VideoEditorProvider({
      extensionUri: { path: '/ext', fsPath: '/ext' },
    } as unknown as vscode.ExtensionContext);
    const document = provider.openCustomDocument({
      path: '/videos/clip.mp4',
      fsPath: '/videos/clip.mp4',
    } as vscode.Uri);
    const harness = createPanel();
    await provider.resolveCustomEditor(document, harness.panel);
    await harness.send({ type: 'ready' });
    return harness;
  }

  const lastReview = (posted: Array<Record<string, unknown>>) =>
    posted.filter((m) => m.type === 'review').at(-1) as Record<string, unknown> & {
      notes: Array<{ id: string }>;
    };
  const errors = (posted: Array<Record<string, unknown>>) =>
    posted.filter((m) => m.type === 'reviewError').map((m) => m.message);

  it('adds a note, rewrites the markdown, and says which note is new', async () => {
    const { posted, send } = await open(SIDECAR);
    await send({ type: 'reviewAdd', at: 2.4, text: 'Cut here.' });
    const sidecar = files.get(YAML)!;
    expect(sidecar).toContain('next_note_id: 3\n');
    expect(sidecar).toContain(
      "- id: n2\n  target: source\n  at: 2.4\n  kind: note\n  text: Cut here.\n  done: false\n  applied_op: null\n  checkpoint: null\n  drawing: []\n  created: '2026-01-02T03:04:05'\n",
    );
    expect(files.get(MD)).toContain('## n2  00:00:02:10  note');
    expect([...files.keys()].filter((k) => k.endsWith('.tmp'))).toEqual([]);
    expect(lastReview(posted)).toMatchObject({ added: 'n2', restorable: null });
    expect(lastReview(posted).notes.map((n) => n.id)).toEqual(['n1', 'n2']);
  });

  it('acknowledges a saved note even when the read after the save fails', async () => {
    const { posted, send } = await open(SIDECAR);
    const vs = await import('vscode');
    const rename = vi.mocked(vs.workspace.fs.rename);
    const real = rename.getMockImplementation()!;
    // Let both writes land, then make only the next read fail.
    rename.mockImplementation(async (from, to) => {
      await real(from, to);
      if ((to as { path: string }).path === MD) {
        readFailure.next = Object.assign(new Error('EIO'), { code: 'Unknown' });
      }
    });
    await send({ type: 'reviewAdd', at: 2.4, text: 'Cut here.' });
    rename.mockImplementation(real);
    readFailure.next = undefined;

    expect(files.get(YAML)!.match(/^- id: n2$/gm)).toHaveLength(1);
    expect(posted.filter((m) => m.type === 'review' && m.added === 'n2')).toHaveLength(1);
    expect(failures(posted).filter((m) => m.failed === 'add')).toEqual([]);
    await send({ type: 'reviewEnable' });
    expect(lastReview(posted).notes.map((n) => n.id)).toEqual(['n1', 'n2']);
  });

  it('does not post stale notes when another editor saves during the markdown write', async () => {
    const n2 = (text: string) =>
      `- id: n2\n  target: source\n  at: 4.0\n  kind: note\n  text: ${text}\n  done: false\n  applied_op: null\n  checkpoint: null\n  drawing: []\n  created: '2026-01-02T03:04:05'\n`;
    const two = SIDECAR.replace('next_note_id: 2', 'next_note_id: 3') + n2('Cut this range.');
    const { posted, send } = await open(two);
    const vs = await import('vscode');
    const rename = vi.mocked(vs.workspace.fs.rename);
    const real = rename.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding!: () => void;
    const reachedMd = new Promise<void>((resolve) => {
      holding = resolve;
    });
    rename.mockImplementation(async (from, to) => {
      if ((to as { path: string }).path === MD) {
        holding();
        await held;
      }
      await real(from, to);
    });
    const adding = send({ type: 'reviewAdd', at: 2.4, text: 'Cut here.' });
    await reachedMd;
    // The sidecar is already saved with n3; another editor now changes n2.
    const external = files
      .get(YAML)!
      .replace('Cut this range.', 'External update during markdown save.');
    expect(external).toContain('id: n3');
    files.set(YAML, external);
    (watcher.onDidChange.mock.calls[0][0] as () => void)();
    await vi.waitFor(() =>
      expect(JSON.stringify(lastReview(posted))).toContain('External update during markdown save.'),
    );
    release();
    await adding;
    rename.mockImplementation(real);

    expect(posted.filter((m) => m.type === 'review' && m.added === 'n3')).toHaveLength(1);
    const last = lastReview(posted) as unknown as { notes: Array<{ id: string; text: string }> };
    expect(last.notes.find((n) => n.id === 'n2')?.text).toBe(
      'External update during markdown save.',
    );
    expect(files.get(YAML)).toContain('External update during markdown save.');
    expect(files.get(YAML)).not.toContain('Cut this range.');
  });

  it('writes a pin, cleaned, after out and before nothing else', async () => {
    const { posted, send } = await open(SIDECAR);
    await send({ type: 'reviewAdd', at: 2.4, text: 'Pinned.', point: [0.123456, 1] });
    expect(files.get(YAML)).toContain("created: '2026-01-02T03:04:05'\n  point: [0.1235, 1.0]\n");
    expect(files.get(MD)).toContain('Pin: 12% from left, 100% from top');
    expect(lastReview(posted).notes.at(-1)).toMatchObject({ point: [0.1235, 1] });
    await send({ type: 'reviewAdd', at: 3, text: 'bad', point: [2, 0] });
    expect(errors(posted).at(-1)).toMatch(/pin must be/);
  });

  it('runs edits in order: two adds in a row get n1 and n2', async () => {
    const { posted, send } = await open();
    // No sidecar yet: the first add creates it, once the probe has said 24 fps.
    await send({ type: 'reviewEnable' });
    await Promise.all([
      send({ type: 'reviewAdd', at: 1, text: 'one' }),
      send({ type: 'reviewAdd', at: 2, out: 3, text: 'two' }),
    ]);
    const loaded = files.get(YAML)!;
    expect(loaded).toMatch(
      /^version: 1\nid: [0-9a-f]{12}\nsource: clip.mp4\nfps: 24.0\nnext_note_id: 3\n/,
    );
    expect(loaded).toContain(
      "asset:\n  rating: 0\n  status: none\n  keywords: []\n  notes: ''\nnotes:\n- id: n1\n",
    );
    expect(loaded.indexOf('id: n1')).toBeLessThan(loaded.indexOf('id: n2'));
    const adds = posted.filter((m) => m.type === 'review' && m.added).map((m) => m.added);
    expect(adds).toEqual(['n1', 'n2']);
    // The post after the next, unrelated change carries no `added`.
    await send({ type: 'reviewDelete', id: 'n1' });
    expect(lastReview(posted).added).toBeNull();
  });

  it('rewrites the markdown only through an edit, and leaves a done note alone', async () => {
    const marked = SIDECAR.replace('done: false', 'done: true');
    const { posted, send } = await open(marked);
    expect(files.has(MD)).toBe(false);
    await send({ type: 'reviewAdd', at: 2, text: 'b' });
    expect(files.get(YAML)).toContain(marked.slice(marked.indexOf('- id: n1')));
    expect(files.has(MD)).toBe(true);
    // A reload caused by another program leaves the markdown alone.
    files.delete(MD);
    files.set(YAML, marked);
    (watcher.onDidChange.mock.calls[0][0] as () => void)();
    await vi.waitFor(() =>
      expect(posted.filter((m) => m.type === 'review').length).toBeGreaterThan(2),
    );
    expect(files.has(MD)).toBe(false);
  });

  it('deletes, then restores under the same id at the same place', async () => {
    const two =
      SIDECAR.replace('next_note_id: 2', 'next_note_id: 3') +
      "- id: n2\n  target: source\n  at: 4.0\n  kind: note\n  text: Second.\n  done: false\n  applied_op: null\n  checkpoint: null\n  drawing: []\n  created: '2026-01-02T03:04:05'\n";
    const { posted, send } = await open(two);
    await send({ type: 'reviewDelete', id: 'n1' });
    expect(lastReview(posted)).toMatchObject({ restorable: 'n1' });
    expect(lastReview(posted).notes.map((n) => n.id)).toEqual(['n2']);
    await send({ type: 'reviewRestore' });
    expect(files.get(YAML)).toBe(two);
    expect(lastReview(posted)).toMatchObject({ restorable: null });
    // One level only: nothing is held now.
    await send({ type: 'reviewRestore' });
    expect(errors(posted)).toEqual(['There is no deleted note to restore']);
  });

  it('holds one deleted note: a second delete replaces the first', async () => {
    const { posted, send } = await open(SIDECAR);
    await send({ type: 'reviewAdd', at: 2, text: 'b' });
    await send({ type: 'reviewDelete', id: 'n1' });
    await send({ type: 'reviewDelete', id: 'n2' });
    expect(lastReview(posted).restorable).toBe('n2');
    await send({ type: 'reviewRestore' });
    expect(lastReview(posted).notes.map((n) => n.id)).toEqual(['n2']);
    expect(files.get(YAML)).toContain('next_note_id: 3\n');
  });

  it('refuses every edit while the sidecar is read-only, and leaves it alone', async () => {
    const v2 = 'version: 2\nsource: clip.mp4\nfps: 25\n';
    const { posted, send } = await open(v2);
    await send({ type: 'reviewAdd', at: 1, text: 'x' });
    await send({ type: 'reviewDelete', id: 'n1' });
    await send({ type: 'reviewRestore' });
    expect(files.get(YAML)).toBe(v2);
    expect(files.has(MD)).toBe(false);
    expect(errors(posted).every((m) => /read-only/.test(String(m)))).toBe(true);
  });

  it('refuses invalid messages and unknown ids without writing', async () => {
    const { posted, send } = await open(SIDECAR);
    await send({ type: 'reviewAdd', at: 1, text: 'x', color: 'red' });
    await send({ type: 'reviewAdd', at: 1, out: 1, text: 'empty range' });
    await send({ type: 'reviewDelete', id: 'n9' });
    expect(files.get(YAML)).toBe(SIDECAR);
    expect(errors(posted)).toHaveLength(3);
  });

  const failures = (posted: Array<Record<string, unknown>>) =>
    posted.filter((m) => m.type === 'reviewError');

  it('marks only the errors for an add that was not saved with failed: add', async () => {
    const v2 = 'version: 2\nsource: clip.mp4\nfps: 25\n';
    const ro = await open(v2);
    await ro.send({ type: 'reviewAdd', at: 1, text: 'x' });
    await ro.send({ type: 'reviewAdd', at: 1, out: 1, text: 'bad range' });
    await ro.send({ type: 'reviewDelete', id: 'n1' });
    await ro.send({ type: 'reviewCopy' });
    expect(failures(ro.posted).map((m) => m.failed)).toEqual(['add', 'add', undefined, undefined]);

    files.set(YAML, SIDECAR);
    const wf = await open();
    readFailure.next = Object.assign(new Error('EACCES'), { code: 'NoPermissions' });
    await wf.send({ type: 'reviewAdd', at: 1, text: 'read' });
    const vs = await import('vscode');
    vi.mocked(vs.workspace.fs.writeFile).mockRejectedValueOnce(new Error('disk full'));
    await wf.send({ type: 'reviewAdd', at: 1, text: 'write' });
    expect(failures(wf.posted).map((m) => m.failed)).toEqual(['add', 'add']);
    expect(files.get(YAML)).toBe(SIDECAR);
  });

  it('does not treat a failed read as a missing file: nothing is written', async () => {
    const two =
      SIDECAR.replace('next_note_id: 2', 'next_note_id: 3') +
      "- id: n2\n  target: source\n  at: 2.0\n  kind: note\n  text: Second.\n  done: false\n  applied_op: null\n  checkpoint: null\n  drawing: []\n  created: '2026-01-02T03:04:05'\n";
    const { posted, send } = await open(two);
    await send({ type: 'reviewCopy' });
    const md = files.get(MD);
    expect(md).toContain('## n2');
    const vs = await import('vscode');
    const writes = vi.mocked(vs.workspace.fs.writeFile).mock.calls.length;
    const renames = vi.mocked(vs.workspace.fs.rename).mock.calls.length;
    const states = posted.filter((m) => m.type === 'review').length;
    readFailure.next = Object.assign(new Error('EACCES'), { code: 'NoPermissions' });
    await send({ type: 'reviewAdd', at: 3, text: 'lost?' });
    expect(vi.mocked(vs.workspace.fs.writeFile).mock.calls).toHaveLength(writes);
    expect(vi.mocked(vs.workspace.fs.rename).mock.calls).toHaveLength(renames);
    expect(files.get(YAML)).toBe(two);
    expect(files.get(MD)).toBe(md);
    expect(failures(posted)).toEqual([
      { type: 'reviewError', message: expect.stringMatching(/Could not read/), failed: 'add' },
    ]);
    expect(posted.filter((m) => m.type === 'review')).toHaveLength(states);
  });

  it('keeps the panel as it is when a reload cannot read the file', async () => {
    const { posted, send } = await open(SIDECAR);
    const states = posted.filter((m) => m.type === 'review').length;
    readFailure.next = Object.assign(new Error('EIO'), { code: 'Unknown' });
    (watcher.onDidChange.mock.calls[0][0] as () => void)();
    await vi.waitFor(() => expect(errors(posted)).toHaveLength(1));
    expect(posted.filter((m) => m.type === 'review')).toHaveLength(states);
    expect(failures(posted)[0].failed).toBeUndefined();
    await send({ type: 'reviewAdd', at: 2, text: 'still works' });
    expect(files.get(YAML)).toContain('- id: n2\n');
  });

  it('refuses a change that would leave an invalid sidecar, without writing', async () => {
    // A flow mapping at the root: a block list spliced in would not parse.
    const flow = '{version: 1, source: clip.mp4, fps: 25.0, next_note_id: 1, notes: []}\n';
    const { posted, send } = await open(flow);
    await send({ type: 'reviewAdd', at: 1, text: 'x' });
    expect(files.get(YAML)).toBe(flow);
    expect(files.has(MD)).toBe(false);
    expect(failures(posted)).toEqual([
      { type: 'reviewError', message: expect.stringMatching(/invalid/), failed: 'add' },
    ]);
  });

  it('checks times against the probed duration before creating a sidecar', async () => {
    const { posted, send } = await open();
    await send({ type: 'reviewEnable' });
    // The 5 second probe lands first; one frame (at 24 fps) of slack is allowed.
    await send({ type: 'reviewAdd', at: 5.1, text: 'past the end' });
    expect(files.has(YAML)).toBe(false);
    expect(errors(posted)).toEqual(['That time is past the end of the video']);
    await send({ type: 'reviewAdd', at: 5.04, text: 'last frame' });
    expect(files.get(YAML)).toContain('at: 5.04\n');
  });

  it('says so once when a note this panel wrote is gone after a reload', async () => {
    const { posted, send } = await open(SIDECAR);
    await send({ type: 'reviewAdd', at: 2, text: 'b' });
    expect(errors(posted)).toEqual([]);
    const onChange = watcher.onDidChange.mock.calls[0][0] as () => void;
    // Marker saves its in-memory copy, which never had n2.
    files.set(YAML, SIDECAR);
    onChange();
    await vi.waitFor(() =>
      expect(errors(posted)).toEqual(['Notes were replaced by another program']),
    );
    onChange();
    await vi.waitFor(() =>
      expect(posted.filter((m) => m.type === 'review').length).toBeGreaterThan(3),
    );
    expect(errors(posted)).toHaveLength(1);
  });

  it('does not call a note this panel deleted a replacement', async () => {
    const { posted, send } = await open(SIDECAR);
    await send({ type: 'reviewAdd', at: 2, text: 'b' });
    await send({ type: 'reviewDelete', id: 'n2' });
    (watcher.onDidChange.mock.calls[0][0] as () => void)();
    await vi.waitFor(() =>
      expect(posted.filter((m) => m.type === 'review').length).toBeGreaterThan(2),
    );
    expect(errors(posted)).toEqual([]);
  });

  it('reads the file again for each edit, so an outside change is kept', async () => {
    const { send } = await open(SIDECAR);
    // Another program added n2 and bumped the mark behind this panel's back.
    files.set(
      YAML,
      SIDECAR.replace('next_note_id: 2', 'next_note_id: 3') +
        "- id: n2\n  target: source\n  at: 4.0\n  kind: note\n  done: false\n  created: '2026-01-02T03:04:05'\n",
    );
    await send({ type: 'reviewAdd', at: 5, text: 'mine' });
    expect(files.get(YAML)).toContain('- id: n2\n  target: source\n  at: 4.0\n');
    expect(files.get(YAML)).toContain('- id: n3\n');
  });
});
