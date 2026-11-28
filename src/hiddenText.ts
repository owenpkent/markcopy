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
  /**
   * A hash of every flagged character, listed or not, in order. Two scans with
   * the same counts but different hidden content have different fingerprints.
   */
  fingerprint: string;
}

export const MAX_RUNS = 200;
export const MAX_DECODED = 200;
const MAX_LABELS = 8;
const MIN_ENCODED = 4;
// Rounds of re-judging in `settled`. Benign spans sit only at a run's edges or
// are lone direction marks, so it settles in three; the cap is a backstop.
const MAX_ROUNDS = 8;

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
const MONGOLIAN = /^\p{Script=Mongolian}$/u;
// Scripts written without spaces, where U+200B marks a word break.
const SPACELESS = /^[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]$/u;
// Characters a mathematical expression is made of, for the invisible operators.
const MATHY = /^[\p{N}\p{Sm}()[\]{}\u{1D400}-\u{1D7FF}]$/u;

function visible(cp: number | undefined): cp is number {
  return cp !== undefined && kindOf(cp) === undefined;
}

// A leading consonant jamo (not the filler) and a vowel jamo, in Hangul Jamo
// and its extensions.
function isChoseong(cp: number | undefined): boolean {
  return cp !== undefined && ((cp >= 0x1100 && cp <= 0x115e) || (cp >= 0xa960 && cp <= 0xa97c));
}
function isJungseong(cp: number | undefined): boolean {
  return cp !== undefined && ((cp >= 0x1161 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6));
}
// A trailing consonant jamo.
function isJongseong(cp: number | undefined): boolean {
  return cp !== undefined && ((cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb));
}

// Markdown emphasis delimiters (`*`, `_`), at most three in a row. They draw
// nothing, so for a word break beside one the letter behind it is what counts.
function isEmphasis(cp: number | undefined): boolean {
  return cp === 0x2a || cp === 0x5f;
}

function visibleBase(cp: number | undefined): boolean {
  return cp !== undefined && !WHITESPACE.test(String.fromCodePoint(cp));
}

function isSubdivisionTag(cp: number): boolean {
  return (cp >= 0xe0030 && cp <= 0xe0039) || (cp >= 0xe0061 && cp <= 0xe007a);
}

function isVariationSelector(cp: number | undefined): boolean {
  return cp !== undefined && kindOf(cp) === 'selector';
}

function test(re: RegExp, cp: number | undefined): boolean {
  return cp !== undefined && re.test(String.fromCodePoint(cp));
}

// A visible letter or mark. Variation selectors are nonspacing marks by
// category, so an invisible neighbour inside a run must not count as one.
function letter(cp: number | undefined): boolean {
  return cp !== undefined && kindOf(cp) === undefined && test(LETTER_OR_MARK, cp);
}

// A letter or mark of a script that shapes with joiners: anything but Latin.
function shapingLetter(cp: number | undefined): boolean {
  return letter(cp) && !test(LATIN, cp);
}

function isDirectionMark(cp: number | undefined): boolean {
  return cp === 0x200e || cp === 0x200f || cp === 0x061c;
}

// The visible code points around a run. `prev` and `next` touch it; `prev2` and
// `next2` are one further out. `prevText` and `nextText` are the nearest ones
// past up to three Markdown emphasis delimiters.
interface Around {
  prev?: number;
  next?: number;
  prev2?: number;
  next2?: number;
  prevText?: number;
  nextText?: number;
}

// Which code points of a run text legitimately needs, one flag per code point.
// `around` holds the visible code points around the run. Each benign
// pattern is matched where it stands, so a legitimate character beside a
// suspicious one, or beside another legitimate one (an emoji's VS16 then a
// right-to-left mark), keeps its exemption.
function explained(cps: number[], around: Around): boolean[] {
  const { prev, next } = around;
  const ok = cps.map(() => false);
  const before = (k: number): number | undefined => (k === 0 ? prev : cps[k - 1]);
  const after = (k: number): number | undefined => (k + 1 < cps.length ? cps[k + 1] : next);
  let k = 0;
  // A subdivision flag such as Scotland: black flag, tag letters, cancel tag.
  if (prev === 0x1f3f4) {
    let j = 0;
    while (j < cps.length && j < 7 && isSubdivisionTag(cps[j])) {
      j++;
    }
    if (j >= 2 && cps[j] === 0xe007f) {
      for (let x = 0; x <= j; x++) {
        ok[x] = true;
      }
      k = j + 1;
    }
  }
  // One variation selector on a visible base (emoji presentation, an
  // ideographic variation sequence), then optionally a join to the next emoji.
  // A second selector straight after it is a payload, not a variation, so the
  // first is not exempted either: its byte belongs to what the run spells.
  if (k === 0 && visibleBase(prev)) {
    if (isVariationSelector(cps[0]) && !isVariationSelector(after(0))) {
      ok[0] = true;
      k = 1;
    }
    if (cps[k] === 0x200d && test(PICTOGRAPHIC, after(k))) {
      ok[k] = true;
      k++;
    }
  }
  for (let i = k; i < cps.length; i++) {
    const cp = cps[i];
    const left = before(i);
    const right = after(i);
    if (isDirectionMark(cp)) {
      // One mark sets direction; a row of them is a binary channel.
      ok[i] = !isDirectionMark(left) && !isDirectionMark(right);
    } else if (cp === 0x200c || cp === 0x200d) {
      // Shaping control beside a letter of a joining script, mid-word or at a
      // word's edge (a legacy Malayalam chillu ends in ZWJ before a space).
      // Neighbours inside the run are invisible, so they count as no letter.
      ok[i] =
        (shapingLetter(left) && (shapingLetter(right) || !letter(right))) ||
        (!letter(left) && shapingLetter(right));
    } else if (cp === 0x200b) {
      // A lone word break between two words of a script written without
      // spaces. Both neighbours are visible, so a row of them is still flagged.
      // Markdown emphasis delimiters between the break and a letter are skipped,
      // since the preview draws the two words with the break between them.
      const leftText = i === 0 ? around.prevText : left;
      const rightText = i === cps.length - 1 ? around.nextText : right;
      ok[i] =
        visible(left) && visible(right) && test(SPACELESS, leftText) && test(SPACELESS, rightText);
    } else if (cp >= 0x2061 && cp <= 0x2064) {
      // An invisible function application, times, separator or plus between
      // the parts of a mathematical expression: deleting it changes the maths.
      // Both sides must be visible (a row of them is still flagged). A side is an
      // operand when it is a number, an operator or a bracket, or a letter
      // standing as a variable: a letter that is not part of a longer word (the
      // next one out is no letter: the m and the c of `mc²`) or that has a
      // number or operator beyond it.
      const operand = (cp: number | undefined, outer: number | undefined): boolean =>
        test(MATHY, cp) || (letter(cp) && (!letter(outer) || test(MATHY, outer)));
      const rightOk = operand(right, i === cps.length - 1 ? around.next2 : undefined);
      if (cp === 0x2061) {
        // Function application sits between a function name, a run of letters of
        // any length (`sin`, `f`), or a closing bracket or number, and its
        // argument. The name needs no further test: it is what the marker marks.
        // The argument is what must look like one (an operand or an opening
        // bracket), so `say` then `hello` is still flagged: `hello` is a word.
        ok[i] = visible(left) && visible(right) && (letter(left) || test(MATHY, left)) && rightOk;
      } else {
        ok[i] =
          visible(left) &&
          visible(right) &&
          operand(left, i === 0 ? around.prev2 : undefined) &&
          rightOk;
      }
    } else if (cp === 0x115f) {
      // The choseong filler that stands in for a missing leading consonant,
      // before a vowel: how Unicode spells an isolated vowel jamo.
      // With the vowel filler behind it, before a trailing consonant, it spells
      // an isolated trailing consonant, which would otherwise join the syllable
      // before it.
      ok[i] = isJungseong(right) || (right === 0x1160 && isJongseong(cps[i + 2] ?? next));
    } else if (cp === 0x1160) {
      // The jungseong filler that stands in for a missing vowel, after a
      // leading consonant: an isolated consonant jamo. After the choseong filler
      // and before a trailing consonant: an isolated trailing consonant.
      ok[i] = isChoseong(left) || (left === 0x115f && isJongseong(right));
    } else if (cp === 0x180e) {
      // The Mongolian vowel separator, before a final A or E.
      ok[i] = test(MONGOLIAN, left) && (right === 0x1820 || right === 0x1821);
    }
  }
  return ok;
}

// `explained`, judged again on what a strip keeps until nothing changes. Taking
// a flagged character out can leave a kept one in a new context (two direction
// marks that a payload separated end up side by side), so a kept character is
// only benign if it is still benign once its flagged neighbours are gone. That
// makes a strip final: stripping its output again changes nothing.
function settled(cps: number[], around: Around): boolean[] {
  const ok = explained(cps, around);
  for (let round = 0; ; round++) {
    if (round === MAX_ROUNDS) {
      // Not expected to happen; flag everything rather than keep an unsettled set.
      return cps.map(() => false);
    }
    const kept: number[] = [];
    for (let k = 0; k < cps.length; k++) {
      if (ok[k]) {
        kept.push(k);
      }
    }
    if (kept.length === 0 || kept.length === cps.length) {
      return ok;
    }
    const again = explained(
      kept.map((k) => cps[k]),
      around,
    );
    if (again.every(Boolean)) {
      return ok;
    }
    kept.forEach((k, j) => (ok[k] = again[j]));
  }
}

// The position of the first visible code point at or after `pos`, or the length.
function visibleFrom(text: string, pos: number): number {
  while (pos < text.length) {
    const c = text.codePointAt(pos) as number;
    if (kindOf(c) === undefined) {
      return pos;
    }
    pos += c > 0xffff ? 2 : 1;
  }
  return pos;
}

function codePointAtVisible(text: string, pos: number): number | undefined {
  const at = visibleFrom(text, pos);
  return at < text.length ? text.codePointAt(at) : undefined;
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
  // The visible code points behind the current position, never reset by a run:
  // context is read from the text with every invisible character taken out, so
  // it does not change when a strip removes some of them. Judging each code
  // point by the visible text around it is what keeps a clean copy stable: what
  // it keeps is judged the same way when it is scanned again.
  let prev: number | undefined;
  let prev2: number | undefined;
  // The nearest visible code point before the current one that is no emphasis
  // delimiter, and how many delimiters sit between it and the current position.
  let prevText: number | undefined;
  let delimiters = 0;
  let i = 0;
  while (i < n) {
    const cp = text.codePointAt(i) as number;
    const width = cp > 0xffff ? 2 : 1;
    if (kindOf(cp) === undefined) {
      if (lines && (cp === 0x0a || (cp === 0x0d && text.charCodeAt(i + 1) !== 0x0a))) {
        line++;
        lineStart = i + width;
      }
      prev2 = prev;
      prev = cp;
      if (isEmphasis(cp)) {
        delimiters++;
      } else {
        prevText = cp;
        delimiters = 0;
      }
      i += width;
      continue;
    }
    // The maximal run of invisible code points starting here.
    const start = i;
    let end = i;
    const cps: number[] = [];
    const at: number[] = [];
    while (end < n) {
      const c = text.codePointAt(end) as number;
      if (kindOf(c) === undefined) {
        break;
      }
      cps.push(c);
      at.push(end);
      end += c > 0xffff ? 2 : 1;
    }
    const report = (from: number, to: number, points: number): void =>
      found({ start: from, end: to, line, column: from - lineStart + 1, count: points });
    // A byte order mark leads the file; what follows it is judged on its own.
    const skip = start === 0 && cps[0] === 0xfeff ? 1 : 0;
    const next = end < n ? text.codePointAt(end) : undefined;
    const next2 =
      next === undefined ? undefined : codePointAtVisible(text, end + (next > 0xffff ? 2 : 1));
    let after = end;
    for (let d = 0; d < 3 && after < n && isEmphasis(text.charCodeAt(after)); d++) {
      after = visibleFrom(text, after + 1);
    }
    const nextText = after >= n ? next : text.codePointAt(after);
    const leading = skip ? undefined : prev;
    const around: Around = {
      prev: leading,
      prev2: skip ? undefined : prev2,
      prevText: skip ? undefined : delimiters > 0 && delimiters <= 3 ? prevText : prev,
      next,
      next2,
      nextText,
    };
    // Every code point is judged, however long the run, so a payload's length
    // never decides whether the emoji or flag in front of it keeps its form.
    const ok = settled(cps.slice(skip), around);
    // Each stretch of unexplained code points is a flagged run of its own.
    let from = -1;
    for (let k = 0; k <= ok.length; k++) {
      if (k < ok.length && !ok[k]) {
        if (from < 0) {
          from = k;
        }
      } else if (from >= 0) {
        report(at[skip + from], k < ok.length ? at[skip + k] : end, k - from);
        from = -1;
      }
    }
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
  const scan: HiddenScan = {
    runs: [],
    totalRuns: 0,
    totalChars: 0,
    encoded: false,
    fingerprint: '',
  };
  // FNV-1a over the flagged UTF-16 units, with a separator between runs.
  let hash = 0x811c9dc5;
  const mix = (unit: number): void => {
    hash = Math.imul(hash ^ unit, 0x01000193) >>> 0;
  };
  walk(text, true, (found) => {
    scan.totalRuns++;
    scan.totalChars += found.count;
    for (let u = found.start; u < found.end; u++) {
      mix(text.charCodeAt(u));
    }
    mix(0xffff);
    scan.fingerprint = hash.toString(16).padStart(8, '0');
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
