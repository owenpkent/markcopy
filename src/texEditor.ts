import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { getNonce } from './previewShell';
import { applyMarkcopySetting } from './settingsScope';
import { readComments, writeComments } from './pdfEditor';
import {
  CompileCancelled,
  CompileFailed,
  compile,
  ensureTexDir,
  findTex,
  isInsideDir,
  outDirFor,
  removeQuietly,
  resolveRootFile,
  type TexEngine,
  type TexTools,
} from './texCompile';
import { compileFailed, compileOffer, compileUnavailable, compiling } from './texInfo';

// Source files whose saving should rebuild the preview. A document's own save is
// the obvious trigger, but a thesis is usually a root file that \inputs chapters
// and cites a .bib, and saving one of those has to redraw the preview too or the
// feature only works for single-file documents.
const SOURCE_EXTENSIONS = new Set(['.tex', '.bib', '.sty', '.cls', '.tikz']);

/**
 * A LaTeX preview: compile the document to a PDF in a temp directory, then show
 * that PDF with the pdf.js viewer the PDF preview already uses.
 *
 * This is a CustomTextEditorProvider rather than a read-only one because a .tex
 * file, unlike a PDF or a video, has a perfectly good text form that people spend
 * most of their day in. Contributed at "option" priority for the same reason:
 * opening a .tex must keep giving you the editor unless you ask for otherwise.
 */
export class TexEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'markcopy.texPreview';

  /**
   * `onDismiss` is injected rather than imported so this module does not have to
   * import extension.ts back and close a cycle, the same arrangement xlsxEditor
   * uses for its PDF export. It lets auto-preview know a reader closed this tab,
   * so it does not spring straight back open on the next focus change.
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onDismiss?: (uri: vscode.Uri) => void,
  ) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = {
      enableScripts: true,
      // The compiled PDF reaches the webview as base64 rather than as a URI, so
      // unlike the video proxy the temp directory never has to be a resource root.
      localResourceRoots: [mediaRoot],
    };

    const nonce = getNonce();
    const asUri = (file: string, bust = false) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file));
      return bust ? uri.with({ query: `v=${nonce}` }) : uri;
    };
    const theme = vscode.workspace
      .getConfiguration('markcopy', document.uri)
      .get<string>('theme', 'auto');
    webview.html = this.html(
      webview,
      asUri('pdf.js', true),
      asUri('preview.css', true),
      nonce,
      theme,
    );

    const session = new CompileSession(document, webview, asUri('pdf.worker.js').toString());
    const entry = { panel, session, document };
    active.add(entry);

    webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') {
        await session.start();
      } else if (msg?.type === 'texRecompile') {
        await session.run();
      } else if (msg?.type === 'saveComments') {
        await writeComments(session.commentsUri(), msg.comments);
      } else if (msg?.type === 'updateSetting' && typeof msg.key === 'string') {
        await applyMarkcopySetting(msg.key, msg.value, document.uri);
      }
    });

    // Rebuild on save rather than on keystroke. A LaTeX run is seconds, not the
    // milliseconds the Markdown preview gets away with, and recompiling a half
    // typed \begin{ would spend that time producing an error the writer already
    // knows about.
    const saveListener = vscode.workspace.onDidSaveTextDocument((saved) => {
      const recompile = vscode.workspace
        .getConfiguration('markcopy', document.uri)
        .get<boolean>('tex.recompileOnSave', true);
      if (recompile && session.affectedBy(saved.uri)) {
        void session.run();
      }
    });

    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('markcopy.theme', document.uri)) {
        const value = vscode.workspace
          .getConfiguration('markcopy', document.uri)
          .get<string>('theme', 'auto');
        void webview.postMessage({ type: 'setTheme', value });
      }
      if (e.affectsConfiguration('markcopy.tex', document.uri)) {
        session.invalidateTools();
        // The setting a reader reaches for right after "no LaTeX engine
        // installed" is exactly this one, so it is worth retrying on their
        // behalf rather than waiting for the next save. Not when compiling is
        // switched off, though: that would turn ticking `tex.compile` back to
        // "off" into one more unwanted compile on the way there.
        const mode = vscode.workspace
          .getConfiguration('markcopy', document.uri)
          .get<string>('tex.compile', 'auto');
        if (mode !== 'off') {
          void session.run();
        }
      }
    });

    panel.onDidDispose(() => {
      active.delete(entry);
      saveListener.dispose();
      configListener.dispose();
      void session.dispose();
      this.onDismiss?.(document.uri);
    });
  }

  private html(
    webview: vscode.Webview,
    scriptUri: vscode.Uri,
    styleUri: vscode.Uri,
    nonce: string,
    theme: string,
  ): string {
    // Identical to the PDF preview's policy, because it is the same viewer: the
    // pdf.js worker is fetched as text and re-wrapped in a same-origin Blob,
    // which is what worker-src and connect-src blob: are for.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource} blob: data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en" class="mc-pdf-root">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<title>MarkCopy LaTeX Preview</title>
</head>
<body class="mc-pdf" data-mc-theme="${theme}" data-vscode-context='{"preventDefaultContextMenuItems":true}'>
  <div id="pdf-root"></div>
  <div id="mc-menu" class="mc-menu" role="menu" hidden></div>
  <div id="mc-toast" class="mc-toast" hidden></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Live preview panels, so the Recompile command can find the focused one. */
const active = new Set<{
  panel: vscode.WebviewPanel;
  session: CompileSession;
  document: vscode.TextDocument;
}>();

/**
 * The live preview panel for `uri`, if there is one.
 *
 * Auto-preview runs on every active-editor change, so the caller needs a way to
 * ask "is this already open" that does not depend on `vscode.openWith` reusing a
 * tab. It does not reliably: the target group is `ViewColumn.Beside`, which is
 * relative to whatever is focused at the time, so once focus is inside the
 * preview's own group, Beside resolves to a NEW group and openWith builds a
 * second panel rather than revealing the first. Each one carries its own pdf.js
 * webview, compile session and listeners, so left unchecked they pile up until
 * the extension host falls over.
 */
export function texPanelFor(uri: vscode.Uri): vscode.WebviewPanel | undefined {
  const key = uri.toString();
  for (const entry of active) {
    if (entry.document.uri.toString() === key) {
      return entry.panel;
    }
  }
  return undefined;
}

/**
 * Recompile whichever LaTeX preview is focused. Returns false when none is, so
 * the command can say something useful instead of silently doing nothing.
 */
export function recompileActiveTex(): boolean {
  for (const entry of active) {
    if (entry.panel.active) {
      void entry.session.run();
      return true;
    }
  }
  return false;
}

/**
 * One panel's compile loop.
 *
 * Owns everything with a lifetime: the running engine, the temp directory it
 * writes into, and the last PDF handed to the viewer. All of it is scoped to the
 * panel, which is why it is an object per panel rather than module state.
 */
class CompileSession {
  private abort: AbortController | undefined;
  private running = false;
  // Set when `run` is asked to start again while one is already in flight (a
  // second save landing before the first compile settles, or Recompile
  // clicked while the spinner is up). Restarting immediately would throw away
  // a latexmk run that may be a single incremental pass from finishing, so the
  // request is only noted here and picked up by the `finally` in `run` once
  // the current one is done, rather than aborting it.
  private rerunRequested = false;
  private disposed = false;
  // Looked up once and kept for the panel's life. Under `auto`, `start` hands
  // straight over to `run`, and without this the PATH walk would happen twice
  // for one compile, then again on every save.
  private tools: TexTools | undefined;
  private outDir: string | undefined;

  constructor(
    private readonly document: vscode.TextDocument,
    private readonly webview: vscode.Webview,
    private readonly workerSrc: string,
  ) {}

  /** The file actually handed to the engine, which is not always this document. */
  rootFile(): string {
    const cfg = vscode.workspace.getConfiguration('markcopy', this.document.uri);
    const configured = cfg.get<string>('tex.rootFile', '').trim() || undefined;
    const folder = vscode.workspace.getWorkspaceFolder(this.document.uri);
    return resolveRootFile(
      this.document.uri.fsPath,
      this.document.getText(),
      configured,
      folder?.uri.fsPath,
    );
  }

  /**
   * Pins live beside the .tex source, not beside the compiled PDF, because the
   * PDF is a temp file this session deletes on the way out.
   */
  commentsUri(): vscode.Uri {
    return this.document.uri.with({ path: this.document.uri.path + '.mccomments.json' });
  }

  /** Does saving `uri` mean this preview is now out of date? */
  affectedBy(uri: vscode.Uri): boolean {
    if (uri.toString() === this.document.uri.toString()) {
      return true;
    }
    if (!SOURCE_EXTENSIONS.has(extname(uri.fsPath).toLowerCase())) {
      return false;
    }
    // Anything the root file could plausibly be pulling in. Scoping this to the
    // root's own directory tree keeps an unrelated .tex elsewhere in the
    // workspace from triggering a compile nobody asked for.
    return isInsideDir(dirname(this.rootFile()), uri.fsPath);
  }

  /** First contact: decide whether to compile at all, and say so if not. */
  async start(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('markcopy', this.document.uri);
    const mode = cfg.get<string>('tex.compile', 'auto');
    if (mode === 'off') {
      // No action button: this is a dead end until a setting changes, and a
      // button that cannot help is worse than no button.
      this.post({ state: 'unavailable', text: compileUnavailable('disabled', process.platform) });
      return;
    }
    const tools = await this.find(cfg);
    if (!tools) {
      this.post({ state: 'unavailable', text: compileUnavailable('missing', process.platform) });
      return;
    }
    if (mode === 'ask') {
      // The escape hatch for a thesis-scale document, where compiling the moment
      // a preview opens is a wait nobody asked for.
      this.post({
        state: 'unavailable',
        text: compileOffer(basename(this.rootFile()), tools.engine),
        action: 'Compile',
      });
      return;
    }
    await this.run();
  }

  /** Compile, and show the result. */
  async run(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    const cfg = vscode.workspace.getConfiguration('markcopy', this.document.uri);
    const tools = await this.find(cfg);
    if (!tools) {
      this.post({ state: 'unavailable', text: compileUnavailable('missing', process.platform) });
      return;
    }

    this.running = true;
    this.abort = new AbortController();
    const abort = this.abort;
    try {
      const rootFile = this.rootFile();
      this.post({ state: 'compiling', text: compiling(basename(rootFile)) });

      const outDir = outDirFor(rootFile);
      await ensureTexDir(outDir);
      // Kept for the panel's life rather than per compile, so latexmk's .aux and
      // friends survive between saves and the second compile is the fast one.
      this.outDir = outDir;

      const result = await compile({ tools, rootFile, outDir, signal: abort.signal });
      if (this.disposed) {
        return;
      }
      const bytes = await readFile(result.pdf);
      // Base64 for the same reason the PDF preview uses it: postMessage turns a
      // Uint8Array into a plain indexed object with no length, which pdf.js
      // rejects. A string round-trips cleanly.
      await this.webview.postMessage({
        type: 'load',
        data: bytes.toString('base64'),
        workerSrc: this.workerSrc,
        comments: await readComments(this.commentsUri()),
      });
      this.post({ state: 'ok' });
    } catch (err) {
      if (this.disposed || err instanceof CompileCancelled) {
        // Cancelled means the panel is going away. There is nobody left to tell.
        return;
      }
      const errors = err instanceof CompileFailed ? err.errors : [];
      this.post({
        state: 'failed',
        text: compileFailed(errors),
        // The engine's own log line, verbatim. LaTeX's diagnostics are terse and
        // often cryptic, but they are the thing a writer can search for.
        detail: err instanceof Error ? err.message : String(err),
        action: 'Recompile',
      });
    } finally {
      this.running = false;
      this.abort = undefined;
      // A disposed panel has nobody left to show a rerun to, and its temp
      // directory may already be on the way out; only honour the request while
      // the panel is still around to want it.
      if (this.rerunRequested && !this.disposed) {
        this.rerunRequested = false;
        void this.run();
      }
    }
  }

  /** Whether this session is building into `dir`, for the shared-directory check. */
  buildsInto(dir: string): boolean {
    return this.outDir === dir;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.rerunRequested = false; // nothing left to honour a rerun for
    this.abort?.abort();
    const dir = this.outDir;
    this.outDir = undefined;
    if (!dir) {
      return;
    }
    // The build directory is keyed by the root file, not by the panel, so two
    // previews of one document (a split view, or a chapter and its root) share
    // it. Closing one of them must not delete the other's build out from under
    // it: the survivor would still be showing its PDF, but its next save would
    // have lost every incremental file latexmk left behind.
    for (const entry of active) {
      if (entry.session.buildsInto(dir)) {
        return;
      }
    }
    // The whole directory, not just the PDF: a LaTeX run leaves .aux, .log,
    // .out, .bbl and more beside it, and none of it outlives the last panel.
    await removeQuietly(dir);
  }

  /**
   * Drop the memoized engine choice so the next compile re-resolves it.
   *
   * `tools` is looked up once and kept for the panel's life (see `find`
   * below), so without this a reader who changes `markcopy.tex.engine` or
   * `.enginePath` -- typically right after a failed compile, since that
   * overlay's own "no LaTeX engine installed" text sends them to settings --
   * would see nothing happen until they closed and reopened the tab.
   */
  invalidateTools(): void {
    this.tools = undefined;
  }

  private async find(cfg: vscode.WorkspaceConfiguration): Promise<TexTools | undefined> {
    if (!this.tools) {
      const configured = cfg.get<string>('tex.enginePath', '').trim() || undefined;
      const preferred = cfg.get<string>('tex.engine', 'auto') as 'auto' | TexEngine;
      this.tools = await findTex(configured, preferred);
    }
    return this.tools;
  }

  private post(msg: {
    state: 'compiling' | 'failed' | 'unavailable' | 'ok';
    text?: string;
    detail?: string;
    action?: string;
  }): void {
    void this.webview.postMessage({ type: 'texState', ...msg });
  }
}
