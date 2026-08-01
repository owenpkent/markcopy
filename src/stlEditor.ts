import * as vscode from 'vscode';
import { getNonce } from './previewShell';
import { MAX_STL_BYTES, checkStl } from './webview/stlInfo';

// A read-only custom editor that renders STL files with Three.js in a webview.
// Mouse-only orbit/pan/zoom; see media/stl.js (built from src/webview/stl.ts).
//
// Unlike the Markdown, CSV, and PDF previews this one has no copy actions: an
// STL is a triangle soup with nothing meaningful to put on the clipboard, so it
// is a viewer only and deliberately skips the shared preview shell.
export class StlEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'markcopy.stlPreview';

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };

    const nonce = getNonce();
    // Cache-bust the script so a rebuilt bundle always loads fresh: the webview
    // otherwise caches it by its (unchanged) resource URL.
    const scriptUri = webview
      .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'stl.js'))
      .with({ query: `v=${nonce}` });
    const theme = vscode.workspace
      .getConfiguration('markcopy', document.uri)
      .get<string>('theme', 'auto');
    webview.html = this.html(webview, scriptUri, nonce, theme);

    webview.onDidReceiveMessage(async (msg: { type?: string }) => {
      if (msg?.type !== 'ready') {
        return;
      }
      try {
        // Size first, off stat, before a byte is read. Every guard used to live
        // in the webview, which meant a hostile file was read whole, base64'd
        // (1.33x, as a string), serialized through postMessage, and decoded on
        // the other side before anything asked whether it should have been
        // opened. The allocation the guards exist to prevent had already
        // happened five times over by then, in the extension host, where it
        // takes the whole window down rather than one preview.
        const stat = await vscode.workspace.fs.stat(document.uri);
        if (stat.size > MAX_STL_BYTES) {
          void webview.postMessage({
            type: 'error',
            message: `${basename(document.uri)} is ${mib(stat.size)}, above MarkCopy's ${mib(MAX_STL_BYTES)} limit for STL previews.`,
          });
          return;
        }

        const bytes = await vscode.workspace.fs.readFile(document.uri);

        // Cheap to run here and it saves base64-encoding a file that is about to
        // be refused. The webview checks again on arrival: this one is about not
        // doing pointless work, that one is the actual guard on the allocation.
        const check = checkStl(bytes);
        if (!check.ok) {
          void webview.postMessage({
            type: 'error',
            message: check.reason ?? `Could not load ${basename(document.uri)}.`,
          });
          return;
        }

        const cfg = vscode.workspace.getConfiguration('markcopy', document.uri);
        void webview.postMessage({
          type: 'load',
          name: basename(document.uri),
          // Base64, not the raw Uint8Array. The webview transport JSON-encodes
          // messages, and JSON turns a typed array into a numeric-keyed object
          // ~13x the size of the file (a 5 MB STL becomes ~67 MB of JSON and
          // several hundred MB of objects). Base64 costs 1.33x and stays a
          // string end to end. toBytes() in src/webview/stlInfo.ts decodes it.
          bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
          showGrid: cfg.get<boolean>('stl.showGrid', true),
          meshColor: cfg.get<string>('stl.meshColor', '#8ab4f8'),
        });
      } catch (err) {
        // Into the viewport as well as the toast: a blank 3D canvas with the
        // explanation in a notification that has already faded is how someone
        // concludes the preview is broken rather than the file.
        void webview.postMessage({
          type: 'error',
          message: `Could not read ${basename(document.uri)} (${String(err)}).`,
        });
        void vscode.window.showErrorMessage(
          `MarkCopy: could not read ${basename(document.uri)} (${String(err)}).`,
        );
      }
    });

    // Retint the viewport when markcopy.theme changes elsewhere (the Markdown or
    // PDF preview's Theme menu, or settings.json), matching src/pdfEditor.ts.
    const themeListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('markcopy.theme', document.uri)) {
        return;
      }
      const value = vscode.workspace
        .getConfiguration('markcopy', document.uri)
        .get<string>('theme', 'auto');
      void webview.postMessage({ type: 'setTheme', value });
    });
    panel.onDidDispose(() => themeListener.dispose());
  }

  private html(
    webview: vscode.Webview,
    scriptUri: vscode.Uri,
    nonce: string,
    theme: string,
  ): string {
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      // The bundle is a single entry point with no code splitting, so a bare
      // nonce is enough here (no 'strict-dynamic', unlike src/previewShell.ts).
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>MarkCopy STL Preview</title>
<style>
  /* Viewport background per markcopy.theme; 'auto' follows the VS Code theme.
     The palette matches media/preview.css so a forced theme looks the same
     across the Markdown, PDF, and STL previews. src/webview/stl.ts reads the
     resolved value and hands it to the WebGL renderer as its clear color. */
  body { --mc-stl-bg: var(--vscode-editor-background); }
  body[data-mc-theme='light'] { --mc-stl-bg: #ffffff; }
  body[data-mc-theme='dark'] { --mc-stl-bg: #0d1117; }
  body[data-mc-theme='green'] { --mc-stl-bg: #000000; }

  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--mc-stl-bg); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  #viewport { position: fixed; inset: 0; }
  #viewport canvas { display: block; outline: none; }
  #toolbar { position: fixed; top: 8px; left: 8px; z-index: 10; display: flex; gap: 6px; }
  #toolbar button {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    line-height: 1;
    border: 1px solid var(--vscode-contrastBorder, transparent);
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ffffff);
    cursor: pointer;
    padding: 0;
  }
  #toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  #toolbar button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #stats {
    position: fixed;
    bottom: 8px;
    left: 8px;
    z-index: 10;
    font-size: 11px;
    padding: 4px 7px;
    border-radius: 4px;
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editorWidget-background, rgba(0, 0, 0, 0.4));
    border: 1px solid var(--vscode-widget-border, transparent);
    pointer-events: none;
    white-space: pre;
  }
</style>
</head>
<body data-mc-theme="${theme}" data-vscode-context='{"preventDefaultContextMenuItems":true}'>
  <div id="viewport"></div>
  <div id="toolbar">
    <button id="btn-fit" title="Fit view" aria-label="Fit view">&#10530;</button>
    <button id="btn-wireframe" title="Toggle wireframe" aria-label="Toggle wireframe">&#9638;</button>
    <button id="btn-grid" title="Toggle grid" aria-label="Toggle grid">&#8862;</button>
  </div>
  <div id="stats"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function basename(uri: vscode.Uri): string {
  const p = uri.path;
  return p.substring(p.lastIndexOf('/') + 1);
}

function mib(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}
