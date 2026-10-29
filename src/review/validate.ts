// The checks a video-review message from the webview must pass before the host
// acts on it. Pure, so they can be unit-tested and fuzzed without `vscode`.
import type { ReviewWebviewMessage } from './protocol';

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isString = (v: unknown): v is string => typeof v === 'string';
export const isUnit = (v: unknown): boolean => isNumber(v) && v >= 0 && v <= 1;
export const isPair = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 2 && v.every(isUnit);

/** Longest note text a page may send. */
export const MAX_NOTE_TEXT = 10_000;

/** What the validators check times against. `durationSec` is absent when unknown. */
export interface ReviewBounds {
  durationSec?: number;
  fps: number;
}

type AddMessage = Extract<ReviewWebviewMessage, { type: 'reviewAdd' }>;
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

export function isReviewDelete(msg: unknown, ids: readonly string[]): msg is DeleteMessage {
  return isObject(msg) && !extraKey(msg, ['type', 'id']) && knownId(msg.id, ids);
}

export function isReviewRestore(msg: unknown): msg is RestoreMessage {
  return isObject(msg) && !extraKey(msg, ['type']);
}
