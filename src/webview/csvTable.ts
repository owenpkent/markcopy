// Resizable columns for the CSV preview's grid.
//
// The table renders with the browser's automatic column sizing (see the
// `.mc-csv` rules in media/preview.css, which cap and ellipsize wide cells) so
// the first paint costs nothing extra. The moment the reader drags a grip we
// freeze the widths the browser worked out onto the <col> elements and switch to
// `table-layout: fixed`, which is the only layout mode where an explicit column
// width actually sticks. From then on the table carries its own width and the
// wrapper scrolls horizontally.

/** Never let a column collapse to the point where the grip is unreachable. */
const MIN_COL_PX = 44;
/** Ceiling for a double-click auto-fit, so one essay-length cell can't take over. */
const MAX_FIT_PX = 720;
/** Arrow-key resize step; Shift makes it coarse. */
const NUDGE_PX = 16;
const NUDGE_COARSE_PX = 64;

export function enhanceCsvTables(root: ParentNode): void {
  root.querySelectorAll<HTMLTableElement>('table.mc-csv').forEach(setupColumnResize);
}

// Undo every width this module applied and hand sizing back to the browser.
// Exposed for the preview's "Reset column widths" menu item.
export function resetColumnWidths(table: HTMLTableElement): void {
  for (const col of columnsOf(table)) {
    col.style.width = '';
  }
  table.style.tableLayout = '';
  table.style.width = '';
  delete table.dataset.mcFrozen;
}

function columnsOf(table: HTMLTableElement): HTMLTableColElement[] {
  return Array.from(table.querySelectorAll<HTMLTableColElement>('colgroup > col'));
}

// The row the grips live in: the header when there is one, otherwise the first
// body row, so a headerless CSV is still resizable.
function gripRow(table: HTMLTableElement): HTMLTableRowElement | undefined {
  return table.tHead?.rows[0] ?? table.tBodies[0]?.rows[0];
}

function setupColumnResize(table: HTMLTableElement): void {
  const cols = columnsOf(table);
  const row = gripRow(table);
  if (!row || cols.length !== row.cells.length) {
    // The renderer emits one <col> per cell including the row-number gutter. If
    // they ever disagree, the width math below would shear, so do nothing.
    return;
  }

  // Skip the gutter (index 0): its width is fixed by the CSS.
  for (let i = 1; i < row.cells.length; i++) {
    row.cells[i].appendChild(makeGrip(table, cols, row, i));
  }
}

function makeGrip(
  table: HTMLTableElement,
  cols: HTMLTableColElement[],
  row: HTMLTableRowElement,
  index: number,
): HTMLElement {
  const grip = document.createElement('span');
  grip.className = 'mc-csv-grip';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-label', `Resize column ${index}`);
  grip.tabIndex = 0;

  grip.addEventListener('pointerdown', (e) => {
    // Left button only, and never let the drag turn into a text selection or
    // bubble out to the preview's context-menu / click-to-dismiss handlers.
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    freeze(table, cols, row);
    const startX = e.clientX;
    const startWidth = parseFloat(cols[index].style.width) || 0;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('mc-csv-grip--active');
    document.body.classList.add('mc-csv-resizing');

    const onMove = (ev: PointerEvent): void => {
      setColumnWidth(table, cols, index, startWidth + (ev.clientX - startX));
    };
    const onUp = (): void => {
      grip.releasePointerCapture(e.pointerId);
      grip.classList.remove('mc-csv-grip--active');
      document.body.classList.remove('mc-csv-resizing');
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
    };

    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });

  // Double-click snaps the column to its content, the way a spreadsheet does.
  grip.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    autoFit(table, cols, row, index);
  });

  // Keep the grips off the click-to-dismiss path, and out of the way of a
  // right-click meant for the cell underneath.
  grip.addEventListener('click', (e) => e.stopPropagation());

  // The grip sits inside a cell, so csvEdit.ts's table-level key handling would
  // otherwise see these too: Enter would auto-fit the column *and* open the cell
  // editor, and the arrows would resize *and* move the selection. Stop the keys
  // this grip acts on, and only those, so Escape still reaches the context menu.
  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? NUDGE_COARSE_PX : NUDGE_PX;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      freeze(table, cols, row);
      const current = parseFloat(cols[index].style.width) || 0;
      setColumnWidth(table, cols, index, current + (e.key === 'ArrowRight' ? step : -step));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      autoFit(table, cols, row, index);
    }
  });

  return grip;
}

// Pin the browser's current column widths onto the <col> elements and switch to
// fixed layout, so later width changes hold. Runs once per table.
function freeze(
  table: HTMLTableElement,
  cols: HTMLTableColElement[],
  row: HTMLTableRowElement,
): void {
  if (table.dataset.mcFrozen === '1') {
    return;
  }
  const widths = Array.from(row.cells, (cell) => cell.getBoundingClientRect().width);
  cols.forEach((col, i) => {
    col.style.width = `${Math.max(MIN_COL_PX, Math.round(widths[i]))}px`;
  });
  table.style.tableLayout = 'fixed';
  table.dataset.mcFrozen = '1';
  retotal(table, cols);
}

function setColumnWidth(
  table: HTMLTableElement,
  cols: HTMLTableColElement[],
  index: number,
  width: number,
): void {
  cols[index].style.width = `${Math.max(MIN_COL_PX, Math.round(width))}px`;
  retotal(table, cols);
}

// A fixed-layout table stretches to its container unless it is told otherwise,
// which would quietly redistribute the widths we just set. Give it the exact sum
// of its columns so they are honored and the wrapper scrolls instead.
function retotal(table: HTMLTableElement, cols: HTMLTableColElement[]): void {
  const total = cols.reduce((sum, col) => sum + (parseFloat(col.style.width) || 0), 0);
  table.style.width = `${total}px`;
}

// Size one column to its widest cell. Automatic layout is the only thing that
// knows the natural width, so briefly restore it, measure, then put the frozen
// widths back with just this column changed.
function autoFit(
  table: HTMLTableElement,
  cols: HTMLTableColElement[],
  row: HTMLTableRowElement,
  index: number,
): void {
  freeze(table, cols, row);
  const frozen = cols.map((col) => col.style.width);

  cols.forEach((col) => (col.style.width = ''));
  table.style.tableLayout = '';
  table.style.width = '';
  table.classList.add('mc-csv-measuring');
  // Reading the box forces the reflow that gives us the natural width.
  const natural = row.cells[index].getBoundingClientRect().width;
  table.classList.remove('mc-csv-measuring');

  cols.forEach((col, i) => (col.style.width = frozen[i]));
  table.style.tableLayout = 'fixed';
  setColumnWidth(table, cols, index, Math.min(MAX_FIT_PX, Math.ceil(natural)));
}
