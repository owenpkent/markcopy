import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderCsvHtml } from '../src/csv';
import { enhanceCsvTables, resetColumnWidths } from '../src/webview/csvTable';

// jsdom has no layout engine, so every box measures 0x0 and pointer capture is
// missing. Give cells a fixed width and stub capture so the drag logic, which
// is the part worth testing, runs exactly as it does in the webview.
const CELL_PX = 120;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: CELL_PX,
    height: 20,
    top: 0,
    left: 0,
    right: CELL_PX,
    bottom: 20,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  (Element.prototype as unknown as Record<string, unknown>).setPointerCapture = vi.fn();
  (Element.prototype as unknown as Record<string, unknown>).releasePointerCapture = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.className = '';
});

// A 3-column grid (plus the row-number gutter), built by the real renderer so
// the <col>-per-cell contract between the two modules stays honest.
function grid(csv = 'a,b,c\n1,2,3\n4,5,6'): {
  table: HTMLTableElement;
  cols: HTMLTableColElement[];
  grips: HTMLElement[];
} {
  document.body.innerHTML = renderCsvHtml(csv).html;
  enhanceCsvTables(document.body);
  return {
    table: document.querySelector('table') as HTMLTableElement,
    cols: Array.from(document.querySelectorAll('colgroup > col')),
    grips: Array.from(document.querySelectorAll('.mc-csv-grip')),
  };
}

function pointer(type: string, clientX: number): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  return e;
}

function drag(grip: HTMLElement, from: number, to: number): void {
  grip.dispatchEvent(pointer('pointerdown', from));
  grip.dispatchEvent(pointer('pointermove', to));
  grip.dispatchEvent(pointer('pointerup', to));
}

const widthOf = (col: HTMLTableColElement): number => parseFloat(col.style.width);

describe('enhanceCsvTables', () => {
  it('adds one grip per data column and none on the gutter', () => {
    const { grips } = grid();
    expect(grips).toHaveLength(3);
    expect(document.querySelector('.mc-csv-gutter .mc-csv-grip')).toBeNull();
  });

  it('labels the grips for screen readers', () => {
    const { grips } = grid();
    expect(grips[0].getAttribute('role')).toBe('separator');
    expect(grips[0].getAttribute('aria-orientation')).toBe('vertical');
    expect(grips[0].tabIndex).toBe(0);
  });

  it('leaves the table on automatic layout until something is dragged', () => {
    const { table, cols } = grid();
    expect(table.style.tableLayout).toBe('');
    expect(cols.every((c) => c.style.width === '')).toBe(true);
  });

  it('does nothing when the <col> count does not match the cells', () => {
    document.body.innerHTML =
      '<table class="mc-csv"><colgroup><col /></colgroup>' +
      '<thead><tr><th>a</th><th>b</th></tr></thead></table>';
    enhanceCsvTables(document.body);
    expect(document.querySelectorAll('.mc-csv-grip')).toHaveLength(0);
  });
});

describe('column resizing', () => {
  it('freezes the measured widths onto the columns on first drag', () => {
    const { table, cols, grips } = grid();
    grips[0].dispatchEvent(pointer('pointerdown', 100));
    expect(table.style.tableLayout).toBe('fixed');
    expect(table.dataset.mcFrozen).toBe('1');
    expect(cols.map(widthOf)).toEqual([CELL_PX, CELL_PX, CELL_PX, CELL_PX]);
  });

  it('widens the dragged column by the pointer delta', () => {
    const { cols, grips } = grid();
    drag(grips[0], 100, 160);
    // grips[0] resizes the first data column, which is cols[1] (cols[0] is the gutter).
    expect(widthOf(cols[1])).toBe(CELL_PX + 60);
  });

  it('narrows the column when dragged left', () => {
    const { cols, grips } = grid();
    drag(grips[1], 300, 260);
    expect(widthOf(cols[2])).toBe(CELL_PX - 40);
  });

  it('leaves the other columns alone', () => {
    const { cols, grips } = grid();
    drag(grips[1], 300, 380);
    expect([widthOf(cols[0]), widthOf(cols[1]), widthOf(cols[3])]).toEqual([
      CELL_PX,
      CELL_PX,
      CELL_PX,
    ]);
  });

  it('keeps the table width equal to the sum of its columns', () => {
    const { table, cols, grips } = grid();
    drag(grips[0], 100, 190);
    const sum = cols.reduce((total, c) => total + widthOf(c), 0);
    expect(table.style.width).toBe(`${sum}px`);
    expect(sum).toBe(CELL_PX * 4 + 90);
  });

  it('clamps a column to a usable minimum rather than collapsing it', () => {
    const { cols, grips } = grid();
    drag(grips[0], 100, -900);
    expect(widthOf(cols[1])).toBe(44);
  });

  it('ignores a non-primary button', () => {
    const { table, grips } = grid();
    grips[0].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 }));
    expect(table.dataset.mcFrozen).toBeUndefined();
  });

  it('flags the drag on the body so the resize cursor survives leaving the grip', () => {
    const { grips } = grid();
    grips[0].dispatchEvent(pointer('pointerdown', 100));
    expect(document.body.classList.contains('mc-csv-resizing')).toBe(true);
    grips[0].dispatchEvent(pointer('pointerup', 100));
    expect(document.body.classList.contains('mc-csv-resizing')).toBe(false);
  });

  it('stops tracking the pointer once the drag ends', () => {
    const { cols, grips } = grid();
    drag(grips[0], 100, 160);
    grips[0].dispatchEvent(pointer('pointermove', 400));
    expect(widthOf(cols[1])).toBe(CELL_PX + 60);
  });

  it('resizes with the arrow keys', () => {
    const { cols, grips } = grid();
    grips[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(widthOf(cols[1])).toBe(CELL_PX + 16);
    grips[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }),
    );
    expect(widthOf(cols[1])).toBe(CELL_PX + 16 - 64);
  });
});

describe('resetColumnWidths', () => {
  it('hands sizing back to the browser', () => {
    const { table, cols, grips } = grid();
    drag(grips[0], 100, 200);
    resetColumnWidths(table);
    expect(cols.every((c) => c.style.width === '')).toBe(true);
    expect(table.style.tableLayout).toBe('');
    expect(table.style.width).toBe('');
    expect(table.dataset.mcFrozen).toBeUndefined();
  });

  it('leaves the grips working afterwards', () => {
    const { table, cols, grips } = grid();
    drag(grips[0], 100, 200);
    resetColumnWidths(table);
    drag(grips[0], 100, 150);
    expect(widthOf(cols[1])).toBe(CELL_PX + 50);
  });
});
