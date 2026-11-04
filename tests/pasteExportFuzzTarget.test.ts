// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fuzz } from '../fuzz/targets/paste-export.fuzz';
import { isDominoParserBug } from '../fuzz/targets/expected';

// Found by the nightly fuzz run (paste-export, 2026-11-04): an <input> in a
// table with a valueless `type` attribute makes domino's getTypeAttr throw a
// TypeError. domino only runs under Node; the webview bundle parses with the
// browser's DOMParser, so users cannot reach it. The Node environment above
// matters: under jsdom turndown would not load domino.
const CRASH = Buffer.from(
  'PHRhYmxlPjx0YWJsZT5wcm90by8vLy8vLy8v/zxpbnB1dCB0eXBlLy8vL/88aW5wdXQgdHlwZT0iY2hlY2tib3giIGM9ImNoZWNrYm94IiBjaGVja2VkPi8vdHlwZTx0YWJsZT4=',
  'base64',
);

describe('paste-export fuzz target', () => {
  it('treats the domino getTypeAttr TypeError as a third-party bug, not a finding', async () => {
    await expect(fuzz(CRASH)).resolves.toBeUndefined();
  });

  it('only filters TypeErrors whose stack is inside domino', () => {
    const own = new TypeError('Cannot read properties of undefined');
    own.stack = 'TypeError: x\n    at htmlToMarkdown (src/webview/markdownConvert.ts:1:1)';
    expect(isDominoParserBug(own)).toBe(false);
    expect(isDominoParserBug(new RangeError('x'))).toBe(false);
    const domino = new TypeError('x');
    domino.stack =
      'TypeError: x\n    at getTypeAttr (node_modules/@mixmark-io/domino/lib/HTMLParser.js:1:1)';
    expect(isDominoParserBug(domino)).toBe(true);
  });
});
