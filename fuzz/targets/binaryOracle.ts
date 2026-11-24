// What a file-information page (an executable or a package) must satisfy for
// any input, shared by the pe, pkg and file-source targets. An error is not
// the only way a reader fails, so these turn the other ways into findings:
//
// - Cost. The first pkg target ran half a million inputs clean while a
//   642-byte file could take the extension host to 4 GB, because a reader that
//   spends a gigabyte and returns a small page throws nothing. Memory is the
//   JavaScript heap and array buffers together: every Uint8Array a reader or a
//   decompressor allocates lives outside the heap, where `heapUsed` alone (what
//   this target measured until 2026-11-23) does not see it.
// - Markup. The page is built from escaped text and a fixed set of tags; any
//   other tag, attribute, or a `<` that does not open one is text from the file
//   that escaped escaping.
// - Content. A value that came out as `[native code]`, `[object Object]`,
//   `undefined`, `NaN` or `Infinity`, when the file holds no such text, is the
//   program speaking, not the file: a lookup that reached Object.prototype (the
//   bug that found this check, see docs/FUZZING-STRATEGY.md), a field read
//   before it was set, or arithmetic on a missing number.
//
// The limits are far above what any input the fuzzer can produce should need
// (a real 900 MB installer reads in 25 ms), so a slow CI machine does not trip
// them.
export const MAX_MILLISECONDS = 3000;
export const MAX_HTML_CHARS = 4 * 1024 * 1024;
export const MAX_HEAP_GROWTH = 256 * 1024 * 1024;

/** Thrown when an input was read without error but cost more than a preview may. */
export class CostError extends Error {}

/** Thrown when a page holds markup or text the renderers never write. */
export class PageError extends Error {}

/** The JavaScript heap and the array buffers behind typed arrays, in bytes. */
export function memoryInUse(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/** Start measuring one read; call the result when it is done. */
export function startCost(label: string, inputBytes: number): (html: string) => void {
  const started = performance.now();
  const memory = memoryInUse();
  return (html: string) => {
    const took = performance.now() - started;
    const grew = memoryInUse() - memory;
    if (took > MAX_MILLISECONDS) {
      throw new CostError(`${label}: ${inputBytes} bytes took ${Math.round(took)} ms to read`);
    }
    if (html.length > MAX_HTML_CHARS) {
      throw new CostError(`${label}: ${inputBytes} bytes made a page of ${html.length} characters`);
    }
    if (grew > MAX_HEAP_GROWTH) {
      throw new CostError(
        `${label}: ${inputBytes} bytes grew memory by ${Math.round(grew / 1048576)} MB`,
      );
    }
  };
}

// Every tag and attribute src/binary/html.ts, src/pe/render.ts and
// src/pkg/render.ts write. A renderer that starts writing another adds it here.
const TAGS = new Set([
  'div',
  'h1',
  'h2',
  'p',
  'strong',
  'br',
  'code',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'img',
]);
const ATTRIBUTES: Record<string, RegExp> = {
  class: /^[a-z0-9 -]+$/,
  alt: /^[A-Za-z ]+$/,
  width: /^\d+$/,
  height: /^\d+$/,
  'data-mc-media': /^[a-z0-9-]+$/,
};
const TAG = /^<(\/?)([a-z0-9]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*>$/;
const ATTRIBUTE = /\s+([a-z-]+)="([^"]*)"/g;

const ENGINE_TEXT = ['[native code]', '[object ', 'undefined', 'NaN', 'Infinity'];

/** Whether the file itself holds `text`, in a single-byte or a UTF-16 encoding. */
function fileHolds(input: Uint8Array, text: string): boolean {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return bytes.includes(text, 0, 'latin1') || bytes.includes(text, 0, 'utf16le');
}

/** Throws a PageError when `html` holds markup or engine text it should not. */
export function checkPage(label: string, html: string, input: Uint8Array): void {
  for (let at = html.indexOf('<'); at >= 0; at = html.indexOf('<', at + 1)) {
    const end = html.indexOf('>', at);
    const tag = end < 0 ? html.slice(at, at + 80) : html.slice(at, end + 1);
    const match = TAG.exec(tag);
    if (!match || !TAGS.has(match[2])) {
      throw new PageError(`${label}: unexpected markup ${JSON.stringify(tag.slice(0, 120))}`);
    }
    for (const [, name, value] of match[3].matchAll(ATTRIBUTE)) {
      const allowed = ATTRIBUTES[name];
      if (!Object.hasOwn(ATTRIBUTES, name) || !allowed.test(value)) {
        throw new PageError(
          `${label}: unexpected attribute ${JSON.stringify(`${name}="${value}"`.slice(0, 120))}`,
        );
      }
    }
  }
  const text = html.replace(/<[^>]*>/g, ' ');
  for (const word of ENGINE_TEXT) {
    const found = word.startsWith('[')
      ? text.includes(word)
      : new RegExp(`\\b${word}\\b`).test(text);
    if (found && !fileHolds(input, word.replace(/ $/, ''))) {
      const at = text.indexOf(word);
      throw new PageError(
        `${label}: the page says ${JSON.stringify(word)} and the file does not (${JSON.stringify(text.slice(Math.max(0, at - 60), at + 60))})`,
      );
    }
  }
}
