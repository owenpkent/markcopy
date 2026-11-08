// @vitest-environment node
//
// Three hosts write the PDF webview's page: the PDF editor, the LaTeX preview
// and the screenshot harness. The page reads the pdf.js worker's address from
// `data-worker-src` on <body> and nothing else, so a host that leaves the
// attribute out gets a viewer that cannot start. The LaTeX preview once did,
// while the PDF editor's own tests, which set the attribute themselves, stayed
// green. This pins the contract for both extension-host providers.
import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: vi.fn(), file: vi.fn() },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    fs: {},
  },
  window: {},
  commands: {},
}));

import { PdfEditorProvider } from '../src/pdfEditor';
import { TexEditorProvider } from '../src/texEditor';

interface Internals {
  html(
    webview: unknown,
    script: unknown,
    worker: unknown,
    style: unknown,
    nonce: string,
    theme: string,
  ): string;
}

const webview = { cspSource: 'vscode-webview://x' };
const worker = 'https://file+.vscode-resource.vscode-cdn.net/ext/media/pdf.worker.js';

function workerAttr(html: string): string | undefined {
  const body = /<body\b[^>]*>/.exec(html)?.[0] ?? '';
  return /data-worker-src="([^"]*)"/.exec(body)?.[1];
}

describe('PDF webview hosts', () => {
  it('the PDF editor writes the worker address on the body', () => {
    const provider = new PdfEditorProvider({} as never) as unknown as Internals;
    const html = provider.html(webview, 's.js', worker, 'p.css', 'n', 'auto');
    expect(workerAttr(html)).toBe(worker);
  });

  it('the LaTeX preview writes the worker address on the body', () => {
    const provider = new TexEditorProvider({} as never) as unknown as Internals;
    const html = provider.html(webview, 's.js', worker, 'p.css', 'n', 'auto');
    expect(workerAttr(html)).toBe(worker);
  });
});
