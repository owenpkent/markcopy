import * as vscode from 'vscode';
import { posix } from 'node:path';
import { applyMarkcopySetting } from './settingsScope';
import { htmlShell } from './previewShell';
import { renderWorkbookHtml, WorkbookError } from './xlsx';

const { basename } = posix;

// The settings a sheet is drawn from. Anything outside this list cannot change
// what the grid looks like, so it must not cost a re-read and a re-parse.
const REDRAW_SETTINGS = [
  'markcopy.theme',
  'markcopy.xlsx.maxRows',
  'markcopy.xlsx.maxColumns',
  'markcopy.styleProfile',
];

/** Hand the finished export page back to the host's PDF pipeline. */
export type ExportPdf = (docUri: vscode.Uri, bodyHtml: string) => void;

// A read-only custom editor for .xlsx / .xlsm workbooks.
//
// Unlike the PDF viewer, this ships no webview bundle of its own: it serves the
// same htmlShell() as the Markdown/CSV preview and drives media/webview.js. The
// host renders a sheet into the CSV grid's markup, so the sheet inherits the
// context menu, every Copy as flavor, column resizing, the four themes, and Save
// as PDF without a line of new webview code. src/webview/pdf.ts is a thousand
// lines largely because that reuse was not attempted there.
//
// A workbook is binary, so it never becomes a TextDocument and none of the
// preview's live-update, scroll-sync, or cell-writeback machinery applies. That
// is why this is a custom editor rather than another arm of update().
export class XlsxEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'markcopy.xlsxPreview';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly exportPdf: ExportPdf,
  ) {}

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

    // Which sheet is on screen. The grid is rendered one sheet at a time: the
    // webview's scroller and its column-resize wiring both take the first
    // .mc-csv-wrap they find, and a tab strip matches what every spreadsheet
    // viewer does anyway.
    let sheetIndex = 0;

    const draw = async (): Promise<void> => {
      let html: string;
      try {
        html = await this.renderWorkbook(document.uri, sheetIndex);
      } catch (err) {
        html = errorHtml(err);
      }
      const cfg = vscode.workspace.getConfiguration('markcopy', document.uri);
      void webview.postMessage({
        type: 'render',
        kind: 'xlsx',
        html,
        // No source text and no document version: there is no TextDocument behind
        // this, so nothing addresses it by line. Deliberately no data-source-line
        // on any row either, which is what keeps a sheet out of scroll sync.
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
        // What this surface does, which is a different question from what the
        // user has enabled. A sheet has no TextDocument to reveal into.
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
        } else if (msg?.type === 'selectSheet') {
          const next = Number(msg.index);
          if (Number.isInteger(next) && next >= 0 && next !== sheetIndex) {
            sheetIndex = next;
            await draw();
          }
        } else if (msg?.type === 'pdfHtml' && typeof msg.bodyHtml === 'string') {
          this.exportPdf(document.uri, msg.bodyHtml);
        } else if (msg?.type === 'updateSetting' && typeof msg.key === 'string') {
          await applyMarkcopySetting(msg.key, msg.value, document.uri);
        } else if (msg?.type === 'openSettings') {
          void vscode.commands.executeCommand('markcopy.openSettings');
        } else if (msg?.type === 'toast') {
          vscode.window.setStatusBarMessage(`MarkCopy: ${msg.text}`, 2500);
        }
      }),
    );

    webview.html = htmlShell(this.context, webview, XlsxEditorProvider.viewType);

    // Re-read the workbook when it changes on disk. The PDF viewer has no
    // equivalent and shows a stale document forever.
    //
    // createFileSystemWatcher takes a GlobPattern, not a path. Handing it an
    // fsPath produced a watcher that matched nothing, so this never fired: on
    // Windows the separators read as glob escapes, and an absolute path is not a
    // pattern anywhere. A RelativePattern rooted at the containing folder is the
    // documented way to watch one file.
    //
    // onDidCreate matters as much as onDidChange here, because a spreadsheet
    // application saves by writing a temporary file and renaming it over the
    // original, which arrives as a delete followed by a create.
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

    // Follow markcopy.* changes the way the Markdown preview does, so the theme
    // and the row cap take effect without reopening the workbook.
    //
    // Narrowed to the settings a sheet actually renders from. `markcopy` as a
    // whole includes the Markdown-only keys, and every one of them was re-reading
    // the file from disk and re-parsing the whole workbook to redraw a grid that
    // could not have changed.
    disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (REDRAW_SETTINGS.some((key) => e.affectsConfiguration(key, document.uri))) {
          void draw();
        }
      }),
    );
  }

  private async renderWorkbook(uri: vscode.Uri, sheetIndex: number): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('markcopy', uri);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return renderWorkbookHtml(bytes, {
      sheetIndex,
      maxRows: cfg.get<number>('xlsx.maxRows', 5000),
      maxColumns: cfg.get<number>('xlsx.maxColumns', 200),
    }).html;
  }
}

// A workbook we cannot read becomes a readable notice in the panel, never a blank
// one. WorkbookError messages are written to be shown; anything else is a bug and
// gets a generic lead-in so the panel does not present a stack trace as content.
function errorHtml(err: unknown): string {
  const message =
    err instanceof WorkbookError
      ? err.message
      : `something went wrong reading it (${err instanceof Error ? err.message : String(err)}).`;
  return `<div class="mc-csv-wrap"><p class="mc-csv-note">MarkCopy could not preview this workbook: ${escapeText(message)}</p></div>`;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string;
  });
}
