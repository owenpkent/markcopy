import * as vscode from 'vscode';
import { escapeAttr } from './escape';
import { renderWorkbookHtml, WorkbookError } from './xlsx';
import { OoxmlEditorProvider, describeReadError, type OoxmlSession } from './ooxmlEditor';
export type { ExportPdf, ExportXhtml } from './ooxmlEditor';

// The settings a sheet is drawn from. Anything outside this list cannot change
// what the grid looks like, so it must not cost a re-read and a re-parse.
const REDRAW_SETTINGS = [
  'markcopy.theme',
  'markcopy.xlsx.maxRows',
  'markcopy.xlsx.maxColumns',
  'markcopy.styleProfile',
];

// A read-only custom editor for .xlsx / .xlsm workbooks, built on the shared
// OoxmlEditorProvider scaffold (options, watcher, config listener, draw loop
// and message router all live there; see its own comment for why).
//
// A workbook is binary, so it never becomes a TextDocument and none of the
// preview's live-update, scroll-sync, or cell-writeback machinery applies.
// The grid it draws deliberately carries no data-source-line on any row
// either, which is what keeps a sheet out of scroll sync on top of that.
export class XlsxEditorProvider extends OoxmlEditorProvider {
  public static readonly viewType = 'markcopy.xlsxPreview';
  protected readonly viewType = XlsxEditorProvider.viewType;
  protected readonly kind = 'xlsx';
  protected readonly redrawSettings = REDRAW_SETTINGS;

  protected createSession(document: vscode.CustomDocument): OoxmlSession {
    // Which sheet is on screen. The grid is rendered one sheet at a time: the
    // webview's scroller and its column-resize wiring both take the first
    // .mc-csv-wrap they find, and a tab strip matches what every spreadsheet
    // viewer does anyway.
    //
    // Scoped to this call rather than an instance field: one provider
    // instance serves every open workbook, and an instance field would leak
    // one document's sheet selection into another's.
    let sheetIndex = 0;
    return {
      render: () => this.renderWorkbook(document.uri, sheetIndex),
      handleMessage: async (msg, redraw) => {
        if (msg?.type === 'selectSheet') {
          const next = Number(msg.index);
          if (Number.isInteger(next) && next >= 0 && next !== sheetIndex) {
            sheetIndex = next;
            await redraw();
          }
        }
      },
    };
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

  protected errorHtml(err: unknown): string {
    const message = describeReadError(err, (e) => e instanceof WorkbookError);
    return `<div class="mc-csv-wrap"><p class="mc-csv-note">MarkCopy could not preview this workbook: ${escapeAttr(message)}</p></div>`;
  }
}
