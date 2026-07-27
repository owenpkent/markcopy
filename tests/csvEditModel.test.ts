import { describe, it, expect } from 'vitest';
import { cellEdit, formatField, parseDelimited, type CsvCellEdit } from '../src/csv';

// Apply an edit the way the host does, so these tests assert on the document
// text that would actually land on disk.
function apply(text: string, edit: CsvCellEdit | null): string {
  if (!edit) {
    throw new Error('expected an edit');
  }
  return text.slice(0, edit.start) + edit.text + text.slice(edit.end);
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
