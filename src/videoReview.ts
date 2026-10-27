import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { isMap, isScalar, isSeq, parseDocument, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';
import type {
  FpsSource,
  ReviewErrorMessage,
  ReviewNote,
  ReviewStateMessage,
  ReviewWebviewMessage,
} from './review/protocol';
import { reviewMarkdown } from './review/markdown';
import type { ReviewFile } from './review/schema';

// The host half of video review: finds, reads, validates and watches the
// `<stem>.review.yaml` sidecar, resolves the frame rate, and writes the markdown
// hand-off, and from phase 2 writes notes. See docs/VIDEO-REVIEW-DESIGN.md.
// Everything here that does not touch vscode is exported so it can be tested.

/**
 * `clip.mp4` -> `clip`. Only the last extension goes, as in the kit's
 * `review_path` (Python's `Path.stem`): `a.b.mov` -> `a.b`, `noext` stays, and a
 * leading or trailing dot is not an extension.
 */
export function reviewStem(videoName: string): string {
  const dot = videoName.lastIndexOf('.');
  return dot <= 0 || dot === videoName.length - 1 ? videoName : videoName.slice(0, dot);
}

export function sidecarName(videoName: string): string {
  return `${reviewStem(videoName)}.review.yaml`;
}

export function markdownName(videoName: string): string {
  return `${reviewStem(videoName)}.review.md`;
}

/** The result of reading a sidecar's text. */
export interface SidecarLoad {
  /** The validated content, or undefined when it failed to parse or validate. */
  file?: ReviewFile;
  notes: ReviewNote[];
  /** Why the sidecar cannot be edited, or null when it is a valid version 1 file. */
  readOnly: string | null;
  /** The file's own `fps`, when it is a positive number. */
  fps?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isUnit = (v: unknown): boolean => isNumber(v) && v >= 0 && v <= 1;
const isPair = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every(isUnit);

// Read as YAML 1.1 because PyYAML does: `yes`, `on` and `1:30` mean what Marker sees.
const YAML_OPTS = { version: '1.1' } as const;

const KINDS = ['note', 'keep', 'reject'];
const STATUSES = ['none', 'needs_review', 'in_progress', 'approved', 'rejected'];
const TOOLS = ['arrow', 'line', 'box', 'free'];

/** A key the schema does not list: it sets additionalProperties false everywhere. */
function unknownKey(obj: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(obj).find((k) => !allowed.includes(k));
}

function noteError(note: unknown, index: number): string | null {
  const at = `notes[${index}]`;
  if (!isObject(note)) {
    return `${at} is not a mapping`;
  }
  const extra = unknownKey(note, [
    'id',
    'target',
    'at',
    'out',
    'kind',
    'text',
    'color',
    'author',
    'point',
    'done',
    'applied_op',
    'checkpoint',
    'drawing',
    'created',
  ]);
  if (extra) {
    return `${at} has an unknown field "${extra}"`;
  }
  for (const key of ['id', 'target', 'at', 'kind', 'done', 'created']) {
    if (!(key in note)) {
      return `${at} is missing "${key}"`;
    }
  }
  if (!isString(note.id)) {
    return `${at}.id must be a string`;
  }
  if (note.target !== 'source' && note.target !== 'render') {
    return `${at}.target must be source or render`;
  }
  if (!isNumber(note.at) || note.at < 0) {
    return `${at}.at must be a number of seconds, 0 or more`;
  }
  if ('out' in note && (!isNumber(note.out) || note.out <= 0)) {
    return `${at}.out must be a positive number of seconds`;
  }
  if (isNumber(note.out) && note.out <= note.at) {
    return `${at}.out must be greater than at`;
  }
  if (!isString(note.kind) || !KINDS.includes(note.kind)) {
    return `${at}.kind must be note, keep or reject`;
  }
  if ((note.kind === 'keep' || note.kind === 'reject') && note.target !== 'source') {
    return `${at} is a ${note.kind} note and must have target source`;
  }
  if (typeof note.done !== 'boolean') {
    return `${at}.done must be true or false`;
  }
  if (!isString(note.created)) {
    return `${at}.created must be a string`;
  }
  for (const key of ['text', 'color', 'author']) {
    if (key in note && !isString(note[key])) {
      return `${at}.${key} must be a string`;
    }
  }
  for (const key of ['applied_op', 'checkpoint']) {
    if (key in note && note[key] !== null && !isString(note[key])) {
      return `${at}.${key} must be a string or null`;
    }
  }
  if ('point' in note && !isPair(note.point)) {
    return `${at}.point must be two numbers from 0 to 1`;
  }
  if ('drawing' in note) {
    if (!Array.isArray(note.drawing)) {
      return `${at}.drawing must be a list`;
    }
    for (const d of note.drawing) {
      const valid =
        isObject(d) &&
        !unknownKey(d, ['tool', 'color', 'points']) &&
        TOOLS.includes(d.tool as string) &&
        Array.isArray(d.points) &&
        d.points.every(isPair) &&
        (!('color' in d) || isString(d.color));
      if (!valid) {
        return `${at}.drawing has an invalid entry`;
      }
    }
  }
  return null;
}

/**
 * The first way `data` departs from review.schema.json plus the kit's cross-field
 * rules, or null when it is a valid version 1 sidecar.
 */
export function reviewFileError(data: unknown): string | null {
  if (!isObject(data)) {
    return 'The file is not a review document';
  }
  const extra = unknownKey(data, [
    'version',
    'id',
    'source',
    'fps',
    'next_note_id',
    'asset',
    'notes',
  ]);
  if (extra) {
    return `Unknown field "${extra}"`;
  }
  for (const key of ['version', 'source', 'fps']) {
    if (!(key in data)) {
      return `Missing "${key}"`;
    }
  }
  if (data.version !== 1) {
    return `Version ${String(data.version)} is not supported (only version 1 is)`;
  }
  if (!isString(data.source) || !data.source) {
    return '"source" must be a file name';
  }
  if (!isNumber(data.fps) || data.fps <= 0) {
    return '"fps" must be a positive number';
  }
  if ('id' in data && (!isString(data.id) || !data.id)) {
    return '"id" must be a non-empty string';
  }
  if (
    'next_note_id' in data &&
    (!isNumber(data.next_note_id) || !Number.isInteger(data.next_note_id) || data.next_note_id < 1)
  ) {
    return '"next_note_id" must be a whole number, 1 or more';
  }
  if ('asset' in data) {
    const asset = data.asset;
    if (!isObject(asset) || unknownKey(asset, ['rating', 'status', 'keywords', 'notes'])) {
      return '"asset" is not valid';
    }
    if (
      'rating' in asset &&
      (!isNumber(asset.rating) ||
        !Number.isInteger(asset.rating) ||
        asset.rating < 0 ||
        asset.rating > 5)
    ) {
      return '"asset.rating" must be a whole number from 0 to 5';
    }
    if ('status' in asset && !STATUSES.includes(asset.status as string)) {
      return '"asset.status" is not a known status';
    }
    if ('keywords' in asset && !(Array.isArray(asset.keywords) && asset.keywords.every(isString))) {
      return '"asset.keywords" must be a list of strings';
    }
    if ('notes' in asset && !isString(asset.notes)) {
      return '"asset.notes" must be a string';
    }
  }
  if ('notes' in data) {
    if (!Array.isArray(data.notes)) {
      return '"notes" must be a list';
    }
    for (let i = 0; i < data.notes.length; i++) {
      const err = noteError(data.notes[i], i);
      if (err) {
        return err;
      }
    }
  }
  return null;
}

function toReviewNote(n: Record<string, unknown>): ReviewNote {
  const note: ReviewNote = {
    id: n.id as string,
    at: n.at as number,
    text: isString(n.text) ? n.text : '',
    kind: isString(n.kind) ? n.kind : 'note',
    done: n.done === true,
    created: isString(n.created) ? n.created : '',
  };
  if (isNumber(n.out) && n.out > note.at) {
    note.out = n.out;
  }
  if (isPair(n.point)) {
    note.point = [...(n.point as [number, number])] as [number, number];
  }
  return note;
}

/** The notes of a document that parsed but failed validation, as far as they make sense. */
function lenientNotes(data: unknown): ReviewNote[] {
  if (!isObject(data) || !Array.isArray(data.notes)) {
    return [];
  }
  return data.notes
    .filter((n) => isObject(n) && isString(n.id) && isNumber(n.at) && n.at >= 0)
    .map((n) => toReviewNote(n as Record<string, unknown>));
}

/** Read a sidecar's text: parse, validate, and say why it is read-only if it is. */
export function loadSidecar(text: string): SidecarLoad {
  const doc = parseDocument(text, YAML_OPTS);
  if (doc.errors.length > 0) {
    return { notes: [], readOnly: `Not valid YAML (${doc.errors[0].message.split('\n')[0]})` };
  }
  const data: unknown = doc.toJS();
  const fps = isObject(data) && isNumber(data.fps) && data.fps > 0 ? data.fps : undefined;
  const error = reviewFileError(data);
  if (error) {
    return { notes: lenientNotes(data), readOnly: error, fps };
  }
  const file = data as ReviewFile;
  return {
    file,
    notes: (file.notes ?? []).map((n) => toReviewNote(n as unknown as Record<string, unknown>)),
    readOnly: null,
    fps: file.fps,
  };
}

/**
 * Sidecar, then probe, then 30. `probeFps` is undefined while the probe is in
 * flight and 0 when it ran and found nothing usable.
 */
export function resolveFps(
  sidecarFps: number | undefined,
  probeFps: number | undefined,
): { fps: number; fpsSource: FpsSource } {
  if (sidecarFps !== undefined && sidecarFps > 0) {
    return { fps: sidecarFps, fpsSource: 'sidecar' };
  }
  if (probeFps === undefined) {
    return { fps: 30, fpsSource: 'pending' };
  }
  return probeFps > 0 ? { fps: probeFps, fpsSource: 'probe' } : { fps: 30, fpsSource: 'assumed' };
}

/** The toast after a copy: `Copied 3 notes, saved clip.review.md`. */
export function copyToast(count: number, markdownFile: string): string {
  return `Copied ${count} ${count === 1 ? 'note' : 'notes'}, saved ${markdownFile}`;
}

// ---------------------------------------------------------------------------
// Writing. The kit saves with PyYAML (`yaml.safe_dump(sort_keys=False,
// default_flow_style=None, allow_unicode=True)`), and Marker and cutline read the
// same file, so an edit must leave every byte it does not touch alone and write
// what PyYAML would for the bytes it does. The `yaml` package parses (as YAML 1.1,
// like PyYAML) and locates nodes by range; the edit is then a splice of the
// original text. Re-stringifying the document would re-wrap long strings and
// re-pick quote styles in notes the edit never meant to touch.
// ---------------------------------------------------------------------------

/** The file system provider's file-not-found, however the host or a test spells it. */
function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'FileNotFound' || code === 'ENOENT';
}

/** A failure the toast can say as is. */
export class EditError extends Error {}

/** Longest note text a page may send. */
export const MAX_NOTE_TEXT = 10_000;

/** What the validators check times against. `durationSec` is absent when unknown. */
export interface ReviewBounds {
  durationSec?: number;
  fps: number;
}

type AddMessage = Extract<ReviewWebviewMessage, { type: 'reviewAdd' }>;
type SetDoneMessage = Extract<ReviewWebviewMessage, { type: 'reviewSetDone' }>;
type DeleteMessage = Extract<ReviewWebviewMessage, { type: 'reviewDelete' }>;
type RestoreMessage = Extract<ReviewWebviewMessage, { type: 'reviewRestore' }>;

/** A key outside `allowed`: the messages come from a page, so extra fields are refused. */
const extraKey = (msg: Record<string, unknown>, allowed: string[]) =>
  Object.keys(msg).find((k) => !allowed.includes(k));

/** Why a `reviewAdd` is refused, or null when it is fine. */
export function reviewAddError(msg: unknown, bounds: ReviewBounds): string | null {
  if (!isObject(msg)) {
    return 'That note is not valid';
  }
  const extra = extraKey(msg, ['type', 'at', 'out', 'text', 'point']);
  if (extra) {
    return `That note has an unexpected field "${extra}"`;
  }
  if (!isNumber(msg.at) || msg.at < 0) {
    return 'The note time must be a number of seconds, 0 or more';
  }
  const hasOut = msg.out !== undefined;
  if (hasOut && (!isNumber(msg.out) || msg.out <= msg.at)) {
    return 'The range end must be after its start';
  }
  if (msg.point !== undefined && !isPair(msg.point)) {
    return 'The pin must be two numbers from 0 to 1';
  }
  if (!isString(msg.text) || msg.text.length > MAX_NOTE_TEXT) {
    return `The note text must be ${MAX_NOTE_TEXT.toLocaleString('en-US')} characters or fewer`;
  }
  // One frame of slack, because the last frame starts a frame before the duration.
  const limit =
    bounds.durationSec !== undefined && bounds.durationSec > 0
      ? bounds.durationSec + 1 / bounds.fps
      : Infinity;
  if (msg.at > limit || (hasOut && (msg.out as number) > limit)) {
    return 'That time is past the end of the video';
  }
  return null;
}

export function isReviewAdd(msg: unknown, bounds: ReviewBounds): msg is AddMessage {
  return reviewAddError(msg, bounds) === null;
}

const knownId = (id: unknown, ids: readonly string[]): id is string =>
  isString(id) && ids.includes(id);

export function isReviewSetDone(msg: unknown, ids: readonly string[]): msg is SetDoneMessage {
  return (
    isObject(msg) &&
    !extraKey(msg, ['type', 'id', 'done']) &&
    knownId(msg.id, ids) &&
    typeof msg.done === 'boolean'
  );
}

export function isReviewDelete(msg: unknown, ids: readonly string[]): msg is DeleteMessage {
  return isObject(msg) && !extraKey(msg, ['type', 'id']) && knownId(msg.id, ids);
}

export function isReviewRestore(msg: unknown): msg is RestoreMessage {
  return isObject(msg) && !extraKey(msg, ['type']);
}

/** `datetime.now().isoformat(timespec="seconds")`: local time, no zone. */
export function localTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * A float as PyYAML writes it: always with a fraction, and in Python's exponent
 * form outside 1e-4 to 1e16 (`5.0e-05`), where JavaScript's differs.
 */
export function pyFloat(v: number): string {
  if (Object.is(v, -0)) {
    return '-0.0';
  }
  const abs = Math.abs(v);
  if (abs >= 1e-4 && abs < 1e16) {
    return Number.isInteger(v) ? `${v}.0` : String(v);
  }
  if (v === 0) {
    return '0.0';
  }
  const [mantissa, exponent] = v.toExponential().split('e');
  const e = Number(exponent);
  const m = mantissa.includes('.') ? mantissa : `${mantissa}.0`;
  return `${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
}

const WIDTH = 80;
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const BOM = String.fromCharCode(0xfeff);
const BREAKS = '\n\x85' + LS + PS;

/** A character PyYAML cannot write as is under `allow_unicode`, so it double-quotes. */
function needsEscape(ch: string): boolean {
  const c = ch.codePointAt(0) as number;
  if (ch === '\n' || (c >= 0x20 && c <= 0x7e)) {
    return false;
  }
  const printable =
    c === 0x85 ||
    (c >= 0xa0 && c <= 0xd7ff) ||
    (c >= 0xe000 && c <= 0xfffd) ||
    (c >= 0x10000 && c <= 0x10ffff);
  return !printable || c === 0xfeff;
}

/**
 * Which style PyYAML picks for a string value: a port of `analyze_scalar` and
 * `choose_scalar_style` for a block-context value. Plain also needs the text to
 * resolve back to a string, which PyYAML decides with its implicit resolvers and
 * this decides by reading it as YAML 1.1. The two differ on `y`, `n` and `1e3`
 * (PyYAML leaves them plain, this quotes them, and both read the quoted form as a
 * string) and on `=` and `<<`, which PyYAML quotes as reserved.
 */
function stringStyle(s: string): 'plain' | 'single' | 'double' {
  const chars = Array.from(s);
  const white = (ch: string | undefined) =>
    ch === undefined || (' \t\r\n\x85' + LS + PS).includes(ch);
  let blockIndicators = s.startsWith('---') || s.startsWith('...');
  let lineBreaks = false;
  let special = false;
  let leading = false;
  let trailing = false;
  let breakSpace = false;
  let spaceBreak = false;
  let prevSpace = false;
  let prevBreak = false;
  chars.forEach((ch, i) => {
    const next = chars[i + 1];
    if (i === 0) {
      if ('#,[]{}&*!|>\'"%@`'.includes(ch) || (ch === '-' && white(next))) {
        blockIndicators = true;
      }
      if ('?:'.includes(ch) && white(next)) {
        blockIndicators = true;
      }
    } else {
      if (ch === ':' && white(next)) {
        blockIndicators = true;
      }
      if (ch === '#' && white(chars[i - 1])) {
        blockIndicators = true;
      }
    }
    if (BREAKS.includes(ch)) {
      lineBreaks = true;
    }
    special ||= needsEscape(ch);
    if (ch === ' ') {
      leading ||= i === 0;
      trailing ||= i === chars.length - 1;
      breakSpace ||= prevBreak;
      prevSpace = true;
      prevBreak = false;
    } else if (BREAKS.includes(ch)) {
      leading ||= i === 0;
      trailing ||= i === chars.length - 1;
      spaceBreak ||= prevSpace;
      prevSpace = false;
      prevBreak = true;
    } else {
      prevSpace = prevBreak = false;
    }
  });
  let plain = !(leading || trailing || lineBreaks || blockIndicators);
  let single = true;
  if (breakSpace) {
    plain = single = false;
  }
  if (spaceBreak || special) {
    plain = single = false;
  }
  if (plain && s !== '' && s !== '=' && s !== '<<') {
    const doc = parseDocument(`k: ${s}`, YAML_OPTS);
    plain = doc.errors.length === 0 && doc.get('k') === s;
  } else {
    plain = false;
  }
  return plain ? 'plain' : single ? 'single' : 'double';
}

const ESCAPES: Record<string, string> = {
  '\0': '0',
  '\x07': 'a',
  '\b': 'b',
  '\t': 't',
  '\n': 'n',
  '\v': 'v',
  '\f': 'f',
  '\r': 'r',
  '\x1b': 'e',
  '"': '"',
  '\\': '\\',
  '\x85': 'N',
  '\xa0': '_',
  [LS]: 'L',
  [PS]: 'P',
};

/** The narrower printable range PyYAML tests inside double quotes (no astral planes). */
function escapeInQuotes(ch: string): boolean {
  const c = ch.codePointAt(0) as number;
  return !((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd));
}

/**
 * A string value written the way PyYAML's emitter writes it, including where it
 * wraps: PyYAML breaks at a single space once the column passes 80, so a line runs
 * past 80 up to the next space, which the `yaml` package's folding does not
 * reproduce. A port of `write_plain`, `write_single_quoted` and
 * `write_double_quoted`. `prefix` is the width of the `key:` before the value and
 * `indent` the column continuation lines start at. The result starts with the
 * space after the colon.
 */
export function pyString(value: string, prefix: number, indent: number): string {
  const chars = Array.from(value);
  const n = chars.length;
  let out = ' ';
  let col = prefix + 1;
  const put = (s: string) => {
    out += s;
    col += Array.from(s).length;
  };
  const lineBreak = (br = '\n') => {
    out += br;
    col = 0;
  };
  const writeIndent = () => {
    if (col > indent) {
      lineBreak();
    }
    out += ' '.repeat(Math.max(0, indent - col));
    col = Math.max(col, indent);
  };
  const style = stringStyle(value);

  if (style === 'plain') {
    let spaces = false;
    let start = 0;
    for (let end = 0; end <= n; end++) {
      const ch = end < n ? chars[end] : null;
      if (spaces) {
        if (ch !== ' ') {
          if (start + 1 === end && col > WIDTH) {
            writeIndent();
          } else {
            put(chars.slice(start, end).join(''));
          }
          start = end;
        }
      } else if (ch === null || ch === ' ') {
        put(chars.slice(start, end).join(''));
        start = end;
      }
      spaces = ch === ' ';
    }
  } else if (style === 'single') {
    put("'");
    let spaces = false;
    let breaks = false;
    let start = 0;
    for (let end = 0; end <= n; end++) {
      const ch = end < n ? chars[end] : null;
      if (spaces) {
        if (ch !== ' ') {
          if (start + 1 === end && col > WIDTH && start !== 0 && end !== n) {
            writeIndent();
          } else {
            put(chars.slice(start, end).join(''));
          }
          start = end;
        }
      } else if (breaks) {
        if (ch === null || !BREAKS.includes(ch)) {
          if (chars[start] === '\n') {
            lineBreak();
          }
          for (const br of chars.slice(start, end)) {
            lineBreak(br);
          }
          writeIndent();
          start = end;
        }
      } else if (ch === null || ch === ' ' || BREAKS.includes(ch) || ch === "'") {
        if (start < end) {
          put(chars.slice(start, end).join(''));
          start = end;
        }
      }
      if (ch === "'") {
        put("''");
        start = end + 1;
      }
      spaces = ch === ' ';
      breaks = ch !== null && BREAKS.includes(ch);
    }
    put("'");
  } else {
    put('"');
    let start = 0;
    for (let end = 0; end <= n; end++) {
      const ch = end < n ? chars[end] : null;
      if (ch === null || ('"\\\x85' + LS + PS + BOM).includes(ch) || escapeInQuotes(ch)) {
        if (start < end) {
          put(chars.slice(start, end).join(''));
        }
        if (ch !== null) {
          const c = ch.codePointAt(0) as number;
          const hex = (width: number) => c.toString(16).toUpperCase().padStart(width, '0');
          const code = c <= 0xff ? `x${hex(2)}` : c <= 0xffff ? `u${hex(4)}` : `U${hex(8)}`;
          put(`\\${ESCAPES[ch] ?? code}`);
        }
        start = end + 1;
      }
      if (end > 0 && end < n - 1 && (ch === ' ' || start >= end) && col + (end - start) > WIDTH) {
        const data = `${chars.slice(start, end).join('')}\\`;
        if (start < end) {
          start = end;
        }
        put(data);
        writeIndent();
        if (chars[start] === ' ') {
          put('\\');
        }
      }
    }
    put('"');
  }
  return out;
}

/** The fields of a note MarkCopy creates; the rest are fixed. */
export interface NewNote {
  id: string;
  at: number;
  out?: number;
  text: string;
  created: string;
  /** A pin as the page sent it; written as the kit's `_clean_point` leaves it. */
  point?: readonly [number, number];
}

/**
 * `_clean_point`: Python's `round(v, 4)` for a value already 0 to 1. `toFixed(4)`
 * agrees except on an exact tie, where Python goes to the even digit: a click 25 px
 * into an 800 px picture is exactly 0.03125, which Python writes as 0.0312 and
 * `toFixed` as 0.0313. `toFixed(100)` is the double's exact decimal expansion for
 * any value a tie can occur at, so it tells a true tie from a near one (0.00005 is
 * really 0.0000500000000000000024, which rounds up in both).
 */
export function cleanPoint(v: number): number {
  const exact = v.toFixed(100);
  const dot = exact.indexOf('.');
  if (/^50*$/.test(exact.slice(dot + 5))) {
    const kept = Number(exact.slice(0, dot + 5));
    return Number(exact[dot + 4]) % 2 === 0 ? kept : Number((kept + 0.0001).toFixed(4));
  }
  return Number(v.toFixed(4));
}

/** One note exactly as `Review.add_note` and `safe_dump` write it, LF line ends. */
export function noteYaml(note: NewNote): string {
  const lines = [
    `- id: ${note.id}`,
    '  target: source',
    `  at: ${pyFloat(note.at)}`,
    '  kind: note',
    `  text:${pyString(note.text, '  text:'.length, 4)}`,
    '  done: false',
    '  applied_op: null',
    '  checkpoint: null',
    '  drawing: []',
    `  created:${pyString(note.created, '  created:'.length, 4)}`,
  ];
  if (note.out !== undefined) {
    lines.push(`  out: ${pyFloat(note.out)}`);
  }
  if (note.point !== undefined) {
    lines.push(`  point: [${note.point.map((v) => pyFloat(cleanPoint(v))).join(', ')}]`);
  }
  return `${lines.join('\n')}\n`;
}

/** What `Review.new` followed by `save` writes for a video with no notes yet. */
export function newSidecarText(source: string, fps: number, id: string): string {
  return [
    'version: 1',
    `id:${pyString(id, 'id:'.length, 2)}`,
    `source:${pyString(source, 'source:'.length, 2)}`,
    `fps: ${pyFloat(fps)}`,
    'next_note_id: 1',
    'asset:',
    '  rating: 0',
    '  status: none',
    '  keywords: []',
    "  notes: ''",
    'notes: []',
    '',
  ].join('\n');
}

/** Twelve lowercase hex characters, as `uuid.uuid4().hex[:12]`. */
export function newSidecarId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * The next note number: the larger of the high-water mark and one past the highest
 * `n<k>` id present. A file without `next_note_id` would otherwise start at n1 again.
 */
export function nextNoteNumber(file: ReviewFile): number {
  let highest = 0;
  for (const note of file.notes ?? []) {
    const m = /^n(\d+)$/.exec(note.id);
    if (m) {
      highest = Math.max(highest, Number(m[1]));
    }
  }
  return Math.max(isNumber(file.next_note_id) ? file.next_note_id : 1, highest + 1);
}

const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');
const withEol = (s: string, eol: string) => (eol === '\n' ? s : s.replace(/\n/g, eol));

/** The start of the line holding `pos`. */
const lineStart = (text: string, pos: number) =>
  pos <= 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;

type Range = [number, number, number];

/** Where the line after a node's last line begins (the end of the text for the last). */
function lineAfter(text: string, range: Range): number {
  let end = range[1];
  while (end > range[0] && (text[end - 1] === '\n' || text[end - 1] === '\r')) {
    end--;
  }
  const nl = text.indexOf('\n', end);
  return nl < 0 ? text.length : nl + 1;
}

const rangeOf = (node: unknown): Range => {
  const r = (node as { range?: Range | null } | null)?.range;
  if (!r) {
    throw new EditError('The notes file could not be read for editing');
  }
  return r;
};

/** The offset just past the `:` after a pair's key, which may sit apart from it (`notes  :`). */
function colonEnd(text: string, pair: Pair): number {
  let at = rangeOf(pair.key)[1];
  while (text[at] === ' ' || text[at] === '\t') {
    at++;
  }
  if (text[at] !== ':') {
    throw new EditError(UNSUPPORTED);
  }
  return at + 1;
}

const UNSUPPORTED = 'The notes list is written in a layout MarkCopy cannot edit safely';

interface Located {
  /** The `notes` pair, when the file has one. */
  pair: Pair | undefined;
  /** Its list; undefined when the value is not one. */
  seq: YAMLSeq | undefined;
}

function locate(text: string): Located & { root: YAMLMap } {
  const doc = parseDocument(text, YAML_OPTS);
  if (!isMap(doc.contents)) {
    throw new EditError('The notes file is not a mapping');
  }
  const root = doc.contents;
  const pair = root.items.find((p) => isScalar(p.key) && p.key.value === 'notes');
  return { root, pair, seq: pair && isSeq(pair.value) ? pair.value : undefined };
}

/** The notes as maps. A flow list with notes in it is hand-written and not edited. */
function noteMaps(seq: YAMLSeq): YAMLMap[] {
  if (seq.flow && seq.items.length > 0) {
    throw new EditError(UNSUPPORTED);
  }
  return seq.items.map((item) => {
    if (!isMap(item)) {
      throw new EditError(UNSUPPORTED);
    }
    return item;
  });
}

/**
 * Put `raw` (whole note lines, LF) into the list at `index`, past the end meaning
 * the end. `relead` indents a fresh fragment like the notes already there.
 */
function insertNote(text: string, raw: string, index: number, relead: boolean): string {
  const eol = eolOf(text);
  const { pair, seq } = locate(text);
  if (!pair) {
    return `${text}${text === '' || text.endsWith('\n') ? '' : eol}notes:${eol}${withEol(raw, eol)}`;
  }
  if (!seq) {
    throw new EditError(UNSUPPORTED);
  }
  const items = noteMaps(seq);
  if (items.length === 0) {
    // `notes: []` becomes a block list, as PyYAML writes the first note.
    const from = colonEnd(text, pair);
    const end = rangeOf(seq)[1];
    return text.slice(0, from) + eol + withEol(raw.replace(/\n$/, ''), eol) + text.slice(end);
  }
  const at = Math.min(index, items.length);
  const anchor = rangeOf(items[Math.min(at, items.length - 1)])[0];
  const lead = relead ? (/^[ \t]*/.exec(text.slice(lineStart(text, anchor)))?.[0] ?? '') : '';
  const body = withEol(lead ? raw.replace(/^(?=.)/gm, lead) : raw, eol);
  if (at < items.length) {
    const pos = lineStart(text, rangeOf(items[at])[0]);
    return text.slice(0, pos) + body + text.slice(pos);
  }
  const pos = lineAfter(text, rangeOf(items[items.length - 1]));
  const gap = pos === text.length && !text.endsWith('\n') ? eol : '';
  return text.slice(0, pos) + gap + body + text.slice(pos);
}

/** Set a top-level scalar, appending the key at the end of the file when it is new. */
function setTopLevel(text: string, key: string, value: string): string {
  const { root } = locate(text);
  const pair = root.items.find((p) => isScalar(p.key) && p.key.value === key);
  if (pair && isScalar(pair.value)) {
    const [start, end] = rangeOf(pair.value);
    return text.slice(0, start) + value + text.slice(end);
  }
  const eol = eolOf(text);
  return `${text}${text === '' || text.endsWith('\n') ? '' : eol}${key}: ${value}${eol}`;
}

/** `Review.add_note` on the sidecar's text: the new text and the id it gave. */
export function addNoteText(
  text: string,
  note: Omit<NewNote, 'id'>,
  file: ReviewFile,
): { text: string; id: string } {
  const n = nextNoteNumber(file);
  const id = `n${n}`;
  const bumped = setTopLevel(text, 'next_note_id', String(n + 1));
  return { text: insertNote(bumped, noteYaml({ ...note, id }), Infinity, true), id };
}

/** Flip a note's `done` in place. Returns null when no note has that id. */
export function setDoneText(text: string, id: string, done: boolean): string | null {
  const { seq } = locate(text);
  const note = seq && noteMaps(seq).find((m) => m.get('id') === id);
  const flag = note?.items.find((p) => isScalar(p.key) && p.key.value === 'done');
  if (!note || !flag || !isScalar(flag.value)) {
    return null;
  }
  const [start, end] = rangeOf(flag.value);
  return text.slice(0, start) + String(done) + text.slice(end);
}

/** A note taken out of the file: its lines and where it was, so Restore can put it back. */
export interface RemovedNote {
  id: string;
  index: number;
  /** The note's own lines, LF line ends. */
  raw: string;
}

/** `Review.remove_note`: drop one note, leaving the others' bytes alone. Null if absent. */
export function removeNoteText(
  text: string,
  id: string,
): { text: string; removed: RemovedNote } | null {
  const { pair, seq } = locate(text);
  if (!pair || !seq) {
    return null;
  }
  const items = noteMaps(seq);
  const index = items.findIndex((m) => m.get('id') === id);
  if (index < 0) {
    return null;
  }
  const start = lineStart(text, rangeOf(items[index])[0]);
  const end = lineAfter(text, rangeOf(items[index]));
  const raw = text.slice(start, end).replace(/\r\n/g, '\n');
  const removed = { id, index, raw: raw.endsWith('\n') ? raw : `${raw}\n` };
  if (items.length === 1) {
    // The last note goes and the list reads `notes: []`, as PyYAML writes an empty one.
    const from = colonEnd(text, pair);
    return { text: `${text.slice(0, from)} []${eolOf(text)}${text.slice(end)}`, removed };
  }
  return { text: text.slice(0, start) + text.slice(end), removed };
}

/** Put a removed note back at its old index (clamped), under its old id. */
export function restoreNoteText(text: string, removed: RemovedNote): string {
  return insertNote(text, removed.raw, removed.index, false);
}

/** What the host's one ffprobe run says about the video; 0 where it has no answer. */
export interface ProbeInfo {
  /** Average frame rate. */
  fps: number;
  durationSec: number;
}

/** A note this panel deleted, held so Restore can bring it back. One level deep. */
interface HeldNote extends RemovedNote {
  /** It was written by this panel, so it counts for the replaced-notes check again. */
  wasWritten: boolean;
}

/** What a queued edit decided: the new text, or the reason it will not happen. */
type Change = { text: string; added?: string; applied?: () => void } | string;

const idsOf = (loaded: SidecarLoad | undefined): string[] => (loaded?.notes ?? []).map((n) => n.id);

/**
 * One panel's review mode. Owns the watcher, the probed fps and the edit queue,
 * all scoped to the panel. Nothing runs until review mode is on, so a plain
 * preview costs nothing.
 */
export class ReviewSession {
  private active = false;
  private disposed = false;
  private watcher: vscode.FileSystemWatcher | undefined;
  // undefined until the probe lands; its fps is 0 if the file has no average rate.
  private probeInfo: ProbeInfo | undefined;
  private probePromise: Promise<void> | undefined;
  // Bumped by every post, so a slow read that started before a newer one (the
  // watcher often fires twice for one save) cannot post stale notes last.
  private generation = 0;
  // Every edit runs after the one before it, so two quick adds get n1 and n2.
  private queue: Promise<void> = Promise.resolve();
  private editing = false;
  // The sidecar text this panel last wrote, so the watcher event it raises is not
  // answered with a second post.
  private lastWritten: string | undefined;
  private tmpCount = 0;
  // Ids of notes this panel added and has not deleted: if one vanishes in a reload,
  // another program replaced the file.
  private readonly written = new Set<string>();
  private held: HeldNote | undefined;
  private readonly videoName: string;
  private readonly dir: vscode.Uri;

  /** `probe` resolves the video's average frame rate and duration, 0 where unknown. */
  constructor(
    private readonly source: vscode.Uri,
    private readonly webview: vscode.Webview,
    private readonly probe: () => Promise<ProbeInfo>,
  ) {
    const p = source.path;
    this.videoName = p.substring(p.lastIndexOf('/') + 1);
    this.dir = vscode.Uri.joinPath(source, '..');
  }

  private get sidecarUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, sidecarName(this.videoName));
  }

  /** After the webview's `ready`: review mode comes on if a sidecar exists or the setting is true. */
  async onReady(): Promise<void> {
    const setting = vscode.workspace
      .getConfiguration('markcopy', this.source)
      .get<boolean>('video.review', false);
    // An unreadable sidecar is still a sidecar: turn on and let post() report it.
    const exists = await this.read().then(
      (text) => text !== undefined,
      () => true,
    );
    if (setting || exists) {
      await this.enable();
    }
  }

  /** Turn review mode on (idempotent) and post the state. */
  async enable(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.active) {
      this.active = true;
      // A RelativePattern on the video's folder, not the workspace, so a video
      // opened from outside the workspace is watched as well.
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.dir, sidecarName(this.videoName)),
      );
      const reload = () => void this.reload();
      watcher.onDidChange(reload);
      watcher.onDidCreate(reload);
      watcher.onDidDelete(reload);
      this.watcher = watcher;
    }
    await this.post();
  }

  /** Build the markdown from the sidecar, save it beside the sidecar, and copy it. */
  async copy(): Promise<void> {
    let text: string | undefined;
    try {
      text = await this.read();
    } catch (err) {
      this.error(`Could not read ${sidecarName(this.videoName)} (${String(err)})`);
      return;
    }
    if (text === undefined) {
      this.error('There are no notes to copy yet');
      return;
    }
    const loaded = loadSidecar(text);
    if (!loaded.file) {
      this.error(`Cannot copy: ${loaded.readOnly ?? 'the notes file is not valid'}`);
      return;
    }
    const markdown = reviewMarkdown(loaded.file);
    const name = markdownName(this.videoName);
    try {
      await this.writeAtomic(vscode.Uri.joinPath(this.dir, name), markdown);
    } catch (err) {
      this.error(`Could not save ${name} (${String(err)})`);
      return;
    }
    await vscode.env.clipboard.writeText(markdown);
    void this.webview.postMessage({
      type: 'toast',
      message: copyToast(loaded.notes.length, name),
    });
  }

  /**
   * Add a note at the playhead or over a range. The first note creates the
   * sidecar, so a probe still in flight is awaited: it decides the new file's fps
   * and the duration the times are checked against.
   */
  add(msg: unknown): Promise<void> {
    return this.enqueue(async () => {
      await this.probePromise;
      await this.commit((text, loaded) => {
        const bounds = {
          durationSec: this.probeInfo?.durationSec,
          fps: resolveFps(loaded?.fps, this.probeInfo?.fps).fps,
        };
        const bad = reviewAddError(msg, bounds);
        if (bad || !isReviewAdd(msg, bounds)) {
          return bad ?? 'That note is not valid';
        }
        const base = text ?? newSidecarText(this.videoName, bounds.fps, newSidecarId());
        const file = loaded?.file ?? (loadSidecar(base).file as ReviewFile);
        const note = {
          at: msg.at,
          out: msg.out,
          text: msg.text,
          point: msg.point,
          created: localTimestamp(new Date()),
        };
        const next = addNoteText(base, note, file);
        return { text: next.text, added: next.id, applied: () => this.written.add(next.id) };
      }, true);
    }, 'add');
  }

  setDone(msg: unknown): Promise<void> {
    return this.enqueue(() =>
      this.commit((text, loaded) => {
        if (text === undefined || !isReviewSetDone(msg, idsOf(loaded))) {
          return 'That note is no longer in the notes file';
        }
        const next = setDoneText(text, msg.id, msg.done);
        return next === null ? 'That note is no longer in the notes file' : { text: next };
      }),
    );
  }

  delete(msg: unknown): Promise<void> {
    return this.enqueue(() =>
      this.commit((text, loaded) => {
        if (text === undefined || !isReviewDelete(msg, idsOf(loaded))) {
          return 'That note is no longer in the notes file';
        }
        const gone = removeNoteText(text, msg.id);
        if (!gone) {
          return 'That note is no longer in the notes file';
        }
        return {
          text: gone.text,
          applied: () => {
            this.held = { ...gone.removed, wasWritten: this.written.delete(msg.id) };
          },
        };
      }),
    );
  }

  restore(msg: unknown): Promise<void> {
    return this.enqueue(() =>
      this.commit((text, loaded) => {
        const held = this.held;
        if (!isReviewRestore(msg) || !held) {
          return 'There is no deleted note to restore';
        }
        if (text === undefined || idsOf(loaded).includes(held.id)) {
          // Not restorable any more: the note is back already, or its file is gone.
          this.held = undefined;
          return `${held.id} cannot be restored`;
        }
        return {
          text: restoreNoteText(text, held),
          applied: () => {
            if (held.wasWritten) {
              this.written.add(held.id);
            }
            this.held = undefined;
          },
        };
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  private enqueue(job: () => Promise<void>, failed?: 'add'): Promise<void> {
    const run = this.queue.then(job).catch((err) => {
      this.editing = false;
      this.error(
        err instanceof EditError ? err.message : `Could not save the notes (${String(err)})`,
        failed,
      );
    });
    this.queue = run;
    return run;
  }

  /**
   * Re-read the sidecar, refuse if it is read-only, let `change` apply one
   * operation to the fresh text, write the sidecar and then the markdown, and
   * post the result. The markdown is derived output, so it is written only here
   * and in Copy, never from a reload.
   */
  private async commit(
    change: (text: string | undefined, loaded: SidecarLoad | undefined) => Change,
    createsFile = false,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    // Only an add creates the file, and it is the one edit whose draft the page can take back.
    const failed = createsFile ? 'add' : undefined;
    this.editing = true;
    let text: string | undefined;
    try {
      text = await this.read();
    } catch (err) {
      // Not "absent": writing now would replace a file that is there but unreadable.
      this.editing = false;
      this.error(`Could not read ${sidecarName(this.videoName)} (${String(err)})`, failed);
      return;
    }
    const loaded = text === undefined ? undefined : loadSidecar(text);
    if (loaded?.readOnly || (!createsFile && loaded === undefined)) {
      this.editing = false;
      this.error(
        loaded?.readOnly
          ? `The notes file is read-only: ${loaded.readOnly}`
          : 'The notes file is no longer there',
        failed,
      );
      return;
    }
    const result = change(text, loaded);
    if (typeof result === 'string') {
      this.editing = false;
      this.error(result, failed);
      return;
    }
    // A splice that misjudged the layout must never reach the disk.
    const candidate = loadSidecar(result.text);
    if (!candidate.file || candidate.readOnly) {
      this.editing = false;
      this.error('That change would leave the notes file invalid, so nothing was saved', failed);
      return;
    }
    try {
      await this.writeAtomic(this.sidecarUri, result.text);
    } catch (err) {
      this.editing = false;
      this.error(`Could not save ${sidecarName(this.videoName)} (${String(err)})`, failed);
      return;
    }
    this.lastWritten = result.text;
    result.applied?.();
    const name = markdownName(this.videoName);
    try {
      await this.writeAtomic(vscode.Uri.joinPath(this.dir, name), reviewMarkdown(candidate.file));
    } catch (err) {
      this.error(`Saved the notes, but could not write ${name} (${String(err)})`);
    }
    this.editing = false;
    await this.post(result.added ?? null, result.text);
  }

  /** Write beside the target and rename over it, so a reader never sees half a file. */
  private async writeAtomic(target: vscode.Uri, content: string): Promise<void> {
    const base = target.path.substring(target.path.lastIndexOf('/') + 1);
    const tmp = vscode.Uri.joinPath(
      this.dir,
      `.${base}.${Date.now().toString(36)}${(this.tmpCount++).toString(36)}.tmp`,
    );
    try {
      await vscode.workspace.fs.writeFile(tmp, Buffer.from(content, 'utf8'));
      await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
    } catch (err) {
      await Promise.resolve(vscode.workspace.fs.delete(tmp)).catch(() => undefined);
      throw err;
    }
  }

  /**
   * The sidecar's text, or undefined when there is none. Any other failure (no
   * permission, an I/O error) throws: the file may well be there, and treating it
   * as absent would let the next add replace it.
   */
  private async read(): Promise<string | undefined> {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(this.sidecarUri)).toString('utf8');
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  /** The file changed on disk. Our own write is already on screen, so it is not posted again. */
  private async reload(): Promise<void> {
    try {
      if (this.lastWritten !== undefined && (await this.read()) === this.lastWritten) {
        return;
      }
    } catch {
      // post() reads again and says so.
    }
    await this.post();
  }

  /** The probe, started once; its answer lands in `probeInfo` and is posted. */
  private startProbe(): Promise<void> {
    this.probePromise ??= this.probe()
      .catch(() => ({ fps: 0, durationSec: 0 }))
      .then((info) => {
        this.probeInfo = info;
        void this.post();
      });
    return this.probePromise;
  }

  /**
   * Post the panel's state. After an edit, `written` is the text just written and
   * validated, so the acknowledgement does not depend on reading it back: a
   * failed reread must not leave a saved note unacknowledged.
   */
  private async post(added: string | null = null, written?: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    const generation = ++this.generation;
    let text = written;
    if (written === undefined) {
      try {
        text = await this.read();
      } catch (err) {
        // Leave the panel as it is: an unreadable file is not an empty one.
        if (generation === this.generation && !this.disposed) {
          this.error(`Could not read ${sidecarName(this.videoName)} (${String(err)})`);
        }
        return;
      }
    }
    if (generation !== this.generation || this.disposed) {
      return;
    }
    const loaded = text === undefined ? undefined : loadSidecar(text);
    // Only a sidecar without a usable fps needs the probe.
    if (loaded?.fps === undefined && this.probeInfo === undefined) {
      void this.startProbe();
    }
    // Not mid-edit: a read between our write and our bookkeeping would show a note
    // we are about to count (or stop counting) as missing.
    if (!this.editing && !loaded?.readOnly) {
      const present = new Set(idsOf(loaded));
      const gone = [...this.written].filter((id) => !present.has(id));
      if (gone.length > 0) {
        gone.forEach((id) => this.written.delete(id));
        this.error('Notes were replaced by another program');
      }
    }
    const msg: ReviewStateMessage = {
      type: 'review',
      ...resolveFps(loaded?.fps, this.probeInfo?.fps),
      sidecar: loaded ? sidecarName(this.videoName) : null,
      notes: loaded?.notes ?? [],
      readOnly: loaded?.readOnly ?? null,
      restorable: this.held?.id ?? null,
      added,
    };
    void this.webview.postMessage(msg);
  }

  private error(message: string, failed?: 'add'): void {
    const msg: ReviewErrorMessage = failed
      ? { type: 'reviewError', message, failed }
      : { type: 'reviewError', message };
    void this.webview.postMessage(msg);
  }
}
