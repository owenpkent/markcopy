import * as vscode from 'vscode';
import { escapeAttr } from './escape';
import { renderDocxHtml, DocxError } from './docx/read';
import { OoxmlEditorProvider, describeReadError, type OoxmlSession } from './ooxmlEditor';

// The settings a document is drawn from. Anything outside this list cannot
// change what the page looks like, so it must not cost a re-read and a
// re-parse.
const REDRAW_SETTINGS = ['markcopy.theme', 'markcopy.styleProfile'];

// A read-only custom editor for .docx / .docm Word documents, built on the same
// OoxmlEditorProvider scaffold as the workbook and deck editors. The whole
// document is one scrolling column of ordinary semantic HTML inside the shared
// shell, so the context menu, every Copy as flavor, the themes, and all three
// exports (PDF, Word, PowerPoint) work on it without a line of webview code.
// There is no TextDocument behind it, so no scroll sync and no block editing.
export class DocxEditorProvider extends OoxmlEditorProvider {
  public static readonly viewType = 'markcopy.docxPreview';
  protected readonly viewType = DocxEditorProvider.viewType;
  protected readonly kind = 'docx';
  protected readonly redrawSettings = REDRAW_SETTINGS;

  protected createSession(document: vscode.CustomDocument): OoxmlSession {
    return { render: () => this.renderDocument(document.uri) };
  }

  private async renderDocument(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return renderDocxHtml(bytes).html;
  }

  protected errorHtml(err: unknown): string {
    const message = describeReadError(err, (e) => e instanceof DocxError);
    return `<div class="mc-docx"><p class="mc-docx-note">MarkCopy could not preview this document: ${escapeAttr(message)}</p></div>`;
  }
}
