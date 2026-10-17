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
  if (!/^\d{1,9}$/.test(trimmed)) {
    return 1;
  }
  const n = Number.parseInt(trimmed, 10);
  return n < 1 ? 1 : Math.min(n, max);
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
