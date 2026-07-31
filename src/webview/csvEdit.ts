// Spreadsheet-style cell editing for the CSV grid.
//
// The grid stays a plain rendered table: nothing is editable until the reader
// asks for it, and a commit does not mutate the DOM. Instead the new value is
// posted to the extension host, which rewrites that one field in the underlying
// document; the resulting document change re-renders the preview. So the file on
// disk is the single source of truth, and every edit lands in the editor's
// normal undo stack.
//
// Because each render replaces the grid wholesale, the focused cell is
// remembered by (record line, column) rather than by element, and restored after
// the re-render that a commit triggers.

/** Which cell the reader is on. Survives the re-render caused by a commit. */
interface CellRef {
  line: number;
  column: number;
}

export type CommitCell = (line: number, column: number, value: string) => void;

let focused: CellRef | undefined;
// True while a commit is in flight, so the re-render it causes restores focus
// to the cell the reader moved to rather than fighting them for it.
let restoring = false;

export function enableCsvEditing(root: ParentNode, commit: CommitCell): void {
  // Only grids the renderer marked editable. A spreadsheet sheet uses this same
  // markup but is read-only, because a cell edit has nowhere to go: the document
  // behind it is a binary workbook, not the text file this writeback assumes.
  const tables = Array.from(
    root.querySelectorAll<HTMLTableElement>('table.mc-csv[data-mc-editable="1"]'),
  );
  for (const table of tables) {
    wireTable(table, commit);
  }
  if (tables.length === 0) {
    focused = undefined;
    return;
  }
  // Re-seat the reader after the render a commit triggered.
  if (focused) {
    const cell = findCell(tables[0], focused);
    if (cell) {
      setFocus(cell, { scroll: restoring });
    }
  }
  restoring = false;
}

// Every data cell in the grid, excluding the row-number gutter.
function dataCells(row: HTMLTableRowElement): HTMLTableCellElement[] {
  return Array.from(row.cells).filter((c) => !c.hasAttribute('data-mc-ignore'));
}

function rowsOf(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.querySelectorAll<HTMLTableRowElement>('tr[data-record-line]'));
}

function refOf(cell: HTMLTableCellElement): CellRef | undefined {
  const row = cell.parentElement as HTMLTableRowElement | null;
  const line = Number(row?.dataset.recordLine);
  if (!row || Number.isNaN(line)) {
    return undefined;
  }
  const column = dataCells(row).indexOf(cell);
  return column < 0 ? undefined : { line, column };
}

function findCell(table: HTMLTableElement, ref: CellRef): HTMLTableCellElement | undefined {
  const row = rowsOf(table).find((r) => Number(r.dataset.recordLine) === ref.line);
  return row ? dataCells(row)[ref.column] : undefined;
}

function setFocus(cell: HTMLTableCellElement, opts: { scroll?: boolean } = {}): void {
  const table = cell.closest('table.mc-csv');
  // Roving tabindex: exactly one cell is in the tab order, so Tab enters and
  // leaves the grid once instead of walking thousands of cells. Select on the
  // tabindex rather than the focus class, so this also demotes the cell that
  // wireTable seeded (which is tab-reachable before anything is focused), and
  // so a big grid is not walked cell by cell on every move.
  table?.querySelectorAll<HTMLElement>('.mc-csv-cell[tabindex="0"]').forEach((el) => {
    el.classList.remove('mc-csv-cell--focus');
    el.tabIndex = -1;
  });
  cell.classList.add('mc-csv-cell--focus');
  cell.tabIndex = 0;
  // Record the cell before handing it the focus, not after: .focus() blurs
  // whatever held it, and an open editor's blur handler commits synchronously
  // from inside that call. It has to see the cell the reader just moved to.
  focused = refOf(cell);
  cell.focus({ preventScroll: !opts.scroll });
  if (opts.scroll) {
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/** Whether the reader has already moved off `cell` to somewhere else in the grid. */
function focusMovedOff(cell: HTMLTableCellElement): boolean {
  const ref = refOf(cell);
  return !!focused && !!ref && (focused.line !== ref.line || focused.column !== ref.column);
}

// Step one cell in either axis, staying inside the grid.
function move(cell: HTMLTableCellElement, dRow: number, dCol: number): void {
  const table = cell.closest<HTMLTableElement>('table.mc-csv');
  const row = cell.parentElement as HTMLTableRowElement | null;
  if (!table || !row) {
    return;
  }
  const rows = rowsOf(table);
  const cells = dataCells(row);
  const rowIndex = rows.indexOf(row) + dRow;
  const colIndex = cells.indexOf(cell) + dCol;
  const target = rows[rowIndex];
  if (!target) {
    return;
  }
  const next = dataCells(target)[Math.max(0, colIndex)];
  if (next) {
    setFocus(next, { scroll: true });
  }
}

function wireTable(table: HTMLTableElement, commit: CommitCell): void {
  for (const row of rowsOf(table)) {
    for (const cell of dataCells(row)) {
      cell.tabIndex = -1;
      cell.classList.add('mc-csv-cell');
    }
  }
  // One cell has to be reachable by Tab for the grid to be enterable at all.
  const first = dataCells(rowsOf(table)[0] ?? document.createElement('tr'))[0];
  if (first) {
    first.tabIndex = 0;
  }

  table.addEventListener('mousedown', (e) => {
    const cell = cellFrom(e.target);
    // Ignore the resize grips, which sit inside the header cells.
    if (cell && !(e.target as HTMLElement).classList?.contains('mc-csv-grip')) {
      setFocus(cell);
    }
  });

  table.addEventListener('dblclick', (e) => {
    const cell = cellFrom(e.target);
    if (cell && !(e.target as HTMLElement).classList?.contains('mc-csv-grip')) {
      e.preventDefault();
      beginEdit(cell, commit);
    }
  });

  table.addEventListener('keydown', (e) => {
    const cell = cellFrom(e.target);
    if (!cell || cell.querySelector('.mc-csv-input')) {
      return; // the textarea handles its own keys
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(cell, 1, 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(cell, -1, 0);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        move(cell, 0, -1);
        break;
      case 'ArrowRight':
      case 'Tab':
        if (e.key === 'Tab' && e.shiftKey) {
          return; // let Shift+Tab leave the grid
        }
        e.preventDefault();
        move(cell, 0, 1);
        break;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        beginEdit(cell, commit);
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        commitCell(cell, '', commit, { row: 0, col: 0 });
        break;
      default:
        // Typing a printable character starts editing and replaces the value,
        // the way it does in a spreadsheet.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          beginEdit(cell, commit, e.key);
        }
    }
  });
}

function cellFrom(target: EventTarget | null): HTMLTableCellElement | undefined {
  return (
    (target as HTMLElement)?.closest?.<HTMLTableCellElement>('td,th[scope="col"]') ?? undefined
  );
}

// Lay a textarea over the cell holding the same value. A textarea rather than an
// input because a CSV field may legitimately contain newlines, and an <input>
// would silently strip them.
//
// The editor covers the cell rather than replacing its content: it is absolutely
// positioned (see .mc-csv-input in preview.css, which explains why) and the cell
// keeps its text underneath. Emptying the cell would collapse the row to nothing
// while it was being edited.
function beginEdit(cell: HTMLTableCellElement, commit: CommitCell, seed?: string): void {
  if (cell.querySelector('.mc-csv-input')) {
    return;
  }
  const original = cell.textContent ?? '';
  const editor = document.createElement('textarea');
  editor.className = 'mc-csv-input';
  editor.value = seed ?? original;
  editor.rows = 1;
  // A textarea's intrinsic width comes from `cols`; keep it at the floor so the
  // column cannot be widened even if the positioning above ever changes.
  editor.cols = 1;
  editor.spellcheck = false;

  cell.classList.add('mc-csv-cell--editing');
  cell.appendChild(editor);

  // Grow downwards to fit a wrapped or multi-line value, never shrinking below
  // the cell it covers.
  const autoSize = (): void => {
    editor.style.height = 'auto';
    editor.style.height = `${Math.max(cell.clientHeight, editor.scrollHeight)}px`;
  };
  autoSize();
  editor.addEventListener('input', autoSize);

  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);

  let done = false;
  const finish = (save: boolean, next: { row: number; col: number }): void => {
    if (done) {
      return;
    }
    done = true;
    const value = editor.value;
    cell.classList.remove('mc-csv-cell--editing');
    // Remove only the editor. The cell's own children are untouched underneath
    // it, so pulling the editor out restores exactly what was there, including
    // the column's resize grip (csvTable.ts hangs it off this same cell).
    // Rewriting textContent here would flatten both away, and on Escape or an
    // unchanged value there is no re-render to put them back.
    editor.remove();
    if (save && value !== original) {
      commitCell(cell, value, commit, next);
    } else {
      const target = next.row || next.col ? undefined : cell;
      if (target) {
        setFocus(target);
      } else {
        move(cell, next.row, next.col);
      }
    }
  };

  editor.addEventListener('keydown', (e) => {
    e.stopPropagation(); // never let cell navigation see the editor's keys
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true, { row: 1, col: 0 });
    } else if (e.key === 'Tab') {
      e.preventDefault();
      finish(true, { row: 0, col: e.shiftKey ? -1 : 1 });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false, { row: 0, col: 0 });
    }
  });
  // Clicking away keeps the edit, matching every spreadsheet.
  editor.addEventListener('blur', () => finish(true, { row: 0, col: 0 }));
}

// Send the new value to the host and park focus where the reader is heading, so
// the re-render that follows lands them in the right place.
function commitCell(
  cell: HTMLTableCellElement,
  value: string,
  commit: CommitCell,
  next: { row: number; col: number },
): void {
  const ref = refOf(cell);
  if (!ref) {
    return;
  }
  if (next.row || next.col) {
    move(cell, next.row, next.col);
  } else if (!focusMovedOff(cell)) {
    // Only re-seat the edited cell when the reader is still on it. Clicking
    // straight onto another cell blurs the editor, which commits from here, and
    // pulling focus back would drag them off the cell they just picked.
    setFocus(cell);
  }
  restoring = true;
  commit(ref.line, ref.column, value);
}
