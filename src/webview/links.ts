// Recognising the two values a reader most often wants off a preview and has no
// good way to take today: an email address and a URL.
//
// Both are reachable by hand -- drag across the text, copy the selection -- and
// both are exactly the kind of value a hand-drag gets wrong, because a missed
// character at either end is invisible until the paste fails somewhere else. So
// the menu offers them whole, and this module is where "whole" is decided.
//
// Two sources feed it. A rendered link carries its target in the href, which is
// the authoritative answer and the one prose gets, since the renderer autolinks
// bare emails and schemed URLs (linkify in src/render.ts). A grid cell carries
// nothing but text: CSV and spreadsheet cells are rendered verbatim, deliberately
// so, which leaves the address in them as plain characters no href can be read
// off. Hence the second entry point.

/** Which of the two things a ref is, and so what the menu calls it. */
export type LinkKind = 'email' | 'url';

export interface LinkRef {
  kind: LinkKind;
  /**
   * The bare value: an address without its `mailto:` wrapper, or the URL. What
   * "Copy Email Address" / "Copy Link" puts on the clipboard.
   */
  value: string;
  /**
   * The address as a link would write it. Equal to `value` for a URL, and
   * `mailto:…` for an email, which is why the two are separate fields: the
   * mailto form is the one a Markdown link needs and the bare one is what a
   * reader pastes into a To: field.
   */
  href: string;
}

/**
 * The trailing characters a sentence puts after a URL rather than in it.
 *
 * Text matching has to guess where a URL ends, and the guess that a period ends
 * the sentence rather than the hostname is right far more often than not.
 * Closing brackets go too, on the same reasoning; a URL with an unpaired `)` in
 * it loses that character, which is the accepted cost of not swallowing the one
 * that closes "(see https://example.com)".
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"`)\]}>]+$/;

// Deliberately narrower than what an SMTP server would take. This runs over
// arbitrary cell text, so a pattern that accepts every legal address at the cost
// of matching things that are not addresses would put a confident "Copy Email
// Address" row on the menu for text that has no address in it.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)+/;

// `www.` earns its place here even though the renderer stops autolinking it
// (see linkify in src/render.ts): the reason it is not a link is that firing it
// at the OS was a bad guess, which says nothing about whether someone wants to
// copy it.
const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"'`]+/;

/**
 * What a link's `href` points at, or null when it points at nothing worth
 * copying.
 *
 * Takes the href as written rather than the browser's resolved `.href`. Inside a
 * webview a relative link resolves against a `vscode-webview://` origin, so the
 * resolved form of `./notes.md` is a URL that means nothing anywhere else, while
 * the written form is the one the document says and the one that survives a
 * paste back into the source.
 */
export function refFromHref(href: string): LinkRef | null {
  const trimmed = href.trim();
  // A bare `#heading` is a scroll, not an address.
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  const mailto = /^mailto:/i.exec(trimmed);
  if (!mailto) {
    return { kind: 'url', value: trimmed, href: trimmed };
  }
  // `mailto:` carries the address ahead of any `?subject=…`, percent-encoded.
  // The recipient list is kept whole when there is more than one: a menu row
  // that silently dropped every address but the first would be worse than one
  // that copies what the link says.
  const address = decode(trimmed.slice(mailto[0].length).split('?')[0]).trim();
  return address ? { kind: 'email', value: address, href: trimmed } : null;
}

/**
 * The first email address or URL in a run of plain text, or null if it holds
 * neither.
 *
 * "First" is by position, so a URL with an address in its path is read as the
 * URL it is rather than as the address it contains.
 */
export function refFromText(text: string): LinkRef | null {
  const email = EMAIL.exec(text);
  const url = URL_IN_TEXT.exec(text);
  if (url && (!email || url.index < email.index)) {
    const value = url[0].replace(TRAILING_PUNCTUATION, '');
    // A match that was nothing but punctuation cannot happen (both patterns
    // require a hostname character first), so `value` is always non-empty here.
    return {
      kind: 'url',
      value,
      href: /^https?:/i.test(value) ? value : `https://${value}`,
    };
  }
  if (email) {
    // The sentence's full stop is not part of the domain.
    const value = email[0].replace(/\.+$/, '');
    return { kind: 'email', value, href: `mailto:${value}` };
  }
  return null;
}

/** What the menu calls a ref, as a noun that reads after "Copy". */
export function nounFor(ref: LinkRef): string {
  return ref.kind === 'email' ? 'Email Address' : 'Link';
}

// A malformed escape (`%zz`, or a stray `%`) throws rather than decoding. The
// href still names an address in that case, so hand back what it says instead of
// dropping the row.
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * A `[text](href)` link, escaped enough to survive being pasted back into a
 * document.
 *
 * Brackets in the text would end the label early. Parentheses and whitespace in
 * the address would end the target early, and are percent-encoded rather than
 * wrapped in `<…>`: the angle-bracket form ends at the first `>`, so an href
 * holding both a paren and a `>` would paste as a link pointing somewhere the
 * reader never saw. Percent-escapes mean the same thing to whatever opens the
 * link and have no character that can close them early.
 */
export function markdownLink(text: string, href: string): string {
  const label = text.replace(/([[\]])/g, '\\$1');
  const target = href.replace(/[()\s]/g, (char) =>
    char === '(' ? '%28' : char === ')' ? '%29' : encodeURIComponent(char),
  );
  return `[${label}](${target})`;
}
