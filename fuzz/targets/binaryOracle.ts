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

/** Whether `text` holds a C0 control character or DEL, which every reader's cleaning removes. */
export function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

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
  'ul',
  'li',
]);
const ATTRIBUTES: Record<string, RegExp> = {
  class: /^[a-z0-9 -]+$/,
  alt: /^[A-Za-z ]+$/,
  width: /^\d+$/,
  height: /^\d+$/,
  'data-mc-media': /^[a-z0-9-]+$/,
  role: /^[a-z]+$/,
};
const TAG = /^<(\/?)([a-z0-9]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*>$/;
const ATTRIBUTE = /\s+([a-z-]+)="([^"]*)"/g;

// The encrypted-container readers (7z, RAR, OpenPGP, age, KeePass, LUKS, key files) show only what a
// file states in the clear: algorithm names, parameters, counts. The seeds' salts, IVs, nonces and wrapped
// keys are filled with one marker byte (tests/pkg/encryptionFixture.ts), so an input that holds a run of
// it and a page that holds it, as hex or as base64, is key material that reached the page.
const SECRET_BYTE = 0xab;
const SECRET_RUN = 12;
const SECRET_FORMS = ['abababababababababab', 'q6urq6urq6urq6ur'];

function holdsSecretRun(input: Uint8Array): boolean {
  let run = 0;
  for (const byte of input) {
    run = byte === SECRET_BYTE ? run + 1 : 0;
    if (run >= SECRET_RUN) {
      return true;
    }
  }
  return false;
}

const ENGINE_TEXT = ['[native code]', '[object ', 'undefined', 'NaN', 'Infinity'];

/** Whether the file itself holds `text`, in a single-byte or a UTF-16 encoding. */
function fileHolds(input: Uint8Array, text: string): boolean {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return bytes.includes(text, 0, 'latin1') || bytes.includes(text, 0, 'utf16le');
}

/**
 * Every string value (never a key) in what a reader returned. The page shows
 * decoded and cleaned text (a decompressed .PKGINFO, a version string with its
 * bidi controls stripped), which the raw bytes do not hold, so a word the
 * reader's own output carries as text came from the file. A word that appears
 * only in the page was made by the renderer.
 */
export function decodedStrings(value: unknown): string {
  const out: string[] = [];
  const seen = new Set<object>();
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      out.push(v);
    } else if (v !== null && typeof v === 'object' && !ArrayBuffer.isView(v) && !seen.has(v)) {
      seen.add(v);
      const items = v instanceof Map || v instanceof Set ? [...v.values()] : Object.values(v);
      if (v instanceof Map) {
        items.push(...v.keys());
      }
      items.forEach(visit);
    }
  };
  visit(value);
  return out.join('\n');
}

/**
 * Throws a PageError when `html` holds markup or engine text it should not.
 * `decoded` is what the reader returned: engine text is allowed when the file's
 * raw bytes or the reader's decoded strings hold it.
 */
export function checkPage(
  label: string,
  html: string,
  input: Uint8Array,
  decoded: unknown = undefined,
): void {
  const readerText = decodedStrings(decoded);
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
        // Reported as data, not rebuilt as `name="value"`: the message is for
        // a person reading a fuzz finding and is never put into a page.
        throw new PageError(
          `${label}: unexpected attribute ${JSON.stringify({ name, value: value.slice(0, 120) })}`,
        );
      }
    }
  }
  const text = html.replace(/<[^>]*>/g, ' ');
  for (const word of ENGINE_TEXT) {
    const found = word.startsWith('[')
      ? text.includes(word)
      : new RegExp(`\\b${word}\\b`).test(text);
    const bare = word.replace(/ $/, '');
    const fromReader = word.startsWith('[')
      ? readerText.includes(bare)
      : new RegExp(`\\b${word}\\b`).test(readerText);
    if (found && !fileHolds(input, bare) && !fromReader) {
      const at = text.indexOf(word);
      throw new PageError(
        `${label}: the page says ${JSON.stringify(word)} and the file does not (${JSON.stringify(text.slice(Math.max(0, at - 60), at + 60))})`,
      );
    }
  }
}

/** The formats that show only what a file states in the clear (src/pkg/labels.ts). */
const CONTAINER = /7-Zip|RAR|KeePass|LUKS|\bage\b|OpenPGP|PKCS#12|PEM/;

/**
 * Throws a PageError when the page of an encrypted container or key file shows the marker that
 * stands in for a salt, IV or key in the seeds. `format` is the format the reader gave the file.
 */
export function checkNoSecrets(
  label: string,
  format: string,
  html: string,
  input: Uint8Array,
  decoded: unknown = undefined,
): void {
  if (!CONTAINER.test(format)) {
    return;
  }
  const readerText = decodedStrings(decoded);
  if (holdsSecretRun(input)) {
    // A method ID (7z), a cipher or KDF ID (KeePass) and a key ID (OpenPGP) are public identifiers the
    // readers print as hex on purpose, and a mutated file can put the marker in one of those fields.
    const shown = (html + '\n' + readerText)
      .replace(/<[^>]*>/g, ' ')
      .replace(/method [0-9a-f]+|\(id [0-9a-f]+\)|key ID 0x[0-9A-Fa-f]+/g, ' ');
    for (const form of SECRET_FORMS) {
      const hex = form.startsWith('a');
      const where = (hex ? shown.toLowerCase() : shown).indexOf(form);
      if (where >= 0 && !fileHolds(input, form) && !fileHolds(input, form.toUpperCase())) {
        throw new PageError(
          `${label}: the page shows key-material marker bytes (${hex ? 'hex' : 'base64'})`,
        );
      }
    }
  }
}
