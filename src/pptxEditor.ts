import * as vscode from 'vscode';
import { posix } from 'node:path';
import { applyMarkcopySetting } from './settingsScope';
import { htmlShell } from './previewShell';
import { renderDeckHtml, DeckError } from './pptx/read';

const { basename } = posix;

// The settings a deck is drawn from. Anything outside this list cannot change
// what the slides look like, so it must not cost a re-read and a re-parse.
const REDRAW_SETTINGS = [
  'markcopy.theme',
  'markcopy.pptx.maxSlides',
  'markcopy.pptx.showNotes',
  'markcopy.styleProfile',
];

/** Hand the finished export page back to the host's PDF pipeline. */
export type ExportPdf = (docUri: vscode.Uri, bodyHtml: string) => void;

/** The same, for the two structure exports, which take serialized XML. */
export type ExportXhtml = (docUri: vscode.Uri, bodyXhtml: string) => void;

// A read-only custom editor for .pptx / .pptm presentations.
//
// The sibling of XlsxEditorProvider and built the same way: no webview bundle of
// its own, just the shared htmlShell() driving media/webview.js, with the host
// rendering slides into ordinary markup. That is what buys the context menu,
// every Copy as flavor, the four themes, and all three exports without a line of
// new webview code.
//
// Unlike a workbook, the whole deck is on screen at once rather than one slide at
// a time, so there is no tab strip and no selectSheet round trip. See
// docs/PPTX-DESIGN.md for why: a deck is read end to end, and the point of this
// extension is taking the whole thing out in one go.
export class PptxEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'markcopy.pptxPreview';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly exportPdf: ExportPdf,
    private readonly exportDocx: ExportXhtml,
    private readonly exportPptx: ExportXhtml,
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

    const draw = async (): Promise<void> => {
      let html: string;
      try {
        html = await this.renderDeck(document.uri);
      } catch (err) {
        html = errorHtml(err);
      }
      const cfg = vscode.workspace.getConfiguration('markcopy', document.uri);
      void webview.postMessage({
        type: 'render',
        kind: 'pptx',
        html,
        // No source text and no document version: there is no TextDocument behind
        // a deck, so nothing addresses it by line.
        source: '',
        docKey: document.uri.toString(),
        docVersion: -1,
        // The user's own setting values, which drive the Preferences submenu.
        syncScroll: cfg.get<boolean>('syncScroll', true),
        autoPreview: cfg.get<boolean>('autoPreview', true),
        math: cfg.get<boolean>('math', true),
        // What this surface does, which is a different question. A deck has no
        // TextDocument to reveal into, so the data-source-line on each slide only
        // ever feeds the per-block copy menu.
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
        }
      }),
    );

    webview.html = htmlShell(this.context, webview, PptxEditorProvider.viewType);

    // Re-read the deck when it changes on disk. PowerPoint saves by writing a
    // temporary file and renaming it over the original, which arrives as a delete
    // followed by a create, so onDidCreate matters as much as onDidChange. A
    // RelativePattern is the documented way to watch one file; an fsPath produces
    // a watcher that matches nothing.
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

    // Narrowed to the settings slides actually render from: `markcopy` as a whole
    // includes the Markdown-only keys, and every one of them would re-read the
    // file and re-parse the deck to redraw something that could not have changed.
    disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (REDRAW_SETTINGS.some((key) => e.affectsConfiguration(key, document.uri))) {
          void draw();
        }
      }),
    );
  }

  private async renderDeck(uri: vscode.Uri): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('markcopy', uri);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return renderDeckHtml(bytes, {
      maxSlides: cfg.get<number>('pptx.maxSlides', 100),
      showNotes: cfg.get<boolean>('pptx.showNotes', true),
    }).html;
  }
}

// A deck we cannot read becomes a readable notice in the panel, never a blank
// one. DeckError messages are written to be shown; anything else is a bug and
// gets a generic lead-in so the panel does not present a stack trace as content.
function errorHtml(err: unknown): string {
  const message =
    err instanceof DeckError
      ? err.message
      : `something went wrong reading it (${err instanceof Error ? err.message : String(err)}).`;
  return `<div class="mc-pptx-deck"><p class="mc-pptx-note">MarkCopy could not preview this presentation: ${escapeText(message)}</p></div>`;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string;
  });
}
