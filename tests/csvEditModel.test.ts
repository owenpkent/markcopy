import { describe, it, expect } from 'vitest';
import {
  applyCsvEdits,
  cellEdit,
  formatField,
  gridEdits,
  isGridOp,
  parseDelimited,
  type CsvCellEdit,
  type GridOp,
} from '../src/csv';

// Apply an edit the way the host does, so these tests assert on the document
// text that would actually land on disk.
function apply(text: string, edit: CsvCellEdit | null): string {
  if (!edit) {
    throw new Error('expected an edit');
  }
  return text.slice(0, edit.start) + edit.text + text.slice(edit.end);
}

// The same, for the several edits a whole-row or whole-column change makes.
// Applied back to front so an earlier edit cannot shift a later one's offsets.
function applyAll(text: string, edits: CsvCellEdit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((out, edit) => out.slice(0, edit.start) + edit.text + out.slice(edit.end), text);
}

const slice = (text: string, delimiter: string, row: number, col: number): string => {
  const span = parseDelimited(text, delimiter).records[row].spans[col];
  return text.slice(span.start, span.end);
};

describe('field spans', () => {
  it('cover each field exactly', () => {
    const text = 'a,bb,ccc';
    expect(slice(text, ',', 0, 0)).toBe('a');
    expect(slice(text, ',', 0, 1)).toBe('bb');
    expect(slice(text, ',', 0, 2)).toBe('ccc');
  });

  it('include the surrounding quotes', () => {
    const text = 'a,"b,c",d';
    expect(slice(text, ',', 0, 1)).toBe('"b,c"');
  });

  it('cover empty fields as zero-width spans', () => {
    const text = 'a,,c';
    expect(slice(text, ',', 0, 1)).toBe('');
  });

  it('stop at the line ending, not past it', () => {
    const text = 'a,b\r\nc,d';
    expect(slice(text, ',', 0, 1)).toBe('b');
    expect(slice(text, ',', 1, 0)).toBe('c');
  });

  it('span a quoted field that contains newlines', () => {
    const text = 'a,"x\ny",b';
    expect(slice(text, ',', 0, 1)).toBe('"x\ny"');
  });

  it('are not shifted by a stripped BOM', () => {
    const text = '﻿id,name';
    expect(slice(text, ',', 0, 0)).toBe('id');
    expect(slice(text, ',', 0, 1)).toBe('name');
  });

  it('line up one-to-one with the parsed cells', () => {
    const { records } = parseDelimited('a,"b,c",,d\n1,2,3,4', ',');
    for (const record of records) {
      expect(record.spans).toHaveLength(record.cells.length);
    }
  });
});

describe('formatField', () => {
  it('leaves a plain value bare', () => {
    expect(formatField('abc', ',')).toBe('abc');
  });

  it('quotes a value holding the delimiter', () => {
    expect(formatField('a,b', ',')).toBe('"a,b"');
    expect(formatField('a,b', '\t')).toBe('a,b');
    expect(formatField('a\tb', '\t')).toBe('"a\tb"');
  });

  it('doubles inner quotes', () => {
    expect(formatField('say "hi"', ',')).toBe('"say ""hi"""');
  });

  it('quotes a value holding a newline', () => {
    expect(formatField('a\nb', ',')).toBe('"a\nb"');
  });

  it('keeps an empty value empty', () => {
    expect(formatField('', ',')).toBe('');
  });

  it('round-trips through the parser', () => {
    for (const value of ['plain', 'a,b', 'say "hi"', 'two\nlines', '', ' padded ']) {
      const { records } = parseDelimited(formatField(value, ','), ',');
      expect(records[0]?.cells[0] ?? '').toBe(value);
    }
  });
});

describe('cellEdit', () => {
  const text = 'name,qty,note\nWidget,3,first\nGadget,12,second';

  it('replaces just the addressed field', () => {
    expect(apply(text, cellEdit(text, ',', 1, 1, '99'))).toBe(
      'name,qty,note\nWidget,99,first\nGadget,12,second',
    );
  });

  it('edits the header row', () => {
    expect(apply(text, cellEdit(text, ',', 0, 0, 'product'))).toBe(
      'product,qty,note\nWidget,3,first\nGadget,12,second',
    );
  });

  it('edits the last field of the last row', () => {
    expect(apply(text, cellEdit(text, ',', 2, 2, 'last'))).toBe(
      'name,qty,note\nWidget,3,first\nGadget,12,last',
    );
  });

  it('quotes a new value that needs it', () => {
    expect(apply(text, cellEdit(text, ',', 1, 0, 'Widget, large'))).toBe(
      'name,qty,note\n"Widget, large",3,first\nGadget,12,second',
    );
  });

  it('drops quoting a value no longer needs', () => {
    const quoted = 'a,"b,c",d';
    expect(apply(quoted, cellEdit(quoted, ',', 0, 1, 'plain'))).toBe('a,plain,d');
  });

  it('clears a field to empty', () => {
    expect(apply(text, cellEdit(text, ',', 1, 2, ''))).toBe(
      'name,qty,note\nWidget,3,\nGadget,12,second',
    );
  });

  // The whole reason the parser tracks spans: an edit must not reformat the
  // rest of the file, including quoting we would not have chosen ourselves.
  it('leaves every other field byte-for-byte alone', () => {
    const fussy = 'a,"unnecessarily quoted",c\r\n"x","y","z"';
    const out = apply(fussy, cellEdit(fussy, ',', 1, 1, 'edited'));
    expect(out).toBe('a,"unnecessarily quoted",c\r\n"x",edited,"z"');
  });

  it('preserves CRLF line endings', () => {
    const crlf = 'a,b\r\nc,d\r\n';
    expect(apply(crlf, cellEdit(crlf, ',', 1, 0, 'C'))).toBe('a,b\r\nC,d\r\n');
  });

  it('edits a row that follows a multi-line quoted field', () => {
    const multi = 'h1,h2\n"one\ntwo",b\nc,d';
    expect(apply(multi, cellEdit(multi, ',', 3, 1, 'D'))).toBe('h1,h2\n"one\ntwo",b\nc,D');
  });

  it('replaces a multi-line field without disturbing the rows around it', () => {
    const multi = 'h1,h2\n"one\ntwo",b\nc,d';
    expect(apply(multi, cellEdit(multi, ',', 1, 0, 'flat'))).toBe('h1,h2\nflat,b\nc,d');
  });

  it('can introduce a newline into a cell', () => {
    const out = apply(text, cellEdit(text, ',', 1, 2, 'line1\nline2'));
    expect(out).toBe('name,qty,note\nWidget,3,"line1\nline2"\nGadget,12,second');
    // And the file still parses back to the same shape.
    const { records } = parseDelimited(out, ',');
    expect(records).toHaveLength(3);
    expect(records[1].cells[2]).toBe('line1\nline2');
  });

  it('pads a short row out to the edited column', () => {
    const ragged = 'a,b,c\n1\n2,3,4';
    expect(apply(ragged, cellEdit(ragged, ',', 1, 2, 'z'))).toBe('a,b,c\n1,,z\n2,3,4');
  });

  it('appends a single field when the row is short by one', () => {
    const ragged = 'a,b\n1';
    expect(apply(ragged, cellEdit(ragged, ',', 1, 1, 'y'))).toBe('a,b\n1,y');
  });

  it('works with a tab delimiter', () => {
    const tsv = 'a\tb\n1\t2';
    expect(apply(tsv, cellEdit(tsv, '\t', 1, 1, 'x,y'))).toBe('a\tb\n1\tx,y');
  });

  it('returns null for a line that holds no record', () => {
    expect(cellEdit(text, ',', 99, 0, 'x')).toBeNull();
    expect(cellEdit(text, ',', 1, -1, 'x')).toBeNull();
  });

  it('survives repeated edits to the same file', () => {
    let out = text;
    out = apply(out, cellEdit(out, ',', 1, 0, 'A,1'));
    out = apply(out, cellEdit(out, ',', 1, 1, 'B"2'));
    out = apply(out, cellEdit(out, ',', 2, 2, 'C\n3'));
    const { records } = parseDelimited(out, ',');
    expect(records[1].cells).toEqual(['A,1', 'B"2', 'first']);
    expect(records[2].cells).toEqual(['Gadget', '12', 'C\n3']);
  });
});

// Rows and columns, as the grid's Insert and Delete menus ask for them. Every
// case asserts on the document text the host would write, because that is the
// only thing the reader gets to keep.
describe('gridEdits: rows', () => {
  const text = 'name,qty\nWidget,3\nGadget,12\n';

  it('opens a blank row above the addressed one', () => {
    expect(applyAll(text, gridEdits(text, ',', 'insertRowAbove', { line: 1, column: 0 }))).toBe(
      'name,qty\n,\nWidget,3\nGadget,12\n',
    );
  });

  it('opens a blank row below the addressed one', () => {
    expect(applyAll(text, gridEdits(text, ',', 'insertRowBelow', { line: 1, column: 0 }))).toBe(
      'name,qty\nWidget,3\n,\nGadget,12\n',
    );
  });

  it('opens a row above the header', () => {
    expect(applyAll(text, gridEdits(text, ',', 'insertRowAbove', { line: 0, column: 0 }))).toBe(
      ',\nname,qty\nWidget,3\nGadget,12\n',
    );
  });

  it('opens a row below the last one of a file that does not end in a newline', () => {
    const bare = 'a,b\nc,d';
    expect(applyAll(bare, gridEdits(bare, ',', 'insertRowBelow', { line: 1, column: 0 }))).toBe(
      'a,b\nc,d\n,',
    );
  });

  it('writes the line ending it is given', () => {
    const crlf = 'a,b\r\nc,d\r\n';
    expect(
      applyAll(crlf, gridEdits(crlf, ',', 'insertRowBelow', { line: 0, column: 0 }, '\r\n')),
    ).toBe('a,b\r\n,\r\nc,d\r\n');
  });

  it('makes the new row as wide as the row it lands next to, not the widest', () => {
    const ragged = 'a,b,c,d\ne,f\n';
    expect(applyAll(ragged, gridEdits(ragged, ',', 'insertRowBelow', { line: 1, column: 0 }))).toBe(
      'a,b,c,d\ne,f\n,\n',
    );
  });

  it('gives a single-column file a single empty field', () => {
    const one = 'a\nb\n';
    expect(applyAll(one, gridEdits(one, ',', 'insertRowAbove', { line: 1, column: 0 }))).toBe(
      'a\n\nb\n',
    );
  });

  it('deletes a row along with the line ending that closes it', () => {
    expect(applyAll(text, gridEdits(text, ',', 'deleteRow', { line: 1, column: 0 }))).toBe(
      'name,qty\nGadget,12\n',
    );
  });

  it('deletes a CRLF row without leaving a stray line', () => {
    const crlf = 'a,b\r\nc,d\r\ne,f\r\n';
    expect(applyAll(crlf, gridEdits(crlf, ',', 'deleteRow', { line: 1, column: 0 }))).toBe(
      'a,b\r\ne,f\r\n',
    );
  });

  it('takes the line ending in front when the last row has none of its own', () => {
    const bare = 'a,b\nc,d';
    expect(applyAll(bare, gridEdits(bare, ',', 'deleteRow', { line: 1, column: 0 }))).toBe('a,b');
  });

  it('deletes a row that spans several lines as one row', () => {
    const multi = 'h1,h2\n"one\ntwo",b\nc,d';
    expect(applyAll(multi, gridEdits(multi, ',', 'deleteRow', { line: 1, column: 0 }))).toBe(
      'h1,h2\nc,d',
    );
  });

  it('empties a file whose only row is deleted', () => {
    expect(applyAll('a,b', gridEdits('a,b', ',', 'deleteRow', { line: 0, column: 0 }))).toBe('');
  });

  it('does nothing for a line that holds no record', () => {
    expect(gridEdits(text, ',', 'deleteRow', { line: 99, column: 0 })).toEqual([]);
    expect(gridEdits(text, ',', 'insertRowAbove', { line: 99, column: 0 })).toEqual([]);
  });
});

describe('gridEdits: columns', () => {
  const text = 'name,qty\nWidget,3\nGadget,12\n';

  it('opens an empty column to the left of the addressed one', () => {
    expect(applyAll(text, gridEdits(text, ',', 'insertColumnLeft', { line: 0, column: 1 }))).toBe(
      'name,,qty\nWidget,,3\nGadget,,12\n',
    );
  });

  it('opens an empty column to the left of the first one', () => {
    expect(applyAll(text, gridEdits(text, ',', 'insertColumnLeft', { line: 0, column: 0 }))).toBe(
      ',name,qty\n,Widget,3\n,Gadget,12\n',
    );
  });

  it('opens an empty column to the right of the addressed one', () => {
    expect(applyAll(text, gridEdits(text, ',', 'insertColumnRight', { line: 0, column: 0 }))).toBe(
      'name,,qty\nWidget,,3\nGadget,,12\n',
    );
  });

  it('appends a column past the last one, where there is no field to shift', () => {
    expect(applyAll(text, gridEdits(text, ',', 'insertColumnRight', { line: 0, column: 1 }))).toBe(
      'name,qty,\nWidget,3,\nGadget,12,\n',
    );
  });

  it('leaves a short row alone when it has nothing to shift', () => {
    const ragged = 'a,b,c\nd\ne,f,g';
    expect(
      applyAll(ragged, gridEdits(ragged, ',', 'insertColumnRight', { line: 0, column: 2 })),
    ).toBe('a,b,c,\nd\ne,f,g,');
  });

  // A record takes part only if it reaches the column being addressed. Rows that
  // stop short of it have no field next to the new one, so there is nothing to
  // shift and nothing to append: they keep their bytes.
  it('leaves a row that stops one short of the new column alone', () => {
    const ragged = 'a,b,c\nd,e\n';
    expect(
      applyAll(ragged, gridEdits(ragged, ',', 'insertColumnLeft', { line: 0, column: 2 })),
    ).toBe('a,b,,c\nd,e\n');
  });

  it('appends to a short row only where the new column is next to a field it has', () => {
    // Column 1 is the last field of the short row, so a column to its right does
    // belong to it; the row of one field never reaches column 1 at all.
    const ragged = 'a,b,c\nd,e\nf\n';
    expect(
      applyAll(ragged, gridEdits(ragged, ',', 'insertColumnRight', { line: 0, column: 1 })),
    ).toBe('a,b,,c\nd,e,\nf\n');
  });

  it('reaches every row of the file, not just the one addressed', () => {
    const many = Array.from({ length: 50 }, (_, i) => `${i},x`).join('\n');
    const out = applyAll(many, gridEdits(many, ',', 'insertColumnLeft', { line: 0, column: 0 }));
    expect(parseDelimited(out, ',').records.every((r) => r.cells.length === 3)).toBe(true);
  });

  it('deletes a column and the delimiter behind it', () => {
    expect(applyAll(text, gridEdits(text, ',', 'deleteColumn', { line: 0, column: 0 }))).toBe(
      'qty\n3\n12\n',
    );
  });

  it('deletes the last column by taking the delimiter in front of it', () => {
    expect(applyAll(text, gridEdits(text, ',', 'deleteColumn', { line: 0, column: 1 }))).toBe(
      'name\nWidget\nGadget\n',
    );
  });

  it('skips the rows that never reached the deleted column', () => {
    const ragged = 'a,b,c\nd\ne,f,g';
    expect(applyAll(ragged, gridEdits(ragged, ',', 'deleteColumn', { line: 0, column: 2 }))).toBe(
      'a,b\nd\ne,f',
    );
  });

  it('leaves every surviving field byte-for-byte alone, quoting included', () => {
    const fussy = '"a,1",b,"c"\n"x""y",d,e\n';
    expect(applyAll(fussy, gridEdits(fussy, ',', 'insertColumnLeft', { line: 0, column: 1 }))).toBe(
      '"a,1",,b,"c"\n"x""y",,d,e\n',
    );
  });

  it('splits on the delimiter it is given', () => {
    const tsv = 'a\tb\nc\td\n';
    expect(applyAll(tsv, gridEdits(tsv, '\t', 'insertColumnRight', { line: 0, column: 0 }))).toBe(
      'a\t\tb\nc\t\td\n',
    );
  });

  it('leaves empty rows behind when the only column goes', () => {
    // Which is why the grid does not offer it: there would be no column left to
    // right-click afterwards. The model still answers, rather than inventing a
    // rule of its own about it.
    const one = 'a\nb\n';
    expect(applyAll(one, gridEdits(one, ',', 'deleteColumn', { line: 0, column: 0 }))).toBe('\n\n');
  });

  it('does nothing without a column to address', () => {
    expect(gridEdits(text, ',', 'deleteColumn', { line: 0, column: -1 })).toEqual([]);
    expect(gridEdits(text, ',', 'insertColumnLeft', { line: 0, column: -1 })).toEqual([]);
  });

  it('does nothing to an empty document', () => {
    expect(gridEdits('', ',', 'insertColumnLeft', { line: 0, column: 0 })).toEqual([]);
  });
});

// The host folds a very large operation into one whole-document replacement
// rather than handing applyEdit a range per record. That is only safe if
// applying the edits here gives byte-for-byte what applying them one at a time
// would, so each case is checked against applyAll, which works back to front
// from the other end and shares no code with it.
describe('applyCsvEdits', () => {
  const cases: Array<[string, GridOp, { line: number; column: number }]> = [
    ['a,b,c\nd,e,f\ng,h,i\n', 'insertColumnLeft', { line: 0, column: 1 }],
    ['a,b,c\nd,e,f\ng,h,i\n', 'insertColumnRight', { line: 0, column: 2 }],
    ['a,b,c\nd,e,f\ng,h,i\n', 'deleteColumn', { line: 0, column: 1 }],
    ['a,b,c\nd,e,f\ng,h,i\n', 'deleteColumn', { line: 0, column: 2 }],
    ['a,b,c\r\nd,e,f\r\n', 'deleteRow', { line: 1, column: 0 }],
    ['a,b,c\nd\ne,f,g', 'insertColumnRight', { line: 0, column: 1 }],
    ['"a,1",b\n"x""y",d\n', 'insertColumnLeft', { line: 0, column: 1 }],
  ];

  for (const [text, op, ref] of cases) {
    it(`agrees with applying ${op} one edit at a time`, () => {
      const edits = gridEdits(text, ',', op, ref);
      expect(applyCsvEdits(text, edits)).toBe(applyAll(text, edits));
    });
  }

  it('returns the text untouched when there is nothing to do', () => {
    expect(applyCsvEdits('a,b\n', [])).toBe('a,b\n');
  });
});

describe('isGridOp', () => {
  it('accepts every operation gridEdits handles', () => {
    const ops = [
      'insertRowAbove',
      'insertRowBelow',
      'deleteRow',
      'insertColumnLeft',
      'insertColumnRight',
      'deleteColumn',
    ];
    expect(ops.every(isGridOp)).toBe(true);
  });

  it('rejects anything else a webview message could carry', () => {
    expect(isGridOp('dropTable')).toBe(false);
    expect(isGridOp(undefined)).toBe(false);
    expect(isGridOp(1)).toBe(false);
  });
});
