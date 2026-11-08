import { randomBytes } from 'node:crypto';
import { isMap, isScalar, isSeq, parseDocument, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';
import type { ImageNote, ImageRegion } from './imageProtocol';
import type { FpsSource, ReviewNote } from './protocol';
import type { ReviewFile, ReviewMedia } from './schema';

export type { ReviewMedia };
import { isNumber, isObject, isPair, isRegion, isString } from './validate';

/**
 * `clip.mp4` -> `clip`. Only the last extension goes, as in the kit's
 * `review_path` (Python's `Path.stem`): `a.b.mov` -> `a.b`, `noext` stays, and a
 * leading or trailing dot is not an extension.
 */
export function reviewStem(videoName: string): string {
  const dot = videoName.lastIndexOf('.');
  return dot <= 0 || dot === videoName.length - 1 ? videoName : videoName.slice(0, dot);
}

/**
 * The part of the file name the sidecar is named after: the stem for a video, the
 * whole name for an image or audio file (`photo.png` gives `photo.png.review.yaml`,
 * `song.mp3` gives `song.mp3.review.yaml`), as the kit's `review_path` does.
 */
const nameBase = (name: string, media: ReviewMedia): string =>
  media === 'video' ? reviewStem(name) : name;

export function sidecarName(name: string, media: ReviewMedia = 'video'): string {
  return `${nameBase(name, media)}.review.yaml`;
}

export function markdownName(name: string, media: ReviewMedia = 'video'): string {
  return `${nameBase(name, media)}.review.md`;
}

/** The result of reading a sidecar's text. */
export interface SidecarLoad {
  /** The validated content, or undefined when it failed to parse or validate. */
  file?: ReviewFile;
  /**
   * The notes as the page shows them. A video's and an audio file's are
   * `ReviewNote`s and an image's `ImageNote`s: see `media`.
   */
  notes: SidecarNote[];
  /** Why the sidecar cannot be edited, or null when it is a valid version 1 file. */
  readOnly: string | null;
  /** The file's own `fps`, when it is a positive number. */
  fps?: number;
  /** `image` or `audio` when the file says so, else `video`; undefined when it did not parse. */
  media?: ReviewMedia;
}

/** A loaded note: a video's or an image's. */
export type SidecarNote = ReviewNote | ImageNote;

// Read as YAML 1.1 because PyYAML does: `yes`, `on` and `1:30` mean what Marker sees.
const YAML_OPTS = { version: '1.1' } as const;

const KINDS = ['note', 'keep', 'reject'];
const MEDIA = ['video', 'image', 'audio'];

/** `media` as the file says it; a missing or unknown value reads as video. */
function mediaOf(data: Record<string, unknown>): ReviewMedia {
  return data.media === 'image' || data.media === 'audio' ? data.media : 'video';
}
const STATUSES = ['none', 'needs_review', 'in_progress', 'approved', 'rejected'];
const TOOLS = ['arrow', 'line', 'box', 'free'];

/** A key the schema does not list: it sets additionalProperties false everywhere. */
function unknownKey(obj: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(obj).find((k) => !allowed.includes(k));
}

function noteError(note: unknown, index: number, media: ReviewMedia): string | null {
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
    'region',
    'done',
    'applied_op',
    'checkpoint',
    'drawing',
    'created',
  ]);
  if (extra) {
    return `${at} has an unknown field "${extra}"`;
  }
  const image = media === 'image';
  const audio = media === 'audio';
  for (const key of image
    ? ['id', 'target', 'kind', 'done', 'created']
    : ['id', 'target', 'at', 'kind', 'done', 'created']) {
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
  if (image) {
    // A still has no time, and nothing to render.
    if (note.target !== 'source') {
      return `${at}.target must be source in an image review`;
    }
    for (const key of ['at', 'out']) {
      if (key in note) {
        return `${at} has "${key}", which an image review does not use`;
      }
    }
  } else {
    if (audio && note.target !== 'source') {
      return `${at}.target must be source in an audio review`;
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
  if (audio) {
    for (const key of ['point', 'region']) {
      if (key in note) {
        return `${at} has "${key}", which an audio review does not use`;
      }
    }
    if (Array.isArray(note.drawing) && note.drawing.length > 0) {
      return `${at} has a drawing, which an audio review does not use`;
    }
  }
  if ('point' in note && !isPair(note.point)) {
    return `${at}.point must be two numbers from 0 to 1`;
  }
  if ('region' in note && !isRegion(note.region)) {
    return `${at}.region must be x, y, width and height from 0 to 1, with a size above 0, inside the picture`;
  }
  if ('point' in note && 'region' in note) {
    return `${at} has a point or a region, not both`;
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
    'media',
    'fps',
    'next_note_id',
    'asset',
    'notes',
  ]);
  if (extra) {
    return `Unknown field "${extra}"`;
  }
  if ('media' in data && !MEDIA.includes(data.media as string)) {
    return '"media" must be video, image or audio';
  }
  const media = mediaOf(data);
  // An image or an audio file has no frame rate, so only a video must name one.
  for (const key of media === 'video' ? ['version', 'source', 'fps'] : ['version', 'source']) {
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
  if ((media === 'video' || 'fps' in data) && (!isNumber(data.fps) || data.fps <= 0)) {
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
      const err = noteError(data.notes[i], i, media);
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
  if (n.target === 'source' || n.target === 'render') {
    note.target = n.target;
  }
  if (isNumber(n.out) && n.out > note.at) {
    note.out = n.out;
  }
  if (isPair(n.point)) {
    note.point = [...(n.point as [number, number])] as [number, number];
  }
  return note;
}

/** An image note as the page shows it: no time, a pin or an area or neither. */
function toImageNote(n: Record<string, unknown>): ImageNote {
  const note: ImageNote = {
    id: n.id as string,
    text: isString(n.text) ? n.text : '',
    kind: isString(n.kind) ? n.kind : 'note',
    done: n.done === true,
    created: isString(n.created) ? n.created : '',
  };
  if (isString(n.author)) {
    note.author = n.author;
  }
  // A note with both is invalid; show the pin, the one the page always had.
  if (isPair(n.point)) {
    note.point = [...(n.point as [number, number])] as [number, number];
  } else if (isRegion(n.region)) {
    note.region = [...(n.region as ImageRegion)] as ImageRegion;
  }
  return note;
}

/** The notes of a document that parsed but failed validation, as far as they make sense. */
function lenientNotes(data: unknown, media: ReviewMedia): SidecarNote[] {
  if (!isObject(data) || !Array.isArray(data.notes)) {
    return [];
  }
  if (media === 'image') {
    return data.notes
      .filter((n) => isObject(n) && isString(n.id))
      .map((n) => toImageNote(n as Record<string, unknown>));
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
  // Some faults only surface when the tree is resolved, not in doc.errors: an
  // alias with no anchor, or more alias expansions than the yaml library's
  // limit (its guard against an alias bomb). Both are bad YAML to the reader.
  let data: unknown;
  try {
    data = doc.toJS();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { notes: [], readOnly: `Not valid YAML (${message.split('\n')[0]})` };
  }
  const fps = isObject(data) && isNumber(data.fps) && data.fps > 0 ? data.fps : undefined;
  const media: ReviewMedia | undefined = isObject(data) ? mediaOf(data) : undefined;
  const error = reviewFileError(data);
  if (error) {
    return { notes: lenientNotes(data, media ?? 'video'), readOnly: error, fps, media };
  }
  const file = data as ReviewFile;
  const toNote = media === 'image' ? toImageNote : toReviewNote;
  return {
    file,
    notes: (file.notes ?? []).map((n) => toNote(n as unknown as Record<string, unknown>)),
    readOnly: null,
    fps: file.fps,
    media,
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

/** A failure the toast can say as is. */
export class EditError extends Error {}

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
  /** Seconds. A video's or audio file's only: an image note has no time. */
  at?: number;
  out?: number;
  text: string;
  created: string;
  /** A pin as the page sent it; written as the kit's `_clean_point` leaves it. */
  point?: readonly [number, number];
  /** An area as the page sent it, `[x, y, w, h]`; written as `cleanRegion` leaves it. */
  region?: readonly [number, number, number, number];
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

/**
 * `_clean_region`: each value rounded as `cleanPoint` does, then the size pulled
 * back so an edge-flush rectangle never tips past 1. The caller has checked the
 * four numbers (`isRegion`); a rectangle that rounds to no size is refused.
 */
export function cleanRegion(
  region: readonly [number, number, number, number],
): [number, number, number, number] {
  const [x, y] = [cleanPoint(region[0]), cleanPoint(region[1])];
  const w = Math.min(cleanPoint(region[2]), cleanPoint(1 - x));
  const h = Math.min(cleanPoint(region[3]), cleanPoint(1 - y));
  if (w <= 0 || h <= 0) {
    throw new EditError('The area is too small');
  }
  return [x, y, w, h];
}

/**
 * One note exactly as `Review.add_note` and `safe_dump` write it, LF line ends.
 * An image note has no `at`, so that line is left out. An audio note is a video
 * note's lines (the kit writes both from the same `add_note`).
 */
export function noteYaml(note: NewNote, media: ReviewMedia = 'video'): string {
  const lines = [
    `- id: ${note.id}`,
    '  target: source',
    ...(media === 'image' ? [] : [`  at: ${pyFloat(note.at ?? 0)}`]),
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
  if (note.region !== undefined) {
    lines.push(`  region: [${cleanRegion(note.region).map(pyFloat).join(', ')}]`);
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

/** What `Review.new(..., media="image")` followed by `save` writes: no `fps`, `media` after `source`. */
export function newImageSidecarText(source: string, id: string): string {
  return [
    'version: 1',
    `id:${pyString(id, 'id:'.length, 2)}`,
    `source:${pyString(source, 'source:'.length, 2)}`,
    'media: image',
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

/** What `Review.new(..., media="audio")` followed by `save` writes: no `fps`, `media` after `source`. */
export function newAudioSidecarText(source: string, id: string): string {
  return newImageSidecarText(source, id).replace('media: image', 'media: audio');
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
  return {
    text: insertNote(bumped, noteYaml({ ...note, id }, file.media ?? 'video'), Infinity, true),
    id,
  };
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
