import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderCsvHtml } from '../src/csv';
import { enableCsvEditing } from '../src/webview/csvEdit';
import { enhanceCsvTables } from '../src/webview/csvTable';

// name,qty  /  Widget,3  /  Gadget,12: header on line 0, body on lines 1 and 2.
const CSV = 'name,qty\nWidget,3\nGadget,12';

let commit: ReturnType<typeof vi.fn>;

// jsdom implements no layout, so scrolling a cell into view is missing. The
// grid calls it whenever focus moves; stub it out (as the resize tests do for
// getBoundingClientRect) rather than bending the real code around the harness.
beforeEach(() => {
  (Element.prototype as unknown as Record<string, unknown>).scrollIntoView = vi.fn();
});

beforeEach(() => {
  // The module remembers the focused cell across renders (that is how focus
  // survives the re-render a commit triggers). Wiring an empty container clears
  // it, so each test starts from a known state.
  enableCsvEditing(document.createElement('div'), () => {});
  commit = vi.fn();
  document.body.innerHTML = renderCsvHtml(CSV).html;
  // Wire the grid the way main.ts does. The resize handles live inside the same
  // cells the editor covers, so editing has to be exercised with them present.
  enhanceCsvTables(document.body);
  enableCsvEditing(document.body, commit);
});

const rows = (): HTMLTableRowElement[] =>
  Array.from(document.querySelectorAll('tr[data-record-line]'));

/** Data cell at body row `r` (0-based), column `c`; row -1 is the header. */
function cell(r: number, c: number): HTMLTableCellElement {
  const row = r < 0 ? rows()[0] : rows()[r + 1];
  return Array.from(row.cells).filter((x) => !x.hasAttribute('data-mc-ignore'))[c];
}

const editor = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>('.mc-csv-input');

const key = (el: Element, k: string, init: KeyboardEventInit = {}): void => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
};

const click = (el: Element, type = 'mousedown'): void => {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
};

describe('cell selection', () => {
  it('makes data cells focusable but never the row-number gutter', () => {
    expect(cell(0, 0).classList.contains('mc-csv-cell')).toBe(true);
    const gutter = document.querySelector('tbody .mc-csv-gutter') as HTMLElement;
    expect(gutter.classList.contains('mc-csv-cell')).toBe(false);
    expect(gutter.tabIndex).toBe(-1);
  });

  it('keeps exactly one cell in the tab order', () => {
    click(cell(1, 1));
    const inOrder = Array.from(document.querySelectorAll<HTMLElement>('.mc-csv-cell')).filter(
      (c) => c.tabIndex === 0,
    );
    expect(inOrder).toHaveLength(1);
    expect(inOrder[0]).toBe(cell(1, 1));
  });

  it('focuses the cell you click', () => {
    click(cell(1, 0));
    expect(document.activeElement).toBe(cell(1, 0));
    expect(cell(1, 0).classList.contains('mc-csv-cell--focus')).toBe(true);
  });

  it('does not start a selection from a resize grip', () => {
    const grip = document.createElement('span');
    grip.className = 'mc-csv-grip';
    cell(-1, 0).appendChild(grip);
    click(grip);
    expect(cell(-1, 0).classList.contains('mc-csv-cell--focus')).toBe(false);
  });
});

describe('keyboard navigation', () => {
  it('moves with the arrow keys', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'ArrowRight');
    expect(document.activeElement).toBe(cell(0, 1));
    key(cell(0, 1), 'ArrowDown');
    expect(document.activeElement).toBe(cell(1, 1));
    key(cell(1, 1), 'ArrowLeft');
    expect(document.activeElement).toBe(cell(1, 0));
    key(cell(1, 0), 'ArrowUp');
    expect(document.activeElement).toBe(cell(0, 0));
  });

  it('moves up from the first body row into the header', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'ArrowUp');
    expect(document.activeElement).toBe(cell(-1, 0));
  });

  it('stops at the edges instead of wrapping', () => {
    click(cell(-1, 0));
    key(cell(-1, 0), 'ArrowUp');
    expect(document.activeElement).toBe(cell(-1, 0));
    key(cell(-1, 0), 'ArrowLeft');
    expect(document.activeElement).toBe(cell(-1, 0));
  });

  it('leaves Shift+Tab alone so focus can escape the grid', () => {
    click(cell(0, 0));
    const e = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    cell(0, 0).dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('editing a cell', () => {
  it('opens an editor on Enter, seeded with the current value', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    expect(editor()?.value).toBe('Widget');
  });

  it('opens on double-click', () => {
    click(cell(0, 1), 'dblclick');
    expect(editor()?.value).toBe('3');
  });

  // The editor is laid over the cell rather than replacing its contents. jsdom
  // has no layout so these assert the mechanism, not the pixels: emptying the
  // cell would collapse the row mid-edit, and a textarea's default `cols` of 20
  // would widen the whole column the moment editing started.
  it('leaves the cell text in place underneath the editor', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    expect(cell(0, 0).textContent).toBe('Widget');
    expect(cell(0, 0).querySelector('.mc-csv-input')).not.toBeNull();
  });

  it('gives the editor no intrinsic width of its own', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    expect(editor()!.cols).toBe(1);
  });

  it('removes the editor once the edit ends', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    key(editor()!, 'Escape');
    expect(editor()).toBeNull();
    expect(cell(0, 0).classList.contains('mc-csv-cell--editing')).toBe(false);
  });

  it('starts editing when you type over a cell, replacing the value', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'x');
    expect(editor()?.value).toBe('x');
  });

  it('ignores modified keystrokes', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'c', { ctrlKey: true });
    expect(editor()).toBeNull();
  });

  it('commits on Enter with the row line and column', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    editor()!.value = 'Sprocket';
    key(editor()!, 'Enter');
    expect(commit).toHaveBeenCalledWith(1, 0, 'Sprocket');
  });

  it('commits an edit to the header row against line 0', () => {
    click(cell(-1, 1));
    key(cell(-1, 1), 'Enter');
    editor()!.value = 'count';
    key(editor()!, 'Enter');
    expect(commit).toHaveBeenCalledWith(0, 1, 'count');
  });

  it('addresses the second body row by its own source line', () => {
    click(cell(1, 1));
    key(cell(1, 1), 'Enter');
    editor()!.value = '7';
    key(editor()!, 'Enter');
    expect(commit).toHaveBeenCalledWith(2, 1, '7');
  });

  it('does not commit when the value is unchanged', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    key(editor()!, 'Enter');
    expect(commit).not.toHaveBeenCalled();
  });

  it('discards the edit on Escape', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    editor()!.value = 'nope';
    key(editor()!, 'Escape');
    expect(commit).not.toHaveBeenCalled();
    expect(cell(0, 0).textContent).toBe('Widget');
  });

  it('keeps a newline typed with Shift+Enter instead of committing', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    key(editor()!, 'Enter', { shiftKey: true });
    expect(editor()).not.toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits a multi-line value', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    editor()!.value = 'one\ntwo';
    key(editor()!, 'Enter');
    expect(commit).toHaveBeenCalledWith(1, 0, 'one\ntwo');
  });

  it('commits on Tab and moves to the next column', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    editor()!.value = 'Widgets';
    key(editor()!, 'Tab');
    expect(commit).toHaveBeenCalledWith(1, 0, 'Widgets');
    expect(document.activeElement).toBe(cell(0, 1));
  });

  it('commits when the editor loses focus', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    const input = editor()!;
    input.value = 'Blurred';
    input.dispatchEvent(new FocusEvent('blur'));
    expect(commit).toHaveBeenCalledWith(1, 0, 'Blurred');
  });

  it('commits only once even if blur follows Enter', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    const input = editor()!;
    input.value = 'Once';
    key(input, 'Enter');
    input.dispatchEvent(new FocusEvent('blur'));
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('lands on the cell below after Enter', () => {
    click(cell(0, 1));
    key(cell(0, 1), 'Enter');
    editor()!.value = '42';
    key(editor()!, 'Enter');
    expect(document.activeElement).toBe(cell(1, 1));
  });

  it('clears a cell with Delete', () => {
    click(cell(1, 1));
    key(cell(1, 1), 'Delete');
    expect(commit).toHaveBeenCalledWith(2, 1, '');
  });

  it('does not let cell navigation see keys meant for the editor', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    key(editor()!, 'ArrowDown');
    // Still editing: the arrow moved the caret, not the selection.
    expect(editor()).not.toBeNull();
  });
});

// The resize grip is a child of the very cell the editor covers, and it sits in
// the bubble path of the grid's own key handling. Both are easy to break from
// the other module, so pin them from here, where the two are wired together.
describe('living alongside the column resize handles', () => {
  const grip = (c: number): HTMLElement => cell(-1, c).querySelector('.mc-csv-grip') as HTMLElement;

  it('keeps the grip when an edit is abandoned', () => {
    expect(grip(0)).not.toBeNull();
    key(cell(-1, 0), 'Enter');
    key(editor()!, 'Escape');
    expect(grip(0)).not.toBeNull();
  });

  it('keeps the grip when an edit commits an unchanged value', () => {
    key(cell(-1, 0), 'Enter');
    key(editor()!, 'Enter');
    expect(commit).not.toHaveBeenCalled();
    expect(grip(0)).not.toBeNull();
  });

  it('leaves the cell showing its value after an abandoned edit', () => {
    key(cell(-1, 0), 'Enter');
    editor()!.value = 'scratch';
    key(editor()!, 'Escape');
    expect(cell(-1, 0).textContent).toBe('name');
  });

  it('does not open the cell editor when Enter auto-fits a column', () => {
    key(grip(0), 'Enter');
    expect(editor()).toBeNull();
  });

  it('does not move the selection when an arrow resizes a column', () => {
    key(grip(0), 'ArrowRight');
    expect(document.querySelector('.mc-csv-cell--focus')).toBeNull();
  });
});

describe('focus across re-renders', () => {
  it('restores the focused cell after the grid is rebuilt', () => {
    click(cell(1, 1));
    key(cell(1, 1), 'Enter');
    editor()!.value = '9';
    key(editor()!, 'Enter');

    // The host applies the edit, the document changes, the preview re-renders.
    document.body.innerHTML = renderCsvHtml('name,qty\nWidget,3\nGadget,9').html;
    enableCsvEditing(document.body, commit);

    expect(document.activeElement).toBe(cell(1, 1));
  });

  // Clicking straight from an open editor onto another cell blurs the editor,
  // which commits. The commit must not drag focus back to the cell just left.
  it('leaves focus on a cell clicked into from an open editor', () => {
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    editor()!.value = 'Sprocket';
    // No synthetic blur: focusing the new cell is what blurs the editor, and the
    // commit therefore runs from inside that .focus() call.
    click(cell(1, 1));

    expect(commit).toHaveBeenCalledWith(1, 0, 'Sprocket');
    expect(cell(1, 1).classList.contains('mc-csv-cell--focus')).toBe(true);
    expect(cell(0, 0).classList.contains('mc-csv-cell--focus')).toBe(false);
  });
});

// A spreadsheet sheet renders the same grid markup as a CSV but must never become
// editable: the document behind it is a binary workbook, and the writeback this
// module drives rewrites a field in a text document by line and column. Read-only
// is therefore carried by the markup (`data-mc-editable`), not by a condition in
// the webview wiring, so that it cannot be lost to a refactor of that wiring.
describe('read-only grids', () => {
  const readOnlyGrid = (): void => {
    document.body.innerHTML = renderCsvHtml(CSV).html;
    document.querySelector('table.mc-csv')!.removeAttribute('data-mc-editable');
    enhanceCsvTables(document.body);
    enableCsvEditing(document.body, commit);
  };

  it('does not make the cells focusable', () => {
    readOnlyGrid();
    expect(cell(0, 0).classList.contains('mc-csv-cell')).toBe(false);
    expect(cell(0, 0).getAttribute('tabindex')).toBeNull();
  });

  it('opens no editor and commits nothing', () => {
    readOnlyGrid();
    click(cell(0, 0));
    key(cell(0, 0), 'Enter');
    expect(editor()).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('still marks an ordinary CSV grid editable, so the guard is not vacuous', () => {
    // Without this, removing `data-mc-editable` from src/csv.ts would leave every
    // test above passing against a grid nobody can edit.
    expect(renderCsvHtml(CSV).html).toContain('data-mc-editable="1"');
  });
});
