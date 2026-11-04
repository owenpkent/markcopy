import { decodeImage } from '../../src/docx/media';
import { htmlToMarkdown } from '../../src/webview/markdownConvert';
import { isDominoParserBug } from './expected';

// Turndown picks its own DOM in Node (domino), so no jsdom is needed here.
// htmlToMarkdown is async, so this target is too; Jazzer.js awaits the promise.
export async function fuzz(data: Buffer): Promise<void> {
  const text = data.toString('utf8');
  decodeImage(text);
  decodeImage(`data:image/png;base64,${text}`);
  decodeImage(`data:image/gif,${text}`);
  try {
    await htmlToMarkdown(text);
  } catch (err) {
    // A parser bug inside domino (Node only; the webview uses DOMParser).
    if (!isDominoParserBug(err)) throw err;
  }
}
