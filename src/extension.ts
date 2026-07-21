import * as vscode from 'vscode';
import { createMarkdownIt, escapeHtml } from './render';
import { PdfEditorProvider } from './pdfEditor';
import { classifyLink, localImageRef, shouldAutoPreview } from './preview-utils';

const VIEW_TYPE = 'markcopy.preview';

interface PreviewState {
  panel: vscode.WebviewPanel;
  docUri: vscode.Uri;
  // A heading id to scroll to on the next render, set when a link navigates to a
  // new document with a `#fragment`. Consumed (and cleared) by the next update().
  pendingReveal?: string;
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

    vscode.commands.registerCommand('markcopy.openPreview', (uri?: vscode.Uri) => {
      const doc = pickDocument(uri);
      if (doc) {
        // An explicit open clears any earlier dismissal for this document.
        dismissedPreviews.delete(doc.uri.toString());
        openPreview(context, doc);
      } else {
        vscode.window.showInformationMessage('MarkCopy: open a Markdown file first.');
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

    // Export the preview to a self-contained HTML file and open it in the default
    // browser, where the user prints it to PDF. The webview serializes its already
    // rendered content (KaTeX, Mermaid, highlighted code) and posts it back as a
    // `pdfHtml` message, handled in onDidReceiveMessage below.
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
        update(current);
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
      const cfg = vscode.workspace.getConfiguration('markcopy');
      if (!cfg.get<boolean>('syncScroll', true)) {
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
  if (active && active.document.languageId === 'markdown') {
    return active.document;
  }
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
        applySetting(msg.key, msg.value);
      } else if (msg?.type === 'openSettings') {
        vscode.commands.executeCommand('markcopy.openSettings');
      } else if (msg?.type === 'openLink' && typeof msg.href === 'string') {
        void openLink(context, state, msg.href);
      } else if (msg?.type === 'pdfHtml' && typeof msg.bodyHtml === 'string') {
        void exportPdf(context, state, msg.bodyHtml);
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

// Persist a setting changed from the in-preview menu. User (Global) scope is the
// safe default; onDidChangeConfiguration then re-renders and refreshes the menu.
function applySetting(key: string, value: unknown): void {
  vscode.workspace
    .getConfiguration('markcopy')
    .update(key, value, vscode.ConfigurationTarget.Global);
}

function update(state: PreviewState): void {
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
  const html = md.render(source, {
    resolveImage: (src: string) => resolveImageSrc(src, state.docUri, webview),
  });
  state.panel.title = `Preview ${basename(state.docUri)}`;
  // A one-shot heading reveal, set when a link navigated here. The webview also
  // scrolls a newly-targeted document to the top on its own (docKey change).
  const revealFragment = state.pendingReveal || undefined;
  state.pendingReveal = undefined;
  webview.postMessage({
    type: 'render',
    html,
    source,
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

function revealEditorLine(docUri: vscode.Uri, line: number): void {
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === docUri.toString(),
  );
  if (!editor) {
    return;
  }
  const range = new vscode.Range(line, 0, line, 0);
  editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
}

function htmlShell(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.js'),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'preview.css'),
  );
  const katexStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'katex', 'katex.min.css'),
  );
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    // Same-origin only: lets html-to-image fetch and embed KaTeX fonts when
    // copying an equation as an image (see SECURITY.md).
    `connect-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<link href="${katexStyleUri}" rel="stylesheet" />
<title>MarkCopy Preview</title>
</head>
<body data-vscode-context='{"webviewId":"markcopy.preview","preventDefaultContextMenuItems":true}'>
  <div id="content" class="markdown-body"></div>
  <div id="mc-menu" class="mc-menu" role="menu" hidden></div>
  <div id="mc-toast" class="mc-toast" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// Assemble a self-contained HTML document from the webview's serialized content,
// write it to the extension's storage folder, and open it in the OS default
// browser. The page auto-invokes the print dialog, where the user picks
// "Save as PDF". Reused by both the command and the in-preview menu item.
async function exportPdf(
  context: vscode.ExtensionContext,
  state: PreviewState,
  bodyHtml: string,
): Promise<void> {
  try {
    const name = basename(state.docUri).replace(/\.(md|markdown|mdown|mkd)$/i, '');
    const html = await buildPdfHtml(context, bodyHtml, name);
    const dir = context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(dir);
    const safe = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'markcopy';
    const fileUri = vscode.Uri.joinPath(dir, `${safe}.html`);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(html, 'utf8'));
    // globalStorageUri uses the `vscode-userdata:` scheme, which the OS shell
    // can't open; re-wrap the on-disk path as a `file:` URI for the browser.
    await vscode.env.openExternal(vscode.Uri.file(fileUri.fsPath));
    vscode.window.setStatusBarMessage(
      'MarkCopy: opened in your browser — press Ctrl/Cmd+P and choose "Save as PDF".',
      6000,
    );
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
): Promise<string> {
  const previewCss = await readMedia(context, 'preview.css');
  // KaTeX CSS is only needed when the document contains math; skip its (font-heavy)
  // inlining otherwise to keep the export small.
  const katexCss = /class="(katex|mc-math)/.test(bodyHtml) ? await inlineKatexFonts(context) : '';
  const printCss = `
html, body { background: #ffffff; }
body { padding: 24px 28px; box-sizing: border-box; }
.markdown-body { max-width: 820px; margin: 0 auto; }
@page { margin: 16mm; }
@media print {
  body { padding: 0; }
  .markdown-body { max-width: none; }
  pre, blockquote, table, .mc-mermaid, .mc-math { break-inside: avoid; page-break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title || 'MarkCopy')}</title>
<style>${previewCss}</style>
${katexCss ? `<style>${katexCss}</style>` : ''}
<style>${printCss}</style>
</head>
<body class="mc-force-light" data-style="github" data-mc-theme="light">
<div id="content" class="markdown-body">${bodyHtml}</div>
<script>
window.addEventListener('load', function () {
  var print = function () { setTimeout(function () { window.print(); }, 200); };
  if (document.fonts && document.fonts.ready) { document.fonts.ready.then(print, print); }
  else { print(); }
});
</script>
</body>
</html>`;
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

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
