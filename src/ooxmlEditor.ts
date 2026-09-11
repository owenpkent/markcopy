import * as vscode from 'vscode';
import { posix } from 'node:path';
import { applyMarkcopySetting } from './settingsScope';
import { htmlShell } from './previewShell';

const { basename } = posix;

/** Hand the finished export page back to the host's PDF pipeline. */
export type ExportPdf = (docUri: vscode.Uri, bodyHtml: string) => void;

/** The same, for the two structure pipelines, which take serialized XML. */
export type ExportXhtml = (docUri: vscode.Uri, bodyXhtml: string) => void;

/**
 * The per-document state and hooks a subclass needs across one panel's
 * lifetime.
 *
 * Created once per resolveCustomEditor call rather than held on the provider
 * instance, because one provider instance serves every workbook or deck a
 * reader has open at once: an instance field for something like xlsx's
 * current sheet index would leak one document's selection into another's the
 * moment two were open side by side.
 */
export interface OoxmlSession {
  /** Read the file and produce the markup draw() should show for it. */
  render(): Promise<string>;
  /**
   * Handle a message type this format adds on top of the shared router
   * (xlsx's selectSheet, say). Called only for messages none of the shared
   * branches matched; call `redraw` if the message changes what should be on
   * screen.
   */
  handleMessage?(msg: any, redraw: () => Promise<void>): Promise<void> | void;
}

/**
 * The message an error notice shows.
 *
 * A workbook or deck we cannot read becomes a readable notice in the panel,
 * never a blank one. A format's own error type is written to be shown as its
 * message verbatim; anything else is a bug and gets a generic lead-in so the
 * panel never presents a stack trace as content.
 */
export function describeReadError(err: unknown, isFormatError: (err: unknown) => boolean): string {
  return isFormatError(err) && err instanceof Error
    ? err.message
    : `something went wrong reading it (${err instanceof Error ? err.message : String(err)}).`;
}

// The read-only OOXML custom-editor scaffold that XlsxEditorProvider and
// PptxEditorProvider both build on.
//
// Neither ships a webview bundle of its own: both serve the same htmlShell()
// as the Markdown/CSV preview and drive media/webview.js, with the host
// rendering the file into ordinary markup. That is what buys the context
// menu, every Copy as flavor, the four themes, and all three exports without
// a line of new webview code. src/webview/pdf.ts is a thousand lines largely
// because that reuse was not attempted there.
//
// A workbook or deck is binary, so it never becomes a TextDocument and none
// of the preview's live-update, scroll-sync, or cell-writeback machinery
// applies. That is why this is a custom editor rather than another arm of
// update(), and it is true of every format built on this base, so it lives
// here rather than being repeated in each one.
//
// What is NOT here: anything about what a document looks like once read.
// Each subclass supplies its own render() (and, for a format like xlsx that
// tracks more than "the whole file", its own per-panel state) through
// createSession, its own redrawSettings, its own errorHtml, and any message
// type the shared router does not already know about.
export abstract class OoxmlEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly exportPdf: ExportPdf,
    private readonly exportDocx: ExportXhtml,
    private readonly exportPptx: ExportXhtml,
  ) {}

  /** The viewType this editor is registered under, and what htmlShell keys its bundle on. */
  protected abstract readonly viewType: string;

  /** The `kind` the render message carries; preview.css and main.ts key the layout off it. */
  protected abstract readonly kind: string;

  /**
   * Settings that can change what this format draws. Anything outside this
   * list cannot change the output, so it must not cost a re-read and a
   * re-parse; see each subclass's own list for why its particular keys are
   * on it.
   */
  protected abstract readonly redrawSettings: readonly string[];

  /** Build the per-panel render/message state for a newly opened document. */
  protected abstract createSession(document: vscode.CustomDocument): OoxmlSession;

  /** Turn a render failure into the notice the panel shows instead of it. */
  protected abstract errorHtml(err: unknown): string;

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    const disposables: vscode.Disposable[] = [];
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));

    const session = this.createSession(document);

    const draw = async (): Promise<void> => {
      let html: string;
      try {
        html = await session.render();
      } catch (err) {
        html = this.errorHtml(err);
      }
      const cfg = vscode.workspace.getConfiguration('markcopy', document.uri);
      void webview.postMessage({
        type: 'render',
        kind: this.kind,
        html,
        // No source text and no document version: there is no TextDocument
        // behind this format, so nothing addresses it by line.
        source: '',
        docKey: document.uri.toString(),
        docVersion: -1,
        // The user's own setting values. These drive the Preferences submenu,
        // which reads them as what the user has chosen and writes the opposite
        // back when clicked. Describing this surface here instead reported Sync
        // scroll, Auto-open preview and Math as off no matter what the user had
        // set, and every click on one wrote a value they had not asked for.
        syncScroll: cfg.get<boolean>('syncScroll', true),
        autoPreview: cfg.get<boolean>('autoPreview', true),
        math: cfg.get<boolean>('math', true),
        footnotes: cfg.get<boolean>('footnotes', true),
        // What this surface does, which is a different question from what the
        // user has enabled: this format has no TextDocument to reveal into,
        // so scroll sync never applies regardless of the setting above.
        supportsSync: false,
        theme: cfg.get<string>('theme', 'auto'),
        styleProfile: cfg.get<string>('styleProfile', 'github'),
        mermaidConfig: {},
      });
    };

    // Registered before the HTML is assigned, so the webview's `ready` cannot
    // arrive before there is something listening for it.
    disposables.push(
      webview.onDidReceiveMessage(async (msg) => {
        if (msg?.type === 'ready') {
          await draw();
        } else if (msg?.type === 'pdfHtml' && typeof msg.bodyHtml === 'string') {
          this.exportPdf(document.uri, msg.bodyHtml);
        } else if (msg?.type === 'docxXhtml' && typeof msg.bodyXhtml === 'string') {
          this.exportDocx(document.uri, msg.bodyXhtml);
        } else if (msg?.type === 'pptxXhtml' && typeof msg.bodyXhtml === 'string') {
          this.exportPptx(document.uri, msg.bodyXhtml);
        } else if (msg?.type === 'updateSetting' && typeof msg.key === 'string') {
          await applyMarkcopySetting(msg.key, msg.value, document.uri);
        } else if (msg?.type === 'openSettings') {
          void vscode.commands.executeCommand('markcopy.openSettings');
        } else if (msg?.type === 'toast') {
          vscode.window.setStatusBarMessage(`MarkCopy: ${msg.text}`, 2500);
        } else if (session.handleMessage) {
          await session.handleMessage(msg, draw);
        }
      }),
    );

    webview.html = htmlShell(this.context, webview, this.viewType);

    // Re-read the file when it changes on disk. The PDF viewer has no
    // equivalent and shows a stale document forever.
    //
    // createFileSystemWatcher takes a GlobPattern, not a path. Handing it an
    // fsPath produced a watcher that matched nothing, so this never fired: on
    // Windows the separators read as glob escapes, and an absolute path is not a
    // pattern anywhere. A RelativePattern rooted at the containing folder is the
    // documented way to watch one file.
    //
    // onDidCreate matters as much as onDidChange here, because both a
    // spreadsheet application and PowerPoint save by writing a temporary file
    // and renaming it over the original, which arrives as a delete followed by
    // a create.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.joinPath(document.uri, '..'),
        basename(document.uri.path),
      ),
    );
    disposables.push(
      watcher,
      watcher.onDidChange(() => void draw()),
      watcher.onDidCreate(() => void draw()),
    );

    // Follow markcopy.* changes the way the Markdown preview does, so settings
    // like the theme take effect without reopening the file.
    //
    // Narrowed to the settings this format actually renders from. `markcopy` as
    // a whole includes the Markdown-only keys, and every one of them would
    // re-read the file from disk and re-parse it to redraw something that
    // could not have changed.
    disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (this.redrawSettings.some((key) => e.affectsConfiguration(key, document.uri))) {
          void draw();
        }
      }),
    );
  }
}
