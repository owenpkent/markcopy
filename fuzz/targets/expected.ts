// Which exceptions are the code's documented answer to bad input, and so not
// findings. Everything else (TypeError, RangeError, a stack overflow, and so
// on) propagates to Jazzer.js and is reported as a crash.
import { OpcError } from '../../src/ooxml/zip';

// saxes reports malformed XML as a plain Error whose message starts with the
// position, such as "1:5: unclosed tag."; there is no error class to match.
const SAX_ERROR = /^\d+:\d+: /;

export function isExpectedXmlError(err: unknown): boolean {
  return err instanceof Error && SAX_ERROR.test(err.message);
}

/** A refusal from openZip (not a zip, limit exceeded, no workbook part, and so on). */
export function isExpectedOoxmlError(err: unknown): boolean {
  return err instanceof OpcError || isExpectedXmlError(err);
}
