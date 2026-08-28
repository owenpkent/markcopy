import * as vscode from 'vscode';
import { getNonce } from './previewShell';
import { applyMarkcopySetting } from './settingsScope';

// A read-only custom editor that plays QuickTime (.mov) and MP4 (.mp4/.m4v)
// files in a webview, with MarkCopy's copy actions on the current frame.
//
// The file is streamed, not loaded: unlike the PDF and STL editors, which read
// the whole file and base64 it through postMessage, this one hands the webview
// a resource URI and lets the <video> element pull ranges off disk as it plays.
// A video is one to three orders of magnitude larger than either of those, and
// the base64 round trip would cost several times the file's size in the
// extension host, where running out of memory takes the whole window with it.
export class VideoEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'markcopy.videoPreview';

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
    // The video's own folder has to be a resource root as well. Workspace
    // folders are roots by default, but a video opened from outside the
    // workspace (a Downloads folder, a drag onto the window) is the ordinary
    // case for this editor, and without its directory here the element would be
    // handed a URI the webview refuses to serve.
    const fileRoot = vscode.Uri.joinPath(document.uri, '..');
    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, fileRoot],
    };

    const nonce = getNonce();
    // Cache-bust the script/style so a rebuilt bundle always loads fresh: the
    // webview otherwise caches these by their (unchanged) resource URL.
    const asUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file)).with({ query: `v=${nonce}` });
    const theme = vscode.workspace
      .getConfiguration('markcopy', document.uri)
      .get<string>('theme', 'auto');
    webview.html = this.html(webview, asUri('video.js'), asUri('preview.css'), nonce, theme);

    webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') {
        await this.sendLoad(webview, document.uri);
      } else if (msg?.type === 'saveFrame') {
        await saveFrame(document.uri, msg.name, msg.data, webview);
      } else if (msg?.type === 'openExternal') {
        // The escape hatch for a codec VS Code's Chromium cannot decode
        // (ProRes, DNxHD, most HEVC), which is a common shape for a .mov.
        await vscode.env.openExternal(document.uri);
      } else if (msg?.type === 'updateSetting' && typeof msg.key === 'string') {
        // Persist a setting changed from the viewer's menu (theme, loop) at the
        // scope where it is defined, matching the other previews.
        await applyMarkcopySetting(msg.key, msg.value, document.uri);
      }
    });

    // Retint when markcopy.theme changes elsewhere (another preview's Theme
    // menu, or settings.json), matching src/pdfEditor.ts and src/stlEditor.ts.
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

  /** Point the webview at the file and tell it what it is about to play. */
  private async sendLoad(webview: vscode.Webview, uri: vscode.Uri): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('markcopy', uri);
    // Only for the readout. A file that cannot be stat'd may still play, so a
    // failure here drops the size rather than the video.
    const size = await vscode.workspace.fs.stat(uri).then(
      (stat) => stat.size,
      () => 0,
    );
    void webview.postMessage({
      type: 'load',
      src: webview.asWebviewUri(uri).toString(),
      name: basename(uri),
      path: uri.fsPath,
      size,
      autoplay: cfg.get<boolean>('video.autoplay', false),
      loop: cfg.get<boolean>('video.loop', false),
    });
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
      // media-src is what lets the <video> element load the file at all; blob:
      // is not used today but keeps a future in-memory source working.
      `media-src ${webview.cspSource} blob:`,
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
<link href="${styleUri}" rel="stylesheet" />
<title>MarkCopy Video Preview</title>
<style>
  /* Viewport background per markcopy.theme; 'auto' follows the VS Code theme.
     The palette matches media/preview.css so a forced theme looks the same
     across the Markdown, PDF, STL, and video previews. Video is letterboxed
     against it, so it stays deliberately dark by default: a white surround
     around a dark clip is the one thing a player should not do. */
  body.mc-video { --mc-video-bg: #1e1e1e; --mc-video-fg: var(--vscode-foreground); }
  body.mc-video[data-mc-theme='light'] { --mc-video-bg: #f6f8fa; --mc-video-fg: #1f2328; }
  body.mc-video[data-mc-theme='dark'] { --mc-video-bg: #0d1117; --mc-video-fg: #e6edf3; }
  body.mc-video[data-mc-theme='green'] { --mc-video-bg: #000000; --mc-video-fg: #33ff33; }

  html, body.mc-video {
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: var(--mc-video-bg);
    color: var(--mc-video-fg);
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
  }
  /* The element is sized by the box, not the file: a 4K clip must not push the
     controls off-screen, and a 240p one must not be blown up to fill it. */
  #mc-video { max-width: 100%; max-height: 100%; outline: none; }
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
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 32px;
    text-align: center;
  }
  .mc-video-error-text { margin: 0; max-width: 44em; line-height: 1.5; font-size: 13px; }
  .mc-video-button {
    border: 1px solid var(--vscode-contrastBorder, transparent);
    border-radius: 4px;
    padding: 6px 14px;
    font-size: 13px;
    background: var(--vscode-button-background, #0969da);
    color: var(--vscode-button-foreground, #ffffff);
    cursor: pointer;
  }
  .mc-video-button:hover { background: var(--vscode-button-hoverBackground, #0a6ad1); }

  /* Both boxes above set display:flex on an id selector, which outranks the
     user agent's [hidden] { display: none } and would leave the stage and the
     error overlay on screen together. The toast and the menu need no such rule:
     neither one sets a display. */
  #mc-stage[hidden], #mc-error[hidden] { display: none; }
</style>
</head>
<body class="mc-video" data-mc-theme="${theme}" data-vscode-context='{"preventDefaultContextMenuItems":true}'>
  <div id="mc-stage" hidden>
    <video id="mc-video" controls playsinline preload="metadata"></video>
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

// Write a grabbed frame wherever the reader points the save dialog, defaulting
// to the video's own folder.
async function saveFrame(
  videoUri: vscode.Uri,
  name: unknown,
  data: unknown,
  webview: vscode.Webview,
): Promise<void> {
  if (typeof data !== 'string' || !data) {
    return;
  }
  const fileName = typeof name === 'string' && name ? name : 'frame.png';
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(videoUri, '..', fileName),
    filters: { 'PNG image': ['png'] },
  });
  if (!target) {
    return; // cancelled
  }
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(data, 'base64'));
    void webview.postMessage({ type: 'toast', message: 'Frame saved' });
  } catch (err) {
    void vscode.window.showErrorMessage(`MarkCopy: could not save the frame (${String(err)}).`);
  }
}

function basename(uri: vscode.Uri): string {
  const p = uri.path;
  return p.substring(p.lastIndexOf('/') + 1);
}
