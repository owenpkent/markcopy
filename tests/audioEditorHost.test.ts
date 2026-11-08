// @vitest-environment node
//
// Host-side coverage for how the audio viewer hands the webview its file URI: in
// the page HTML (escaped), never in a message.
import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: vi.fn() },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    fs: { stat: () => Promise.resolve({ size: 1234 }) },
  },
  window: {},
}));
vi.mock('../src/folderNav', () => ({
  hasExtension: () => true,
  folderPosition: () => Promise.resolve({ index: 1, count: 1 }),
  navigateFolder: vi.fn(),
}));

import { AudioEditorProvider } from '../src/audioEditor';

interface Internals {
  html(
    webview: unknown,
    script: unknown,
    style: unknown,
    nonce: string,
    theme: string,
    src: string,
  ): string;
  sendLoad(webview: unknown, uri: unknown): Promise<void>;
}

const provider = new AudioEditorProvider({} as never) as unknown as Internals;

describe('audio viewer file URI', () => {
  it('writes the escaped URI on the body and not into any message', async () => {
    const src = 'vscode-webview://x/take "1" <b>&.flac';
    const html = provider.html(
      { cspSource: 'vscode-webview://x' },
      's.js',
      'p.css',
      'n',
      'auto',
      src,
    );
    expect(html).toContain(
      'data-mc-src="vscode-webview://x/take &quot;1&quot; &lt;b&gt;&amp;.flac"',
    );
    expect(html).not.toContain('"1" <b>');

    const postMessage = vi.fn();
    const uri = { fsPath: '/a/take.flac', path: '/a/take.flac' };
    await provider.sendLoad({ postMessage, asWebviewUri: () => ({ toString: () => src }) }, uri);
    const msg = postMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(msg.type).toBe('load');
    expect('src' in msg).toBe(false);
    expect(JSON.stringify(msg)).not.toContain('vscode-webview');
    expect(msg.size).toBe(1234);
  });
});
