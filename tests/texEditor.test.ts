// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type * as TexCompile from '../src/texCompile';
import type * as DocumentFile from '../src/documentFile';
import { MAX_PDF_BYTES } from '../src/documentFile';

const host = vi.hoisted(() => {
  function event<T>() {
    const listeners = new Set<(value: T) => void>();
    return {
      on(listener: (value: T) => void) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      fire(value: T) {
        for (const listener of listeners) {
          listener(value);
        }
      },
    };
  }

  return {
    trusted: true,
    settings: new Map<string, unknown>(),
    save: event<vscode.TextDocument>(),
    change: event<vscode.ConfigurationChangeEvent>(),
    grantTrust: event<void>(),
    findTex: vi.fn<typeof TexCompile.findTex>(),
    compile: vi.fn<typeof TexCompile.compile>(),
    ensureTexDir: vi.fn(),
    removeQuietly: vi.fn(),
    readDocument: vi.fn<(uri: vscode.Uri, maxBytes: number) => Promise<Uint8Array>>(),
  };
});

vi.mock('vscode', () => ({
  Uri: {
    file: (fsPath: string) => ({ scheme: 'file', fsPath }),
    joinPath: (_base: vscode.Uri, ...segments: string[]) => ({
      with: () => segments.join('/'),
      toString: () => segments.join('/'),
    }),
  },
  workspace: {
    get isTrusted() {
      return host.trusted;
    },
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => host.settings.get(key) ?? fallback,
    }),
    getWorkspaceFolder: () => undefined,
    onDidSaveTextDocument: host.save.on,
    onDidChangeConfiguration: host.change.on,
    onDidGrantWorkspaceTrust: host.grantTrust.on,
    fs: { readFile: vi.fn(async () => Buffer.from('[]')) },
  },
}));

vi.mock('../src/texCompile', async (importOriginal) => ({
  ...(await importOriginal<typeof TexCompile>()),
  findTex: host.findTex,
  compile: host.compile,
  ensureTexDir: host.ensureTexDir,
  removeQuietly: host.removeQuietly,
}));

vi.mock('../src/documentFile', async (importOriginal) => ({
  ...(await importOriginal<typeof DocumentFile>()),
  readDocument: host.readDocument,
}));

import { recompileActiveTex, TexEditorProvider } from '../src/texEditor';

const path = '/project/main.tex';
const uri = { path, fsPath: path, with: () => uri, toString: () => path } as unknown as vscode.Uri;
const document = { uri, getText: () => '' } as unknown as vscode.TextDocument;
const closePanels: Array<() => void> = [];

async function openPreview() {
  let receive: ((msg: { type: string }) => Promise<void>) | undefined;
  let dispose: (() => void) | undefined;
  const post = vi.fn(async (_msg: unknown) => true);
  const panel = {
    active: true,
    webview: {
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: post,
      onDidReceiveMessage: (listener: typeof receive) => {
        receive = listener;
      },
    },
    onDidDispose: (listener: typeof dispose) => {
      dispose = listener;
    },
  } as unknown as vscode.WebviewPanel;

  const context = { extensionUri: { path: '/extension' } } as vscode.ExtensionContext;
  await new TexEditorProvider(context).resolveCustomTextEditor(document, panel);
  closePanels.push(() => dispose?.());
  const send = async (type: string) => receive?.({ type });
  await send('ready');
  return { post, send };
}

function changeSetting(key: string, value: unknown): void {
  host.settings.set(key, value);
  host.change.fire({
    affectsConfiguration: (section) => `markcopy.${key}`.startsWith(section),
  });
}

describe('LaTeX preview compiler consent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    host.trusted = true;
    host.settings.clear();
    host.findTex.mockResolvedValue({ engine: 'latexmk', path: 'latexmk' });
    host.compile.mockResolvedValue({ pdf: '/temp/main.pdf', log: '', errors: [] });
    host.readDocument.mockImplementation(async ({ fsPath }) =>
      Buffer.from(fsPath.endsWith('.pdf') ? 'mock PDF' : '[]'),
    );
  });

  afterEach(() => {
    for (const close of closePanels.splice(0)) {
      close();
    }
  });

  it('waits for a manual request before discovery or automatic rebuilds', async () => {
    const preview = await openPreview();
    host.save.fire(document);
    changeSetting('tex.engine', 'pdflatex');
    expect(preview.post).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'unavailable', action: 'Compile' }),
    );
    expect(host.findTex).not.toHaveBeenCalled();

    await preview.send('texRecompile');
    expect(host.compile).toHaveBeenCalledTimes(1);
    host.save.fire(document);
    await vi.waitFor(() => expect(host.compile).toHaveBeenCalledTimes(2));

    const next = await openPreview();
    expect(next.post).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'unavailable', action: 'Compile' }),
    );
    expect(host.compile).toHaveBeenCalledTimes(2);
  });

  it('blocks saves, config changes and manual commands in off mode', async () => {
    host.settings.set('tex.compile', 'off');
    const preview = await openPreview();
    host.save.fire(document);
    changeSetting('tex.engine', 'pdflatex');
    await preview.send('texRecompile');
    expect(recompileActiveTex()).toBe(true);
    expect(host.findTex).not.toHaveBeenCalled();
    expect(host.compile).not.toHaveBeenCalled();
    expect(preview.post).toHaveBeenLastCalledWith({
      type: 'texState',
      state: 'unavailable',
      text: expect.stringContaining('Compiling is off'),
    });
  });

  it('cancels work and resets consent when switched off during discovery', async () => {
    const preview = await openPreview();
    host.findTex.mockImplementationOnce(
      (_configured, _engine, _platform, _env, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve(undefined), { once: true });
        }),
    );
    const pending = preview.send('texRecompile');
    const signal = host.findTex.mock.calls[0][4];
    expect(signal?.aborted).toBe(false);
    host.save.fire(document);
    changeSetting('tex.compile', 'off');
    expect(signal?.aborted).toBe(true);
    await pending;

    changeSetting('tex.compile', 'ask');
    host.save.fire(document);
    expect(host.findTex).toHaveBeenCalledTimes(1);
    expect(host.compile).not.toHaveBeenCalled();
    expect(preview.post).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'Compile' }));
  });

  it('requires new consent after changing the root or compiler', async () => {
    const preview = await openPreview();
    await preview.send('texRecompile');

    changeSetting('tex.rootFile', 'other.tex');
    host.save.fire(document);
    expect(preview.post).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'Compile', text: expect.stringContaining('other.tex') }),
    );
    expect(host.compile).toHaveBeenCalledTimes(1);
    await preview.send('texRecompile');
    expect(host.compile).toHaveBeenLastCalledWith(
      expect.objectContaining({ rootFile: expect.stringMatching(/[/\\]other\.tex$/) }),
    );

    changeSetting('tex.engine', 'pdflatex');
    host.save.fire(document);
    expect(preview.post).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'Compile' }));
    expect(host.compile).toHaveBeenCalledTimes(2);
  });

  it('ignores tex settings that do not change the build', async () => {
    host.settings.set('tex.compile', 'auto');
    const preview = await openPreview();
    await vi.waitFor(() => expect(host.compile).toHaveBeenCalledTimes(1));
    changeSetting('tex.recompileOnSave', false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(preview.post).toBeDefined();
    expect(host.findTex).toHaveBeenCalledTimes(1);
    expect(host.compile).toHaveBeenCalledTimes(1);

    changeSetting('tex.enginePath', '/bin/latexmk');
    await vi.waitFor(() => expect(host.compile).toHaveBeenCalledTimes(2));
  });

  it('uses the PDF preview limit for compiled output', async () => {
    const preview = await openPreview();
    host.readDocument.mockRejectedValueOnce(
      new Error('This file exceeds the 64 MB preview limit.'),
    );
    await preview.send('texRecompile');

    expect(host.readDocument).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: 'file', fsPath: '/temp/main.pdf' }),
      MAX_PDF_BYTES,
    );
    expect(preview.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'load' }));
    expect(preview.post).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'failed', detail: expect.stringContaining('64 MB') }),
    );
  });

  it('requires workspace trust even for an explicit request in auto mode', async () => {
    host.trusted = false;
    host.settings.set('tex.compile', 'auto');
    const preview = await openPreview();
    await preview.send('texRecompile');
    host.save.fire(document);
    changeSetting('tex.engine', 'pdflatex');
    expect(host.findTex).not.toHaveBeenCalled();
    expect(preview.post).toHaveBeenLastCalledWith({
      type: 'texState',
      state: 'unavailable',
      text: expect.stringContaining('trusted VS Code workspace'),
    });

    host.trusted = true;
    host.grantTrust.fire();
    await vi.waitFor(() => expect(host.compile).toHaveBeenCalledTimes(1));
  });
});
