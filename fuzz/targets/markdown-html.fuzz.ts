import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createMarkdownIt } from '../../src/render';

// The webview runs `DOMPurify.sanitize(html)` with its defaults on whatever the
// host rendered (src/webview/main.ts), and that is the only gate between raw
// HTML in a document and the preview. Everything is built once: construction is
// slow next to a render and takes no untrusted input.
const md = createMarkdownIt();
const mdPlain = createMarkdownIt({ math: false, footnotes: false });

const { window } = new JSDOM('');
const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);

// Each sanitize leaves a jsdom document behind, and V8 lets that garbage pile up
// to gigabytes before it collects, past the fuzzer's memory limit. So collect on
// a schedule.
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;
const COLLECT_EVERY = 200;
let sanitized = 0;

const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data', 'poster'];
const SCRIPT_URL = /^(?:javascript|vbscript):/i;

// A browser ignores tabs, newlines and control characters inside a scheme.
function stripControls(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code > 0x20 && (code < 0x7f || code > 0x9f)) {
      out += ch;
    }
  }
  return out;
}

// A manual walk, not querySelectorAll: under the fuzzer jsdom's selector engine
// retains memory on every call and runs the process out of it in seconds.
function descendants(root: ParentNode): Element[] {
  const found: Element[] = [];
  const walk = (node: ParentNode): void => {
    for (const child of Array.from(node.children)) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function check(html: string): void {
  if (++sanitized % COLLECT_EVERY === 0) {
    collect();
  }
  // The fragment DOMPurify built, not its serialization re-parsed, so the check
  // sees exactly what sanitizing kept.
  const fragment = purify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
  const clean = () => JSON.stringify(new window.XMLSerializer().serializeToString(fragment));
  for (const el of descendants(fragment)) {
    if (el.localName === 'script') {
      throw new Error(`<script> survived sanitizing: ${clean()}`);
    }
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) {
        throw new Error(`${attr.name} survived sanitizing: ${clean()}`);
      }
      if (
        URL_ATTRS.includes(attr.name.toLowerCase()) &&
        SCRIPT_URL.test(stripControls(attr.value))
      ) {
        throw new Error(`${attr.name}=${attr.value} survived sanitizing: ${clean()}`);
      }
    }
  }
}

export function fuzz(data: Buffer): void {
  const text = data.toString('utf8');
  check(md.render(text));
  check(mdPlain.render(text));
}
