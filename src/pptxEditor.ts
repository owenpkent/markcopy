import * as vscode from 'vscode';
import { escapeAttr } from './escape';
import { renderDeckHtml, DeckError } from './pptx/read';
import { OoxmlEditorProvider, describeReadError, type OoxmlSession } from './ooxmlEditor';
export type { ExportPdf, ExportXhtml } from './ooxmlEditor';

// The settings a deck is drawn from. Anything outside this list cannot change
// what the slides look like, so it must not cost a re-read and a re-parse.
const REDRAW_SETTINGS = [
  'markcopy.theme',
  'markcopy.pptx.maxSlides',
  'markcopy.pptx.showNotes',
  'markcopy.styleProfile',
];

// A read-only custom editor for .pptx / .pptm presentations, built on the
// same OoxmlEditorProvider scaffold as XlsxEditorProvider (options, watcher,
// config listener, draw loop and message router all live there; see its own
// comment for why).
//
// Unlike a workbook, the whole deck is on screen at once rather than one slide
// at a time, so there is no tab strip and no selectSheet round trip. See
// docs/PPTX-DESIGN.md for why: a deck is read end to end, and the point of
// this extension is taking the whole thing out in one go. Each slide still
// carries data-source-line, for the per-block copy menu, but nothing
// addresses it by line since there is no TextDocument to reveal into either.
export class PptxEditorProvider extends OoxmlEditorProvider {
  public static readonly viewType = 'markcopy.pptxPreview';
  protected readonly viewType = PptxEditorProvider.viewType;
  protected readonly kind = 'pptx';
  protected readonly redrawSettings = REDRAW_SETTINGS;

  protected createSession(document: vscode.CustomDocument): OoxmlSession {
    return { render: () => this.renderDeck(document.uri) };
  }

  private async renderDeck(uri: vscode.Uri): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('markcopy', uri);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return renderDeckHtml(bytes, {
      maxSlides: cfg.get<number>('pptx.maxSlides', 100),
      showNotes: cfg.get<boolean>('pptx.showNotes', true),
    }).html;
  }

  protected errorHtml(err: unknown): string {
    const message = describeReadError(err, (e) => e instanceof DeckError);
    return `<div class="mc-pptx-deck"><p class="mc-pptx-note">MarkCopy could not preview this presentation: ${escapeAttr(message)}</p></div>`;
  }
}
