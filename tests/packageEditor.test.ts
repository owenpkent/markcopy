// @vitest-environment node
//
// The package preview's host side: the package.json contribution, the rule that
// the preview can never hand the file to the OS, and the render it posts for a
// real file on disk. Modelled on tests/exeEditor.test.ts; vscode is mocked the
// same way, and for the same reason (see the header of
// tests/ooxmlEditor.test.ts).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
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
      get: (_key: string, fallback: unknown) => fallback,
    })),
    createFileSystemWatcher: vi.fn(() => ({
      onDidChange: vi.fn(() => ({ dispose: () => undefined })),
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
}));

import { formatBytes } from '../src/binary/html';
import { runFileInfoTask } from '../src/fileInfoTask';
import { PackageEditorProvider } from '../src/packageEditor';
import { buildElf } from './pkg/elfFixture';
import type * as vscode from 'vscode';

const dir = mkdtempSync(join(tmpdir(), 'markcopy-pkg-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  openExternal.mockClear();
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

function createPanel(): {
  panel: vscode.WebviewPanel;
  post: (msg: unknown) => Promise<void>;
  posted: () => { type: string; kind?: string; html?: string }[];
} {
  let handler: ((msg: unknown) => unknown) | undefined;
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
  return {
    panel: {
      webview,
      onDidDispose: () => ({ dispose: () => undefined }),
    } as unknown as vscode.WebviewPanel,
    post: async (msg) => {
      await handler?.(msg);
    },
    posted: () => webview.postMessage.mock.calls.map(([msg]) => msg),
  };
}

describe('package.json: markcopy.packagePreview', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const editors: { viewType: string; priority: string; selector: { filenamePattern: string }[] }[] =
    pkg.contributes.customEditors;
  const editor = editors.find((e) => e.viewType === 'markcopy.packagePreview')!;
  const patternsOf = (e: { selector: { filenamePattern: string }[] }): string[] =>
    e.selector.map((s) => s.filenamePattern);

  it('is contributed, and is the default editor for its files', () => {
    expect(editor).toBeDefined();
    expect(editor.priority).toBe('default');
  });

  it('claims exactly the package extensions, in lower and upper case, plus shared objects and AppImages', () => {
    const extensions = [
      'deb',
      'udeb',
      'rpm',
      'msi',
      'dmg',
      'pkg',
      'apk',
      'jar',
      'war',
      'ear',
      'vsix',
      'whl',
      'nupkg',
      'snupkg',
      'so',
      'dylib',
      'elf',
      'ko',
    ];
    const expected = [
      ...extensions.flatMap((ext) => [`*.${ext}`, `*.${ext.toUpperCase()}`]),
      '*.so.*',
      '*.AppImage',
      '*.appimage',
      '*.APPIMAGE',
    ];
    expect([...patternsOf(editor)].sort()).toEqual([...expected].sort());
  });

  it('shares no pattern with any other custom editor', () => {
    const mine = new Set(patternsOf(editor));
    for (const other of editors.filter((e) => e.viewType !== editor.viewType)) {
      const clash = patternsOf(other).filter((p) => mine.has(p));
      expect(clash, `${other.viewType} also claims ${clash.join(', ')}`).toEqual([]);
    }
  });

  it('lists no pattern twice', () => {
    const patterns = patternsOf(editor);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it('matches the view type the provider registers', () => {
    expect(PackageEditorProvider.viewType).toBe('markcopy.packagePreview');
  });
});

describe('Open in Default App', () => {
  it('is refused by the package preview, so it can never launch the file', async () => {
    const provider = new PackageEditorProvider(fakeContext, vi.fn(), vi.fn(), vi.fn());
    const { panel, post } = createPanel();
    await provider.resolveCustomEditor(documentAt(join(dir, 'tool.AppImage')), panel);

    await post({ type: 'openExternal' });

    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('PackageEditorProvider render', () => {
  async function renderOf(path: string) {
    const provider = new PackageEditorProvider(fakeContext, vi.fn(), vi.fn(), vi.fn());
    // Read in this process: there is no bundled worker script under test.
    provider.reader = (request) => runFileInfoTask(request);
    const { panel, post, posted } = createPanel();
    await provider.resolveCustomEditor(documentAt(path), panel);
    // The page opens waiting; the reader's click is what reads the file.
    await post({ type: 'ready' });
    await post({ type: 'readFile' });
    const renders = posted().filter((m) => m.type === 'render');
    expect(renders).toHaveLength(2);
    return renders[1] as { kind: string; html: string };
  }

  it('posts the file details, with the size and SHA-256 of the bytes on disk', async () => {
    const bytes = buildElf();
    const path = join(dir, 'libdemo.so');
    writeFileSync(path, bytes);

    const render = await renderOf(path);

    expect(render.kind).toBe('package');
    expect(render.html).toContain('<h1>libdemo.so</h1>');
    expect(render.html).toContain(createHash('sha256').update(bytes).digest('hex'));
    expect(render.html).toContain(formatBytes(bytes.length));
    expect(render.html).not.toContain('could not preview');
  });

  it('reports a file that is not the format its name says instead of failing to open', async () => {
    const path = join(dir, 'notreally.deb');
    writeFileSync(path, 'this is plain text, not a package, and long enough to look like a file\n');

    const render = await renderOf(path);

    expect(render.kind).toBe('package');
    expect(render.html).toContain('MarkCopy could not preview this file');
  });

  it('reports a file that is not there', async () => {
    const render = await renderOf(join(dir, 'missing.rpm'));
    expect(render.html).toContain('MarkCopy could not preview this file');
  });
});
