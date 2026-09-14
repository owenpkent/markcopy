// The two pieces of behavior this PR touches, driven through the real bundle:
// the context menu's "Search Google for..." row, and a link click that the
// webview now intercepts from `document` instead of `#content`.
//
// tests/search.test.ts and the anchorHref/hostFollowsLink cases in
// tests/links.test.ts already pin the values these compute. What this adds is
// that the menu actually wires the row to selectionSearchText and posts the
// URL it names, and that a followed link's click never reaches the window --
// where VS Code's own webview shell listens and would otherwise show its own
// "open external website?" prompt on top of the one the host already handled.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { boot, type Harness } from '../webview/harness';
import { createMarkdownIt } from '../../src/render';
import { googleSearchUrl, searchLabel } from '../../src/webview/search';

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

beforeEach(() => {
  h.reset();
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

const PROSE_SOURCE = [
  'The golden retriever chased the ball across the yard.',
  '',
  'Tom & Jerry cartoons are still funny.',
  '',
  '[Docs](https://example.com/docs)',
  '',
].join('\n');
const PROSE_HTML = createMarkdownIt().render(PROSE_SOURCE);

/** The link whose href starts with `prefix`. */
function link(prefix: string): HTMLAnchorElement {
  const found = Array.from(h.content().querySelectorAll('a')).find((a) =>
    (a.getAttribute('href') ?? '').startsWith(prefix),
  );
  if (!found) {
    throw new Error(`no link with href starting ${prefix}`);
  }
  return found;
}

/** Select the first occurrence of `text` inside the rendered content. */
function selectText(text: string): void {
  const walker = document.createTreeWalker(h.content(), NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const idx = node.data.indexOf(text);
    if (idx >= 0) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
  }
  throw new Error(`no text node containing "${text}"`);
}

/** Dispatch a real left click, the way a pointer does, and hand back the event. */
function leftClick(target: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  target.dispatchEvent(event);
  return event;
}

/** The href on the last message posted, or '' if it did not carry one. */
function lastHref(): string {
  const last = h.posted.at(-1) as { href?: unknown } | undefined;
  return typeof last?.href === 'string' ? last.href : '';
}

describe('the Search Google row', () => {
  beforeEach(async () => {
    await h.render({ html: PROSE_HTML, source: PROSE_SOURCE, kind: 'markdown' });
  });

  it('shows a row for the selected words and posts the search URL for them', async () => {
    selectText('golden retriever');
    const menu = h.rightClick(h.content());
    const label = searchLabel('golden retriever');
    expect(label.startsWith('Search Google for “')).toBe(true);
    expect(menu.labels()).toContain(label);
    await menu.click(label);
    expect(h.posted.at(-1)).toEqual({
      type: 'openLink',
      href: googleSearchUrl('golden retriever'),
    });
  });

  it('offers no such row with nothing selected', () => {
    window.getSelection()?.removeAllRanges();
    const menu = h.rightClick(h.content());
    expect(menu.labels().some((label) => label.startsWith('Search Google for “'))).toBe(false);
  });

  it('percent-encodes an ampersand in the selected words', async () => {
    selectText('Tom & Jerry');
    const menu = h.rightClick(h.content());
    await menu.click(searchLabel('Tom & Jerry'));
    expect(lastHref()).toContain('%26');
  });
});

describe('link clicks', () => {
  beforeEach(async () => {
    await h.render({ html: PROSE_HTML, source: PROSE_SOURCE, kind: 'markdown' });
  });

  it('intercepts an http link, posts openLink, and keeps the shell from seeing it', () => {
    const anchor = link('https://example.com/docs');
    const shellSaw = vi.fn();
    window.addEventListener('click', shellSaw);
    const event = leftClick(anchor);
    window.removeEventListener('click', shellSaw);

    expect(event.defaultPrevented).toBe(true);
    expect(shellSaw).not.toHaveBeenCalled();
    expect(h.posted.at(-1)).toEqual({ type: 'openLink', href: 'https://example.com/docs' });
  });

  it('leaves a non-web scheme link alone for the shell to open', () => {
    const anchor = link('https://example.com/docs');
    // DOMPurify strips a vscode: href at render time (it is not on the allowed
    // scheme list), so the only way to put one in front of the click handler is
    // to set it directly on the already-rendered anchor.
    anchor.setAttribute('href', 'vscode:extension/foo.bar');
    const postedBefore = h.posted.length;
    const shellSaw = vi.fn();
    window.addEventListener('click', shellSaw);
    const event = leftClick(anchor);
    window.removeEventListener('click', shellSaw);

    expect(event.defaultPrevented).toBe(false);
    expect(shellSaw).toHaveBeenCalledTimes(1);
    expect(h.posted.length).toBe(postedBefore);
  });

  it('closes an open context menu and still posts openLink for a link inside it', () => {
    const anchor = link('https://example.com/docs');
    const menu = h.rightClick(h.content());
    expect(menu.open()).toBe(true);

    leftClick(anchor);

    expect(menu.open()).toBe(false);
    expect(h.posted.at(-1)).toEqual({ type: 'openLink', href: 'https://example.com/docs' });
  });
});
