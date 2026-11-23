// @vitest-environment node
//
// The executable preview's host side: the package.json contribution, the rule
// that the preview can never hand the executable to the OS, and the render it
// posts for a real file on disk. vscode is mocked the same way, and for the same
// reason, as in tests/ooxmlEditor.test.ts (read its header for why this file
// needs the node environment).
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

import { DocxEditorProvider } from '../src/docxEditor';
import { ExeEditorProvider } from '../src/exeEditor';
import { buildPe, iconBitmap } from './pe/fixture';
import type * as vscode from 'vscode';

const dir = mkdtempSync(join(tmpdir(), 'markcopy-exe-test-'));
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
  posted: () => {
    type: string;
    kind?: string;
    html?: string;
    items?: { id: string; mime: string; base64: string }[];
  }[];
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

describe('package.json: markcopy.exePreview', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const editor = pkg.contributes.customEditors.find(
    (e: { viewType: string }) => e.viewType === 'markcopy.exePreview',
  );

  it('claims exactly the PE extensions, in lower and upper case', () => {
    const patterns = editor.selector.map((s: { filenamePattern: string }) => s.filenamePattern);
    const extensions = ['exe', 'dll', 'sys', 'ocx', 'scr', 'cpl', 'efi'];
    const expected = extensions.flatMap((ext) => [`*.${ext}`, `*.${ext.toUpperCase()}`]);
    expect([...patterns].sort()).toEqual([...expected].sort());
  });

  it('is the default editor for those files', () => {
    expect(editor.priority).toBe('default');
  });

  it('matches the view type the provider registers', () => {
    expect(ExeEditorProvider.viewType).toBe('markcopy.exePreview');
  });
});

describe('Open in Default App', () => {
  it('is refused by the executable preview, so it can never launch the file', async () => {
    const provider = new ExeEditorProvider(fakeContext, vi.fn(), vi.fn(), vi.fn());
    const { panel, post } = createPanel();
    await provider.resolveCustomEditor(documentAt(join(dir, 'tool.exe')), panel);

    await post({ type: 'openExternal' });

    expect(openExternal).not.toHaveBeenCalled();
  });

  it('is still honoured by the Word preview', async () => {
    const provider = new DocxEditorProvider(fakeContext, vi.fn(), vi.fn(), vi.fn());
    const { panel, post } = createPanel();
    await provider.resolveCustomEditor(documentAt(join(dir, 'report.docx')), panel);

    await post({ type: 'openExternal' });

    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('leaves Reveal in the file manager to the shared router for the executable preview', async () => {
    const vs = await import('vscode');
    const execute = vi.mocked(vs.commands.executeCommand);
    execute.mockClear();
    const provider = new ExeEditorProvider(fakeContext, vi.fn(), vi.fn(), vi.fn());
    const { panel, post } = createPanel();
    await provider.resolveCustomEditor(documentAt(join(dir, 'tool.exe')), panel);

    await post({ type: 'revealInOS' });

    expect(execute).toHaveBeenCalledWith('revealFileInOS', expect.anything());
  });
});

describe('ExeEditorProvider render', () => {
  async function renderOf(path: string) {
    const provider = new ExeEditorProvider(fakeContext, vi.fn(), vi.fn(), vi.fn());
    const { panel, post, posted } = createPanel();
    await provider.resolveCustomEditor(documentAt(path), panel);
    await post({ type: 'ready' });
    await vi.waitFor(() => expect(posted().some((m) => m.type === 'render')).toBe(true));
    return posted().find((m) => m.type === 'render') as { kind: string; html: string };
  }

  it('posts the file details, with the SHA-256 of the bytes on disk', async () => {
    const bytes = buildPe({
      version: {
        fileVersion: [3, 1, 4, 1],
        strings: [
          ['FileDescription', 'Pie Tool'],
          ['CompanyName', 'Contoso'],
        ],
      },
      imports: [{ library: 'KERNEL32.dll', functions: 2 }],
    });
    const path = join(dir, 'tool.exe');
    writeFileSync(path, bytes);

    const render = await renderOf(path);

    expect(render.kind).toBe('exe');
    expect(render.html).toContain('<h1>tool.exe</h1>');
    expect(render.html).toContain('Pie Tool');
    expect(render.html).toContain('KERNEL32.dll');
    expect(render.html).toContain(createHash('sha256').update(bytes).digest('hex'));
  });

  it('reports a file that is not a PE image instead of failing to open', async () => {
    const path = join(dir, 'notreally.exe');
    writeFileSync(
      path,
      'this is plain text, not an executable, and long enough to pass the size check\n',
    );

    const render = await renderOf(path);

    expect(render.kind).toBe('exe');
    expect(render.html).toContain('MarkCopy could not preview this file');
    expect(render.html).toContain('MZ');
  });

  it('reports a file that is not there', async () => {
    const render = await renderOf(join(dir, 'missing.exe'));
    expect(render.html).toContain('MarkCopy could not preview this file');
  });
});

describe('ExeEditorProvider icon', () => {
  async function messagesFor(bytes: Uint8Array, name: string) {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    const provider = new ExeEditorProvider(fakeContext, vi.fn(), vi.fn(), vi.fn());
    const { panel, post, posted } = createPanel();
    await provider.resolveCustomEditor(documentAt(path), panel);
    await post({ type: 'ready' });
    await vi.waitFor(() => expect(posted().some((m) => m.type === 'render')).toBe(true));
    // Let any media message that follows the render be posted.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return posted();
  }

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

  it('posts the icon as a PNG media message after the render', async () => {
    const messages = await messagesFor(buildPe({ icons: [icon] }), 'icon.exe');
    const types = messages.map((m) => m.type);
    expect(types.indexOf('media')).toBeGreaterThan(types.indexOf('render'));
    const media = messages.filter((m) => m.type === 'media');
    expect(media).toHaveLength(1);
    expect(media[0].items).toHaveLength(1);
    const [item] = media[0].items!;
    expect(item).toMatchObject({ id: 'm1', mime: 'image/png' });
    expect(Array.from(Buffer.from(item.base64, 'base64').subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const render = messages.find((m) => m.type === 'render');
    expect(render?.html).toContain('data-mc-media="m1"');
  });

  it('posts no media message for a file without an icon', async () => {
    const messages = await messagesFor(buildPe(), 'plain.exe');
    expect(messages.some((m) => m.type === 'media')).toBe(false);
    expect(messages.find((m) => m.type === 'render')?.html).not.toContain('<img');
  });
});
