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

/**
 * domino, the DOM turndown uses under Node, throws a TypeError from its HTML
 * parser on some malformed input (an <input> in a table with a valueless
 * `type`). It is a third-party bug in code the shipped webview never loads (the
 * browser's DOMParser is used there), so it is not a finding. Only a TypeError
 * whose stack is inside domino matches; one raised by MarkCopy's own code
 * carries a different stack and still propagates.
 */
export function isDominoParserBug(err: unknown): boolean {
  return err instanceof TypeError && /@mixmark-io.domino./.test(err.stack ?? '');
}
