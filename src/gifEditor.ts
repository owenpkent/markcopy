import * as vscode from 'vscode';
import { revealInOs } from './revealInOs';
import { getNonce } from './previewShell';
import { applyMarkcopySetting } from './settingsScope';
import { basename, isViewerSetting, saveFrame } from './videoEditor';
import { MAX_GIF_BYTES } from './webview/gifInfo';

// A read-only custom editor that plays GIFs in a webview, with MarkCopy's copy
// actions on the current frame. VS Code's built-in image preview shows only the
// animation as the browser plays it: no pause, no frame stepping, no frame copy.
//
// Unlike the video editor, which streams its file, a GIF is read whole on the
// host and sent through postMessage as base64, the way the PDF and STL editors
// do it. The webview decodes from a Blob of those bytes, so the file never has
// to be served from a resource origin and the canvas it draws on stays clean
// (a tainted canvas would make Copy Frame throw).

/** True for the one setting the GIF viewer's menus write, with a valid value. */
export function isGifSetting(key: string, value: unknown): boolean {
  return key === 'theme' && isViewerSetting(key, value);
}

export class GifEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'markcopy.gifPreview';

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
    webview.html = this.html(webview, asUri('gif.js'), asUri('preview.css'), nonce, theme);

    webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') {
        await this.sendLoad(webview, document.uri);
      } else if (msg?.type === 'revealInOS') {
        revealInOs(document.uri);
      } else if (msg?.type === 'saveFrame') {
        await saveFrame(document.uri, msg.name, msg.data, webview);
      } else if (msg?.type === 'openExternal') {
        // Always the host's own document, never a URI the webview sent.
        await vscode.env.openExternal(document.uri);
      } else if (
        msg?.type === 'updateSetting' &&
        typeof msg.key === 'string' &&
        isGifSetting(msg.key, msg.value)
      ) {
        await applyMarkcopySetting(msg.key, msg.value, document.uri);
      }
    });

    // Retint when markcopy.theme changes elsewhere, matching the other previews.
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
    const name = basename(uri);
    try {
      // Size first, off stat, so a huge file is refused before it is read and
      // base64'd in the extension host (see src/stlEditor.ts for the reasoning).
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_GIF_BYTES) {
        void webview.postMessage({
          type: 'error',
          message: `${name} is ${mib(stat.size)}, above MarkCopy's ${mib(MAX_GIF_BYTES)} limit for GIF previews.`,
        });
        return;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      void webview.postMessage({
        type: 'load',
        name,
        path: uri.fsPath,
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
  ) {
    const csp = [
      `default-src 'none'`,
      // blob: is the decoder's source and the no-ImageDecoder fallback <img>;
      // no media-src, since nothing here is a <video> or <audio>.
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
<title>MarkCopy GIF Preview</title>
<link href="${styleUri}" rel="stylesheet" />
<style>
  /* Viewport background per markcopy.theme; 'auto' follows the VS Code theme.
     The palette matches media/preview.css so a forced theme looks the same
     across the previews. Deliberately dark by default like the video viewer:
     most GIFs are clips, and a white surround makes them glare. */
  body.mc-gif { --mc-gif-bg: #1e1e1e; --mc-gif-fg: var(--vscode-foreground); }
  body.mc-gif[data-mc-theme='light'] { --mc-gif-bg: #f6f8fa; --mc-gif-fg: #1f2328; }
  body.mc-gif[data-mc-theme='dark'] { --mc-gif-bg: #0d1117; --mc-gif-fg: #e6edf3; }
  body.mc-gif[data-mc-theme='green'] { --mc-gif-bg: #000000; --mc-gif-fg: #33ff33; }

  html, body.mc-gif {
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: var(--mc-gif-bg);
    color: var(--mc-gif-fg);
    font-family: var(--vscode-font-family);
  }
  #mc-stage {
    position: fixed;
    inset: 0 0 30px 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
    box-sizing: border-box;
    cursor: pointer;
  }
  /* Sized by the box, not the file: a large GIF must not push the status line
     off-screen. Small ones are not blown up past their own size. */
  #mc-canvas, #mc-img { max-width: 100%; max-height: 100%; outline: none; }
  #mc-status {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: 30px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    box-sizing: border-box;
    font-size: 11px;
    opacity: 0.75;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #mc-error {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    text-align: center;
    font-size: 13px;
    line-height: 1.5;
  }
  /* The boxes above set display:flex on an id selector, which outranks the user
     agent's [hidden] { display: none }. */
  #mc-stage[hidden], #mc-error[hidden], #mc-canvas[hidden], #mc-img[hidden] { display: none; }
</style>
</head>
<body class="mc-gif" data-mc-theme="${theme}" data-vscode-context='{"preventDefaultContextMenuItems":true}'>
  <div id="mc-stage" hidden>
    <canvas id="mc-canvas" hidden></canvas>
    <img id="mc-img" alt="" hidden />
  </div>
  <div id="mc-error" hidden></div>
  <div id="mc-status"></div>
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
