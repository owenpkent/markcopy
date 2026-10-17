// Bounds on the tables the Word and PowerPoint writers will lay out.
//
// Both writers take the preview's serialized XHTML and expand each table into a
// grid, one output cell per grid position. The span attributes that drive that
// expansion arrive from the webview as strings and are untrusted: DOMPurify
// keeps `colspan` and `rowspan` verbatim, and the browser's own clamp applies to
// the DOM property, not to the attribute the serializer copies out. A single
// `<td colspan="10000">` in raw HTML therefore reached the host as ten thousand
// grid columns, and nothing between the attribute and the writer's loops asked
// whether that was a sensible table.
//
// Shared rather than duplicated, so the two exports cannot drift into accepting
// different tables.

/**
 * The most columns one cell may span. The same value browsers clamp the
 * `colSpan` property to, so a table the preview could lay out survives, and one
 * it could not is cut to what the preview actually showed.
 */
export const MAX_CELL_COLSPAN = 1000;

/** The most rows one cell may span, again the browsers' clamp for `rowSpan`. */
export const MAX_CELL_ROWSPAN = 65534;

/** The widest grid either writer will expand. */
export const MAX_TABLE_COLUMNS = 1000;

/**
 * The most grid positions (columns times rows) either writer will expand, the
 * budget that keeps a legal-looking table from turning into tens of megabytes
 * of XML built synchronously in the extension host. Sized to hold the CSV grid
 * at its default row cap with a few dozen columns.
 */
export const MAX_TABLE_CELLS = 250_000;

/**
 * A `colspan` or `rowspan` attribute as a span the writers can loop over.
 *
 * Anything that is not a plain positive decimal integer (an empty string, a
 * sign, an exponent, text) means 1, which is what a browser does with the same
 * attribute. A value above `max` is clamped to it rather than rejected: the
 * preview drew that cell as wide as its own clamp allowed, and the export
 * should match the preview, not refuse the table.
 */
export function spanAttr(value: string | undefined, max: number): number {
  if (value === undefined) {
    return 1;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return 1;
  }
  // Leading zeros carry no magnitude (`0000000002` is 2, as in a browser), so
  // drop them before judging size. What is left is compared by length and never
  // parsed when long, so a value that would round in floating point is clamped
  // instead of becoming a loop bound.
  const digits = trimmed.replace(/^0+/, '');
  if (digits === '') {
    return 1;
  }
  if (digits.length > 9) {
    return max;
  }
  return Math.min(Number.parseInt(digits, 10), max);
}

/** Work counted by `countTableColumns`, exposed so a test can bound it. */
export interface ColumnCountStats {
  /** Rows scanned before the count finished or gave up. */
  rowsScanned: number;
  /** The longest the rowspan carry array grew. */
  maxCarried: number;
}

/**
 * The grid width of a table, in columns, or a lower bound on it once the table
 * is known to be too large to write.
 *
 * The sum of a row's own colspans is not the answer: a rowspan from an earlier
 * row occupies a column in this row too, so a `<td rowspan="2">` above a row of
 * two cells makes a three-column table. Undercounting is not a layout nit: the
 * placement loop stops at the width, so every cell past it is dropped from the
 * document entirely.
 *
 * The count enforces `tableTooLarge`'s budgets as it goes. It returns as soon
 * as the width passes `MAX_TABLE_COLUMNS`, before allocating the columns that
 * span implies, and as soon as the width times the row count passes
 * `MAX_TABLE_CELLS`; the result then still fails `tableTooLarge`. That keeps the
 * work linear in the budget: without it, a cell spanning a thousand columns and
 * rows deep added a thousand carried columns per row and the validation alone
 * went quadratic.
 *
 * A loop rather than `Math.max(...rows.map(...))`, because the spread passes one
 * argument per row and overflows the call stack somewhere north of a hundred
 * thousand of them, a size `markcopy.csv.maxRows` can be set to.
 */
export function countTableColumns(
  rows: readonly { cells: readonly { colspan: number; rowspan: number }[] }[],
  stats?: ColumnCountStats,
): number {
  let cols = 1;
  // Rows still to come that each column owes to a rowspan above it.
  let carried: number[] = [];

  for (const row of rows) {
    if (stats) {
      stats.rowsScanned++;
    }
    let col = 0;
    for (const cell of row.cells) {
      while ((carried[col] ?? 0) > 0) {
        col++;
      }
      if (col + cell.colspan > MAX_TABLE_COLUMNS) {
        return col + cell.colspan;
      }
      for (let i = 0; i < cell.colspan; i++) {
        carried[col + i] = Math.max(carried[col + i] ?? 0, cell.rowspan);
      }
      col += cell.colspan;
    }
    if (stats) {
      stats.maxCarried = Math.max(stats.maxCarried, carried.length);
    }
    cols = Math.max(cols, col);
    if (cols * rows.length > MAX_TABLE_CELLS) {
      return cols;
    }
    carried = carried.map((left) => Math.max(0, left - 1));
  }
  return cols;
}

/**
 * Why a grid of `columns` by `rows` is too large to write, or undefined when
 * it is within budget. The message is what the writer puts in the document in
 * the table's place, so it names the limit the table hit.
 */
export function tableTooLarge(columns: number, rows: number): string | undefined {
  if (columns > MAX_TABLE_COLUMNS) {
    return (
      `Table omitted: ${fmt(columns)} columns is more than the ` +
      `${fmt(MAX_TABLE_COLUMNS)} this export can write.`
    );
  }
  if (columns * rows > MAX_TABLE_CELLS) {
    return (
      `Table omitted: ${fmt(columns)} columns by ${fmt(rows)} rows is more than the ` +
      `${fmt(MAX_TABLE_CELLS)} cells this export can write.`
    );
  }
  return undefined;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
