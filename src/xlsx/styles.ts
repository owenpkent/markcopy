// Resolving a cell's style index to a number format code, and applying it.
//
// This is where previews classically go wrong, in two ways:
//
// 1. Resolving `@s` through the wrong table. A cell's `s` indexes `<cellXfs>`,
//    the formatting records. `<cellStyleXfs>` is the named-style table those
//    records may inherit from, and reading it instead silently returns some other
//    workbook's formats.
//
// 2. Deciding date-ness from the format id. The widespread "14-22 and 165-180
//    mean date" heuristic is wrong in both directions: it misses builtins 45, 46,
//    and 47 (elapsed time) and the 27-36 / 50-58 East Asian date blocks, and
//    anything from 164 up is custom, meaning whatever that file says it means. So
//    ids here only ever resolve to a format *code*, and the code decides.
import { attr, intAttr, walkXml } from './xml';
import { format as formatNumber, isDateFormat } from 'numfmt';

/** The builtin number formats a file may reference without declaring. */
const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'mm-dd-yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
};

export interface Styles {
  /** Format code per cellXfs index. */
  codes: string[];
}

export function readStyles(xml: string | undefined): Styles {
  if (xml === undefined) {
    return { codes: [] };
  }

  const custom = new Map<number, string>();
  const codes: string[] = [];
  // `<xf>` appears in both tables, so track which one we are inside. Without
  // this, cellStyleXfs entries land in the array cells index into.
  let inCellXfs = false;

  walkXml(xml, {
    open(name, attrs) {
      if (name === 'numFmt') {
        const id = intAttr(attrs, 'numFmtId');
        const code = attr(attrs, 'formatCode');
        if (id !== undefined && code !== undefined) {
          custom.set(id, code);
        }
      } else if (name === 'cellXfs') {
        inCellXfs = true;
      } else if (name === 'xf' && inCellXfs) {
        const id = intAttr(attrs, 'numFmtId') ?? 0;
        codes.push(custom.get(id) ?? BUILTIN_FORMATS[id] ?? 'General');
      }
    },
    close(name) {
      if (name === 'cellXfs') {
        inCellXfs = false;
      }
    },
  });

  return { codes };
}

/**
 * The format code for a cell's style index.
 *
 * `<numFmts>` may be declared after `<cellXfs>` in the part, so a code captured
 * during the walk above can be a builtin standing in for a custom format. In
 * practice styles.xml always orders them the other way round, and this stays a
 * lookup rather than a second pass.
 */
export function formatCodeFor(styles: Styles, styleIndex: number | undefined): string {
  if (styleIndex === undefined) {
    return 'General';
  }
  return styles.codes[styleIndex] ?? 'General';
}

/**
 * The 1904 date system counts from 1904-01-01 instead of 1899-12-30, which is
 * exactly 1462 days later, so a 1904 serial is its 1900 equivalent minus 1462.
 */
const DATE_1904_OFFSET = 1462;

/**
 * Render a numeric cell the way Excel would display it.
 *
 * Falls back to the plain number whenever the format cannot be applied, which is
 * always better than showing the reader an error where a value should be.
 * numfmt throws on a malformed format code, and workbooks do contain them.
 */
export function formatValue(value: number, code: string, date1904: boolean): string {
  if (code === 'General' || code === '') {
    return generalNumber(value);
  }
  // The 1904 shift applies to serials, and only to serials. A workbook in the
  // 1904 system still holds ordinary numbers, and moving a currency figure by
  // 1462 because the file happens to use that date system would be nonsense.
  // Note this deliberately leaves `leap1900` at its default: the phantom
  // 1900-02-29 is real data in a 1900-system file (Excel wrote it, and serial 60
  // means that day to every reader of the file), so a preview reproduces it
  // rather than silently correcting the value by a day.
  const serial = date1904 && isDateCode(code) ? value + DATE_1904_OFFSET : value;
  try {
    const text = formatNumber(code, serial);
    return typeof text === 'string' ? text : generalNumber(value);
  } catch {
    return generalNumber(value);
  }
}

/** Whether a format code makes its value a date or time, per the code itself. */
export function isDateCode(code: string): boolean {
  try {
    return isDateFormat(code);
  } catch {
    return false;
  }
}

/**
 * A number under the `General` format.
 *
 * Excel's General is a width-sensitive algorithm involving the column width,
 * which a preview that re-flows columns cannot reproduce and should not pretend
 * to. JavaScript's own shortest-round-trip output is the honest approximation,
 * except for exponent formatting, where `1e+21` is not something a reader expects
 * in a cell.
 */
function generalNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : '';
}
