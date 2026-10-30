import * as vscode from 'vscode';
import { revealInOs } from './revealInOs';
import { getNonce } from './previewShell';
import { applyMarkcopySetting } from './settingsScope';
import { basename, saveFrame } from './videoEditor';
import { parseImageMessage } from './messages/image';
import { IMAGE_BACKGROUNDS, THEMES, isImageSetting } from './messages/settings';
import { MAX_IMAGE_BYTES } from './webview/imageInfo';

// A read-only custom editor for PNG, JPEG, WebP, BMP, ICO, AVIF and SVG, with
// MarkCopy's copy actions. VS Code's built-in image preview can zoom and nothing
// else, and shows an SVG as XML text.
//
// Like the GIF editor, the file is read whole on the host and sent through
// postMessage as base64. The webview builds a Blob from it, so the canvas it
// copies from stays untainted and localResourceRoots stays at media/ alone.

// The allow-list lives with the message parsers; re-exported for the tests.
export { isImageSetting };

export class ImageEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'markcopy.imagePreview';

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
    const themeValue = this.setting(document.uri, 'theme', 'auto');
    const theme = THEMES.includes(themeValue) ? themeValue : 'auto';
    const background = this.background(document.uri);
    // preview.css carries the shared context menu and toast styles.
    webview.html = this.html(
      webview,
      asUri('image.js'),
      asUri('preview.css'),
      nonce,
      theme,
      background,
    );

    webview.onDidReceiveMessage(async (raw) => {
      const msg = parseImageMessage(raw);
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
          await vscode.env.openExternal(document.uri);
          break;
        case 'updateSetting':
          await applyMarkcopySetting(msg.key, msg.value, document.uri);
          break;
      }
    });

    // Retint when markcopy.theme or markcopy.image.background change elsewhere.
    const themeListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('markcopy.theme', document.uri)) {
        const value = this.setting(document.uri, 'theme', 'auto');
        void webview.postMessage({ type: 'setTheme', value });
      }
      if (e.affectsConfiguration('markcopy.image.background', document.uri)) {
        const value = this.background(document.uri);
        void webview.postMessage({ type: 'setBackground', value });
      }
    });
    panel.onDidDispose(() => themeListener.dispose());
  }

  // Only a known value reaches the page (it is written into an attribute).
  private background(uri: vscode.Uri): string {
    const value = this.setting(uri, 'image.background', 'checkerboard');
    return IMAGE_BACKGROUNDS.includes(value) ? value : 'checkerboard';
  }

  private setting(uri: vscode.Uri, key: string, fallback: string): string {
    return vscode.workspace.getConfiguration('markcopy', uri).get<string>(key, fallback);
  }

  private async sendLoad(webview: vscode.Webview, uri: vscode.Uri): Promise<void> {
    const name = basename(uri);
    try {
      // Size first, off stat, so a huge file is refused before it is read and
      // base64'd in the extension host (see src/stlEditor.ts for the reasoning).
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_IMAGE_BYTES) {
        void webview.postMessage({
          type: 'error',
          message: `${name} is ${mib(stat.size)}, above MarkCopy's ${mib(MAX_IMAGE_BYTES)} limit for image previews.`,
        });
        return;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      void webview.postMessage({
        type: 'load',
        name,
        path: uri.fsPath,
        // The workspace-relative path for Markdown and HTML references; the bare
        // file name outside any workspace, so no other layout reaches the webview.
        relativePath: vscode.workspace.getWorkspaceFolder(uri)
          ? vscode.workspace.asRelativePath(uri, false)
          : name,
        background: this.background(uri),
        size: bytes.byteLength,
        // Base64, not the raw Uint8Array: the webview transport JSON-encodes
        // messages, and JSON turns a typed array into a numeric-keyed object.
        data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
      });
    } catch (err) {
      void webview.postMessage({
        type: 'error',
        message: `Could not read ${name} (${String(err)}).`,
      });
    }
  }

  private html(
    webview: vscode.Webview,
    scriptUri: vscode.Uri,
    styleUri: vscode.Uri,
    nonce: string,
    theme: string,
    background: string,
  ) {
    const csp = [
      `default-src 'none'`,
      // blob: is the picture's source; data: covers a canvas export. No
      // connect-src and no media-src: an SVG in an <img> loads nothing external.
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      // The bundle is a single entry point with no code splitting, so a bare
      // nonce is enough here (no 'strict-dynamic', unlike src/previewShell.ts).
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>MarkCopy Image Preview</title>
<link href="${styleUri}" rel="stylesheet" />
<style>
  /* The viewer's own styles live in media/preview.css; this only keeps the page
     from flashing white before it loads. */
  html, body { height: 100%; margin: 0; }
</style>
</head>
<body class="mc-image" data-mc-theme="${theme}" data-mc-background="${background}" data-vscode-context='{"preventDefaultContextMenuItems":true}'>
  <div id="app"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function mib(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}
