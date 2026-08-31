import * as vscode from 'vscode';
import { join } from 'node:path';
import { getNonce } from './previewShell';
import { applyMarkcopySetting } from './settingsScope';
import {
  codecLabel,
  ensureProxyDir,
  findFfmpeg,
  probeSource,
  proxyDir,
  proxyFileName,
  removeQuietly,
  TranscodeCancelled,
  transcode,
  type FfmpegTools,
  type SourceProbe,
} from './videoProxy';

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
    // Where an ffmpeg-built proxy would go. Registered up front, before any
    // proxy exists, because this list is fixed at the moment the element asks
    // for a URI: a root added later would come too late for the file it is for.
    const proxyRoot = vscode.Uri.file(proxyDir());
    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, fileRoot, proxyRoot],
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

    const proxy = new ProxySession(document.uri, webview, (built) =>
      this.sendLoad(webview, document.uri, built),
    );

    webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') {
        await this.sendLoad(webview, document.uri);
      } else if (msg?.type === 'saveFrame') {
        await saveFrame(document.uri, msg.name, msg.data, webview);
      } else if (msg?.type === 'openExternal') {
        // The escape hatch for a codec VS Code's Chromium cannot decode
        // (ProRes, DNxHD, most HEVC), which is a common shape for a .mov.
        await vscode.env.openExternal(document.uri);
      } else if (msg?.type === 'proxyRequest') {
        // The element gave up on the file. Whether that is the end of the story
        // depends on things only the host can see: the setting, and ffmpeg.
        await proxy.offer();
      } else if (msg?.type === 'proxyStart') {
        await proxy.build();
      } else if (msg?.type === 'proxyCancel') {
        proxy.cancel();
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
    panel.onDidDispose(() => {
      themeListener.dispose();
      // The proxy is scratch, not an export: nothing offers to keep it, so the
      // panel closing is what it was scoped to.
      void proxy.dispose();
    });
  }

  /**
   * Point the webview at something playable and tell it what it is about to play.
   *
   * `built` swaps the source for an ffmpeg proxy while leaving every other field
   * describing the original, because that is what the reader opened: the name in
   * the status line, the path its copy actions yield, and the size on disk are
   * all facts about their file, not about the scratch copy standing in for it.
   */
  private async sendLoad(
    webview: vscode.Webview,
    uri: vscode.Uri,
    built?: BuiltProxy,
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('markcopy', uri);
    // Only for the readout. A file that cannot be stat'd may still play, so a
    // failure here drops the size rather than the video.
    const size = await vscode.workspace.fs.stat(uri).then(
      (stat) => stat.size,
      () => 0,
    );
    void webview.postMessage({
      type: 'load',
      src: webview.asWebviewUri(built ? vscode.Uri.file(built.path) : uri).toString(),
      name: basename(uri),
      path: uri.fsPath,
      size,
      autoplay: cfg.get<boolean>('video.autoplay', false),
      loop: cfg.get<boolean>('video.loop', false),
      proxyNote: built?.note,
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
  .mc-video-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }

  /* The transcode's progress. Fixed width rather than a share of the viewport:
     a bar that resizes with the panel reads as motion, and this one is already
     moving for a reason. */
  .mc-video-progress {
    width: 260px;
    max-width: 80%;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    /* A neutral track rather than a faded copy of the fill colour: opacity on
       the track would fade the fill inside it too, and mid-grey at this alpha
       reads as a groove against both the light and the dark viewport. */
    background: rgba(128, 128, 128, 0.35);
  }
  .mc-video-progress-fill {
    height: 100%;
    width: 0;
    background: var(--vscode-progressBar-background, #0969da);
    transition: width 120ms linear;
  }
  /* A container with no duration gives no percentage to show, so the bar paces
     instead of claiming a position it cannot compute. */
  .mc-video-progress-fill--waiting {
    width: 40%;
    animation: mc-video-pace 1.4s ease-in-out infinite;
  }
  @keyframes mc-video-pace {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(250%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .mc-video-progress-fill { transition: none; }
    .mc-video-progress-fill--waiting { animation: none; width: 100%; opacity: 0.5; }
  }

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

/** A finished proxy: where it is, and how the status line should describe it. */
interface BuiltProxy {
  path: string;
  note: string;
}

// How often the encode's position is pushed to the webview. ffmpeg reports about
// twice a second; a 4K master reports just as often and would otherwise fill the
// message channel with numbers nobody can read that fast.
const PROGRESS_INTERVAL_MS = 250;

/**
 * One panel's attempt to make an unplayable file playable.
 *
 * Owns everything with a lifetime: the running ffmpeg, the file it is writing,
 * and the reader's place in the conversation about it. All of that is scoped to
 * the panel, which is why it is an object per panel rather than module state.
 */
class ProxySession {
  private abort: AbortController | undefined;
  private built: BuiltProxy | undefined;
  private running = false;
  // Set by dispose. An encode that lands in the same tick as the panel closing
  // has a finished proxy and nowhere to play it, and must not keep the file.
  private disposed = false;
  // Both looked up once and kept for the panel's life. Under `auto`, `offer`
  // hands straight over to `build`, and without these the PATH walk and the
  // ffprobe run would each happen twice for one transcode. The probe is also
  // what lets a cancelled encode come back offering to build the same named
  // codec, rather than falling back to the generic message.
  private tools: FfmpegTools | undefined;
  private probed: SourceProbe | undefined;

  constructor(
    private readonly source: vscode.Uri,
    private readonly webview: vscode.Webview,
    private readonly play: (built: BuiltProxy) => Promise<void>,
  ) {}

  /**
   * Answer the viewer's question: can this file be rescued, and should we?
   *
   * Under `auto` this goes straight on to the encode. The setting exists because
   * "straight on" is the wrong default for someone whose folder is 4K camera
   * masters, where the honest answer is a dialogue rather than a ten-minute
   * spinner they did not ask for.
   */
  async offer(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('markcopy', this.source);
    const mode = cfg.get<string>('video.transcode', 'auto');
    if (mode === 'off') {
      this.post({ state: 'unavailable', reason: 'disabled' });
      return;
    }
    const tools = await this.find(cfg);
    if (!tools) {
      this.post({ state: 'unavailable', reason: 'missing' });
      return;
    }
    if (mode === 'ask') {
      // Probe first, so the offer can name the codec rather than describe the
      // whole family of things it might be.
      this.post({ state: 'ask', codec: codecLabel(await this.probe(tools.ffprobe)) });
      return;
    }
    await this.build();
  }

  /** Encode the proxy, reporting progress, and play it when it lands. */
  async build(): Promise<void> {
    if (this.running) {
      return;
    }
    if (this.built) {
      // Already have one; a second press is a request to watch it, not to spend
      // the encode again.
      await this.play(this.built);
      return;
    }

    const cfg = vscode.workspace.getConfiguration('markcopy', this.source);
    const tools = await this.find(cfg);
    if (!tools) {
      this.post({ state: 'unavailable', reason: 'missing' });
      return;
    }

    this.running = true;
    this.abort = new AbortController();
    const abort = this.abort;
    // Named out here so the cleanup below can reach it: a cancelled or failed
    // encode has already written part of this file.
    let output: string | undefined;
    try {
      const probe = await this.probe(tools.ffprobe);
      this.post({ state: 'running', seconds: 0, durationSec: probe.durationSec });

      const dir = await ensureProxyDir();
      output = join(dir, proxyFileName(basename(this.source)));

      let lastPost = 0;
      await transcode({
        ffmpeg: tools.ffmpeg,
        input: this.source.fsPath,
        output,
        probe,
        signal: abort.signal,
        onProgress: (seconds) => {
          const now = Date.now();
          if (now - lastPost < PROGRESS_INTERVAL_MS) {
            return;
          }
          lastPost = now;
          this.post({ state: 'running', seconds, durationSec: probe.durationSec });
        },
      });

      if (this.disposed) {
        // The panel went while ffmpeg was working. There is no webview left to
        // play this, so leave it unclaimed and let the cleanup below take it.
        return;
      }
      this.built = {
        path: output,
        // Said in the status line for as long as the proxy is on screen. The
        // checkerboard half matters more than it looks: a frame grabbed from a
        // composited proxy has the board baked into it, and the reader has to
        // know that before pasting it into a bug report.
        note: probe.hasAlpha
          ? 'ffmpeg preview copy · alpha on checkerboard'
          : 'ffmpeg preview copy',
      };
      await this.play(this.built);
    } catch (err) {
      if (err instanceof TranscodeCancelled) {
        // Back to the offer rather than to an error: the reader stopped this,
        // and may well want it again once they know how long it takes. The
        // probe is already in hand, so the offer still names the codec.
        this.post({ state: 'ask', codec: codecLabel(await this.probe(tools.ffprobe)) });
      } else {
        this.post({ state: 'failed', detail: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.running = false;
      this.abort = undefined;
      // Anything written but never claimed is scratch nothing will ever come
      // looking for: a cancelled encode, a failed one, or one whose panel closed
      // underneath it. Left here it would sit in the temp directory forever,
      // and a cancelled 4K master is not a small thing to leave behind.
      // `transcode` settles only once ffmpeg has actually exited, so by now the
      // file is no longer open and Windows will let go of it.
      if (output !== undefined && this.built?.path !== output) {
        await removeQuietly(output);
      }
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.abort?.abort();
    if (this.built) {
      await removeQuietly(this.built.path);
      this.built = undefined;
    }
  }

  /**
   * The ffmpeg for this panel, found once.
   *
   * Only a successful lookup sticks. A failed one is deliberately not
   * remembered: "no ffmpeg" is the answer most likely to stop being true while
   * the panel is open, because the message the reader is looking at is the one
   * telling them to go and install it.
   */
  private async find(cfg: vscode.WorkspaceConfiguration): Promise<FfmpegTools | undefined> {
    this.tools ??= await findFfmpeg(cfg.get<string>('video.ffmpegPath', ''));
    return this.tools;
  }

  /**
   * What the source is, or a blank answer.
   *
   * A probe that fails is not a reason to refuse the encode: every field it
   * yields is an optimisation (the codec in the message, the total behind the
   * percentage, the checkerboard behind an alpha channel), and `transcodeArgs`
   * already treats an empty probe as "take the plain path".
   */
  private async probe(ffprobe: string): Promise<SourceProbe> {
    if (this.probed) {
      return this.probed;
    }
    try {
      this.probed = await probeSource(ffprobe, this.source.fsPath);
    } catch {
      this.probed = {
        durationSec: 0,
        width: 0,
        height: 0,
        frameRate: 0,
        hasAlpha: false,
        hasAudio: false,
        codec: '',
        profile: '',
      };
    }
    return this.probed;
  }

  private post(msg: Record<string, unknown>): void {
    void this.webview.postMessage({ type: 'proxy', ...msg });
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
