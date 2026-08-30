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

import type { MenuController } from './menu';

/** Which cell the reader is on. Survives the re-render caused by a commit. */
export interface CellRef {
  line: number;
  column: number;
}

export type CommitCell = (line: number, column: number, value: string) => void;

// The class the open cell editor's textarea carries, and the selector that finds
// it. Named once: main.ts, the grid's own pointer handling and the editor
// teardown all have to agree on what an open editor looks like.
const EDITOR_CLASS = 'mc-csv-input';
const EDITOR_SELECTOR = `.${EDITOR_CLASS}`;

let focused: CellRef | undefined;
// True while a commit is in flight, so the re-render it causes restores focus
// to the cell the reader moved to rather than fighting them for it.
let restoring = false;

// The context menu, which opens over the grid and takes the keyboard with it.
// Handed in rather than looked up: the editor asks the menu whether it is the
// thing that just took the focus, instead of string-matching its markup.
let contextMenu: MenuController | undefined;

// The open editor's subscription to that menu closing, if one is armed. At most
// one cell editor exists at a time, and a render replaces the grid wholesale, so
// a single module-level slot both bounds this to one live listener and gives the
// re-render an unambiguous place to drop it.
let menuWatch: (() => void) | undefined;

function dropMenuWatch(): void {
  menuWatch?.();
  menuWatch = undefined;
}

// How to end the open cell edit from outside it, or undefined when no cell is
// being edited. One slot, for the same reason menuWatch is one slot: at most one
// editor exists at a time. See endStrandedEdit for why this is needed at all.
let closeOpenEdit: ((save: boolean) => void) | undefined;

// Whether the document-level safety net below has been installed.
let netInstalled = false;

/**
 * Commit an edit whose reader has left without the textarea ever being blurred.
 *
 * `blur` carries almost every way out of a cell, and where it fires it is the
 * better signal, because it knows what took the focus. But it is not guaranteed
 * to fire at all:
 *
 * - A press on something unfocusable (the padding around the grid, the
 *   row-number gutter, the page background under a short file) moves focus in
 *   Chromium but not in every engine, and a handler that calls preventDefault on
 *   the way down suppresses the focus change everywhere.
 * - A webview hidden by a tab switch is torn down without a blur.
 *
 * In both, the value the reader typed is sitting in a textarea nobody will ever
 * ask about again, and removing the grid drops it. Every spreadsheet keeps that
 * edit, so keep it.
 */
function endStrandedEdit(): void {
  // Except while the context menu holds the keyboard. Right-clicking a value is
  // not leaving the cell, and the menu's own close handler already decides that
  // edit's fate (see watchMenu); committing from here would end the edit out
  // from under a menu whose copy rows are still reading it.
  if (contextMenu?.isOpen()) {
    return;
  }
  closeOpenEdit?.(true);
}

/**
 * Arm the safety net once, on the document rather than the grid, because the
 * presses it exists to catch are the ones that land outside the grid.
 *
 * Deliberately on the bubble phase: the table's own mousedown handler runs
 * first, and a press that lands on another cell is already committed by the
 * focus change it causes. By the time this runs, `closeOpenEdit` is cleared and
 * there is nothing left to do, so the ordinary path keeps its `relatedTarget`
 * and this only ever sees presses that path did not handle.
 */
function installStrandedEditNet(): void {
  if (netInstalled || typeof document === 'undefined') {
    return;
  }
  netInstalled = true;

  document.addEventListener('mousedown', (e) => {
    const target = e.target as HTMLElement | null;
    // A press inside the editor is placing the caret, not leaving the cell, and
    // a press on a resize grip is a drag the header's editor deliberately
    // survives (csvTable.ts suppresses the focus change for exactly that).
    if (editorIn(target) || target?.classList?.contains('mc-csv-grip')) {
      return;
    }
    endStrandedEdit();
  });

  // Leaving the webview entirely: another editor tab, another window, or a
  // reload. `pagehide` rather than `unload`, which Chromium no longer fires
  // reliably, and `visibilitychange` for the tab switch that hides the panel
  // without unloading it.
  window.addEventListener('blur', endStrandedEdit);
  window.addEventListener('pagehide', endStrandedEdit);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      endStrandedEdit();
    }
  });
}

export function enableCsvEditing(root: ParentNode, commit: CommitCell, menu: MenuController): void {
  contextMenu = menu;
  installStrandedEditNet();
  // Any editor that was watching the menu belonged to the grid this render is
  // replacing. Left armed, it would fire against a detached textarea and write
  // that dead edit's value over whatever the document holds by then. The same
  // goes for the safety net's handle on it: this render has already taken the
  // textarea out of the document, so there is no longer an edit to strand.
  dropMenuWatch();
  closeOpenEdit = undefined;
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
  // Re-seat the reader after the render a commit triggered. The square may be
  // gone rather than merely moved: deleting the last row of a file, or its last
  // column, takes the parked ref out of the grid with it. Falling back to the
  // nearest surviving cell keeps the reader inside the grid instead of dropping
  // them on <body> with nothing focused and the arrow keys dead.
  if (focused) {
    const cell = findCell(tables[0], focused) ?? nearestCell(tables[0], focused);
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

// The closest surviving cell to `ref`, for when the square itself is gone: the
// last row at or above `ref.line`, and the nearest column it actually has. A
// delete at the end of a file leaves nothing below to slide up, so the answer
// there is the row that is now last rather than no row at all.
function nearestCell(table: HTMLTableElement, ref: CellRef): HTMLTableCellElement | undefined {
  const rows = rowsOf(table);
  let best: HTMLTableRowElement | undefined;
  for (const row of rows) {
    const line = Number(row.dataset.recordLine);
    if (!Number.isNaN(line) && line <= ref.line) {
      best = row;
    }
  }
  // Nothing at or above it means every row is below: the first one is then the
  // nearest, which is where a delete of the very first row lands.
  const row = best ?? rows[0];
  if (!row) {
    return undefined; // an emptied file has no square to offer
  }
  const cells = dataCells(row);
  return cells[Math.min(ref.column, cells.length - 1)];
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
    const target = e.target as HTMLElement;
    // An open editor handles its own pointer: clicking into it places the caret,
    // dragging selects part of the value, right-clicking opens the menu over it.
    // Re-focusing the cell here would blur the textarea, and blur ends the edit,
    // so every one of those gestures used to close the editor on the way down.
    if (editorIn(target)) {
      return;
    }
    const cell = cellFrom(target);
    // Ignore the resize grips, which sit inside the header cells.
    if (cell && !target.classList?.contains('mc-csv-grip')) {
      setFocus(cell);
    }
  });

  table.addEventListener('dblclick', (e) => {
    const target = e.target as HTMLElement;
    // Double-clicking again, now inside the editor the first one opened, takes
    // the whole value. A cell holds one short field far more often than a
    // sentence, so select-all is what that gesture is reaching for here, whether
    // the value is about to be replaced or copied. Dragging still takes a part.
    const open = editorIn(target);
    if (open) {
      open.select();
      return;
    }
    const cell = cellFrom(target);
    if (cell && !target.classList?.contains('mc-csv-grip')) {
      e.preventDefault();
      beginEdit(cell, commit);
    }
  });

  table.addEventListener('keydown', (e) => {
    const cell = cellFrom(e.target);
    if (!cell || cell.querySelector(EDITOR_SELECTOR)) {
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

/**
 * The open cell editor `node` sits in, if it is inside one.
 *
 * Exported because the context menu asks the same question from main.ts: a
 * right-click inside an open editor has to offer the value being typed rather
 * than the table around it.
 */
export function editorIn(node: EventTarget | Node | null): HTMLTextAreaElement | undefined {
  return (node as HTMLElement)?.closest?.<HTMLTextAreaElement>(EDITOR_SELECTOR) ?? undefined;
}

/**
 * The row and column the pointer is over, for an edit that takes a whole row or
 * column rather than one field.
 *
 * Unlike the cell lookup the grid uses internally, this also answers for the
 * row-number gutter, which addresses a row but no column: `column` comes back as
 * -1 there, and the caller offers only the operations that need no column.
 * Exported because the context menu is built in main.ts, over whatever was
 * right-clicked.
 */
export function gridRefFrom(target: EventTarget | null): CellRef | undefined {
  const cell = (target as HTMLElement)?.closest?.<HTMLTableCellElement>('td,th');
  const row = cell?.parentElement as HTMLTableRowElement | null;
  if (!cell || !row?.dataset.recordLine) {
    return undefined;
  }
  const line = Number(row.dataset.recordLine);
  if (Number.isNaN(line)) {
    return undefined;
  }
  if (cell.hasAttribute('data-mc-ignore')) {
    return { line, column: -1 };
  }
  const column = dataCells(row).indexOf(cell);
  return column < 0 ? undefined : { line, column };
}

/**
 * Leave the reader on `ref` through the re-render a host-side edit will cause.
 *
 * Inserting or deleting a row or column moves the grid under the reader rather
 * than moving the reader: the square they were standing on is the one they
 * should still be standing on afterwards, whatever has slid into it. Focus is
 * remembered by (line, column) across renders, so saying so is the whole of it.
 */
export function parkFocus(ref: CellRef): void {
  focused = ref;
  restoring = true;
}

/**
 * Whether the blur that just fired handed the keyboard to the context menu.
 *
 * `relatedTarget` is the only direct signal available here: `document
 * .activeElement` is still <body> this early in the dispatch, in both Chromium
 * and jsdom, so testing it would be dead code. When the engine reports no
 * related target at all, the menu being on screen is what stands in for it.
 */
function menuTookFocus(e: FocusEvent): boolean {
  if (!contextMenu) {
    return false;
  }
  return e.relatedTarget ? contextMenu.owns(e.relatedTarget) : contextMenu.isOpen();
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
  if (cell.querySelector(EDITOR_SELECTOR)) {
    return;
  }
  const original = cell.textContent ?? '';
  const editor = document.createElement('textarea');
  editor.className = EDITOR_CLASS;
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
    dropMenuWatch();
    closeOpenEdit = undefined;
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

  // The handle the safety net ends this edit through when no blur ever arrives.
  // Set after `finish` exists and cleared inside it, so the slot holds an edit
  // that is genuinely still open and nothing else.
  closeOpenEdit = (save) => finish(save, { row: 0, col: 0 });

  // The stand-in for the blur that never comes while the context menu holds the
  // keyboard (see the blur handler below). No blur is coming, so the menu
  // closing is the moment this edit's fate is decided: either the menu hands the
  // caret back and the edit carries on, or the reader has moved on and it ends
  // the way losing focus would have.
  const watchMenu = (): void => {
    if (menuWatch) {
      return; // already watching this same interaction
    }
    menuWatch = contextMenu?.onClose(() => {
      dropMenuWatch();
      // A render can replace the grid while the menu is up, taking the editor
      // with it. There is then nothing left to commit: the value in this closure
      // describes a cell that no longer exists, and writing it would land on
      // whatever now occupies that line and column.
      if (!editor.isConnected) {
        done = true;
        return;
      }
      if (document.activeElement === editor) {
        return;
      }
      finish(true, { row: 0, col: 0 });
    });
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
  editor.addEventListener('blur', (e) => {
    // Except when what took the focus is MarkCopy's own context menu, which
    // grabs it so its rows can be arrowed through. Right-clicking a value is not
    // leaving the cell: keep the edit open underneath the menu, so the selection
    // is still on screen and still there for the menu's copy rows to read.
    if (menuTookFocus(e as FocusEvent)) {
      watchMenu();
      return;
    }
    finish(true, { row: 0, col: 0 });
  });
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
