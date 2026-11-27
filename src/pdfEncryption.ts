// What a PDF declares about its encryption, read from its unencrypted trailer.
//
// It only labels. It never asks for a password, never tries one, never loads a
// key and never decrypts; it says nothing about whether the file is safe or the
// password strong, beyond calling RC4 a legacy scheme. The webview's pdf.js does
// the actual opening. Free of the `vscode` module so it unit-tests directly.
//
// Every read is bounded: the last 64 KiB for `startxref`, 64 KiB at the offset it
// names for the trailer (a classic `trailer` dictionary, or the dictionary of a
// cross-reference stream, PDF 1.5+), and the one indirect object /Encrypt refers
// to, whose dictionary is parsed from at most 8 KiB. That object is found where
// the cross-reference data puts it (a classic table entry, or an entry of an
// unfiltered or Flate cross-reference stream, followed along /Prev for at most 8
// sections), never by searching the file for text shaped like an object header, so
// a comment or stream cannot stand in for it. When the entry cannot be read or
// does not lead to that object, the details are reported as not determined.
//
// Layout of the dictionary: ISO 32000-1 section 7.6 (/Filter, /V, /R, /Length,
// /P, /CF with /StmF and /StrF) and ISO 32000-2 for revision 6 (AES-256).

import { Unzlib } from 'fflate';
import { clip, printable } from './binary/text';

const WINDOW = 64 * 1024;
const OBJECT_BYTES = 8 * 1024;
const MAX_DEPTH = 8;
const MAX_TOKENS = 4000;
// Cross-reference sections followed along /Prev, subsections walked in one table,
// and the most a cross-reference stream may inflate to.
const MAX_SECTIONS = 8;
const MAX_SUBSECTIONS = 1000;
const MAX_XREF_BYTES = 1024 * 1024;

type Value = number | string | boolean | null | Ref | Name | Value[] | Dict;
interface Ref {
  ref: number;
  gen: number;
}
interface Name {
  name: string;
}
interface Dict {
  dict: Map<string, Value>;
}

const isDict = (v: Value | undefined): v is Dict =>
  typeof v === 'object' && v !== null && 'dict' in v;
const isName = (v: Value | undefined): v is Name =>
  typeof v === 'object' && v !== null && 'name' in v;
const isRef = (v: Value | undefined): v is Ref => typeof v === 'object' && v !== null && 'ref' in v;

const WS = /[\0\t\n\f\r ]/;
const DELIM = /[()<>[\]{}/%]/;

/** A small tokenising parser for PDF objects. It stops at its budget and returns what it has. */
class Parser {
  private i = 0;
  private tokens = 0;
  constructor(private readonly s: string) {}

  at(): number {
    return this.i;
  }

  private skip(): void {
    for (;;) {
      while (this.i < this.s.length && WS.test(this.s[this.i])) {
        this.i++;
      }
      if (this.s[this.i] === '%') {
        while (this.i < this.s.length && this.s[this.i] !== '\n' && this.s[this.i] !== '\r') {
          this.i++;
        }
      } else {
        return;
      }
    }
  }

  private word(): string {
    const start = this.i;
    while (this.i < this.s.length && !WS.test(this.s[this.i]) && !DELIM.test(this.s[this.i])) {
      this.i++;
    }
    return this.s.slice(start, this.i);
  }

  value(depth = 0): Value | undefined {
    if (depth > MAX_DEPTH || ++this.tokens > MAX_TOKENS) {
      return undefined;
    }
    this.skip();
    const c = this.s[this.i];
    if (c === undefined) {
      return undefined;
    }
    if (c === '/') {
      this.i++;
      return {
        name: this.word().replace(/#([0-9a-fA-F]{2})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        ),
      };
    }
    if (c === '<' && this.s[this.i + 1] === '<') {
      this.i += 2;
      const dict = new Map<string, Value>();
      for (;;) {
        this.skip();
        if (this.s.startsWith('>>', this.i)) {
          this.i += 2;
          return { dict };
        }
        const key = this.value(depth + 1);
        if (!isName(key)) {
          return { dict };
        }
        const val = this.value(depth + 1);
        if (val === undefined) {
          return { dict };
        }
        dict.set(key.name, val);
      }
    }
    if (c === '<') {
      const end = this.s.indexOf('>', this.i);
      this.i = end < 0 ? this.s.length : end + 1;
      return '';
    }
    if (c === '(') {
      let level = 0;
      while (this.i < this.s.length) {
        const ch = this.s[this.i++];
        if (ch === '\\') {
          this.i++;
        } else if (ch === '(') {
          level++;
        } else if (ch === ')' && --level === 0) {
          break;
        }
      }
      return '';
    }
    if (c === '[') {
      this.i++;
      const list: Value[] = [];
      for (;;) {
        this.skip();
        if (this.s[this.i] === ']') {
          this.i++;
          return list;
        }
        const v = this.value(depth + 1);
        if (v === undefined) {
          return list;
        }
        list.push(v);
      }
    }
    if (c === '>' || c === ']' || c === ')' || c === '{' || c === '}') {
      this.i++;
      return undefined;
    }
    const w = this.word();
    if (w === 'true' || w === 'false') {
      return w === 'true';
    }
    if (w === 'null') {
      return null;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const n = Number(w);
      // "12 0 R" is a reference, so look ahead for a generation and R.
      if (/^\d+$/.test(w)) {
        const save = this.i;
        this.skip();
        const gen = this.word();
        this.skip();
        if (
          /^\d+$/.test(gen) &&
          this.s[this.i] === 'R' &&
          !/[^\0\t\n\f\r ()<>[\]{}/%]/.test(this.s[this.i + 1] ?? ' ')
        ) {
          this.i++;
          return { ref: n, gen: Number(gen) };
        }
        this.i = save;
      }
      return n;
    }
    return w === '' ? undefined : w;
  }
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 8192)));
  }
  return out;
}

/** The offset the last startxref names, or undefined. */
function startXref(bytes: Uint8Array): number | undefined {
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - WINDOW)));
  const at = tail.lastIndexOf('startxref');
  if (at < 0) {
    return undefined;
  }
  const offset = Number(/^\s*(\d{1,15})/.exec(tail.slice(at + 9, at + 40))?.[1]);
  return Number.isSafeInteger(offset) && offset < bytes.length ? offset : undefined;
}

/** The trailer dictionary at the last startxref, or undefined. */
function trailerDict(bytes: Uint8Array): Dict | undefined {
  const offset = startXref(bytes);
  if (offset === undefined) {
    return undefined;
  }
  const section = latin1(bytes.subarray(offset, Math.min(bytes.length, offset + WINDOW)));
  const head = section.trimStart();
  let from: number;
  if (head.startsWith('xref')) {
    from = section.indexOf('trailer');
    if (from < 0) {
      return undefined;
    }
    from += 7;
  } else if (/^\d+\s+\d+\s+obj\b/.test(head)) {
    from = section.indexOf('obj') + 3;
  } else {
    return undefined;
  }
  const parser = new Parser(section.slice(from));
  const v = parser.value();
  return isDict(v) ? v : undefined;
}

const slice = (bytes: Uint8Array, from: number, length: number): string =>
  latin1(bytes.subarray(from, Math.min(bytes.length, from + length)));

/**
 * What one cross-reference section says about an object: the byte offset of its
 * object when it is in use, null when it is free or lives in an object stream,
 * undefined when the section does not list it. `prev` is the older section.
 */
interface Section {
  entry: number | null | undefined;
  prev: number | undefined;
}

const prevOf = (d: Dict): number | undefined => {
  const p = num(d, 'Prev');
  return p !== undefined && Number.isSafeInteger(p) && p >= 0 ? p : undefined;
};

/**
 * A classic table: "xref", subsections of "first count" and then 20-byte
 * entries, "trailer". The one entry wanted is read by position, so a table
 * larger than the window costs the same as a small one. Undefined when the
 * section is not a table or an entry is not in the standard 20-byte shape.
 */
function classicSection(bytes: Uint8Array, offset: number, want: number): Section | undefined {
  const start = /^[\0\t\n\f\r ]*xref/.exec(slice(bytes, offset, 32));
  if (!start) {
    return undefined;
  }
  let pos = offset + start[0].length;
  let entry: number | null | undefined;
  for (let k = 0; ; k++) {
    if (k >= MAX_SUBSECTIONS) {
      return undefined;
    }
    const head = slice(bytes, pos, 64);
    const trailer = /^[\0\t\n\f\r ]*trailer/.exec(head);
    if (trailer) {
      pos += trailer[0].length;
      break;
    }
    const sub = /^[\0\t\n\f\r ]*(\d{1,10}) +(\d{1,10})[ \t]*(?:\r\n|\n|\r)/.exec(head);
    if (!sub) {
      return undefined;
    }
    const first = Number(sub[1]);
    const count = Number(sub[2]);
    const entries = pos + sub[0].length;
    if (entry === undefined && want >= first && want < first + count) {
      const e = /^(\d{10}) (\d{5}) ([nf])/.exec(slice(bytes, entries + (want - first) * 20, 20));
      if (!e) {
        return undefined;
      }
      entry = e[3] === 'n' ? Number(e[1]) : null;
    }
    pos = entries + count * 20;
  }
  const v = new Parser(slice(bytes, pos, WINDOW)).value();
  return { entry, prev: isDict(v) ? prevOf(v) : undefined };
}

/** Deflate-decoded `data`, or undefined when it is damaged or expands past `max`. */
function inflate(data: Uint8Array, max: number): Uint8Array | undefined {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = new Unzlib((chunk) => {
    total += chunk.length;
    if (total <= max) {
      chunks.push(chunk);
    }
  });
  try {
    // Small slices, so one slice cannot expand far past the cap before it is checked.
    for (let i = 0; i < data.length && total <= max; i += 1024) {
      stream.push(data.subarray(i, i + 1024), i + 1024 >= data.length);
    }
  } catch {
    return undefined;
  }
  if (total > max) {
    return undefined;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Undoes a PNG predictor (/Predictor 10 to 15) for the None, Sub and Up row types; else undefined. */
function unpredict(data: Uint8Array, columns: number): Uint8Array | undefined {
  const rows = Math.floor(data.length / (columns + 1));
  const out = new Uint8Array(rows * columns);
  for (let r = 0; r < rows; r++) {
    const tag = data[r * (columns + 1)];
    for (let c = 0; c < columns; c++) {
      const raw = data[r * (columns + 1) + 1 + c];
      const left = c > 0 ? out[r * columns + c - 1] : 0;
      const up = r > 0 ? out[(r - 1) * columns + c] : 0;
      if (tag === 0) {
        out[r * columns + c] = raw;
      } else if (tag === 1) {
        out[r * columns + c] = (raw + left) & 0xff;
      } else if (tag === 2) {
        out[r * columns + c] = (raw + up) & 0xff;
      } else {
        return undefined;
      }
    }
  }
  return out;
}

/**
 * A cross-reference stream (PDF 1.5+): an object whose stream is a table of
 * fixed-width entries. Only an unfiltered or Flate stream that fits in the
 * window is read; undefined for anything else.
 */
function streamSection(bytes: Uint8Array, offset: number, want: number): Section | undefined {
  const text = slice(bytes, offset, WINDOW);
  const header = /^[\0\t\n\f\r ]*\d+[\0\t\n\f\r ]+\d+[\0\t\n\f\r ]+obj\b/.exec(text);
  if (!header) {
    return undefined;
  }
  const parser = new Parser(text.slice(header[0].length));
  const dict = parser.value();
  if (!isDict(dict) || nameOf(dict, 'Type') !== 'XRef') {
    return undefined;
  }
  const after = header[0].length + parser.at();
  const keyword = /^[\0\t\n\f\r ]*stream(?:\r\n|\n)/.exec(text.slice(after, after + 32));
  const length = num(dict, 'Length');
  if (!keyword || length === undefined || !Number.isSafeInteger(length) || length < 0) {
    return undefined;
  }
  const from = after + keyword[0].length;
  if (from + length > text.length) {
    return undefined;
  }
  let data: Uint8Array | undefined = bytes.subarray(offset + from, offset + from + length);
  const filter = dict.dict.get('Filter');
  if (isName(filter) && filter.name === 'FlateDecode') {
    data = inflate(data, MAX_XREF_BYTES);
  } else if (filter !== undefined) {
    return undefined;
  }
  const parms = dict.dict.get('DecodeParms');
  const predictor = isDict(parms) ? (num(parms, 'Predictor') ?? 1) : 1;
  if (data && predictor >= 10 && predictor <= 15) {
    const columns = isDict(parms) ? num(parms, 'Columns') : undefined;
    data =
      columns !== undefined && Number.isSafeInteger(columns) && columns > 0 && columns <= 64
        ? unpredict(data, columns)
        : undefined;
  } else if (predictor !== 1) {
    return undefined;
  }
  const w = dict.dict.get('W');
  if (!data || !Array.isArray(w) || w.length !== 3 || !w.every((x) => Number.isSafeInteger(x))) {
    return undefined;
  }
  const [w0, w1, w2] = w as number[];
  if ([w0, w1, w2].some((x) => x < 0 || x > 6)) {
    return undefined;
  }
  const size = num(dict, 'Size');
  const indexValue = dict.dict.get('Index');
  const index: number[] =
    Array.isArray(indexValue) && indexValue.every((x) => Number.isSafeInteger(x))
      ? (indexValue as number[])
      : size !== undefined
        ? [0, size]
        : [];
  const width = w0 + w1 + w2;
  let row = 0;
  let entry: number | null | undefined;
  for (let k = 0; k + 1 < index.length && width > 0; k += 2) {
    const first = index[k];
    const count = index[k + 1];
    if (want >= first && want < first + count && entry === undefined) {
      const at = (row + (want - first)) * width;
      if (at + width > data.length) {
        return undefined;
      }
      const field = (from: number, n: number): number => {
        let v = 0;
        for (let b = 0; b < n; b++) {
          v = v * 256 + data[at + from + b];
        }
        return v;
      };
      const type = w0 === 0 ? 1 : field(0, w0);
      entry = type === 1 ? field(w0, w1) : null;
    }
    row += count;
  }
  return { entry, prev: prevOf(dict) };
}

/**
 * Where indirect object `want` starts, by the cross-reference data from the last
 * startxref back along /Prev, or undefined when that cannot be established. The
 * object is taken from where the file says it is, never from text that merely
 * looks like an object header elsewhere in the file.
 */
function locate(bytes: Uint8Array, want: number): number | undefined {
  const seen = new Set<number>();
  let offset = startXref(bytes);
  while (offset !== undefined && seen.size < MAX_SECTIONS && !seen.has(offset)) {
    seen.add(offset);
    const section = classicSection(bytes, offset, want) ?? streamSection(bytes, offset, want);
    if (!section) {
      return undefined;
    }
    if (section.entry !== undefined) {
      return section.entry ?? undefined;
    }
    offset = section.prev;
  }
  return undefined;
}

/** The dictionary of the indirect object a reference names, read where the cross-reference data puts it. */
function objectDict(bytes: Uint8Array, ref: Ref): Dict | undefined {
  const at = locate(bytes, ref.ref);
  if (at === undefined) {
    return undefined;
  }
  const text = slice(bytes, at, OBJECT_BYTES + 64);
  const m = /^[\0\t\n\f\r ]*(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj\b/.exec(text);
  if (!m || Number(m[1]) !== ref.ref || Number(m[2]) !== ref.gen) {
    return undefined;
  }
  const v = new Parser(text.slice(m[0].length, m[0].length + OBJECT_BYTES)).value();
  return isDict(v) ? v : undefined;
}

export interface PdfEncryption {
  /** "Encrypted: AES-256 (standard security handler, revision 6)". */
  label: string;
  /** "The file restricts: printing, copying text. ..." when the handler declares permissions. */
  permissions?: string;
}

const NOT_DETERMINED = 'Encrypted: the encryption details were not determined.';

const num = (d: Dict, key: string): number | undefined => {
  const v = d.dict.get(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};
const nameOf = (d: Dict, key: string): string | undefined => {
  const v = d.dict.get(key);
  return isName(v) ? v.name : undefined;
};

/** The cipher the dictionary declares for streams (or strings), or undefined. */
function cipher(enc: Dict, v: number | undefined, r: number | undefined): string | undefined {
  const rc4 = (bits: number) => `RC4 ${bits}-bit`;
  if (v === 1 || (v === undefined && r === 2)) {
    return rc4(40);
  }
  if (v === 2) {
    const length = num(enc, 'Length');
    return rc4(length && length >= 40 && length <= 128 && length % 8 === 0 ? length : 40);
  }
  if (v === 4 || v === 5) {
    const cf = enc.dict.get('CF');
    const filters = isDict(cf) ? cf : undefined;
    for (const key of ['StmF', 'StrF']) {
      const chosen = nameOf(enc, key);
      if (!chosen || chosen === 'Identity') {
        continue;
      }
      const entry = filters?.dict.get(chosen);
      const method = isDict(entry) ? nameOf(entry, 'CFM') : undefined;
      if (method === 'AESV2') {
        return 'AES-128';
      }
      if (method === 'AESV3') {
        return 'AES-256';
      }
      if (method === 'V2') {
        const length = isDict(entry) ? num(entry, 'Length') : undefined;
        // CF /Length is in bytes by the standard, though some writers use bits.
        const bits = length === undefined ? 128 : length <= 32 ? length * 8 : length;
        return rc4(bits >= 40 && bits <= 128 ? bits : 128);
      }
      return undefined;
    }
  }
  return undefined;
}

// Bits of /P (1-based, ISO 32000-1 table 22) and the words for what a clear bit restricts.
const PERMISSIONS: Array<[bit: number, words: string, revision3: boolean]> = [
  [3, 'printing', false],
  [4, 'modifying content', false],
  [5, 'copying text', false],
  [6, 'adding or editing annotations', false],
  [9, 'filling in forms', true],
  [10, 'extracting text for accessibility', true],
  [11, 'assembling pages', true],
  [12, 'high-quality printing', true],
];

function permissions(p: number, r: number | undefined): string {
  const bits = p | 0;
  const restricted = PERMISSIONS.filter(
    ([bit, , rev3]) => (!rev3 || (r ?? 0) >= 3) && !(bits & (1 << (bit - 1))),
  )
    // From revision 3, form filling is also allowed by bit 6 (annotations).
    .filter(([bit]) => !(bit === 9 && (r ?? 0) >= 3 && (bits & (1 << 5)) !== 0))
    // High-quality printing is moot when printing is already restricted.
    .filter(([bit]) => !(bit === 12 && !(bits & 4)))
    .map(([, words]) => words);
  const tail = ' Whether a viewer honours this is up to the viewer.';
  return restricted.length === 0
    ? `The file declares no restrictions on printing, copying or editing.${tail}`
    : `The file restricts: ${restricted.join(', ')}.${tail}`;
}

/** What the PDF declares about its encryption, or undefined when it declares none. Never throws. */
export function readPdfEncryption(bytes: Uint8Array): PdfEncryption | undefined {
  try {
    const trailer = trailerDict(bytes);
    const entry = trailer?.dict.get('Encrypt');
    if (entry === undefined || entry === null) {
      return undefined;
    }
    const enc = isRef(entry) ? objectDict(bytes, entry) : isDict(entry) ? entry : undefined;
    if (!enc) {
      return { label: NOT_DETERMINED };
    }
    const handler = nameOf(enc, 'Filter');
    const v = num(enc, 'V');
    const r = num(enc, 'R');
    if (handler !== 'Standard') {
      // The handler's name is the file's own text and ends up in the label: clean and bound it.
      const shown = clip(printable(handler ?? '').trim(), 60);
      const found = cipher(enc, v, r);
      return {
        label: shown
          ? `Encrypted: ${shown} security handler, ${found ? found : 'cipher not determined'}`
          : NOT_DETERMINED,
      };
    }
    const found = cipher(enc, v, r);
    const revision = r !== undefined ? `revision ${r}` : undefined;
    let label: string;
    if (!found) {
      label = `Encrypted: cipher not determined (standard security handler${revision ? `, ${revision}` : ''})`;
    } else if (found.startsWith('RC4')) {
      label = `Encrypted: ${found} (${['legacy', revision].filter(Boolean).join(', ')})`;
    } else {
      label = `Encrypted: ${found} (${['standard security handler', revision].filter(Boolean).join(', ')})`;
    }
    const p = num(enc, 'P');
    return { label, permissions: p === undefined ? undefined : permissions(p, r) };
  } catch {
    return { label: NOT_DETERMINED };
  }
}
