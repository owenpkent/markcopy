// Reading an .xlsx / .xlsm workbook into the preview's HTML.
//
// Free of the `vscode` module, like src/csv.ts and src/pdfExport.ts, so the whole
// fidelity surface unit-tests directly. That matters more here than elsewhere:
// serial-to-date arithmetic, format-code resolution, merge geometry, and the
// t="s" / t="str" distinction are where this feature's bugs will live, and none
// of them need a webview or a running editor to exercise.
import { openZip, partText, resolveTarget, WorkbookError, type ZipLimits } from './zip';
import { readWorkbook, findPart, type SheetRef } from './workbook';
import { readStyles } from './styles';
import { readSheet, type SheetLimits } from './sheet';
import { renderSheetHtml } from './render';

export { WorkbookError } from './zip';
export type { SheetRef } from './workbook';

export interface ReadOptions extends Partial<SheetLimits> {
  /** Which sheet to render, as an index into the full (unfiltered) sheet list. */
  sheetIndex?: number;
  zipLimits?: ZipLimits;
}

export interface WorkbookHtml {
  html: string;
  sheets: SheetRef[];
  /** The sheet actually rendered, which may differ from the one requested. */
  activeIndex: number;
}

export function renderWorkbookHtml(bytes: Uint8Array, opts: ReadOptions = {}): WorkbookHtml {
  const limits: SheetLimits = {
    maxRows: Math.max(1, opts.maxRows ?? 5000),
    maxColumns: Math.max(1, opts.maxColumns ?? 200),
  };

  const parts = openZip(bytes, opts.zipLimits);
  const workbook = readWorkbook(parts);

  // Land on a visible sheet. The requested index can point at a hidden one (or
  // past the end) after the workbook changed on disk underneath an open preview.
  const activeIndex = pickSheet(workbook.sheets, opts.sheetIndex ?? 0);
  const ref = workbook.sheets[activeIndex];

  const sheetXml = partText(parts, ref.path);
  if (sheetXml === undefined) {
    throw new WorkbookError(`the sheet "${ref.name}" is missing from this workbook.`);
  }

  // Styles are resolved through the workbook's own relationships and against its
  // own folder, both of which readWorkbook already worked out. The workbook part
  // is not always xl/workbook.xml, so neither is xl/styles.xml.
  const stylesPath = findPart(
    parts,
    workbook.rels,
    /\/styles$/,
    resolveTarget(workbook.path, 'styles.xml'),
  );

  const sheet = readSheet(sheetXml, {
    styles: readStyles(stylesPath === undefined ? undefined : partText(parts, stylesPath)),
    sharedStrings: workbook.sharedStrings,
    date1904: workbook.date1904,
    limits,
  });

  return {
    html: renderSheetHtml({
      sheets: workbook.sheets,
      activeIndex,
      sheet,
      maxRows: limits.maxRows,
    }),
    sheets: workbook.sheets,
    activeIndex,
  };
}

/** The requested sheet if it is visible, else the first visible one. */
function pickSheet(sheets: SheetRef[], requested: number): number {
  if (sheets[requested] !== undefined && !sheets[requested].hidden) {
    return requested;
  }
  const firstVisible = sheets.findIndex((s) => !s.hidden);
  if (firstVisible >= 0) {
    return firstVisible;
  }
  // Every sheet is hidden, which is legal. Show the first rather than nothing.
  return 0;
}
