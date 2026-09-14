// @vitest-environment node
//
// Regression coverage for the openLink branch of the shared message router in
// src/ooxmlEditor.ts: the same "Search Google" row and link click the
// Markdown/CSV preview offers (tests/e2e/searchAndLinks.e2e.test.ts) reaches a
// sheet or deck through this router instead of src/webview/main.ts's own click
// handler, and PR review asked that the two paths not drift apart.
//
// vscode is mocked because resolveCustomEditor touches a dozen of its
// surfaces (webview options, workspace config, a file watcher, a
// config-change listener) that would otherwise need a real extension host.
// Each stand-in is just enough to let resolveCustomEditor run without
// throwing; none of it models VS Code's actual behavior beyond that. See
// tests/externalLink.test.ts for why this file also needs the node
// environment: under jsdom, Vite's client import-analysis tries to resolve
// the bare "vscode" specifier for real before Vitest's mock registry gets a
// chance to redirect it, and fails since no such package exists on disk.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const openExternal = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => {
  class RelativePattern {
    constructor(
      public base: unknown,
      public pattern: string,
    ) {}
  }
  return {
    Uri: {
      // Same minimal stand-in as tests/externalLink.test.ts: derive the
      // scheme from the string, throw for anything with none at all.
      parse: (value: string) => {
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1];
        if (!scheme) {
          throw new Error(`cannot parse a URI with no scheme: ${value}`);
        }
        return { scheme: scheme.toLowerCase() };
      },
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
    },
    RelativePattern,
    commands: { executeCommand: vi.fn() },
    window: { setStatusBarMessage: vi.fn() },
  };
});

import { OoxmlEditorProvider, type OoxmlSession } from '../src/ooxmlEditor';
import type * as vscode from 'vscode';

/** A message handler captured off a fake webview, and the fake panel it came from. */
function createPanel(): {
  panel: vscode.WebviewPanel;
  post: (msg: unknown) => Promise<void>;
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
  const panel = {
    webview,
    onDidDispose: () => ({ dispose: () => undefined }),
  };
  return {
    panel: panel as unknown as vscode.WebviewPanel,
    post: async (msg: unknown) => {
      await handler?.(msg);
    },
  };
}

/** Minimal concrete subclass: renders nothing, adds no message types of its own. */
class TestEditorProvider extends OoxmlEditorProvider {
  protected readonly viewType = 'markcopy.testPreview';
  protected readonly kind = 'test';
  protected readonly redrawSettings = ['markcopy.test'];
  public readonly sessionHandleMessage = vi.fn();

  protected createSession(): OoxmlSession {
    return { render: async () => '', handleMessage: this.sessionHandleMessage };
  }

  protected errorHtml(): string {
    return 'error';
  }
}

const fakeContext = {
  extensionUri: { path: '/ext', fsPath: '/ext' },
} as unknown as vscode.ExtensionContext;

const fakeDocument = {
  uri: {
    path: '/workspace/deck.pptx',
    fsPath: '/workspace/deck.pptx',
    toString: () => 'file:///workspace/deck.pptx',
  },
  dispose: () => undefined,
} as unknown as vscode.CustomDocument;

/** A freshly resolved provider, ready to receive messages. */
async function resolvedProvider(): Promise<{
  provider: TestEditorProvider;
  post: (msg: unknown) => Promise<void>;
}> {
  const provider = new TestEditorProvider(fakeContext, vi.fn(), vi.fn(), vi.fn());
  const { panel, post } = createPanel();
  await provider.resolveCustomEditor(fakeDocument, panel);
  return { provider, post };
}

beforeEach(() => {
  openExternal.mockClear();
});

describe('OoxmlEditorProvider message router: openLink', () => {
  it('opens an external web link exactly as posted', async () => {
    const { post } = await resolvedProvider();
    const href = 'https://www.google.com/search?q=AT%26T';

    await post({ type: 'openLink', href });

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(href);
  });

  it('does not open a vscode: link', async () => {
    const { post } = await resolvedProvider();

    await post({ type: 'openLink', href: 'vscode:extension/x.y' });

    expect(openExternal).not.toHaveBeenCalled();
  });

  it('does not open a non-string href', async () => {
    const { post } = await resolvedProvider();

    await post({ type: 'openLink', href: 42 });

    expect(openExternal).not.toHaveBeenCalled();
  });

  it('never forwards a well-formed openLink message to the session handler', async () => {
    const { provider, post } = await resolvedProvider();

    await post({ type: 'openLink', href: 'https://example.com' });
    await post({ type: 'openLink', href: 'vscode:extension/x.y' });

    expect(provider.sessionHandleMessage).not.toHaveBeenCalled();
  });
});
