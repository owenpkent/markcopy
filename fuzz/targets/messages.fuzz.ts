import { FuzzedDataProvider } from '@jazzer.js/core';
import { planBlockEdit } from '../../src/blockEdit';
import { applyCsvEdits, cellEdit, gridEdits } from '../../src/csv';
import { parseGifMessage } from '../../src/messages/gif';
import { parseImageMessage } from '../../src/messages/image';
import { parseMarkdownMessage } from '../../src/messages/markdown';
import { parseOoxmlMessage } from '../../src/messages/ooxml';
import { parsePdfMessage } from '../../src/messages/pdf';
import { parseStlMessage } from '../../src/messages/stl';
import { parseTexMessage } from '../../src/messages/tex';
import { parseVideoMessage } from '../../src/messages/video';
import { classifyLink } from '../../src/preview-utils';
import {
  MAX_NOTE_TEXT,
  isReviewAdd,
  isReviewDelete,
  reviewAddError,
} from '../../src/review/validate';

// The webview-to-host message parsers (src/messages/*). A webview is untrusted,
// so whatever it posts, a parser must return a message or undefined without
// throwing, and a message it returns must satisfy the invariants its handler
// relies on. Those are restated here by hand rather than imported, so a loosened
// check in a parser shows up as a failure.
//
// Two ways in: the input as JSON (what postMessage delivers), and the same bytes
// as a FuzzedDataProvider script that builds a message of a known type with
// fields of random types, which reaches the field checks far sooner than mutated
// JSON text does.

type Msg = { type: string } & Record<string, unknown>;
type Parser = (raw: unknown) => unknown;

const THEMES = ['auto', 'light', 'dark', 'green'];
const PREVIEW_TOGGLES = ['syncScroll', 'autoPreview', 'math', 'footnotes'];
const IMAGE_BACKGROUNDS = ['checkerboard', 'light', 'dark', 'theme'];
const VIEWER_TOGGLES = ['video.loop', 'video.autoplay', 'video.review'];
const GRID_OPS = [
  'insertRowAbove',
  'insertRowBelow',
  'deleteRow',
  'insertColumnLeft',
  'insertColumnRight',
  'deleteColumn',
];

const TYPES = {
  markdown: [
    'revealInOS',
    'revealLine',
    'toast',
    'updateSetting',
    'openSettings',
    'openLink',
    'pdfHtml',
    'docxXhtml',
    'pptxXhtml',
    'editCell',
    'gridOp',
    'editBlock',
  ],
  ooxml: [
    'ready',
    'revealInOS',
    'pdfHtml',
    'docxXhtml',
    'pptxXhtml',
    'updateSetting',
    'openSettings',
    'toast',
    'openLink',
    'selectSheet',
  ],
  pdf: ['ready', 'revealInOS', 'saveComments', 'updateSetting'],
  tex: ['ready', 'revealInOS', 'texRecompile', 'saveComments', 'updateSetting'],
  stl: ['ready'],
  video: [
    'ready',
    'revealInOS',
    'saveFrame',
    'openExternal',
    'proxyRequest',
    'playable',
    'proxyStart',
    'proxyCancel',
    'reviewEnable',
    'reviewCopy',
    'reviewAdd',
    'reviewDelete',
    'reviewRestore',
    'updateSetting',
  ],
  gif: ['ready', 'revealInOS', 'saveFrame', 'openExternal', 'updateSetting'],
  image: ['ready', 'revealInOS', 'saveFrame', 'openExternal', 'updateSetting'],
};
const ALL_TYPES = [...new Set(Object.values(TYPES).flat()), 'toString', '__proto__', ''];

const PARSERS: [keyof typeof TYPES, Parser][] = [
  ['markdown', parseMarkdownMessage],
  ['ooxml', parseOoxmlMessage],
  ['pdf', parsePdfMessage],
  ['tex', parseTexMessage],
  ['stl', parseStlMessage],
  ['video', parseVideoMessage],
  ['gif', parseGifMessage],
  ['image', parseImageMessage],
];

function fail(surface: string, why: string, msg: unknown): never {
  throw new Error(`${surface}: ${why}: ${JSON.stringify(msg)}`);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

// The setting allow-list for each surface, as its menu sends them.
function settingAllowed(surface: string, key: string, value: unknown): boolean {
  const theme = key === 'theme' && typeof value === 'string' && THEMES.includes(value);
  const bool = typeof value === 'boolean';
  switch (surface) {
    case 'markdown':
    case 'ooxml':
      return theme || (PREVIEW_TOGGLES.includes(key) && bool);
    case 'video':
      return theme || (VIEWER_TOGGLES.includes(key) && bool);
    case 'image':
      return theme || (key === 'image.background' && IMAGE_BACKGROUNDS.includes(value as string));
    default:
      return theme; // pdf, tex, gif
  }
}

const SAMPLE_CSV = 'a,b,c\n"d,1",e,f\r\ng,h\n';
const SAMPLE_MD = 'one\ntwo\r\nthree\n\nfour';

function checkMessage(surface: keyof typeof TYPES, raw: unknown, msg: Msg): void {
  if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') {
    fail(surface, 'result is not a typed message', msg);
  }
  if (!TYPES[surface].includes(msg.type)) {
    fail(surface, 'accepted a type this surface does not handle', msg);
  }
  switch (msg.type) {
    case 'revealLine':
      if (typeof msg.line !== 'number' || !Number.isFinite(msg.line)) {
        fail(surface, 'revealLine.line is not a finite number', msg);
      }
      break;
    case 'toast':
      if (typeof msg.text !== 'string') {
        fail(surface, 'toast.text is not a string', msg);
      }
      break;
    case 'updateSetting':
      if (typeof msg.key !== 'string' || !settingAllowed(surface, msg.key, msg.value)) {
        fail(surface, 'updateSetting outside the allow-list', msg);
      }
      break;
    case 'openLink': {
      if (typeof msg.href !== 'string') {
        fail(surface, 'openLink.href is not a string', msg);
      }
      const target = classifyLink(msg.href);
      if (target && target.kind === 'external' && typeof target.href !== 'string') {
        fail(surface, 'external link target is not a string', msg);
      }
      break;
    }
    case 'pdfHtml':
    case 'docxXhtml':
    case 'pptxXhtml':
      if (typeof msg.body !== 'string') {
        fail(surface, 'export body is not a string', msg);
      }
      break;
    case 'editCell': {
      if (!isInt(msg.line) || !isInt(msg.column) || typeof msg.value !== 'string') {
        fail(surface, 'editCell fields are not integers and a string', msg);
      }
      if (msg.docVersion !== undefined && typeof msg.docVersion !== 'number') {
        fail(surface, 'editCell.docVersion is not a number', msg);
      }
      const edit = cellEdit(SAMPLE_CSV, ',', msg.line, msg.column, msg.value);
      if (edit && !(edit.start >= 0 && edit.start <= edit.end && edit.end <= SAMPLE_CSV.length)) {
        fail(surface, 'cellEdit range outside the document', msg);
      }
      break;
    }
    case 'gridOp': {
      if (!GRID_OPS.includes(msg.op as string) || !isInt(msg.line) || !isInt(msg.column)) {
        fail(surface, 'gridOp fields are not an operation and integers', msg);
      }
      if (msg.docVersion !== undefined && typeof msg.docVersion !== 'number') {
        fail(surface, 'gridOp.docVersion is not a number', msg);
      }
      const edits = gridEdits(
        SAMPLE_CSV,
        ',',
        msg.op as Parameters<typeof gridEdits>[2],
        { line: msg.line, column: msg.column },
        '\n',
      );
      for (const e of edits) {
        if (!(e.start >= 0 && e.start <= e.end && e.end <= SAMPLE_CSV.length)) {
          fail(surface, 'gridEdits range outside the document', msg);
        }
      }
      if (typeof applyCsvEdits(SAMPLE_CSV, edits) !== 'string') {
        fail(surface, 'applyCsvEdits did not return a string', msg);
      }
      break;
    }
    case 'editBlock': {
      if (msg.editId !== undefined && !Number.isSafeInteger(msg.editId)) {
        fail(surface, 'editBlock.editId is not a safe integer', msg);
      }
      const plan = planBlockEdit(SAMPLE_MD, '\n', {
        startLine: msg.startLine,
        endLine: msg.endLine,
        original: msg.original,
        text: msg.text,
      });
      if (plan.ok && !(plan.start >= 0 && plan.start <= plan.end && plan.end <= SAMPLE_MD.length)) {
        fail(surface, 'planBlockEdit range outside the document', msg);
      }
      break;
    }
    case 'selectSheet':
      if (!isInt(msg.index) || (msg.index as number) < 0) {
        fail(surface, 'selectSheet.index is not a non-negative integer', msg);
      }
      break;
    case 'saveFrame':
      if (typeof msg.data !== 'string' || msg.data === '') {
        fail(surface, 'saveFrame.data is not a non-empty string', msg);
      }
      if (msg.name !== undefined && (typeof msg.name !== 'string' || msg.name === '')) {
        fail(surface, 'saveFrame.name is not a non-empty string', msg);
      }
      break;
    case 'proxyStart':
      if (msg.kind !== 'sound' && msg.kind !== 'picture') {
        fail(surface, 'proxyStart.kind is not sound or picture', msg);
      }
      break;
    case 'reviewAdd':
    case 'reviewDelete':
    case 'reviewRestore':
      // The review session validates these against the video; they must carry the page's object.
      if (msg.raw !== raw || typeof msg.raw !== 'object' || msg.raw === null) {
        fail(surface, 'review message lost its original object', msg);
      }
      break;
  }
}

// A review edit that passes the session's validators must keep its promises.
function checkReview(raw: unknown, durationSec: number | undefined, fps: number): void {
  const bounds = { durationSec, fps };
  const error = reviewAddError(raw, bounds);
  if (isReviewAdd(raw, bounds) !== (error === null)) {
    fail('review', 'isReviewAdd and reviewAddError disagree', raw);
  }
  if (error === null) {
    const m = raw as Msg;
    const at = m.at as number;
    const out = m.out as number | undefined;
    const limit = durationSec !== undefined && durationSec > 0 ? durationSec + 1 / fps : Infinity;
    if (!Number.isFinite(at) || at < 0 || at > limit) {
      fail('review', 'accepted a time outside the video', raw);
    }
    if (out !== undefined && !(Number.isFinite(out) && out > at && out <= limit)) {
      fail('review', 'accepted a range end outside the video', raw);
    }
    if (typeof m.text !== 'string' || m.text.length > MAX_NOTE_TEXT) {
      fail('review', 'accepted note text over the limit', raw);
    }
    const point = m.point as number[] | undefined;
    if (
      point !== undefined &&
      !(Array.isArray(point) && point.length === 2 && point.every((n) => n >= 0 && n <= 1))
    ) {
      fail('review', 'accepted a pin outside the picture', raw);
    }
    const extra = Object.keys(m).find((k) => !['type', 'at', 'out', 'text', 'point'].includes(k));
    if (extra) {
      fail('review', 'accepted an unexpected field', raw);
    }
  }
  const id = (raw as Msg | null)?.id;
  if (isReviewDelete(raw, ['n1', 'n2']) && !(typeof id === 'string' && ['n1', 'n2'].includes(id))) {
    fail('review', 'accepted a delete for an unknown note', raw);
  }
}

function runAll(raw: unknown, durationSec?: number, fps = 30): void {
  for (const [surface, parse] of PARSERS) {
    const msg = parse(raw);
    if (msg !== undefined) {
      checkMessage(surface, raw, msg as Msg);
    }
  }
  checkReview(raw, durationSec, fps);
}

// ---------------------------------------------------------------------------
// Structured mode
// ---------------------------------------------------------------------------

const FIELDS = [
  'line',
  'column',
  'value',
  'key',
  'href',
  'text',
  'data',
  'name',
  'op',
  'index',
  'kind',
  'id',
  'at',
  'out',
  'point',
  'comments',
  'docKey',
  'startLine',
  'endLine',
  'original',
  'editId',
  'docVersion',
  'bodyHtml',
  'bodyXhtml',
];

const TOKENS = [
  ...THEMES,
  ...PREVIEW_TOGGLES,
  ...VIEWER_TOGGLES,
  ...GRID_OPS,
  'sound',
  'picture',
  'video.ffmpegPath',
  'pdf.browserPath',
  'tex.enginePath',
  '__proto__',
  'constructor',
  'https://example.com/a?b=c',
  'mailto:a@b.c',
  'javascript:alert(1)',
  'file:///etc/passwd',
  '//host/path',
  '../up.md#frag',
  'C:\\Windows\\win.ini',
  '#frag',
  'n1',
  'file:///w/notes.md',
  'a\nb',
];

function anyValue(fdp: FuzzedDataProvider, depth = 0): unknown {
  switch (fdp.consumeIntegralInRange(0, depth >= 2 ? 6 : 8)) {
    case 0:
      return fdp.consumeString(fdp.consumeIntegralInRange(0, 24));
    case 1:
      return fdp.consumeIntegralInRange(-3, 8);
    case 2:
      return fdp.consumeNumber();
    case 3:
      return fdp.consumeBoolean();
    case 4:
      return null;
    case 5:
      return undefined;
    case 6:
      return TOKENS[fdp.consumeIntegralInRange(0, TOKENS.length - 1)];
    case 7:
      return Array.from({ length: fdp.consumeIntegralInRange(0, 3) }, () =>
        anyValue(fdp, depth + 1),
      );
    default: {
      const obj: Record<string, unknown> = {};
      for (let i = fdp.consumeIntegralInRange(0, 3); i > 0; i--) {
        obj[TOKENS[fdp.consumeIntegralInRange(0, TOKENS.length - 1)]] = anyValue(fdp, depth + 1);
      }
      return obj;
    }
  }
}

function structured(data: Buffer): void {
  const fdp = new FuzzedDataProvider(data);
  const type = fdp.consumeBoolean()
    ? ALL_TYPES[fdp.consumeIntegralInRange(0, ALL_TYPES.length - 1)]
    : anyValue(fdp);
  const msg: Record<string, unknown> = { type };
  while (fdp.remainingBytes > 0 && fdp.consumeBoolean()) {
    msg[FIELDS[fdp.consumeIntegralInRange(0, FIELDS.length - 1)]] = anyValue(fdp);
  }
  const duration = fdp.consumeBoolean() ? undefined : fdp.consumeIntegralInRange(0, 600);
  runAll(msg, duration, fdp.consumeIntegralInRange(1, 120));
}

export function fuzz(data: Buffer): void {
  let parsed: unknown;
  let json = true;
  try {
    parsed = JSON.parse(data.toString('utf8'));
  } catch {
    json = false;
  }
  if (json) {
    runAll(parsed);
  }
  structured(data);
}
