import * as vscode from 'vscode';
import { revealInOs, openInDefaultApp } from './revealInOs';
import { getNonce } from './previewShell';
import { hasExtension, folderPosition, navigateFolder } from './folderNav';
import { AudioReviewSession } from './audioReview';
import { probeAudio } from './audioProbe';
import { applyMarkcopySetting } from './settingsScope';
import { parseAudioMessage } from './messages/audio';
import { THEMES } from './messages/settings';

// A read-only custom editor that plays audio files (MP3, WAV, Ogg, Opus, FLAC,
// M4A, AAC) in a webview, with Back and Next through the folder's audio files.
//
// Like the video editor, the file is streamed, not loaded: the webview is handed
// a resource URI and its <audio> element pulls ranges off disk as it plays, so a
// long recording costs the extension host nothing. The file's own folder is a
// resource root, so a file outside the workspace (Downloads, a drag onto the
// window) plays too. There is no ffmpeg proxy: a file VS Code's Chromium cannot
// decode (AAC in particular) gets a message saying so.

/** The extensions this editor claims in package.json, lower case. */
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac'];

/** True when a file name ends in one of the extensions the viewer opens. */
export function isAudioFile(name: string): boolean {
  return hasExtension(name, AUDIO_EXTENSIONS);
}

function basename(uri: vscode.Uri): string {
  const p = uri.path;
  return p.substring(p.lastIndexOf('/') + 1);
}

export class AudioEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'markcopy.audioPreview';

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
    // The file's own folder as a resource root: workspace folders are roots by
    // default, but a file opened from outside the workspace is an ordinary case.
    const fileRoot = vscode.Uri.joinPath(document.uri, '..');
    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, fileRoot],
    };

    const nonce = getNonce();
    // Cache-bust the script/style so a rebuilt bundle always loads fresh.
    const asUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file)).with({ query: `v=${nonce}` });
    webview.html = this.html(
      webview,
      asUri('audio.js'),
      asUri('preview.css'),
      nonce,
      this.theme(document.uri),
    );

    // Audio Notes: nothing runs until notes are turned on or a sidecar exists.
    const review = new AudioReviewSession(document.uri, webview);

    let navigating = false;
    let disposed = false;
    webview.onDidReceiveMessage(async (raw) => {
      const msg = parseAudioMessage(raw);
      if (!msg) {
        return;
      }
      switch (msg.type) {
        case 'ready':
          await this.sendLoad(webview, document.uri);
          // Not awaited: the player works while ffprobe runs, and the details
          // panel fills in when (and if) it answers.
          void this.sendDetails(webview, document.uri, () => disposed);
          // Notes follow the sidecar: one beside the file, or the setting.
          await review.onReady();
          break;
        case 'reviewEnable':
          await review.enable();
          break;
        case 'reviewCopy':
          await review.copy();
          break;
        case 'reviewAdd':
          // The session checks each edit with its validator before it touches the file.
          await review.add(msg.raw);
          break;
        case 'reviewDelete':
          await review.delete(msg.raw);
          break;
        case 'reviewRestore':
          await review.restore(msg.raw);
          break;
        case 'updateSetting':
          // Only the keys in isAudioSetting get here (src/messages/settings.ts).
          await applyMarkcopySetting(msg.key, msg.value, document.uri);
          break;
        case 'revealInOS':
          revealInOs(document.uri);
          break;
        case 'openExternal':
          // The escape hatch for a codec VS Code cannot decode. Always the
          // host's own document, never a URI the webview sent.
          await openInDefaultApp(document.uri);
          break;
        case 'navigate':
          // One step per panel: a double click must not open two files.
          if (!navigating) {
            navigating = true;
            try {
              await navigateFolder(
                document.uri,
                panel,
                AudioEditorProvider.viewType,
                isAudioFile,
                msg.step,
              );
            } finally {
              navigating = false;
            }
          }
          break;
      }
    });

    // Retint when markcopy.theme changes elsewhere.
    const themeListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('markcopy.theme', document.uri)) {
        void webview.postMessage({ type: 'setTheme', value: this.theme(document.uri) });
      }
    });
    panel.onDidDispose(() => {
      disposed = true;
      review.dispose();
      themeListener.dispose();
    });
  }

  private theme(uri: vscode.Uri): string {
    const value = vscode.workspace.getConfiguration('markcopy', uri).get<string>('theme', 'auto');
    return THEMES.includes(value) ? value : 'auto';
  }

  private async sendLoad(webview: vscode.Webview, uri: vscode.Uri): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('markcopy', uri);
    // Only for the readout: a file that cannot be stat'd may still play.
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
      position: await folderPosition(uri, isAudioFile),
      autoplay: cfg.get<boolean>('audio.autoplay', false),
      loop: cfg.get<boolean>('audio.loop', false),
      showTags: cfg.get<boolean>('audio.showTags', false),
    });
  }

  /** Probe the file once and post the `details` message; silent when there is no ffprobe. */
  private async sendDetails(
    webview: vscode.Webview,
    uri: vscode.Uri,
    isDisposed: () => boolean,
  ): Promise<void> {
    if (uri.scheme !== 'file') {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('markcopy', uri);
    const details = await probeAudio(uri.fsPath, cfg.get<string>('video.ffmpegPath', ''));
    if (details && !isDisposed()) {
      void webview.postMessage({ type: 'details', details });
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
      // media-src is what lets the <audio> element load the file at all.
      `media-src ${webview.cspSource} blob:`,
      // connect-src is for the waveform: fetch() of the file's own webview URI so
      // Web Audio can decode it. Nothing else may be fetched.
      `connect-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      // Single entry point, no code splitting: a bare nonce is enough.
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>MarkCopy Audio Preview</title>
<link href="${styleUri}" rel="stylesheet" />
<style>
  /* The viewer's own styles live in media/preview.css; this only keeps the page
     from flashing white before it loads. */
  html, body { height: 100%; margin: 0; }
</style>
</head>
<body class="mc-audio" data-mc-theme="${theme}" data-vscode-context='{"preventDefaultContextMenuItems":true}'>
  <div id="app"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
