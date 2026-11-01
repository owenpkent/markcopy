import * as vscode from 'vscode';
import { openInDefaultApp, revealInOs } from './revealInOs';
import { getNonce } from './previewShell';
import { applyMarkcopySetting } from './settingsScope';
import { basename, saveFrame } from './videoEditor';
import { parseStlMessage } from './messages/stl';
import { isStlSetting } from './messages/settings';
import { MAX_STL_BYTES, checkStl } from './webview/stlInfo';

// A read-only custom editor that renders STL files with Three.js in a webview.
// Mouse-only orbit/pan/zoom; see media/stl.js (built from src/webview/stl.ts).
//
// Its right-click menu carries a handful of copy actions (the current view as a
// PNG, the file name and path, the dimensions and triangle count) plus view
// presets and the theme. It deliberately skips the shared preview shell and
// builds its own HTML, but loads media/preview.css for the menu and toast styles.

// The allow-list lives with the message parsers; re-exported for the callers
// and tests that import it from here, as gifEditor.ts does.
export { isStlSetting };

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
    const asUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file)).with({ query: `v=${nonce}` });
    const theme = vscode.workspace
      .getConfiguration('markcopy', document.uri)
      .get<string>('theme', 'auto');
    // preview.css carries the shared context menu and toast styles.
    webview.html = this.html(webview, asUri('stl.js'), asUri('preview.css'), nonce, theme);

    webview.onDidReceiveMessage(async (raw) => {
      const msg = parseStlMessage(raw);
      if (!msg) {
        return;
      }
      switch (msg.type) {
        case 'ready':
          await this.sendLoad(webview, document.uri);
          break;
        case 'revealInOS':
          revealInOs(document.uri);
          break;
        case 'saveFrame':
          await saveFrame(document.uri, msg.name, msg.data, webview);
          break;
        case 'openExternal':
          // Always the host's own document, never a URI the webview sent.
          await openInDefaultApp(document.uri);
          break;
        case 'updateSetting':
          await applyMarkcopySetting(msg.key, msg.value, document.uri);
          break;
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

  private async sendLoad(webview: vscode.Webview, uri: vscode.Uri): Promise<void> {
    // The name and full path ride on every reply, errors included, so the menu's
    // Copy as > File Name and Full Path still work for a file that failed to load.
    const name = basename(uri);
    const path = uri.fsPath;
    try {
      // Size first, off stat, before a byte is read. Every guard used to live
      // in the webview, which meant a hostile file was read whole, base64'd
      // (1.33x, as a string), serialized through postMessage, and decoded on
      // the other side before anything asked whether it should have been
      // opened. The allocation the guards exist to prevent had already
      // happened five times over by then, in the extension host, where it
      // takes the whole window down rather than one preview.
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_STL_BYTES) {
        void webview.postMessage({
          type: 'error',
          name,
          path,
          message: `${name} is ${mib(stat.size)}, above MarkCopy's ${mib(MAX_STL_BYTES)} limit for STL previews.`,
        });
        return;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);

      // Cheap to run here and it saves base64-encoding a file that is about to
      // be refused. The webview checks again on arrival: this one is about not
      // doing pointless work, that one is the actual guard on the allocation.
      const check = checkStl(bytes);
      if (!check.ok) {
        void webview.postMessage({
          type: 'error',
          name,
          path,
          message: check.reason ?? `Could not load ${name}.`,
        });
        return;
      }

      const cfg = vscode.workspace.getConfiguration('markcopy', uri);
      void webview.postMessage({
        type: 'load',
        name,
        path,
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
        name,
        path,
        message: `Could not read ${name} (${String(err)}).`,
      });
      void vscode.window.showErrorMessage(`MarkCopy: could not read ${name} (${String(err)}).`);
    }
  }

  private html(
    webview: vscode.Webview,
    scriptUri: vscode.Uri,
    styleUri: vscode.Uri,
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
<link href="${styleUri}" rel="stylesheet" />
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
  <div id="mc-menu" class="mc-menu" role="menu" hidden></div>
  <div id="mc-toast" class="mc-toast" hidden></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function mib(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}
