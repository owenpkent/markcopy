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
const readDirectory = vi.hoisted(() =>
  vi.fn(async (_dir: { path: string }): Promise<Array<[string, number]>> => []),
);
const showOpenDialog = vi.hoisted(() => vi.fn());
const executeCommand = vi.hoisted(() => vi.fn(async () => undefined));

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
    FileType: { File: 1, Directory: 2 },
    env: { openExternal: vi.fn() },
    commands: { executeCommand },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: (_key: string, fallback: unknown) => fallback,
        inspect: () => undefined,
        update: configUpdate,
      })),
      fs: { stat, readFile, writeFile, readDirectory },
      onDidChangeConfiguration: vi.fn(() => ({ dispose: () => undefined })),
    },
    window: { showSaveDialog, showOpenDialog, showErrorMessage: vi.fn() },
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

async function open(file = '/models/part.stl') {
  const provider = new StlEditorProvider({
    extensionUri: { path: '/ext', fsPath: '/ext' },
  } as unknown as vscode.ExtensionContext);
  const document = provider.openCustomDocument({
    path: file,
    fsPath: file,
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
  it('allows the up axis, as z or y only', () => {
    expect(isStlSetting('stl.upAxis', 'z')).toBe(true);
    expect(isStlSetting('stl.upAxis', 'y')).toBe(true);
    expect(isStlSetting('stl.upAxis', 'x')).toBe(false);
    expect(isStlSetting('stl.bedSize', '1x1')).toBe(false);
  });

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
      format: 'stl',
      name: 'part.stl',
      path: '/models/part.stl',
      bytes: Buffer.from(TRIANGLE).toString('base64'),
      showGrid: true,
      meshColor: '#8ab4f8',
      upAxis: 'z',
      showBed: false,
      bedSize: '256x256x256',
      siblings: [],
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

  it('sends a 3MF as a 3MF, leaving the unpacking to the webview', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    readFile.mockResolvedValue(zip);
    stat.mockResolvedValue({ size: zip.length });
    const { send, posted } = await open('/models/part.3MF');
    await send({ type: 'ready' });
    expect(posted.find((m) => m.type === 'load')).toMatchObject({
      format: '3mf',
      name: 'part.3MF',
      bytes: Buffer.from(zip).toString('base64'),
    });
  });

  it('refuses a 3MF that is not a zip, naming it', async () => {
    const { send, posted } = await open('/models/part.3mf');
    await send({ type: 'ready' });
    expect(posted.find((m) => m.type === 'load')).toBeUndefined();
    expect(posted.find((m) => m.type === 'error')?.message).toContain('not a 3MF package');
  });

  it('sends a GLB and a STEP file as theirs, with the engine address', async () => {
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]);
    readFile.mockResolvedValue(glb);
    stat.mockResolvedValue({ size: glb.length });
    const first = await open('/models/part.GLB');
    await first.send({ type: 'ready' });
    expect(first.posted.find((m) => m.type === 'load')).toMatchObject({
      format: 'glb',
      bytes: Buffer.from(glb).toString('base64'),
    });

    const step = new Uint8Array(Buffer.from('﻿ISO-10303-21;\nHEADER;'));
    readFile.mockResolvedValue(step);
    stat.mockResolvedValue({ size: step.length });
    for (const file of ['/models/part.step', '/models/part.STP']) {
      const { send, posted } = await open(file);
      await send({ type: 'ready' });
      expect(posted.find((m) => m.type === 'load')).toMatchObject({ format: 'step' });
    }
  });

  it('refuses a GLB with a wrong header and a STEP file with no STEP magic, naming them', async () => {
    readFile.mockResolvedValue(new Uint8Array(Buffer.from('definitely not a glb')));
    stat.mockResolvedValue({ size: 20 });
    const glb = await open('/models/part.glb');
    await glb.send({ type: 'ready' });
    expect(glb.posted.find((m) => m.type === 'load')).toBeUndefined();
    expect(glb.posted.find((m) => m.type === 'error')?.message).toMatch(
      /part.glb is not a GLB file/,
    );
    const step = await open('/models/part.step');
    await step.send({ type: 'ready' });
    expect(step.posted.find((m) => m.type === 'load')).toBeUndefined();
    expect(step.posted.find((m) => m.type === 'error')?.message).toMatch(
      /part.step is not a STEP file/,
    );
  });

  it('names GLB and STEP in the size refusal', async () => {
    stat.mockResolvedValue({ size: 300 * 1024 * 1024 });
    for (const [file, label] of [
      ['/models/a.glb', 'GLB'],
      ['/models/a.stp', 'STEP'],
    ]) {
      const { send, posted } = await open(file);
      await send({ type: 'ready' });
      expect(posted.find((m) => m.type === 'error')?.message).toContain(
        `limit for ${label} previews`,
      );
    }
  });

  it('allows WebAssembly and the engine fetch in the 3D viewer only', async () => {
    const { webview } = await open();
    expect(webview.html).toContain("script-src 'nonce-");
    expect(webview.html).toMatch(/script-src 'nonce-[^']+' 'wasm-unsafe-eval';/);
    expect(webview.html).toContain('connect-src vscode-resource:');
    expect(webview.html).not.toContain("'unsafe-eval'");
    expect(webview.html).not.toContain('img-src');
  });

  it('keeps wasm-unsafe-eval out of every other source file', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '..', 'src');
    const found: string[] = [];
    // The entry kind comes from the listing itself, so there is no separate
    // stat of a path that could change before it is read.
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          /\.ts$/.test(entry.name) &&
          readFileSync(full, 'utf8').includes("'wasm-unsafe-eval'")
        ) {
          found.push(entry.name);
        }
      }
    };
    walk(root);
    expect(found).toEqual(['stlEditor.ts']);
  });

  it('names 3MF in the size refusal for a 3MF', async () => {
    stat.mockResolvedValue({ size: 300 * 1024 * 1024 });
    const { send, posted } = await open('/models/part.3mf');
    await send({ type: 'ready' });
    expect(posted.find((m) => m.type === 'error')?.message).toContain('limit for 3MF previews');
  });

  describe('compare', () => {
    // part.stl sits beside another model and above a versions folder. The
    // listing is keyed by folder path, as the mocked joinPath builds it.
    beforeEach(() => {
      readDirectory.mockImplementation(async (dir: { path: string }) => {
        if (dir.path === '/models/part.stl/..') {
          return [
            ['part.stl', 1],
            ['other.stl', 1],
            ['notes.md', 1],
            ['versions', 2],
          ];
        }
        if (dir.path === '/models/part.stl/../versions') {
          return [
            ['part_v2.stl', 1],
            ['part_v10.3mf', 1],
          ];
        }
        throw new Error('no such folder');
      });
    });

    it('offers the models beside the file, likeliest version first', async () => {
      const { send, posted } = await open();
      await send({ type: 'ready' });
      expect(posted.find((m) => m.type === 'load')?.siblings).toEqual([
        'versions/part_v10.3mf',
        'versions/part_v2.stl',
        'other.stl',
      ]);
    });

    it('sends a model it offered, checked like the first', async () => {
      const { send, posted } = await open();
      await send({ type: 'ready' });
      await send({ type: 'compare', name: 'versions/part_v2.stl' });
      expect(posted.find((m) => m.type === 'compare')).toEqual({
        type: 'compare',
        format: 'stl',
        name: 'versions/part_v2.stl',
        bytes: Buffer.from(TRIANGLE).toString('base64'),
      });
    });

    it('reads nothing for a name it did not offer', async () => {
      const { send, posted } = await open();
      await send({ type: 'ready' });
      readFile.mockClear();
      await send({ type: 'compare', name: '../../secrets.stl' });
      await send({ type: 'compare', name: 'notes.md' });
      expect(readFile).not.toHaveBeenCalled();
      expect(posted.find((m) => m.type === 'compare')).toBeUndefined();
    });

    it('reports a model that fails the checks as a toast, not an error', async () => {
      const { send, posted } = await open();
      await send({ type: 'ready' });
      stat.mockResolvedValue({ size: 300 * 1024 * 1024 });
      await send({ type: 'compare', name: 'other.stl' });
      expect(posted.find((m) => m.type === 'compare')).toBeUndefined();
      expect(posted.find((m) => m.type === 'toast')?.message).toContain('limit for STL previews');
    });

    it('sends the file picked with Browse, and nothing when it is cancelled', async () => {
      const { send, posted } = await open();
      await send({ type: 'ready' });
      showOpenDialog.mockResolvedValueOnce(undefined);
      await send({ type: 'compareBrowse' });
      expect(posted.find((m) => m.type === 'compare')).toBeUndefined();

      const picked = { path: '/elsewhere/old.stl', fsPath: '/elsewhere/old.stl' };
      showOpenDialog.mockResolvedValueOnce([picked]);
      await send({ type: 'compareBrowse' });
      expect(posted.find((m) => m.type === 'compare')).toMatchObject({
        name: 'old.stl',
        format: 'stl',
      });
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

describe('StlEditorProvider with G-code', () => {
  const GCODE = 'G21\nG1 X1 Y1 E1\n; bed_shape = 0x0,250x0,250x210,0x210\n';

  it('sends plain G-code as text, in either case of either extension', async () => {
    const bytes = new Uint8Array(Buffer.from(GCODE));
    readFile.mockResolvedValue(bytes);
    stat.mockResolvedValue({ size: bytes.length });
    for (const file of ['/p/a.gcode', '/p/A.GCODE', '/p/a.gco', '/p/A.Gco']) {
      const { send, posted } = await open(file);
      await send({ type: 'ready' });
      expect(posted.find((m) => m.type === 'load')).toMatchObject({
        format: 'gcode',
        bytes: Buffer.from(bytes).toString('base64'),
      });
    }
  });

  it('refuses a NUL byte in the first 64 KiB with a clear message, and sends nothing', async () => {
    const bytes = new Uint8Array(Buffer.from('G1 X1\u0000 Y1\n', 'latin1'));
    readFile.mockResolvedValue(bytes);
    stat.mockResolvedValue({ size: bytes.length });
    const { send, posted } = await open('/p/a.gcode');
    await send({ type: 'ready' });
    expect(posted.find((m) => m.type === 'load')).toBeUndefined();
    expect(posted.find((m) => m.type === 'error')?.message).toMatch(
      /^a\.gcode cannot be previewed: .*NUL byte/,
    );
  });

  it('refuses Prusa binary G-code whatever the extension', async () => {
    const bytes = new Uint8Array([0x47, 0x43, 0x44, 0x45, 1, 0, 0, 0]);
    readFile.mockResolvedValue(bytes);
    stat.mockResolvedValue({ size: bytes.length });
    for (const file of ['/p/a.gcode', '/p/a.gco']) {
      const { send, posted } = await open(file);
      await send({ type: 'ready' });
      expect(posted.find((m) => m.type === 'load')).toBeUndefined();
      expect(posted.find((m) => m.type === 'error')?.message).toBe(
        `${file.slice(3)} cannot be previewed: binary G-code (.bgcode) is not supported.`,
      );
    }
  });

  it('applies the size cap before reading, naming G-code', async () => {
    stat.mockResolvedValue({ size: 300 * 1024 * 1024 });
    readFile.mockClear();
    const { send, posted } = await open('/p/a.gcode');
    await send({ type: 'ready' });
    expect(readFile).not.toHaveBeenCalled();
    expect(posted.find((m) => m.type === 'error')?.message).toContain('limit for G-code previews');
  });

  it('opens the document as text on openAsText, never another URI', async () => {
    const { send } = await open('/p/a.gcode');
    await send({ type: 'openAsText', path: '/etc/passwd' });
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.openWith',
      expect.objectContaining({ fsPath: '/p/a.gcode' }),
      'default',
    );
  });

  it('refuses to compare against G-code without reading it', async () => {
    readDirectory.mockResolvedValue([['b.gcode', 1]]);
    const { send, posted } = await open('/p/a.stl');
    await send({ type: 'ready' });
    readFile.mockClear();
    showOpenDialog.mockResolvedValueOnce([{ path: '/p/b.gcode', fsPath: '/p/b.gcode' }]);
    await send({ type: 'compareBrowse' });
    expect(readFile).not.toHaveBeenCalled();
    expect(posted.find((m) => m.type === 'toast')?.message).toMatch(/b\.gcode is G-code/);
    // The Browse dialog lists G-code among the models it filters for.
    expect(showOpenDialog.mock.calls.at(-1)?.[0]).toMatchObject({
      filters: { '3D models': expect.arrayContaining(['gcode', 'gco']) },
    });
  });

  it('claims .gcode and .gco in either case in package.json, at default priority', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const editor = pkg.contributes.customEditors.find(
      (e: { viewType: string }) => e.viewType === 'markcopy.stlPreview',
    );
    const patterns = editor.selector.map((s: { filenamePattern: string }) => s.filenamePattern);
    for (const pattern of ['*.gcode', '*.GCODE', '*.gco', '*.GCO']) {
      expect(patterns).toContain(pattern);
    }
    expect(patterns).not.toContain('*.g');
    expect(editor.priority).toBe('default');
    const ignore = readFileSync(join(__dirname, '..', '.vscodeignore'), 'utf8');
    expect(ignore).toMatch(/^sample\.gcode\r?$/m);
  });
});
