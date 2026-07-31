// Reading one worksheet into a bounded grid of display strings.
import { attr, boolAttr, intAttr, walkXml } from './xml';
import { formatCodeFor, formatValue, type Styles } from './styles';

export interface Cell {
  /** Already formatted for display; the renderer only escapes it. */
  text: string;
  /** Right-align numerics the way the CSV grid does. */
  numeric: boolean;
  /** A formula whose cached result the writer did not store. */
  notCalculated?: boolean;
  colspan?: number;
  rowspan?: number;
}

export interface SheetRow {
  cells: (Cell | undefined)[];
  hidden: boolean;
  /**
   * The sheet's own 1-based row number. Rows are sparse: a sheet holding data in
   * rows 1 and 5 stores two <row> elements, so counting them would label the
   * second one "2" and misreport where every value actually sits.
   */
  index: number;
}

export interface Sheet {
  rows: SheetRow[];
  /** Column widths in characters, by 0-based column index. */
  widths: (number | undefined)[];
  hiddenColumns: Set<number>;
  columns: number;
  /** Rows beyond the cap that were counted but not built. */
  dropped: number;
  /** True when a column cap cut the grid short. */
  columnsTruncated: boolean;
}

export interface SheetLimits {
  maxRows: number;
  maxColumns: number;
}

export interface SheetContext {
  styles: Styles;
  sharedStrings: string[];
  date1904: boolean;
  limits: SheetLimits;
}

/** `A1` / `BC12` -> zero-based column index. Returns undefined if unparseable. */
export function columnOf(ref: string): number | undefined {
  let out = 0;
  let seen = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      out = out * 26 + (code - 64);
      seen++;
    } else if (code >= 97 && code <= 122) {
      out = out * 26 + (code - 96);
      seen++;
    } else {
      break;
    }
  }
  return seen === 0 ? undefined : out - 1;
}

export function readSheet(xml: string, ctx: SheetContext): Sheet {
  const rows: SheetRow[] = [];
  const widths: (number | undefined)[] = [];
  const hiddenColumns = new Set<number>();
  const merges: { top: number; left: number; bottom: number; right: number }[] = [];

  let dropped = 0;
  let columns = 0;
  let columnsTruncated = false;

  // Row in progress.
  let cells: (Cell | undefined)[] = [];
  let rowHidden = false;
  let inRow = false;
  let rowIndex = 0;

  // Cell in progress.
  let col = -1;
  let type = 'n';
  let styleIndex: number | undefined;
  let value = '';
  let inlineText = '';
  let hasFormula = false;
  let hasValue = false;
  let inV = false;
  let inT = false;
  let inIs = false;

  const finishCell = (): void => {
    if (col < 0 || col >= ctx.limits.maxColumns) {
      if (col >= ctx.limits.maxColumns) {
        columnsTruncated = true;
      }
      return;
    }
    const cell = buildCell({
      type,
      styleIndex,
      value,
      inlineText,
      hasFormula,
      hasValue,
      ctx,
    });
    if (cell !== undefined) {
      cells[col] = cell;
      if (col + 1 > columns) {
        columns = col + 1;
      }
    }
  };

  walkXml(xml, {
    open(name, attrs) {
      switch (name) {
        case 'col': {
          // `min`/`max` are an inclusive 1-based range, not a single column, and
          // a single <col> routinely spans hundreds of them.
          const min = intAttr(attrs, 'min') ?? 1;
          const max = Math.min(intAttr(attrs, 'max') ?? min, ctx.limits.maxColumns);
          const width = Number(attr(attrs, 'width'));
          const hidden = boolAttr(attrs, 'hidden');
          for (let c = min; c <= max; c++) {
            if (Number.isFinite(width)) {
              widths[c - 1] = width;
            }
            if (hidden) {
              hiddenColumns.add(c - 1);
            }
          }
          break;
        }
        case 'row': {
          inRow = true;
          cells = [];
          rowHidden = boolAttr(attrs, 'hidden');
          // `r` is optional; without it the row is one past the last seen.
          rowIndex = intAttr(attrs, 'r') ?? rowIndex + 1;
          break;
        }
        case 'c': {
          const ref = attr(attrs, 'r');
          // A cell without an `r` is legal and some writers omit it: position is
          // then implicit, one past the previous cell.
          col = ref === undefined ? col + 1 : (columnOf(ref) ?? col + 1);
          type = attr(attrs, 't') ?? 'n';
          styleIndex = intAttr(attrs, 's');
          value = '';
          inlineText = '';
          hasFormula = false;
          hasValue = false;
          break;
        }
        case 'f':
          hasFormula = true;
          break;
        case 'v':
          inV = true;
          hasValue = true;
          break;
        case 'is':
          inIs = true;
          break;
        case 't':
          inT = true;
          break;
        case 'mergeCell': {
          const range = attr(attrs, 'ref') ?? '';
          const [from, to] = range.split(':');
          if (from && to) {
            const left = columnOf(from);
            const right = columnOf(to);
            const top = Number.parseInt(from.replace(/^[A-Za-z]+/, ''), 10) - 1;
            const bottom = Number.parseInt(to.replace(/^[A-Za-z]+/, ''), 10) - 1;
            if (
              left !== undefined &&
              right !== undefined &&
              Number.isFinite(top) &&
              Number.isFinite(bottom)
            ) {
              merges.push({ top, left, bottom, right });
            }
          }
          break;
        }
      }
    },
    text(text) {
      if (inV) {
        value += text;
      } else if (inIs && inT) {
        inlineText += text;
      }
    },
    close(name) {
      switch (name) {
        case 'v':
          inV = false;
          break;
        case 'is':
          inIs = false;
          break;
        case 't':
          inT = false;
          break;
        case 'c':
          finishCell();
          col = Math.max(col, 0);
          break;
        case 'row': {
          inRow = false;
          if (rows.length < ctx.limits.maxRows) {
            rows.push({ cells, hidden: rowHidden, index: rowIndex });
          } else {
            dropped++;
          }
          cells = [];
          break;
        }
      }
    },
  });

  // A final row with no closing tag (a truncated file) still has content worth
  // showing.
  if (inRow && cells.length > 0 && rows.length < ctx.limits.maxRows) {
    rows.push({ cells, hidden: rowHidden, index: rowIndex });
  }

  applyMerges(rows, merges, columns);

  return { rows, widths, hiddenColumns, columns, dropped, columnsTruncated };
}

function buildCell(o: {
  type: string;
  styleIndex: number | undefined;
  value: string;
  inlineText: string;
  hasFormula: boolean;
  hasValue: boolean;
  ctx: SheetContext;
}): Cell | undefined {
  const { ctx } = o;

  // A formula with no cached <v>. openpyxl and xlsxwriter write these: the file
  // holds the formula but no result, because nothing has recalculated it. Showing
  // an empty cell would read as data loss, so say what it is.
  if (o.hasFormula && !o.hasValue && o.type !== 'inlineStr') {
    return { text: '', numeric: false, notCalculated: true };
  }

  switch (o.type) {
    case 's': {
      // Shared string: the value is an *index* into the table.
      const index = Number.parseInt(o.value, 10);
      const text = Number.isFinite(index) ? (ctx.sharedStrings[index] ?? '') : '';
      return text === '' ? undefined : { text, numeric: false };
    }
    case 'inlineStr':
      return o.inlineText === '' ? undefined : { text: o.inlineText, numeric: false };
    case 'str':
      // The classic trap: `t="str"` is a formula's *string result*, held verbatim
      // in <v>. It is not an index into anything, and treating it as one (because
      // it looks like `s`) renders an unrelated string or nothing at all.
      return o.value === '' ? undefined : { text: o.value, numeric: false };
    case 'b':
      return { text: o.value === '1' ? 'TRUE' : 'FALSE', numeric: false };
    case 'e':
      // An error value (#REF!, #DIV/0!) is already its display text.
      return o.value === '' ? undefined : { text: o.value, numeric: false };
    default: {
      if (o.value === '') {
        return undefined;
      }
      const num = Number(o.value);
      if (!Number.isFinite(num)) {
        return { text: o.value, numeric: false };
      }
      const code = formatCodeFor(ctx.styles, o.styleIndex);
      return { text: formatValue(num, code, ctx.date1904), numeric: true };
    }
  }
}

/**
 * Turn merge ranges into colspan/rowspan, blanking the cells they cover.
 *
 * `undefined` means "no cell here"; a covered cell is set to `null`-like absence
 * by being removed, and the renderer skips those positions. The anchor keeps the
 * value, which is where Excel stores it.
 */
function applyMerges(
  rows: SheetRow[],
  merges: { top: number; left: number; bottom: number; right: number }[],
  columns: number,
): void {
  for (const m of merges) {
    if (m.top >= rows.length || m.left >= columns) {
      continue;
    }
    const anchorRow = rows[m.top];
    const anchor = anchorRow.cells[m.left] ?? { text: '', numeric: false };
    anchor.colspan = m.right - m.left + 1;
    anchor.rowspan = m.bottom - m.top + 1;
    anchorRow.cells[m.left] = anchor;
    for (let r = m.top; r <= Math.min(m.bottom, rows.length - 1); r++) {
      for (let c = m.left; c <= m.right; c++) {
        if (r === m.top && c === m.left) {
          continue;
        }
        rows[r].cells[c] = undefined;
        // Mark the position as covered so the renderer emits no <td> for it.
        covered(rows[r]).add(c);
      }
    }
  }
}

const COVERED = new WeakMap<SheetRow, Set<number>>();

export function covered(row: SheetRow): Set<number> {
  let set = COVERED.get(row);
  if (set === undefined) {
    set = new Set();
    COVERED.set(row, set);
  }
  return set;
}
