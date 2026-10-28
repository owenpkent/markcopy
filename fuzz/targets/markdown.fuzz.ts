import { createMarkdownIt } from '../../src/render';

// The parser is built once: construction is slow next to a render and is not
// what takes untrusted input. markdown-it does not throw on any input.
const md = createMarkdownIt();
const mdPlain = createMarkdownIt({ math: false, footnotes: false });

export function fuzz(data: Buffer): void {
  const text = data.toString('utf8');
  md.render(text);
  mdPlain.render(text);
}
