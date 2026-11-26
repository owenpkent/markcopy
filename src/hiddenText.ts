// Finding text that is in the file but invisible on screen.
//
// A README, a rules file or a source file can carry characters that no editor
// or preview draws: Unicode tag characters and variation selectors that spell
// out ASCII or bytes, zero-width characters, bidirectional controls and Hangul
// fillers. The preview shows nothing for them and every copy action carries
// them to the paste target, an AI chat included. This module finds them so the
// preview can say so.
//
// Pure: no `vscode`, no DOM. Written against code points, so the source holds
// no invisible character of its own and no escape for one either.
import { clip, printable } from './binary/text';

export type HiddenKind = 'tag' | 'selector' | 'bidi' | 'zeroWidth' | 'filler';

export interface HiddenRun {
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 code units, as VS Code counts columns. */
  column: number;
  /** UTF-16 offset of the start of the run in the text. */
  offset: number;
  /** UTF-16 length of the run. */
  length: number;
  /** Code points in the run. */
  count: number;
  kinds: HiddenKind[];
  /** Distinct 'U+XXXX' labels in ascending order, at most MAX_LABELS. */
  codePoints: string[];
  /** True when the run has more distinct code points than `codePoints` lists. */
  codePointsTruncated?: boolean;
  /** What the run spells, when it decodes, made safe to show and clipped. */
  decoded?: string;
}

export interface HiddenScan {
  /** Flagged runs only, the first MAX_RUNS of them. */
  runs: HiddenRun[];
  /** All flagged runs. */
  totalRuns: number;
  /** Flagged code points. */
  totalChars: number;
  /** Any run that decodes, has four or more characters, or contains a bidi control. */
  encoded: boolean;
}

export const MAX_RUNS = 200;
export const MAX_DECODED = 200;
const MAX_LABELS = 8;
// The longest run that can be benign: a regional subdivision flag, black flag
// plus up to seven tag letters and the cancel tag, without the flag itself.
const MAX_BENIGN = 8;
const MIN_ENCODED = 4;

function kindOf(cp: number): HiddenKind | undefined {
  if (cp === 0xe0001 || (cp >= 0xe0020 && cp <= 0xe007f)) {
    return 'tag';
  }
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) {
    return 'selector';
  }
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
    return 'bidi';
  }
  if (
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x061c ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    cp === 0xfeff ||
    cp === 0x180e
  ) {
    return 'zeroWidth';
  }
  if (cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0) {
    return 'filler';
  }
  return undefined;
}

// A cheap test on UTF-16 units, so the common file with nothing in it costs one
// pass of integer comparisons. A tag or astral selector starts with the high
// surrogate 0xDB40; every other candidate is a single unit.
function mayBeHidden(unit: number): boolean {
  return (
    unit === 0xdb40 ||
    (unit >= 0xfe00 && unit <= 0xfeff && (unit <= 0xfe0f || unit === 0xfeff)) ||
    (unit >= 0x200b && unit <= 0x2069 && kindOf(unit) !== undefined) ||
    unit === 0x061c ||
    unit === 0x115f ||
    unit === 0x1160 ||
    unit === 0x180e ||
    unit === 0x3164 ||
    unit === 0xffa0
  );
}

function containsCandidate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (mayBeHidden(text.charCodeAt(i))) {
      return true;
    }
  }
  return false;
}

const WHITESPACE = /\s/u;
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
const LATIN = /^\p{Script=Latin}$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;

function visibleBase(cp: number | undefined): boolean {
  return cp !== undefined && !WHITESPACE.test(String.fromCodePoint(cp));
}

function isSubdivisionTag(cp: number): boolean {
  return (cp >= 0xe0030 && cp <= 0xe0039) || (cp >= 0xe0061 && cp <= 0xe007a);
}

function isVariationSelector(cp: number): boolean {
  return kindOf(cp) === 'selector';
}

function shapingContext(prev: number | undefined, next: number | undefined): boolean {
  if (prev === undefined || next === undefined) {
    return false;
  }
  const a = String.fromCodePoint(prev);
  const b = String.fromCodePoint(next);
  return LETTER_OR_MARK.test(a) && LETTER_OR_MARK.test(b) && !LATIN.test(a) && !LATIN.test(b);
}

// Whether a run is a use of these characters that text legitimately needs.
function benign(cps: number[], prev: number | undefined, next: number | undefined): boolean {
  const first = cps[0];
  if (cps.length === 1) {
    if (first === 0x200e || first === 0x200f || first === 0x061c) {
      return true;
    }
    if (isVariationSelector(first) && visibleBase(prev)) {
      return true;
    }
    if ((first === 0x200c || first === 0x200d) && shapingContext(prev, next)) {
      return true;
    }
  }
  // Emoji presentation, then optionally a join to the next emoji.
  if (visibleBase(prev)) {
    let at = 0;
    if (cps[at] === 0xfe0e || cps[at] === 0xfe0f) {
      at++;
    }
    let joins = false;
    if (cps[at] === 0x200d) {
      joins = true;
      at++;
    }
    if (
      at === cps.length &&
      at > 0 &&
      (!joins || (next !== undefined && PICTOGRAPHIC.test(String.fromCodePoint(next))))
    ) {
      return true;
    }
  }
  // A subdivision flag such as Scotland: black flag, tag letters, cancel tag.
  if (prev === 0x1f3f4 && cps.length >= 3 && cps.length <= 8 && cps[cps.length - 1] === 0xe007f) {
    return cps.slice(0, -1).every(isSubdivisionTag);
  }
  return false;
}

interface Found {
  start: number;
  end: number;
  line: number;
  column: number;
  count: number;
}

// Calls `found` for each flagged run, in order. `lines` turns on line tracking,
// which strip does not need.
function walk(text: string, lines: boolean, found: (run: Found) => void): void {
  if (!containsCandidate(text)) {
    return;
  }
  const n = text.length;
  let line = 1;
  let lineStart = 0;
  let prev: number | undefined;
  let i = 0;
  while (i < n) {
    const cp = text.codePointAt(i) as number;
    const width = cp > 0xffff ? 2 : 1;
    if (kindOf(cp) === undefined) {
      if (lines && (cp === 0x0a || (cp === 0x0d && text.charCodeAt(i + 1) !== 0x0a))) {
        line++;
        lineStart = i + width;
      }
      prev = cp;
      i += width;
      continue;
    }
    // The maximal run of invisible code points starting here.
    let start = i;
    let end = i;
    let count = 0;
    const cps: number[] = [];
    while (end < n) {
      const c = text.codePointAt(end) as number;
      if (kindOf(c) === undefined) {
        break;
      }
      if (count < MAX_BENIGN + 1) {
        cps.push(c);
      }
      count++;
      end += c > 0xffff ? 2 : 1;
    }
    // A byte order mark leads the file; what follows it is judged on its own.
    const bom = start === 0 && cps[0] === 0xfeff;
    if (bom) {
      cps.shift();
      count--;
      start = 1;
    }
    const next = end < n ? text.codePointAt(end) : undefined;
    if (count > 0 && (count > MAX_BENIGN || !benign(cps, bom ? undefined : prev, next))) {
      found({ start, end, line, column: start - lineStart + 1, count });
    }
    // The next code point is visible, so it sets prev before anything reads it.
    prev = undefined;
    i = end;
  }
}

// Which characters the run is made of, how, and what they spell.
function describe(text: string, found: Found, needDecode: boolean): HiddenRun {
  const kinds = new Set<HiddenKind>();
  const distinct = new Set<number>();
  const tags: number[] = [];
  const bytes: number[] = [];
  for (let at = found.start; at < found.end;) {
    const cp = text.codePointAt(at) as number;
    at += cp > 0xffff ? 2 : 1;
    const kind = kindOf(cp) as HiddenKind;
    kinds.add(kind);
    distinct.add(cp);
    if (needDecode) {
      if (cp >= 0xe0020 && cp <= 0xe007e) {
        tags.push(cp - 0xe0000);
      } else if (kind === 'selector') {
        bytes.push(cp <= 0xfe0f ? cp - 0xfe00 : cp - 0xe0100 + 16);
      }
    }
  }
  const sorted = [...distinct].sort((a, b) => a - b);
  const run: HiddenRun = {
    line: found.line,
    column: found.column,
    offset: found.start,
    length: found.end - found.start,
    count: found.count,
    kinds: [...kinds],
    codePoints: sorted.slice(0, MAX_LABELS).map(label),
  };
  if (sorted.length > MAX_LABELS) {
    run.codePointsTruncated = true;
  }
  let decoded: string | undefined;
  if (tags.length >= 2) {
    decoded = String.fromCharCode(...tags.slice(0, MAX_DECODED * 2));
  } else if (bytes.length >= 2) {
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    } catch {
      decoded = undefined;
    }
  }
  if (decoded !== undefined) {
    run.decoded = clip(printable(decoded), MAX_DECODED);
  }
  return run;
}

function label(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Find the invisible characters in `text` that nothing legitimate explains. */
export function scanHiddenText(text: string): HiddenScan {
  const scan: HiddenScan = { runs: [], totalRuns: 0, totalChars: 0, encoded: false };
  walk(text, true, (found) => {
    scan.totalRuns++;
    scan.totalChars += found.count;
    const listed = scan.runs.length < MAX_RUNS;
    if (!listed && scan.encoded) {
      return;
    }
    const run = describe(text, found, true);
    if (run.decoded !== undefined || found.count >= MIN_ENCODED || run.kinds.includes('bidi')) {
      scan.encoded = true;
    }
    if (listed) {
      scan.runs.push(run);
    }
  });
  return scan;
}

/** `text` without the characters `scanHiddenText` flags; benign ones stay. */
export function stripHiddenText(text: string): string {
  let out = '';
  let from = 0;
  walk(text, false, (found) => {
    out += text.slice(from, found.start);
    from = found.end;
  });
  return from === 0 && out === '' ? text : out + text.slice(from);
}
