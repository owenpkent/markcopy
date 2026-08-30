import * as vscode from 'vscode';
import { join } from 'node:path';
import { createMarkdownIt } from './render';
import { PdfEditorProvider } from './pdfEditor';
import {
  buildPdfPage,
  createProfileDir,
  findBrowser,
  removeQuietly,
  renderPdf,
  type PageSize,
} from './pdfExport';
import { classifyLink, localImageRef, previewKind, shouldAutoPreview } from './preview-utils';
import { cellEdit, delimiterHint, gridEdits, isGridOp, renderCsvHtml, sniffDelimiter } from './csv';
import { applyMarkcopySetting } from './settingsScope';
import { htmlShell } from './previewShell';
import { XlsxEditorProvider } from './xlsxEditor';
import { StlEditorProvider } from './stlEditor';
import { VideoEditorProvider } from './videoEditor';

const VIEW_TYPE = 'markcopy.preview';

interface PreviewState {
  panel: vscode.WebviewPanel;
  docUri: vscode.Uri;
  // A heading id to scroll to on the next render, set when a link navigates to a
  // new document with a `#fragment`. Consumed (and cleared) by the next update().
  pendingReveal?: string;
  // Line count as of the last render, and the document version at which it last
  // changed. A CSV cell edit is addressed by source line, so together these say
  // whether a line number minted at some earlier version still points at the
  // same row. Reset when the preview retargets to another document.
  lineCount?: number;
  lineCountVersion?: number;
}

let current: PreviewState | undefined;
// Rebuilt in update() only when the `markcopy.math` setting flips, so toggling
// math on/off takes effect without reloading the window.
let md = createMarkdownIt();
let mdMath = true;

// Documents whose preview the user closed this session. Auto-preview skips these
// so a dismissed preview does not spring back open on the next focus change.
const dismissedPreviews = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // PDF files open in the MarkCopy PDF preview (a read-only custom editor).
    vscode.window.registerCustomEditorProvider(
      PdfEditorProvider.viewType,
      new PdfEditorProvider(context),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),

    // Workbooks open in the MarkCopy sheet preview (a read-only custom editor).
    vscode.window.registerCustomEditorProvider(
      XlsxEditorProvider.viewType,
      new XlsxEditorProvider(
        context,
        (docUri, bodyHtml) =>
          // Injected rather than imported, so xlsxEditor.ts does not have to import
          // this module back and close a cycle.
          void exportPdf(context, docUri, bodyHtml),
      ),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),

    // STL files open in the MarkCopy STL preview (a read-only custom editor).
    vscode.window.registerCustomEditorProvider(
      StlEditorProvider.viewType,
      new StlEditorProvider(context),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),

    // Video files open in the MarkCopy video preview (a read-only custom editor).
    vscode.window.registerCustomEditorProvider(
      VideoEditorProvider.viewType,
      new VideoEditorProvider(context),
      {
        supportsMultipleEditorsPerDocument: false,
        // Without this, switching tabs tears the webview down and playback
        // restarts from zero on the way back.
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),

    vscode.commands.registerCommand('markcopy.openPreview', (uri?: vscode.Uri) => {
      const doc = pickDocument(uri);
      if (doc) {
        // An explicit open clears any earlier dismissal for this document.
        dismissedPreviews.delete(doc.uri.toString());
        openPreview(context, doc);
      } else {
        vscode.window.showInformationMessage('MarkCopy: open a Markdown or CSV file first.');
      }
    }),

    // Open the MarkCopy settings (also reachable from the preview's title-bar gear
    // and the in-preview right-click menu).
    vscode.commands.registerCommand('markcopy.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:OwenPKent.markcopy');
    }),

    vscode.commands.registerCommand('markcopy.copyDocumentAsRichText', () => {
      if (current) {
        current.panel.reveal(vscode.ViewColumn.Beside, true);
        current.panel.webview.postMessage({ type: 'copyAll' });
      } else {
        vscode.window.showInformationMessage(
          'MarkCopy: open the preview first (MarkCopy: Open Rich Preview).',
        );
      }
    }),

    // Export the preview as a PDF. The webview serializes its already rendered
    // content (KaTeX, Mermaid, highlighted code) and posts it back as a `pdfHtml`
    // message, handled in onDidReceiveMessage below and rendered by exportPdf.
    vscode.commands.registerCommand('markcopy.saveAsPdf', () => {
      if (current) {
        current.panel.webview.postMessage({ type: 'exportPdf' });
      } else {
        vscode.window.showInformationMessage(
          'MarkCopy: open the preview first (MarkCopy: Open Rich Preview).',
        );
      }
    }),

    // Live update the preview when the source document changes.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (current && e.document.uri.toString() === current.docUri.toString()) {
        // Every change is seen here, unlike update(), which is debounced. Note
        // the version whenever a line appears or disappears: that is the moment
        // line numbers minted by an earlier render stopped being trustworthy.
        if (current.lineCount !== undefined && e.document.lineCount !== current.lineCount) {
          current.lineCountVersion = e.document.version;
        }
        current.lineCount = e.document.lineCount;
        scheduleUpdate(current);
      }
    }),

    // Re-render when a MarkCopy setting (style profile, theme, sync) changes.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (current && e.affectsConfiguration('markcopy')) {
        update(current);
      }
    }),

    // Re-render when the VS Code color theme changes so Mermaid diagrams
    // re-theme in auto mode (the CSS palette already updates live).
    vscode.window.onDidChangeActiveColorTheme(() => {
      if (current) {
        update(current);
      }
    }),

    // Auto-open (or retarget) the preview when a Markdown editor gains focus,
    // when enabled. Opens beside with focus preserved so the cursor stays put.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      maybeAutoPreview(context, editor);
    }),

    // Editor -> preview scroll sync.
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (!syncScrollEnabled() || revealEcho()) {
        return;
      }
      if (current && e.textEditor.document.uri.toString() === current.docUri.toString()) {
        const line = e.visibleRanges[0]?.start.line ?? 0;
        current.panel.webview.postMessage({ type: 'scrollToLine', line });
      }
    }),
  );

  // The extension activates on `onLanguage:markdown`, i.e. a Markdown editor is
  // already active. onDidChangeActiveTextEditor won't fire for that first editor,
  // so run the auto-preview check for it once on activation.
  maybeAutoPreview(context, vscode.window.activeTextEditor);
}

// Auto-open (or retarget) the preview for a Markdown editor when enabled. Opens
// beside with focus preserved so the cursor stays put.
function maybeAutoPreview(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor | undefined,
): void {
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const enabled = vscode.workspace.getConfiguration('markcopy').get<boolean>('autoPreview', true);
  const eligible = shouldAutoPreview({
    enabled,
    languageId: doc.languageId,
    scheme: doc.uri.scheme,
    docKey: doc.uri.toString(),
    path: doc.uri.path,
    dismissed: dismissedPreviews,
  });
  if (eligible) {
    openPreview(context, doc);
  }
}

export function deactivate(): void {
  current?.panel.dispose();
}

function pickDocument(uri?: vscode.Uri): vscode.TextDocument | undefined {
  const active = vscode.window.activeTextEditor;
  if (uri && uri.scheme === 'file') {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  }
  // Whatever is in front of the reader. `update` decides how to render it, so
  // there is nothing to gate on here: a document MarkCopy does not recognize is
  // previewed as Markdown rather than refused.
  return active?.document;
}

function openPreview(context: vscode.ExtensionContext, doc: vscode.TextDocument): void {
  if (current) {
    if (current.docUri.toString() !== doc.uri.toString()) {
      // When the preview panel's own column was the active group, VS Code opens
      // the newly-focused Markdown file as a tab *in that column*. Move it back to
      // the first column so the preview beside it stays a clean two-column layout
      // instead of getting pushed out to a third.
      const editor = vscode.window.activeTextEditor;
      if (
        editor &&
        editor.document.uri.toString() === doc.uri.toString() &&
        editor.viewColumn === current.panel.viewColumn
      ) {
        void vscode.window.showTextDocument(editor.document, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: false,
        });
      }
      current.docUri = doc.uri;
      // Line tracking belongs to the document that just went away; the new one
      // gets its own baseline from the render below.
      current.lineCount = undefined;
      current.lineCountVersion = undefined;
      // Grant the webview read access to the newly-targeted document's folder so
      // its relative images resolve (localResourceRoots is fixed at creation).
      current.panel.webview.options = {
        enableScripts: true,
        localResourceRoots: resourceRoots(context, doc.uri),
      };
    }
    // Reveal in the panel's existing column (never "Beside") so retargeting to a
    // new document never migrates the preview into an additional column.
    current.panel.reveal(current.panel.viewColumn ?? vscode.ViewColumn.Beside, true);
    update(current);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    `Preview ${basename(doc.uri)}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: resourceRoots(context, doc.uri),
    },
  );

  const state: PreviewState = { panel, docUri: doc.uri };
  current = state;

  panel.webview.html = htmlShell(context, panel.webview);

  panel.webview.onDidReceiveMessage(
    (msg) => {
      if (msg?.type === 'revealLine') {
        revealEditorLine(state.docUri, msg.line);
      } else if (msg?.type === 'toast') {
        vscode.window.setStatusBarMessage(`MarkCopy: ${msg.text}`, 2500);
      } else if (msg?.type === 'updateSetting' && typeof msg.key === 'string') {
        void applyMarkcopySetting(msg.key, msg.value, state.docUri);
      } else if (msg?.type === 'openSettings') {
        vscode.commands.executeCommand('markcopy.openSettings');
      } else if (msg?.type === 'openLink' && typeof msg.href === 'string') {
        void openLink(context, state, msg.href);
      } else if (msg?.type === 'pdfHtml' && typeof msg.bodyHtml === 'string') {
        void exportPdf(context, state.docUri, msg.bodyHtml);
      } else if (msg?.type === 'editCell') {
        void applyCellEdit(state, msg);
      } else if (msg?.type === 'gridOp') {
        void applyGridOp(state, msg);
      }
    },
    undefined,
    context.subscriptions,
  );

  panel.onDidDispose(
    () => {
      if (current === state) {
        // Remember the dismissal so auto-preview does not immediately reopen it.
        dismissedPreviews.add(state.docUri.toString());
        current = undefined;
      }
    },
    undefined,
    context.subscriptions,
  );

  update(state);
}

// The folders the preview webview may load local resources (images) from: the
// extension's own media, plus the document's workspace folder or, failing that,
// the document's own directory.
function resourceRoots(context: vscode.ExtensionContext, docUri: vscode.Uri): vscode.Uri[] {
  const roots = [vscode.Uri.joinPath(context.extensionUri, 'media')];
  const folder = vscode.workspace.getWorkspaceFolder(docUri);
  roots.push(folder ? folder.uri : vscode.Uri.joinPath(docUri, '..'));
  return roots;
}

// Coalesce the renders a burst of typing would otherwise trigger. A Markdown
// document is small, but a CSV costs a delimiter sniff, a full parse, and a
// string-built grid of up to markcopy.csv.maxRows rows on every keystroke.
// Short enough to read as live, long enough that holding a key down renders once.
const UPDATE_DEBOUNCE_MS = 80;
let updateTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleUpdate(state: PreviewState): void {
  if (updateTimer !== undefined) {
    clearTimeout(updateTimer);
  }
  updateTimer = setTimeout(() => {
    updateTimer = undefined;
    if (current === state) {
      update(state);
    }
  }, UPDATE_DEBOUNCE_MS);
}

function update(state: PreviewState): void {
  // A direct update supersedes anything the debounce still has pending, so the
  // two can never race and render the same document twice.
  if (updateTimer !== undefined) {
    clearTimeout(updateTimer);
    updateTimer = undefined;
  }
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === state.docUri.toString(),
  );
  if (!doc) {
    return;
  }
  const source = doc.getText();
  const webview = state.panel.webview;
  const cfg = vscode.workspace.getConfiguration('markcopy');
  const math = cfg.get<boolean>('math', true);
  if (math !== mdMath) {
    md = createMarkdownIt({ math });
    mdMath = math;
  }
  // Both kinds end up as HTML in the same `render` message; the webview only
  // needs `kind` to pick the layout (a CSV is a full-width, self-scrolling grid).
  const kind = previewKind(doc.languageId, state.docUri.path) ?? 'markdown';
  const html =
    kind === 'csv'
      ? renderCsvHtml(source, {
          // Resolved here rather than inside renderCsvHtml so the grid and any
          // cell edit written back to it are guaranteed to agree on it.
          delimiter: csvDelimiter(doc, source),
          headerRow: cfg.get<boolean>('csv.headerRow', true),
          maxRows: cfg.get<number>('csv.maxRows', 5000),
        }).html
      : md.render(source, {
          resolveImage: (src: string) => resolveImageSrc(src, state.docUri, webview),
        });
  state.lineCount = doc.lineCount;
  state.panel.title = `Preview ${basename(state.docUri)}`;
  // A one-shot heading reveal, set when a link navigated here. The webview also
  // scrolls a newly-targeted document to the top on its own (docKey change).
  const revealFragment = state.pendingReveal || undefined;
  state.pendingReveal = undefined;
  webview.postMessage({
    type: 'render',
    html,
    source,
    kind,
    docVersion: doc.version,
    docKey: state.docUri.toString(),
    revealFragment,
    styleProfile: cfg.get<string>('styleProfile', 'github'),
    theme: cfg.get<string>('theme', 'auto'),
    mermaidConfig: cfg.get<object>('mermaid', {}),
    syncScroll: cfg.get<boolean>('syncScroll', true),
    autoPreview: cfg.get<boolean>('autoPreview', true),
    math,
  });
}

// The delimiter to read a document with: the configured one, or the sniffed one
// biased by what the document's type already says (a .tsv is tab-separated even
// when its fields are full of commas). Both the grid and the writeback go
// through here, so they can never disagree about where a field ends.
function csvDelimiter(doc: vscode.TextDocument, text: string): string {
  const configured = vscode.workspace
    .getConfiguration('markcopy')
    .get<string>('csv.delimiter', 'auto');
  if (configured && configured !== 'auto') {
    return configured;
  }
  return sniffDelimiter(text, delimiterHint(doc.languageId, doc.uri.path));
}

// Write one edited CSV cell back into the document.
//
// The grid never edits itself: it posts the new value and waits for the document
// to change, which re-renders the preview. That keeps the file authoritative and
// puts every cell edit in the editor's own undo stack, so Ctrl+Z works normally.
//
// `docVersion` is the version the grid was rendered from. If the document has
// moved on since (the user typed in the editor, or an earlier edit is still
// settling), the row the grid is pointing at may no longer be that row, so the
// edit is dropped rather than applied to the wrong line.
async function applyCellEdit(state: PreviewState, msg: Record<string, unknown>): Promise<void> {
  const line = Number(msg.line);
  const column = Number(msg.column);
  const value = msg.value;
  if (!Number.isInteger(line) || !Number.isInteger(column) || typeof value !== 'string') {
    return;
  }

  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === state.docUri.toString(),
  );
  if (!doc || previewKind(doc.languageId, state.docUri.path) !== 'csv') {
    return;
  }
  if (typeof msg.docVersion === 'number' && !addressable(state, doc, msg.docVersion)) {
    return; // stale grid; the re-render already on its way carries the truth
  }

  const text = doc.getText();
  const edit = cellEdit(text, csvDelimiter(doc, text), line, column, value);
  if (!edit) {
    return;
  }

  const range = new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end));
  if (doc.getText(range) === edit.text) {
    return; // nothing to change; applying it would only push a dead undo stop
  }
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.replace(doc.uri, range, edit.text);
  const applied = await vscode.workspace.applyEdit(workspaceEdit);
  if (!applied) {
    void vscode.window.showWarningMessage('MarkCopy: could not edit this file.');
    return;
  }
  // Re-render at once rather than waiting out the debounce, so the grid's notion
  // of the document version catches up before the next cell edit is committed.
  update(state);
}

// Insert or delete a whole row or column.
//
// Written the same way a cell edit is: the grid posts what it wants done and
// waits for the document to change, so the file stays authoritative and the
// operation lands in the editor's own undo stack. One WorkspaceEdit carries
// every replacement, so a column that touches ten thousand rows is still a
// single change and a single Ctrl+Z.
async function applyGridOp(state: PreviewState, msg: Record<string, unknown>): Promise<void> {
  const op = msg.op;
  const line = Number(msg.line);
  const column = Number(msg.column);
  if (!isGridOp(op) || !Number.isInteger(line) || !Number.isInteger(column)) {
    return;
  }

  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === state.docUri.toString(),
  );
  if (!doc || previewKind(doc.languageId, state.docUri.path) !== 'csv') {
    return;
  }
  if (typeof msg.docVersion === 'number' && !addressable(state, doc, msg.docVersion)) {
    return; // stale grid; the re-render already on its way carries the truth
  }

  const text = doc.getText();
  // The document's own line ending, so a new row does not introduce the other
  // kind into a file that has been consistent until now.
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const edits = gridEdits(text, csvDelimiter(doc, text), op, { line, column }, eol);
  if (edits.length === 0) {
    return;
  }

  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const edit of edits) {
    // Every offset was measured against this same unedited text and no two of
    // the ranges overlap, so they can all be handed over together.
    workspaceEdit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)),
      edit.text,
    );
  }
  const applied = await vscode.workspace.applyEdit(workspaceEdit);
  if (!applied) {
    void vscode.window.showWarningMessage('MarkCopy: could not edit this file.');
    return;
  }
  // Re-render at once rather than waiting out the debounce, so the grid stops
  // addressing rows by numbers this edit has just moved.
  update(state);
}

// Whether a grid rendered at `version` can still address this document by line.
//
// An exact version match is the easy case, and not the only safe one. A cell
// edit rewrites a field inside a single line, so a line number stays valid until
// something adds or removes a line: `lineCountVersion` is exactly when that last
// happened. Requiring an exact match instead would silently swallow edits, since
// MarkCopy's own writeback bumps the version and the grid only learns the new
// one when the re-render reaches it. Typing across two cells quickly would lose
// the second. An edit that does move lines (committing a value with a newline in
// it) pushes lineCountVersion past the grid, and is then correctly refused.
function addressable(state: PreviewState, doc: vscode.TextDocument, version: number): boolean {
  return (
    version === doc.version ||
    state.lineCountVersion === undefined ||
    version >= state.lineCountVersion
  );
}

// Rewrite a relative/local markdown image src to a webview-safe URI so it loads
// inside the sandboxed preview. Remote/data URIs are returned untouched.
function resolveImageSrc(src: string, docUri: vscode.Uri, webview: vscode.Webview): string {
  const ref = localImageRef(src);
  if (!ref) {
    return src;
  }
  const target = ref.absolute
    ? vscode.Uri.file(ref.path)
    : vscode.Uri.joinPath(docUri, '..', ref.path);
  return webview.asWebviewUri(target).toString() + ref.suffix;
}

// Follow a link clicked in the preview. In-page `#fragment` links are handled
// entirely in the webview and never reach here; this deals with external URLs
// (opened in the browser) and local files resolved relative to the document:
// Markdown targets retarget the preview, everything else opens in VS Code.
async function openLink(
  context: vscode.ExtensionContext,
  state: PreviewState,
  href: string,
): Promise<void> {
  const target = classifyLink(href);
  if (!target || target.kind === 'fragment') {
    return;
  }
  if (target.kind === 'external') {
    // Only hand real web/mail schemes to the OS. markdown-it + DOMPurify already
    // strip javascript:/vbscript: hrefs upstream, so this just bounds the blast
    // radius (and drops degenerate `?query`-only hrefs that carry no scheme).
    let parsed: vscode.Uri | undefined;
    try {
      parsed = vscode.Uri.parse(target.href, true);
    } catch {
      parsed = undefined;
    }
    if (parsed && /^(https?|mailto)$/i.test(parsed.scheme)) {
      void vscode.env.openExternal(parsed);
    }
    return;
  }
  const targetUri = target.absolute
    ? vscode.Uri.file(target.path)
    : vscode.Uri.joinPath(state.docUri, '..', target.path);
  if (!target.markdown) {
    // Images, PDFs, source files, etc. VS Code picks the right editor (a .pdf
    // opens in the MarkCopy PDF preview).
    await vscode.commands.executeCommand('vscode.open', targetUri);
    return;
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(targetUri);
  } catch {
    void vscode.window.showWarningMessage(`MarkCopy: could not open ${basename(targetUri)}.`);
    return;
  }
  // Land at the linked heading, or the top of the new document. Set before the
  // editor swap so whichever path retargets the preview first sends it.
  state.pendingReveal = target.fragment || '';
  // Keep the source in the first column so editor + preview stay two-column,
  // then (re)target the preview at it.
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: true,
  });
  openPreview(context, doc);
}

// ---------------------------------------------------------------------------
// Scroll sync
// ---------------------------------------------------------------------------
// Revealing a line moves the editor, which fires onDidChangeTextEditorVisibleRanges,
// which would push that same position straight back at the preview the reader is
// still scrolling. This window marks the reveals we caused ourselves so they are
// not echoed; the preview applies the mirror-image rule (see SYNC_ECHO_MS in
// src/webview/main.ts).
const REVEAL_ECHO_MS = 250;
let revealedAt = 0;

function revealEcho(): boolean {
  return Date.now() - revealedAt < REVEAL_ECHO_MS;
}

function syncScrollEnabled(): boolean {
  return vscode.workspace.getConfiguration('markcopy').get<boolean>('syncScroll', true);
}

// Preview -> editor. Gated on the same setting as the other direction: with sync
// scroll off, neither surface follows the other.
function revealEditorLine(docUri: vscode.Uri, line: number): void {
  if (!syncScrollEnabled() || !Number.isFinite(line)) {
    return;
  }
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === docUri.toString(),
  );
  if (!editor) {
    return;
  }
  // The webview measures against the render it has, which a fast edit can leave a
  // line or two behind the document; clamp rather than throw on an out-of-range line.
  const clamped = Math.min(Math.max(0, Math.floor(line)), editor.document.lineCount - 1);
  revealedAt = Date.now();
  editor.revealRange(new vscode.Range(clamped, 0, clamped, 0), vscode.TextEditorRevealType.AtTop);
}

// Only one export at a time: each one spawns a browser process, and a second
// export of the same preview would race it for the same destination file.
let exportingPdf = false;

// Export the preview as a PDF file.
//
// The preview's serialized HTML goes into a standalone page, which a headless
// Chromium-family browser renders straight to the destination the user picked. No
// browser window, no print dialog, and none of the header/footer furniture that
// dialog adds by default (the document title across the top, the `file://…` URL
// across the bottom). See src/pdfExport.ts.
//
// Where no such browser can be found, this falls back to the older route: write
// the page out and open it in the default browser for the user to print by hand.
export async function exportPdf(
  context: vscode.ExtensionContext,
  docUri: vscode.Uri,
  bodyHtml: string,
): Promise<void> {
  if (exportingPdf) {
    void vscode.window.showInformationMessage('MarkCopy: a PDF export is already in progress.');
    return;
  }
  exportingPdf = true;
  try {
    await runExport(context, docUri, bodyHtml);
  } finally {
    exportingPdf = false;
  }
}

async function runExport(
  context: vscode.ExtensionContext,
  docUri: vscode.Uri,
  bodyHtml: string,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('markcopy');
  const pageSize = cfg.get<PageSize>('pdf.pageSize', 'Letter');
  const name = basename(docUri).replace(/\.(md|markdown|mdown|mkd|csv|tsv|tab|xlsx|xlsm)$/i, '');

  const browser = await findBrowser(cfg.get<string>('pdf.browserPath', ''));
  if (!browser) {
    await printViaBrowser(context, bodyHtml, name, pageSize, 'no-browser');
    return;
  }

  const target = await vscode.window.showSaveDialog({
    defaultUri: defaultPdfUri(docUri, name),
    filters: { 'PDF document': ['pdf'] },
    saveLabel: 'Export PDF',
    title: 'Export preview as PDF',
  });
  if (!target) {
    return; // cancelled
  }

  try {
    const html = await buildPdfHtml(context, bodyHtml, name, { pageSize, autoPrint: false });
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `MarkCopy: exporting ${basename(target)}…`,
      },
      async () => {
        // One throwaway directory holds both the page and the browser's profile,
        // so cleaning up is a single delete however the render ends.
        const dir = await createProfileDir();
        try {
          const htmlUri = vscode.Uri.file(join(dir, 'export.html'));
          await vscode.workspace.fs.writeFile(htmlUri, Buffer.from(html, 'utf8'));
          // Render to a scratch file inside the throwaway directory, then move the
          // finished PDF onto the destination. Rendering straight to the user's
          // chosen path looks simpler and is wrong three ways: `stat` on that path
          // cannot tell a fresh render from a file that was already sitting there,
          // so a browser that exits 0 without writing reports success and leaves a
          // stale export the reader believes is current; a browser sandboxed away
          // from this directory would still write its error page to a destination
          // it *can* reach, which no size check can distinguish from a real render;
          // and a failed render would have already overwritten the previous file
          // before we raise the error. A scratch path we know was empty makes the
          // check below sound, and makes a failure a no-op on the reader's disk.
          const scratch = join(dir, 'export.pdf');
          await renderPdf({
            browser,
            htmlPath: htmlUri.fsPath,
            pdfPath: scratch,
            userDataDir: join(dir, 'profile'),
          });
          await vscode.workspace.fs.copy(vscode.Uri.file(scratch), target, { overwrite: true });
        } finally {
          await removeQuietly(dir);
        }
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const choice = await vscode.window.showErrorMessage(
      `MarkCopy: could not export the PDF: ${message}`,
      'Print from Browser',
    );
    if (choice) {
      await printViaBrowser(context, bodyHtml, name, pageSize, 'fallback');
    }
    return;
  }

  // Hand the finished file to whatever the OS uses for PDFs.
  void vscode.env.openExternal(target);
  vscode.window.setStatusBarMessage(`MarkCopy: exported ${basename(target)}.`, 6000);
}

// Where the save dialog starts: beside the source document, or failing that in the
// first workspace folder.
function defaultPdfUri(docUri: vscode.Uri, name: string): vscode.Uri {
  const safe = `${name.replace(/[^\w.\- ]+/g, '-').replace(/^-+|-+$/g, '') || 'markcopy'}.pdf`;
  if (docUri.scheme === 'file') {
    return vscode.Uri.joinPath(docUri, '..', safe);
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, safe) : vscode.Uri.file(safe);
}

// The manual route, kept for machines with no Chromium-family browser installed
// and as the escape hatch when a headless render fails: write the page to the
// extension's storage folder and open it in the default browser, where it invokes
// the print dialog itself.
async function printViaBrowser(
  context: vscode.ExtensionContext,
  bodyHtml: string,
  name: string,
  pageSize: PageSize,
  reason: 'no-browser' | 'fallback',
): Promise<void> {
  try {
    const html = await buildPdfHtml(context, bodyHtml, name, { pageSize, autoPrint: true });
    const dir = context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(dir);
    const safe = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'markcopy';
    const fileUri = vscode.Uri.joinPath(dir, `${safe}.html`);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(html, 'utf8'));
    // globalStorageUri uses the `vscode-userdata:` scheme, which the OS shell
    // can't open; re-wrap the on-disk path as a `file:` URI for the browser.
    await vscode.env.openExternal(vscode.Uri.file(fileUri.fsPath));
    if (reason === 'no-browser') {
      void vscode.window.showInformationMessage(
        'MarkCopy: no Chrome, Edge, or Chromium found for a direct PDF export, so the preview ' +
          'opened in your browser instead. Press Ctrl/Cmd+P and choose "Save as PDF". Set ' +
          '`markcopy.pdf.browserPath` if one is installed somewhere unusual.',
      );
    } else {
      vscode.window.setStatusBarMessage(
        'MarkCopy: opened in your browser. Press Ctrl/Cmd+P and choose "Save as PDF".',
        6000,
      );
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`MarkCopy: could not export PDF (${String(err)}).`);
  }
}

// Wrap the rendered body in a standalone HTML page carrying the preview's own CSS
// (so it looks identical to the on-screen preview) plus print tuning. Forces the
// light palette for a clean printout regardless of the preview's display theme.
async function buildPdfHtml(
  context: vscode.ExtensionContext,
  bodyHtml: string,
  title: string,
  opts: { pageSize: PageSize; autoPrint: boolean },
): Promise<string> {
  return buildPdfPage({
    bodyHtml,
    title,
    previewCss: await readMedia(context, 'preview.css'),
    // KaTeX CSS is only needed when the document contains math; skip its
    // (font-heavy) inlining otherwise to keep the export small.
    katexCss: /class="(katex|mc-math)/.test(bodyHtml) ? await inlineKatexFonts(context) : '',
    pageSize: opts.pageSize,
    autoPrint: opts.autoPrint,
  });
}

async function readMedia(context: vscode.ExtensionContext, ...segments: string[]): Promise<string> {
  const uri = vscode.Uri.joinPath(context.extensionUri, 'media', ...segments);
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

// Return katex.min.css with its woff2 font references replaced by base64 data URIs
// so equations render in a plain file:// page (relative font URLs would 404, and
// cross-origin file:// fonts are CORS-blocked). Browsers pick woff2 first, so the
// now-unresolved woff/ttf fallbacks are never fetched.
async function inlineKatexFonts(context: vscode.ExtensionContext): Promise<string> {
  let css = await readMedia(context, 'katex', 'katex.min.css');
  const fontDir = vscode.Uri.joinPath(context.extensionUri, 'media', 'katex', 'fonts');
  const names = new Set([...css.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)].map((m) => m[1]));
  for (const name of names) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(fontDir, name));
      const dataUrl = `data:font/woff2;base64,${Buffer.from(bytes).toString('base64')}`;
      css = css.split(`url(fonts/${name})`).join(`url(${dataUrl})`);
    } catch {
      /* skip a missing font; the rest still inline */
    }
  }
  return css;
}

function basename(uri: vscode.Uri): string {
  const p = uri.path;
  return p.substring(p.lastIndexOf('/') + 1);
}
