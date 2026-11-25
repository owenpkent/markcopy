import * as vscode from 'vscode';
import { revealInOs, openInDefaultApp } from './revealInOs';
import { basename, dirname, extname } from 'node:path';
import { getNonce } from './previewShell';
import { MAX_PDF_BYTES, readDocument } from './documentFile';
import { parseTexMessage } from './messages/tex';
import { applyMarkcopySetting } from './settingsScope';
import { readComments, warnCommentsRejected, writeComments } from './pdfEditor';
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
import { PdfSnapshot } from './texSnapshot';
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
      asUri('pdf.worker.js'),
      asUri('preview.css', true),
      nonce,
      theme,
    );

    const session = new CompileSession(document, webview);
    const entry = { panel, session, document };
    active.add(entry);

    webview.onDidReceiveMessage(async (raw) => {
      const msg = parseTexMessage(raw);
      if (!msg) {
        return;
      }
      if (msg.type === 'ready') {
        await session.run();
      } else if (msg.type === 'openExternal') {
        // The compiled PDF the preview shows, never a path from the webview.
        const pdf = await session.snapshotUri();
        if (pdf) {
          await openInDefaultApp(pdf);
        }
      } else if (msg.type === 'revealInOS') {
        // The .tex source, not the temp PDF it compiles to.
        revealInOs(document.uri);
      } else if (msg.type === 'texRecompile') {
        await session.run('manual');
      } else if (msg.type === 'saveComments') {
        await writeComments(session.commentsUri(), msg.comments);
      } else if (msg.type === 'saveCommentsRejected') {
        warnCommentsRejected();
      } else if (msg.type === 'updateSetting') {
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
        session.configurationChanged(e);
      }
    });
    const trustListener = vscode.workspace.onDidGrantWorkspaceTrust(() => void session.run());

    panel.onDidDispose(() => {
      active.delete(entry);
      saveListener.dispose();
      configListener.dispose();
      trustListener.dispose();
      void session.dispose();
      this.onDismiss?.(document.uri);
    });
  }

  private html(
    webview: vscode.Webview,
    scriptUri: vscode.Uri,
    workerUri: vscode.Uri,
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
<body class="mc-pdf" data-mc-theme="${theme}" data-worker-src="${workerUri}" data-vscode-context='{"preventDefaultContextMenuItems":true}'>
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

/** What a LaTeX preview last told its webview: the state and the text shown with it. */
export interface TexStatus {
  state: 'compiling' | 'failed' | 'unavailable' | 'ok';
  text?: string;
}

/**
 * The last status the preview for `uri` posted, or undefined before it has posted
 * one or when there is no such preview. Read only. The integration tests use it
 * (through `markcopy.tex.status`) to see what the webview was told, because the
 * webview itself is out of their reach.
 */
export function texStatusFor(uri: vscode.Uri): TexStatus | undefined {
  const key = uri.toString();
  for (const entry of active) {
    if (entry.document.uri.toString() === key) {
      return entry.session.lastStatus;
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
      void entry.session.run('manual');
      return true;
    }
  }
  return false;
}

/** Close active previews and cancel their compilers when the extension stops. */
export function disposeTexPreviews(): void {
  for (const entry of [...active]) {
    entry.panel.dispose();
  }
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
  // Set when `run` is asked to start again while one is already in flight (a
  // second save landing before the first compile settles, or Recompile
  // clicked while the spinner is up). Restarting immediately would throw away
  // a latexmk run that may be a single incremental pass from finishing, so the
  // request is only noted here and picked up by the `finally` in `run` once
  // the current one is done, rather than aborting it.
  private rerunRequested = false;
  private disposed = false;
  private consentedRoot: string | undefined;
  // Cache successful discovery so recompiling on save does not probe again.
  private tools: TexTools | undefined;
  private outDir: string | undefined;
  // The last successfully compiled PDF, which is what the preview shows. Held
  // apart from outDir because a failed rebuild can delete the engine's output.
  private readonly snapshot = new PdfSnapshot();
  /** The last state posted to the webview. Read only, for `texStatusFor`. */
  lastStatus: TexStatus | undefined;

  constructor(
    private readonly document: vscode.TextDocument,
    private readonly webview: vscode.Webview,
  ) {}

  /** A file holding the PDF on screen, or undefined before the first good compile. */
  async snapshotUri(): Promise<vscode.Uri | undefined> {
    const path = await this.snapshot.materialize(basename(this.rootFile()));
    return path ? vscode.Uri.file(path) : undefined;
  }

  /** The file actually handed to the engine, which is not always this document. */
  rootFile(cfg = vscode.workspace.getConfiguration('markcopy', this.document.uri)): string {
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

  /** Check the same policy for every route, including before starting discovery. */
  private canCompile(
    cfg: vscode.WorkspaceConfiguration,
    rootFile: string,
    manual = false,
  ): boolean {
    if (this.disposed) {
      return false;
    }
    const mode = cfg.get<string>('tex.compile', 'ask');
    const trusted = vscode.workspace.isTrusted;
    if (!trusted || mode === 'off') {
      this.consentedRoot = undefined;
      this.cancel();
      const reason = trusted ? 'disabled' : 'untrusted';
      this.post({ state: 'unavailable', text: compileUnavailable(reason, process.platform) });
      return false;
    }
    if (manual) {
      if (this.consentedRoot !== rootFile) {
        this.cancel();
      }
      this.consentedRoot = rootFile;
    }
    if (mode === 'auto' || this.consentedRoot === rootFile) {
      return true;
    }
    this.consentedRoot = undefined;
    this.cancel();
    this.post({
      state: 'unavailable',
      text: compileOffer(basename(rootFile)),
      action: 'Compile',
    });
    return false;
  }

  private cancel(): void {
    this.rerunRequested = false;
    this.abort?.abort();
  }

  configurationChanged(event: vscode.ConfigurationChangeEvent): void {
    const toolChanged =
      event.affectsConfiguration('markcopy.tex.engine', this.document.uri) ||
      event.affectsConfiguration('markcopy.tex.enginePath', this.document.uri);
    // Only the settings that decide what is compiled, with what, or whether it
    // may run restart a build. Others (recompileOnSave) are read when needed.
    if (
      !toolChanged &&
      !event.affectsConfiguration('markcopy.tex.compile', this.document.uri) &&
      !event.affectsConfiguration('markcopy.tex.rootFile', this.document.uri)
    ) {
      return;
    }
    if (toolChanged) {
      this.consentedRoot = undefined;
    }
    this.tools = undefined;
    this.cancel();
    void this.run();
  }

  /** Compile and show the result. Only the command and preview button grant consent. */
  async run(trigger: 'automatic' | 'manual' = 'automatic'): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('markcopy', this.document.uri);
    const rootFile = this.rootFile(cfg);
    if (!this.canCompile(cfg, rootFile, trigger === 'manual')) {
      return;
    }
    if (this.abort) {
      this.rerunRequested = true;
      return;
    }

    const abort = new AbortController();
    this.abort = abort;
    const stillAllowed = () =>
      !abort.signal.aborted &&
      this.canCompile(vscode.workspace.getConfiguration('markcopy', this.document.uri), rootFile);
    try {
      this.post({ state: 'compiling', text: compiling(basename(rootFile)) });
      const tools = this.tools ?? (await this.find(cfg, abort.signal));
      if (!stillAllowed()) {
        return;
      }
      if (!tools) {
        this.post({ state: 'unavailable', text: compileUnavailable('missing', process.platform) });
        return;
      }
      this.tools = tools;

      const outDir = outDirFor(rootFile);
      await ensureTexDir(outDir);
      if (this.disposed) {
        await this.cleanBuildDir(outDir);
        return;
      }
      // Kept for the panel's life rather than per compile, so latexmk's .aux and
      // friends survive between saves and the second compile is the fast one.
      this.outDir = outDir;
      if (!stillAllowed()) {
        return;
      }

      const result = await compile({ tools, rootFile, outDir, signal: abort.signal });
      if (!stillAllowed()) {
        return;
      }
      const output = await readDocument(vscode.Uri.file(result.pdf), MAX_PDF_BYTES);
      const bytes = Buffer.from(output.buffer, output.byteOffset, output.byteLength);
      const comments = await readComments(this.commentsUri());
      if (!stillAllowed()) {
        return;
      }
      this.snapshot.set(bytes);
      // Base64 for the same reason the PDF preview uses it: postMessage turns a
      // Uint8Array into a plain indexed object with no length, which pdf.js
      // rejects. A string round-trips cleanly.
      await this.webview.postMessage({
        type: 'load',
        data: bytes.toString('base64'),
        comments,
      });
      if (stillAllowed()) {
        this.post({ state: 'ok' });
      }
    } catch (err) {
      if (!stillAllowed() || err instanceof CompileCancelled) {
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
    this.cancel();
    await this.snapshot.dispose();
    const dir = this.outDir;
    this.outDir = undefined;
    if (dir) {
      await this.cleanBuildDir(dir);
    }
  }

  private async cleanBuildDir(dir: string): Promise<void> {
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

  private find(
    cfg: vscode.WorkspaceConfiguration,
    signal: AbortSignal,
  ): Promise<TexTools | undefined> {
    const configured = cfg.get<string>('tex.enginePath', '').trim() || undefined;
    const preferred = cfg.get<'auto' | TexEngine>('tex.engine', 'auto');
    return findTex(configured, preferred, process.platform, process.env, signal);
  }

  private post(msg: {
    state: 'compiling' | 'failed' | 'unavailable' | 'ok';
    text?: string;
    detail?: string;
    action?: string;
  }): void {
    this.lastStatus = { state: msg.state, text: msg.text };
    void this.webview.postMessage({ type: 'texState', ...msg });
  }
}
