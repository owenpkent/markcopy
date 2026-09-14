// What goes into a right-click "Search Google" query: the reader's selection,
// walked as words rather than serialized with Selection.toString(), and capped
// to what Google -- and a URL -- can actually use.
//
// The rationale lives in src/webview/search.ts; what is pinned here is that the
// walk visits exactly the text a reader sees (viewer chrome and KaTeX's hidden
// MathML twin left out, a block boundary turned into a word break even with no
// whitespace in the markup, everything else respected byte for byte), and that
// the cap can never hand encodeURIComponent half of a surrogate pair.
import { describe, it, expect, afterEach } from 'vitest';
import { selectionSearchText, truncate, searchLabel, googleSearchUrl } from '../src/webview/search';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

/** A container appended to the body, holding `html`. */
function mount(html: string): HTMLDivElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

/** Select the whole of `node`, the way a triple-click or Ctrl+A would. */
function selectAll(node: Node): void {
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.selectAllChildren(node);
}

/** Select from one point to another, the way a drag would. */
function selectRange(startNode: Node, startOffset: number, endNode: Node, endOffset: number): void {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

describe('selectionSearchText', () => {
  it('is empty with no selection at all', () => {
    expect(selectionSearchText(null)).toBe('');
    window.getSelection()?.removeAllRanges();
    expect(selectionSearchText(window.getSelection())).toBe('');
  });

  it('is empty for a collapsed selection', () => {
    const div = mount('hello world');
    const text = div.firstChild as Text;
    window.getSelection()?.collapse(text, 2);
    expect(selectionSearchText(window.getSelection())).toBe('');
  });

  it('collapses runs of whitespace and trims the ends', () => {
    const div = mount('  hello   world  ');
    selectAll(div);
    expect(selectionSearchText(window.getSelection())).toBe('hello world');
  });

  it('respects a partial selection inside a single text node', () => {
    const div = mount('hello world');
    const text = div.firstChild as Text;
    selectRange(text, 2, text, 5);
    expect(selectionSearchText(window.getSelection())).toBe('llo');
  });

  it('respects the start and end offsets of a selection spanning text nodes', () => {
    const div = mount('Hello <span>brave</span> world');
    const first = div.firstChild as Text; // "Hello "
    const last = div.lastChild as Text; // " world"
    selectRange(first, 2, last, 3);
    expect(selectionSearchText(window.getSelection())).toBe('llo brave wo');
  });

  it('inserts a word break between adjacent table cells', () => {
    const table = mount('<table><tr><td>a</td><td>b</td></tr></table>');
    const row = table.querySelector('tr') as HTMLElement;
    selectAll(row);
    expect(selectionSearchText(window.getSelection())).toBe('a b');
  });

  it('inserts a word break between paragraphs with no whitespace between them', () => {
    const div = mount('<p>a</p><p>b</p>');
    selectAll(div);
    expect(selectionSearchText(window.getSelection())).toBe('a b');
  });

  it('adds no break inside inline markup', () => {
    const div = mount('wo<b>rd</b>');
    selectAll(div);
    expect(selectionSearchText(window.getSelection())).toBe('word');
  });

  it('leaves out the hidden MathML twin KaTeX renders for an equation', () => {
    const div = mount(
      '<span class="katex"><span class="katex-mathml">MATHML</span>' +
        '<span class="katex-html">VISIBLE</span></span>',
    );
    selectAll(div);
    expect(selectionSearchText(window.getSelection())).toBe('VISIBLE');
  });

  it('leaves out viewer chrome marked data-mc-ignore', () => {
    const table = mount('<table><tr><th data-mc-ignore>1</th><td>data</td></tr></table>');
    const row = table.querySelector('tr') as HTMLElement;
    selectAll(row);
    expect(selectionSearchText(window.getSelection())).toBe('data');
  });

  it('caps a long selection at max characters', () => {
    const div = mount('x'.repeat(300));
    selectAll(div);
    expect(selectionSearchText(window.getSelection(), 10)).toBe('x'.repeat(10));
  });

  it('never leaves a lone surrogate when the raw budget lands inside an emoji', () => {
    // The raw code-unit budget is max*2 (here 10): nine plain characters put it
    // one unit into the emoji that follows, on the high surrogate, without its
    // low-surrogate partner. What is pinned here is that the result never
    // carries that half a character forward.
    const div = mount('a'.repeat(9) + '\u{1F600}' + 'z'.repeat(50));
    selectAll(div);
    const result = selectionSearchText(window.getSelection(), 5);
    expect(/[\uD800-\uDFFF]/.test(result)).toBe(false);
    expect(() => encodeURIComponent(result)).not.toThrow();
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('trims trailing whitespace exposed by the cut', () => {
    expect(truncate('hi there', 3)).toBe('hi');
  });

  it('keeps a whole emoji rather than splitting its surrogate pair', () => {
    expect(truncate('ab\u{1F600}cd', 3)).toBe('ab\u{1F600}');
  });

  it('drops a lone trailing surrogate rather than emitting one', () => {
    // The shape a caller could hand in after slicing a string by code unit
    // instead of by character, which is exactly what appendRange in search.ts
    // takes care to avoid upstream.
    expect(truncate('abcd\uD83D', 10)).toBe('abcd');
  });
});

describe('searchLabel', () => {
  it('shows a short query with no ellipsis', () => {
    expect(searchLabel('hi')).toBe('Search Google for “hi”');
  });

  it('cuts a long query to 30 characters and adds an ellipsis', () => {
    const query = 'a'.repeat(40);
    expect(searchLabel(query)).toBe(`Search Google for “${'a'.repeat(30)}…”`);
  });

  it('keeps a whole emoji at the 30-character boundary', () => {
    const query = 'a'.repeat(29) + '\u{1F600}' + 'bbbb';
    expect(searchLabel(query)).toBe(`Search Google for “${'a'.repeat(29)}\u{1F600}…”`);
  });
});

describe('googleSearchUrl', () => {
  it('encodes an ampersand', () => {
    expect(googleSearchUrl('AT&T')).toBe('https://www.google.com/search?q=AT%26T');
  });

  it('encodes plus signs', () => {
    expect(googleSearchUrl('C++')).toBe('https://www.google.com/search?q=C%2B%2B');
  });
});
