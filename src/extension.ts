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
import {
  autoPreviewKind,
  classifyLink,
  isTexDocument,
  localImageRef,
  type PreviewKind,
  previewKind,
} from './preview-utils';
import {
  applyCsvEdits,
  cellEdit,
  delimiterHint,
  gridEdits,
  isGridOp,
  renderCsvHtml,
  sniffDelimiter,
} from './csv';
import { applyMarkcopySetting } from './settingsScope';
import { htmlShell } from './previewShell';
import { htmlToDocx, reportSummary, type DocxReport } from './docxExport';
import { htmlToPptx, reportSummary as pptxReportSummary, type PptxReport } from './pptxExport';
import { XlsxEditorProvider } from './xlsxEditor';
import { PptxEditorProvider } from './pptxEditor';
import { StlEditorProvider } from './stlEditor';
import { VideoEditorProvider } from './videoEditor';
import { sweepProxyDir } from './videoProxy';
import { TexEditorProvider, recompileActiveTex, texPanelFor } from './texEditor';
import { sweepTexRoot } from './texCompile';

const VIEW_TYPE = 'markcopy.preview';

// The two custom-editor viewTypes contributed in package.json. They share this
// provider and this code path; they differ only in which files the editor picker
// offers them for, and in the name it shows.
const MARKDOWN_VIEW_TYPE = 'markcopy.markdownPreview';
const CSV_VIEW_TYPE = 'markcopy.csvPreview';

interface PreviewState {
  panel: vscode.WebviewPanel;
  docUri: vscode.Uri;
  // True for a preview that *is* the document's editor tab, opened through the
  // editor picker's "Reopen Editor With...". It is bound to that document for
  // life, and VS Code, not update(), owns its tab title.
  tab?: boolean;
  // A heading id to scroll to on the next render, set when a link navigates to a
  // new document with a `#fragment`. Consumed (and cleared) by the next update().
  pendingReveal?: string;
  // Line count as of the last render, and the document version at which it last
  // changed. A CSV cell edit is addressed by source line, so together these say
  // whether a line number minted at some earlier version still points at the
  // same row. Reset when the preview retargets to another document.
  lineCount?: number;
  lineCountVersion?: number;
  // This preview's pending debounced render (see scheduleUpdate). Per preview, so
  // typing in one document cannot cancel another preview's render.
  timer?: ReturnType<typeof setTimeout>;
}

// Every live preview: the side panel, plus one per document opened *as* a
// MarkCopy editor tab. Document edits, setting changes and scroll sync fan out
// to all of them.
const previews = new Set<PreviewState>();

// The "to the side" panel: the single preview openPreview retargets rather than
// duplicating. A preview opened as an editor tab is never this one.
let side: PreviewState | undefined;
// Rebuilt in update() only when the `markcopy.math` setting flips, so toggling
// math on/off takes effect without reloading the window.
let md = createMarkdownIt();
let mdMath = true;

// Documents whose preview the user closed this session. Auto-preview skips these
// so a dismissed preview does not spring back open on the next focus change.
const dismissedPreviews = new Set<string>();

// LaTeX previews whose `openWith` is in flight. See `openTexPreview`.
const openingTex = new Set<string>();

// Markdown and CSV documents whose swap to the rendered preview is in flight.
// The same synchronous claim `openingTex` stakes, for the same reason: see
// `showRendered`.
const openingRendered = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  // Proxies are deleted when their panel closes, so this normally finds nothing.
  // It is here for the window that was killed rather than closed, which never got
  // to run that cleanup. Fire and forget: nothing downstream waits on a sweep.
  void sweepProxyDir();
  // Same story for LaTeX build directories, which are larger and more numerous.
  void sweepTexRoot();

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
        // Injected rather than imported, so xlsxEditor.ts does not have to import
        // this module back and close a cycle.
        (docUri, bodyHtml) => void exportPdf(context, docUri, bodyHtml),
        (docUri, bodyXhtml) => void exportDocx(docUri, bodyXhtml),
        (docUri, bodyXhtml) => void exportPptx(docUri, bodyXhtml),
      ),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),

    // Presentations open in the MarkCopy slide preview (a read-only custom editor).
    vscode.window.registerCustomEditorProvider(
      PptxEditorProvider.viewType,
      new PptxEditorProvider(
        context,
        (docUri, bodyHtml) => void exportPdf(context, docUri, bodyHtml),
        (docUri, bodyXhtml) => void exportDocx(docUri, bodyXhtml),
        (docUri, bodyXhtml) => void exportPptx(docUri, bodyXhtml),
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

    // LaTeX files can be opened as a MarkCopy preview, which compiles them and
    // shows the PDF. Contributed at "option" priority, like Markdown and CSV and
    // unlike the read-only previews: a .tex is a file people edit, so opening one
    // has to keep giving them the text editor.
    vscode.window.registerCustomEditorProvider(
      TexEditorProvider.viewType,
      new TexEditorProvider(context, (uri) => dismissedPreviews.add(uri.toString())),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),

    // Markdown and CSV files can also be opened *as* a MarkCopy preview: the same
    // webview the side panel uses, in the document's own tab rather than beside it.
    // Both are contributed at "option" priority, so nothing about what a
    // double-click in the Explorer does changes until someone asks for it, by
    // "Reopen Editor With..." or the `markcopy.openRendered` button below, or for
    // good from the picker's "Set Default for '*.md'". "Default" was tried and
    // reverted: a .md is a file people edit all day, unlike the .pdf and .xlsx
    // this provider sits next to, and quietly taking over every Markdown file on
    // an extension update is a bigger thing to do than a one-click button is
    // worth. The button gets a reader to the same place without the ambush.
    vscode.window.registerCustomEditorProvider(
      MARKDOWN_VIEW_TYPE,
      new PreviewEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerCustomEditorProvider(CSV_VIEW_TYPE, new PreviewEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('markcopy.openPreview', (uri?: vscode.Uri) => {
      const doc = pickDocument(uri);
      if (doc) {
        // LaTeX does not go through the shared preview panel. It renders through
        // pdf.js rather than the Markdown/CSV webview bundle, so its preview is a
        // custom editor; opening it Beside gives the same source-left,
        // preview-right layout by a different route.
        // An explicit open clears any earlier dismissal for this document.
        dismissedPreviews.delete(doc.uri.toString());
        if (isTexDocument(doc.languageId, doc.uri.path)) {
          openTexPreview(doc.uri, false);
          return;
        }
        openPreview(context, doc);
      } else {
        vscode.window.showInformationMessage(
          'MarkCopy: open a Markdown, CSV, or LaTeX file first.',
        );
      }
    }),

    // The way back out of a preview that *is* the tab, however the reader got
    // there: the openRendered button, "Reopen Editor With...", or a "Set Default
    // for '*.md'" they set months ago and have stopped thinking about. Without it
    // the only route to the text is that same picker, two menus deep. Opens in
    // the active group, which is the preview's own, so asking for the source never
    // splits the editor, and `showTextDocument` takes over the preview's tab
    // rather than opening a second editor on the same file beside it, so this is
    // a swap. `markcopy.openRendered` swaps it back.
    vscode.commands.registerCommand('markcopy.openSource', async (uri?: vscode.Uri) => {
      // `focusedPreview`, not `activePreview`: this command swaps the preview the
      // reader is looking at back to its text, so a preview that merely exists is
      // not an answer. `activePreview` falls back to the side panel, which from
      // the palette meant running Show Source with the cursor already in the text
      // re-showed the editor that was focused anyway, closed nothing (the panel
      // is a webview, not a custom tab), and recorded a dismissal that quietly
      // turned auto-preview off for that file for the session.
      const target = uri ?? focusedPreview()?.docUri;
      if (!target) {
        vscode.window.showInformationMessage('MarkCopy: focus a MarkCopy preview tab first.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false,
      });
      await closeStaleEditor(target, 'custom');
      // Asking for the source is a request to look at the text, not to be handed
      // the preview again from the side. Without this, auto-preview would answer
      // the click by opening the panel beside, which is the layout the reader
      // just walked away from. Running "Open Rich Preview to the Side" clears the
      // dismissal again, as it does for a preview closed by hand.
      //
      // Recorded only once the text is actually up. Doing it first meant a file
      // deleted or renamed out from under its preview tab threw on the open and
      // still left auto-preview disabled for it, with nothing to say why when the
      // file came back.
      dismissedPreviews.add(target.toString());
    }),

    // The mirror of openSource, and deliberately the same slot on the title bar:
    // whichever way round the file is open, the leftmost button takes you to the
    // other view, in place, so the pair reads as one toggle rather than two
    // unrelated icons. Contributed on `editorLangId`, so it shows on the text
    // editor and openSource shows on the preview tab, and never both at once.
    vscode.commands.registerCommand('markcopy.openRendered', async (uri?: vscode.Uri) => {
      const doc = pickDocument(uri);
      const kind = doc && previewKind(doc.languageId, doc.uri.path);
      if (!doc || !kind) {
        vscode.window.showInformationMessage('MarkCopy: open a Markdown, CSV, or TSV file first.');
        return;
      }
      // Asking for the preview is the explicit request that clears a dismissal,
      // the same as "Open Rich Preview to the Side" does. Without this, showing
      // the source and then coming back would leave auto-preview switched off for
      // the document for the rest of the session.
      dismissedPreviews.delete(doc.uri.toString());
      await showRendered(doc, kind);
    }),

    vscode.commands.registerCommand('markcopy.recompileTex', () => {
      if (!recompileActiveTex()) {
        vscode.window.showInformationMessage(
          'MarkCopy: focus a LaTeX preview first (MarkCopy: Open Rich Preview).',
        );
      }
    }),

    // Open the MarkCopy settings (also reachable from the preview's title-bar gear
    // and the in-preview right-click menu).
    vscode.commands.registerCommand('markcopy.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:OwenPKent.markcopy');
    }),

    vscode.commands.registerCommand('markcopy.copyDocumentAsRichText', () => {
      const state = activePreview();
      if (state) {
        // Only the side panel is ours to move; an editor tab stays in the group
        // the reader put it in.
        if (state === side) {
          state.panel.reveal(vscode.ViewColumn.Beside, true);
        }
        state.panel.webview.postMessage({ type: 'copyAll' });
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
      const state = activePreview();
      if (state) {
        state.panel.webview.postMessage({ type: 'exportPdf' });
      } else {
        vscode.window.showInformationMessage(
          'MarkCopy: open the preview first (MarkCopy: Open Rich Preview).',
        );
      }
    }),

    // Export the preview as a Word document. Same round trip as the PDF export
    // above, but the webview serializes the structure rather than the styling;
    // see exportDocx below and src/docxExport.ts.
    vscode.commands.registerCommand('markcopy.saveAsDocx', () => {
      const state = activePreview();
      if (state) {
        state.panel.webview.postMessage({ type: 'exportDocx' });
      } else {
        vscode.window.showInformationMessage(
          'MarkCopy: open the preview first (MarkCopy: Open Rich Preview).',
        );
      }
    }),

    // Export the preview as a PowerPoint deck. The same round trip again: the
    // webview serializes the structure once and the host decides what to make of
    // it, which is why adding a third format cost a message name and nothing else.
    vscode.commands.registerCommand('markcopy.saveAsPptx', () => {
      const state = activePreview();
      if (state) {
        state.panel.webview.postMessage({ type: 'exportPptx' });
      } else {
        vscode.window.showInformationMessage(
          'MarkCopy: open the preview first (MarkCopy: Open Rich Preview).',
        );
      }
    }),

    // Live update the preview when the source document changes.
    vscode.workspace.onDidChangeTextDocument((e) => {
      for (const state of previewsOf(e.document.uri)) {
        // Every change is seen here, unlike update(), which is debounced. Note
        // the version whenever a line appears or disappears: that is the moment
        // line numbers minted by an earlier render stopped being trustworthy.
        if (state.lineCount !== undefined && e.document.lineCount !== state.lineCount) {
          state.lineCountVersion = e.document.version;
        }
        state.lineCount = e.document.lineCount;
        scheduleUpdate(state);
      }
    }),

    // Re-render when a MarkCopy setting (style profile, theme, sync) changes.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('markcopy')) {
        for (const state of previews) {
          update(state);
        }
      }
    }),

    // Re-render when the VS Code color theme changes so Mermaid diagrams
    // re-theme in auto mode (the CSS palette already updates live).
    vscode.window.onDidChangeActiveColorTheme(() => {
      for (const state of previews) {
        update(state);
      }
    }),

    // Swap a Markdown, CSV or TSV editor to the preview when it gains focus, if
    // auto-preview is on.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      maybeAutoPreview(context, editor);
    }),

    // Editor -> preview scroll sync.
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (!syncScrollEnabled() || revealEcho()) {
        return;
      }
      const line = e.visibleRanges[0]?.start.line ?? 0;
      for (const state of previewsOf(e.textEditor.document.uri)) {
        state.panel.webview.postMessage({ type: 'scrollToLine', line });
      }
    }),
  );

  // The extension activates on `onLanguage:markdown`, i.e. a Markdown editor is
  // already active. onDidChangeActiveTextEditor won't fire for that first editor,
  // so run the auto-preview check for it once on activation.
  maybeAutoPreview(context, vscode.window.activeTextEditor);
}

// Show the preview for a Markdown, CSV or TSV editor when enabled, in that
// editor's own tab. LaTeX still opens beside, for the reason given below.
function maybeAutoPreview(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor | undefined,
): void {
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const enabled = vscode.workspace.getConfiguration('markcopy').get<boolean>('autoPreview', true);
  if (isTexDocument(doc.languageId, doc.uri.path)) {
    // LaTeX gets the same auto-preview bargain as Markdown and CSV, but keeps the
    // Beside layout the others gave up. Its preview is a compiled PDF rather than
    // a view of the text, so swapping the .tex tab to it would leave the author
    // nothing to edit: the one case where the split is the point rather than the
    // problem.
    if (enabled && doc.uri.scheme === 'file' && !dismissedPreviews.has(doc.uri.toString())) {
      openTexPreview(doc.uri, true);
    }
    return;
  }
  const kind = autoPreviewKind({
    enabled,
    languageId: doc.languageId,
    scheme: doc.uri.scheme,
    docKey: doc.uri.toString(),
    path: doc.uri.path,
    dismissed: dismissedPreviews,
  });
  if (!kind) {
    return;
  }
  // A reader who ran "Open Rich Preview to the Side" asked for two columns, so
  // keep that bargain and retarget the panel rather than swapping this tab.
  // Swapping instead would leave the panel rendering a document that is no
  // longer open anywhere while the file the reader just clicked became a preview
  // in the other column: two previews, no source, and neither of them the one
  // they were pointing at.
  if (side) {
    openPreview(context, doc);
    return;
  }
  if (!swappable(doc, editor)) {
    return;
  }
  // Swap the tab to the rendered document rather than opening a panel beside it,
  // so focusing a Markdown file leaves you with one group instead of two.
  showRendered(doc, kind).then(undefined, () => {
    // A focus change is not a request, so a refused open is not worth a message.
    // Swallowed rather than left to `void`, which would surface it as an
    // unhandled rejection in the extension host and tell the reader nothing.
  });
}

/**
 * Whether focusing `doc` should swap its tab to the preview.
 *
 * Every no here is the reader saying they are working in the text, and the
 * answer to all of them is not to swap at all rather than merely to leave the
 * source tab open alongside. Show Preview still works in each case: it is a
 * click, not a focus change, and a click is an answer.
 */
function swappable(doc: vscode.TextDocument, editor: vscode.TextEditor): boolean {
  // Unsaved changes, read off the document rather than off its tab. The tab only
  // reports `isDirty` for a plain text editor in the active group, so asking it
  // missed a dirty document opened in a diff or in a group other than the
  // focused one, which is exactly when it mattered most.
  if (doc.isDirty) {
    return false;
  }
  // Pinning is the reader saying "keep this one", and a pinned source that
  // flipped to the preview every time it was clicked would be unusable.
  if (activeTabOn(doc.uri, 'text')?.isPinned) {
    return false;
  }
  // A diff is a view of the text by definition. Clicking a modified .md in the
  // Source Control list focuses the working-tree side of a `TabInputTextDiff`,
  // so without this the preview opened over the diff and took the focus, and
  // reviewing a Markdown change was impossible with the setting at its default.
  if (activeDiffTabOn(doc.uri)) {
    return false;
  }
  // A cursor that is not at the top of the file means something put it there:
  // a Find-in-Files hit, `Ctrl+P` with a `:120`, a go-to-definition, a problem
  // in the list. All of them opened the text editor *at a line*, and swapping
  // the tab throws that line away, since the swap closes the editor before its
  // visible range can sync to the preview. Following a search result into a
  // Markdown file has to land on the search result.
  if (editor.selection.active.line > 0 || !editor.selection.isEmpty) {
    return false;
  }
  return true;
}

/**
 * Open the LaTeX preview for `uri` beside its source, or surface the one already
 * showing it.
 *
 * The existing-panel check is not an optimisation, it is what stops this from
 * multiplying. Auto-preview calls this on every active-editor change, and
 * `vscode.openWith` cannot be relied on to reuse a tab here: its target group is
 * `ViewColumn.Beside`, computed against whatever is focused at the time, so as
 * soon as focus is inside the preview's own group Beside means a new group and
 * openWith builds another panel. Each panel is a pdf.js webview with its own
 * compile session, so they accumulate until the extension host dies.
 *
 * `preserveFocus` also decides how insistent to be. The automatic path stays
 * quiet: if a preview for this document exists anywhere, leave it exactly where
 * it is, because yanking a tab into view while someone is typing is worse than
 * doing nothing. Only an explicit request reveals it.
 */
function openTexPreview(uri: vscode.Uri, preserveFocus: boolean): void {
  const key = uri.toString();
  const existing = texPanelFor(uri);
  if (existing) {
    if (!preserveFocus) {
      existing.reveal(existing.viewColumn, true);
    }
    return;
  }
  // `texPanelFor` alone is not enough, because it can only see panels that have
  // finished resolving, and `openWith` is asynchronous. Restoring a folder full
  // of editors churns the active editor several times in a row, so without a
  // synchronous claim staked here every one of those passes sees "no panel yet"
  // and starts another open. They all then resolve, and the window is suddenly
  // carrying a dozen pdf.js webviews for one document, which is enough to take
  // the extension host down with it.
  if (openingTex.has(key)) {
    return;
  }
  openingTex.add(key);
  void Promise.resolve(
    vscode.commands.executeCommand('vscode.openWith', uri, TexEditorProvider.viewType, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus,
    }),
  ).then(
    () => openingTex.delete(key),
    // Released on failure too, so one refused open does not wedge this document
    // out of ever previewing again for the rest of the session.
    () => openingTex.delete(key),
  );
}

export function deactivate(): void {
  // Spread: disposing fires onDidDispose, which deletes from the set.
  for (const state of [...previews]) {
    state.panel.dispose();
  }
}

// Opens a Markdown or CSV document *as* a MarkCopy preview: the same webview the
// side panel uses, in the document's own tab rather than beside it. Everything
// downstream is shared, because what is behind it is still a TextDocument. It
// re-renders as you type in another editor on the same file, and a CSV cell edit
// is still written back through a WorkspaceEdit, undo and all.
class PreviewEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots(this.context, document.uri),
    };
    registerPreview(this.context, { panel, docUri: document.uri, tab: true });
  }
}

// The preview a command should act on: whichever MarkCopy tab has focus, or else
// the side panel. A custom editor's webview reports `active` exactly as a panel
// does, so this follows the reader rather than guessing.
function activePreview(): PreviewState | undefined {
  const focused = focusedPreview();
  if (focused) {
    return focused;
  }
  if (side) {
    return side;
  }
  // Nothing focused and no side panel: fall back to a tab open on whatever the
  // reader is editing, so a command run from the palette still lands somewhere.
  const doc = vscode.window.activeTextEditor?.document;
  return doc ? previewsOf(doc.uri)[0] : undefined;
}

/**
 * The MarkCopy preview the reader is actually looking at, if any.
 *
 * The strict half of `activePreview`, for the commands that act *on* a preview
 * rather than merely near one. A custom editor's webview reports `active`
 * exactly as the side panel does, so this is the same question for both.
 */
function focusedPreview(): PreviewState | undefined {
  for (const state of previews) {
    if (state.panel.active) {
      return state;
    }
  }
  return undefined;
}

/**
 * Close a leftover editor on `uri` in the active group, so Show Source and Show
 * Preview swap a tab rather than stacking two editors on one file.
 *
 * Whether opening one takes over the other's tab turns out to depend on VS Code's
 * preview mode, the italic tab a single click opens: `vscode.open` gives you one,
 * and the next open replaces it, while `vscode.openWith` and anything the reader
 * has pinned are permanent and get opened alongside instead. A button cannot know
 * which it is looking at, so the leftover is closed here rather than hoped away.
 *
 * A pinned tab is left alone, since pinning is the reader saying "keep this one",
 * and so is a dirty text editor, whose unsaved changes are not a layout button's
 * to discard. A preview tab needs no such guard: it is a view of a document that
 * stays open as the text editor this was called for, so closing it loses nothing.
 */
async function closeStaleEditor(uri: vscode.Uri, kind: 'text' | 'custom'): Promise<void> {
  const stale = vscode.window.tabGroups.activeTabGroup.tabs.filter(
    (tab) => tabIsOn(tab, uri, kind) && !tab.isPinned && !(kind === 'text' && tab.isDirty),
  );
  if (stale.length > 0) {
    await vscode.window.tabGroups.close(stale, true);
  }
}

/**
 * Swap `doc`'s tab to the rendered preview, in the group it is already in.
 *
 * Shared by the **Show Preview** button and by auto-preview, so the deliberate
 * route and the automatic one cannot drift into putting the document in two
 * different places. `ViewColumn.Active` is what keeps either from splitting the
 * editor; `markcopy.openPreview` is still there for anyone who wants the
 * source-left/preview-right layout on purpose.
 */
async function showRendered(doc: vscode.TextDocument, kind: PreviewKind): Promise<void> {
  const key = doc.uri.toString();
  // Auto-preview calls this on every active-editor change and nothing is awaited
  // between them, so restoring a folder full of editors can reach the same
  // document several times over before the first `openWith` resolves. Each of
  // those opens is a retained-context webview, and `ViewColumn.Active` is
  // evaluated per call, so a focus change mid-flight lands the second one in a
  // different group: two live previews of one file, both re-rendering on every
  // keystroke. Claimed synchronously here, as `openTexPreview` does.
  if (openingRendered.has(key)) {
    return;
  }
  openingRendered.add(key);
  try {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      doc.uri,
      kind === 'csv' ? CSV_VIEW_TYPE : MARKDOWN_VIEW_TYPE,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    );
    // Only once the preview is really there. `previewKind` answers for a language
    // id as well as an extension, and VS Code's own Markdown grammar claims files
    // the custom-editor selector in package.json does not (.mdwn, .workbook, and
    // whatever a `files.associations` entry points at markdown), so `openWith`
    // can decline to resolve the viewType and hand back the plain text editor.
    // Closing regardless took the file's only tab away as it was opened.
    if (activeTabOn(doc.uri, 'custom')) {
      await closeStaleEditor(doc.uri, 'text');
    }
  } finally {
    // Released on failure too, so one refused open does not wedge this document
    // out of ever previewing again for the rest of the session.
    openingRendered.delete(key);
  }
}

/** Whether `tab` is a `kind` editor open on `uri`. */
function tabIsOn(tab: vscode.Tab, uri: vscode.Uri, kind: 'text' | 'custom'): boolean {
  const key = uri.toString();
  const input = tab.input;
  if (kind === 'text') {
    return input instanceof vscode.TabInputText && input.uri.toString() === key;
  }
  return input instanceof vscode.TabInputCustom && input.uri.toString() === key;
}

/** The tab in the active group holding a `kind` editor on `uri`, if there is one. */
function activeTabOn(uri: vscode.Uri, kind: 'text' | 'custom'): vscode.Tab | undefined {
  return vscode.window.tabGroups.activeTabGroup.tabs.find((tab) => tabIsOn(tab, uri, kind));
}

/** Whether the focused tab is a diff with `uri` on either side of it. */
function activeDiffTabOn(uri: vscode.Uri): boolean {
  const key = uri.toString();
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  return (
    input instanceof vscode.TabInputTextDiff &&
    (input.modified.toString() === key || input.original.toString() === key)
  );
}

// The live previews showing a document: the side panel when it is pointed at it,
// plus any editor tabs opened on it.
function previewsOf(uri: vscode.Uri): PreviewState[] {
  const key = uri.toString();
  return [...previews].filter((state) => state.docUri.toString() === key);
}

function pickDocument(uri?: vscode.Uri): vscode.TextDocument | undefined {
  if (uri && uri.scheme === 'file') {
    return openDocumentOn(uri);
  }
  // Whatever is in front of the reader. `update` decides how to render it, so
  // there is nothing to gate on here: a document MarkCopy does not recognize is
  // previewed as Markdown rather than refused.
  const active = vscode.window.activeTextEditor;
  if (active) {
    return active.document;
  }
  // `activeTextEditor` is undefined while a custom editor holds the focus, so
  // stopping there left every command that starts here inert in exactly the
  // state auto-preview puts the reader in: "Open Rich Preview to the Side" on a
  // Markdown file already showing as a MarkCopy tab answered "open a Markdown,
  // CSV, or LaTeX file first" about the file on the screen. A custom *text*
  // editor is a view of a TextDocument, so the document is open and the preview
  // knows which one it is.
  const focused = focusedPreview();
  return focused && openDocumentOn(focused.docUri);
}

/** The already-open TextDocument for `uri`, if VS Code is holding one. */
function openDocumentOn(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === key);
}

function openPreview(context: vscode.ExtensionContext, doc: vscode.TextDocument): void {
  if (side) {
    if (side.docUri.toString() !== doc.uri.toString()) {
      // When the preview panel's own column was the active group, VS Code opens
      // the newly-focused Markdown file as a tab *in that column*. Move it back to
      // the first column so the preview beside it stays a clean two-column layout
      // instead of getting pushed out to a third.
      const editor = vscode.window.activeTextEditor;
      if (
        editor &&
        editor.document.uri.toString() === doc.uri.toString() &&
        editor.viewColumn === side.panel.viewColumn
      ) {
        void vscode.window.showTextDocument(editor.document, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: false,
        });
      }
      side.docUri = doc.uri;
      // Line tracking belongs to the document that just went away; the new one
      // gets its own baseline from the render below.
      side.lineCount = undefined;
      side.lineCountVersion = undefined;
      // Grant the webview read access to the newly-targeted document's folder so
      // its relative images resolve (localResourceRoots is fixed at creation).
      side.panel.webview.options = {
        enableScripts: true,
        localResourceRoots: resourceRoots(context, doc.uri),
      };
    }
    // Reveal in the panel's existing column (never "Beside") so retargeting to a
    // new document never migrates the preview into an additional column.
    side.panel.reveal(side.panel.viewColumn ?? vscode.ViewColumn.Beside, true);
    update(side);
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

  side = registerPreview(context, { panel, docUri: doc.uri });
}

// Everything a preview needs whichever surface it lives on: the page, the message
// wiring, teardown, and a first render. Both the side panel and an editor tab go
// through here, which is what keeps the two from drifting apart.
function registerPreview(context: vscode.ExtensionContext, state: PreviewState): PreviewState {
  const panel = state.panel;
  previews.add(state);

  panel.webview.html = htmlShell(context, panel.webview);

  const disposables: vscode.Disposable[] = [
    panel.webview.onDidReceiveMessage((msg) => {
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
      } else if (msg?.type === 'docxXhtml' && typeof msg.bodyXhtml === 'string') {
        void exportDocx(state.docUri, msg.bodyXhtml);
      } else if (msg?.type === 'pptxXhtml' && typeof msg.bodyXhtml === 'string') {
        void exportPptx(state.docUri, msg.bodyXhtml);
      } else if (msg?.type === 'editCell') {
        void applyCellEdit(state, msg);
      } else if (msg?.type === 'gridOp') {
        void applyGridOp(state, msg);
      }
    }),
  ];

  panel.onDidDispose(() => {
    disposables.forEach((d) => d.dispose());
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
    }
    previews.delete(state);
    if (side === state) {
      // Remember the dismissal so auto-preview does not immediately reopen it.
      // A preview that is an editor tab needs no such record even though
      // auto-preview opens those too now: closing one closes the document with
      // it, so there is no focused editor left for auto-preview to answer. Show
      // Source is how you keep the file open without the preview, and it records
      // the dismissal itself.
      dismissedPreviews.add(state.docUri.toString());
      side = undefined;
    }
  });

  update(state);
  return state;
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

function scheduleUpdate(state: PreviewState): void {
  if (state.timer !== undefined) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    state.timer = undefined;
    if (previews.has(state)) {
      update(state);
    }
  }, UPDATE_DEBOUNCE_MS);
}

function update(state: PreviewState): void {
  // A direct update supersedes anything the debounce still has pending, so the
  // two can never race and render the same document twice.
  if (state.timer !== undefined) {
    clearTimeout(state.timer);
    state.timer = undefined;
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
  if (!state.tab) {
    state.panel.title = `Preview ${basename(state.docUri)}`;
  }
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

// How many ranges a single WorkspaceEdit is worth carrying. A grid operation
// above this is sent as one whole-document replacement instead (see
// applyGridOp). Comfortably above any file a reader scrolls through by hand,
// and far below the point where the per-range bookkeeping starts to cost real
// time.
const MAX_GRANULAR_EDITS = 2000;

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
  if (edits.length > MAX_GRANULAR_EDITS) {
    // A column operation is not bounded by markcopy.csv.maxRows: it reaches
    // every record in the file, so a big CSV can produce hundreds of thousands
    // of ranges, and handing all of them to applyEdit one at a time freezes the
    // window for as long as it takes. Past this many, the same edits are folded
    // here and go over as a single whole-document replacement. Identical text,
    // still one undo stop; what it gives up is a fine-grained diff for the
    // editor, on files where nobody could read one anyway.
    workspaceEdit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)),
      applyCsvEdits(text, edits),
    );
  } else {
    for (const edit of edits) {
      // Every offset was measured against this same unedited text and no two of
      // the ranges overlap, so they can all be handed over together.
      workspaceEdit.replace(
        doc.uri,
        new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)),
        edit.text,
      );
    }
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
  if (state.tab) {
    // A custom editor cannot retarget to another document, so following a link
    // opens the target as its own MarkCopy tab in the same group. Reading stays
    // where the reader is instead of jumping to the side panel.
    await vscode.commands.executeCommand('vscode.openWith', targetUri, MARKDOWN_VIEW_TYPE, {
      viewColumn: state.panel.viewColumn,
    });
    // By now the new tab has registered its preview, so the heading it was
    // linked to can be handed straight to it.
    const opened = previewsOf(targetUri).find((p) => p.tab);
    if (opened && target.fragment) {
      opened.pendingReveal = target.fragment;
      update(opened);
    }
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
  const name = exportBaseName(docUri);

  const browser = await findBrowser(cfg.get<string>('pdf.browserPath', ''));
  if (!browser) {
    await printViaBrowser(context, bodyHtml, name, pageSize, 'no-browser');
    return;
  }

  const target = await vscode.window.showSaveDialog({
    defaultUri: defaultExportUri(docUri, name, 'pdf'),
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

let exportingDocx = false;

// Export the preview as a Word document.
//
// The counterpart to exportPdf above, and much shorter than it, because there is
// no browser to find and no subprocess to babysit: the webview hands over the
// serialized document and src/docxExport.ts turns it into the bytes of a .docx
// in memory. What the PDF export spends its length on is getting a faithful
// *picture* of the page; what this one is for is keeping the structure, so the
// file can be read aloud, navigated by heading, and edited when it lands.
export async function exportDocx(docUri: vscode.Uri, bodyXhtml: string): Promise<void> {
  if (exportingDocx) {
    void vscode.window.showInformationMessage('MarkCopy: a Word export is already in progress.');
    return;
  }
  exportingDocx = true;
  try {
    await runDocxExport(docUri, bodyXhtml);
  } finally {
    exportingDocx = false;
  }
}

async function runDocxExport(docUri: vscode.Uri, bodyXhtml: string): Promise<void> {
  const name = exportBaseName(docUri);
  const target = await vscode.window.showSaveDialog({
    defaultUri: defaultExportUri(docUri, name, 'docx'),
    filters: { 'Word document': ['docx'] },
    saveLabel: 'Export Word document',
    title: 'Export preview as a Word document',
  });
  if (!target) {
    return; // cancelled
  }

  let report: DocxReport;
  try {
    // Converted before the file is touched, so a document this cannot handle
    // fails without having already replaced whatever was at that path.
    const result = htmlToDocx(bodyXhtml, { title: name || 'Document' });
    report = result.report;
    await vscode.workspace.fs.writeFile(target, Buffer.from(result.bytes));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`MarkCopy: could not export the Word document: ${message}`);
    return;
  }

  void vscode.env.openExternal(target);

  // Missing alt text is worth interrupting for: it is the one defect that
  // quietly undoes the reason to export a Word document instead of a PDF, and
  // it is fixable in the Markdown source in a few seconds.
  const note = reportSummary(report);
  if (note) {
    void vscode.window.showWarningMessage(`MarkCopy: exported ${basename(target)}, but ${note}.`);
  } else {
    vscode.window.setStatusBarMessage(`MarkCopy: exported ${basename(target)}.`, 6000);
  }
}

let exportingPptx = false;

// Export the preview as a PowerPoint deck.
//
// Structure again rather than a picture, like the Word export, but cut a
// different way: a document is one flow and a deck is a sequence, so the only
// real work beyond exportDocx is deciding where one slide ends and the next
// begins. src/pptx/write/ does that; see docs/PPTX-DESIGN.md for the rules.
export async function exportPptx(docUri: vscode.Uri, bodyXhtml: string): Promise<void> {
  if (exportingPptx) {
    void vscode.window.showInformationMessage(
      'MarkCopy: a PowerPoint export is already in progress.',
    );
    return;
  }
  exportingPptx = true;
  try {
    await runPptxExport(docUri, bodyXhtml);
  } finally {
    exportingPptx = false;
  }
}

async function runPptxExport(docUri: vscode.Uri, bodyXhtml: string): Promise<void> {
  const name = exportBaseName(docUri);
  const target = await vscode.window.showSaveDialog({
    defaultUri: defaultExportUri(docUri, name, 'pptx'),
    filters: { 'PowerPoint presentation': ['pptx'] },
    saveLabel: 'Export PowerPoint deck',
    title: 'Export preview as a PowerPoint deck',
  });
  if (!target) {
    return; // cancelled
  }

  const cfg = vscode.workspace.getConfiguration('markcopy', docUri);
  let report: PptxReport;
  try {
    // Converted before the file is touched, so a document this cannot handle
    // fails without having already replaced whatever was at that path.
    const result = htmlToPptx(bodyXhtml, {
      title: name || 'Presentation',
      slideSize: cfg.get<'16:9' | '4:3'>('pptx.slideSize', '16:9'),
    });
    report = result.report;
    await vscode.workspace.fs.writeFile(target, Buffer.from(result.bytes));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`MarkCopy: could not export the deck: ${message}`);
    return;
  }

  void vscode.env.openExternal(target);

  const note = pptxReportSummary(report);
  if (note) {
    void vscode.window.showWarningMessage(`MarkCopy: exported ${basename(target)}, but ${note}.`);
  } else {
    vscode.window.setStatusBarMessage(`MarkCopy: exported ${basename(target)}.`, 6000);
  }
}

// Where the save dialog starts: beside the source document, or failing that in the
// first workspace folder.
function defaultExportUri(docUri: vscode.Uri, name: string, ext: string): vscode.Uri {
  const stem = name.replace(/[^\w.\- ]+/g, '-').replace(/^-+|-+$/g, '') || 'markcopy';
  const safe = `${stem}.${ext}`;
  if (docUri.scheme === 'file') {
    return vscode.Uri.joinPath(docUri, '..', safe);
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, safe) : vscode.Uri.file(safe);
}

// The document's name with the source extension taken off, used both as the
// suggested filename and as the title written into the .docx properties.
function exportBaseName(docUri: vscode.Uri): string {
  return basename(docUri).replace(/\.(md|markdown|mdown|mkd|mdx|csv|tsv|tab|xlsx|xlsm)$/i, '');
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
