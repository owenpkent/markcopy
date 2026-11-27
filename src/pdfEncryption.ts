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
// to, whose dictionary is parsed from at most 8 KiB. Only the last startxref is
// followed; earlier sections of an incrementally updated file are not.
//
// Layout of the dictionary: ISO 32000-1 section 7.6 (/Filter, /V, /R, /Length,
// /P, /CF with /StmF and /StrF) and ISO 32000-2 for revision 6 (AES-256).

const WINDOW = 64 * 1024;
const OBJECT_BYTES = 8 * 1024;
const MAX_DEPTH = 8;
const MAX_TOKENS = 4000;

type Value = number | string | boolean | null | Ref | Name | Value[] | Dict;
interface Ref {
  ref: number;
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
          return { ref: n };
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

/** The trailer dictionary at the last startxref, or undefined. */
function trailerDict(bytes: Uint8Array): Dict | undefined {
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - WINDOW)));
  const at = tail.lastIndexOf('startxref');
  if (at < 0) {
    return undefined;
  }
  const offset = Number(/^\s*(\d{1,15})/.exec(tail.slice(at + 9, at + 40))?.[1]);
  if (!Number.isSafeInteger(offset) || offset >= bytes.length) {
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

/** The dictionary of indirect object `num`, found by its header in the head or tail window. */
function objectDict(bytes: Uint8Array, num: number): Dict | undefined {
  const re = new RegExp(
    `(?:^|[\\0\\t\\n\\f\\r ])${num}[\\0\\t\\n\\f\\r ]+\\d+[\\0\\t\\n\\f\\r ]+obj[\\0\\t\\n\\f\\r ]*<<`,
    'g',
  );
  const windows = [
    latin1(bytes.subarray(Math.max(0, bytes.length - WINDOW))),
    latin1(bytes.subarray(0, Math.min(bytes.length, WINDOW))),
  ];
  for (const text of windows) {
    let last: RegExpExecArray | null = null;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      last = m;
    }
    if (last) {
      const start = text.indexOf('obj', last.index) + 3;
      const v = new Parser(text.slice(start, start + OBJECT_BYTES)).value();
      return isDict(v) ? v : undefined;
    }
  }
  return undefined;
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
    const enc = isRef(entry) ? objectDict(bytes, entry.ref) : isDict(entry) ? entry : undefined;
    if (!enc) {
      return { label: NOT_DETERMINED };
    }
    const handler = nameOf(enc, 'Filter');
    const v = num(enc, 'V');
    const r = num(enc, 'R');
    if (handler !== 'Standard') {
      const found = cipher(enc, v, r);
      return {
        label: handler
          ? `Encrypted: ${handler} security handler, ${found ? found : 'cipher not determined'}`
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
