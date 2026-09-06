// What counts as an address, and what comes off it.
//
// The menu rows these feed are wired up in tests/e2e/copyLink.e2e.test.ts; what
// is pinned here is the value itself, because every one of these cases is a way
// a copied address can be wrong in a manner nobody notices until the paste lands
// somewhere else: a `mailto:` left on the front, a sentence's full stop stuck to
// the end, a percent-escape never decoded.
import { describe, it, expect } from 'vitest';
import { refFromHref, refFromText, nounFor, markdownLink } from '../src/webview/links';

describe('refFromHref', () => {
  it('reads the bare address out of a mailto:', () => {
    expect(refFromHref('mailto:bob@example.com')).toEqual({
      kind: 'email',
      value: 'bob@example.com',
      href: 'mailto:bob@example.com',
    });
  });

  it('drops the headers a mailto: carries after the address', () => {
    // A `?subject=` is for the mail client, not for the To: field this is
    // pasted into.
    expect(refFromHref('mailto:bob@example.com?subject=Hi%20there')?.value).toBe('bob@example.com');
  });

  it('decodes an escaped address', () => {
    expect(refFromHref('mailto:bob%2Bnews@example.com')?.value).toBe('bob+news@example.com');
  });

  it('keeps every recipient of a multi-address mailto:', () => {
    // Copying only the first would be a silent edit of what the link says.
    expect(refFromHref('mailto:a@example.com,b@example.com')?.value).toBe(
      'a@example.com,b@example.com',
    );
  });

  it('hands back a malformed escape rather than dropping the link', () => {
    // decodeURIComponent throws on this. The href still names an address.
    expect(refFromHref('mailto:bob%zz@example.com')?.value).toBe('bob%zz@example.com');
  });

  it('takes a URL as written', () => {
    expect(refFromHref('https://example.com/a?b=1#c')).toEqual({
      kind: 'url',
      value: 'https://example.com/a?b=1#c',
      href: 'https://example.com/a?b=1#c',
    });
  });

  it('keeps a relative link in the form the document wrote it', () => {
    // Resolving this inside the webview would produce a vscode-webview:// URL
    // that means nothing anywhere else.
    expect(refFromHref('./notes.md')?.value).toBe('./notes.md');
  });

  it('has nothing to offer for an in-page anchor or an empty href', () => {
    expect(refFromHref('#heading')).toBeNull();
    expect(refFromHref('   ')).toBeNull();
    expect(refFromHref('mailto:')).toBeNull();
  });
});

describe('refFromText', () => {
  it('finds an address in the middle of a cell', () => {
    expect(refFromText('Bob Smith <bob@example.com> (sales)')).toEqual({
      kind: 'email',
      value: 'bob@example.com',
      href: 'mailto:bob@example.com',
    });
  });

  it('leaves the sentence full stop out of the domain', () => {
    expect(refFromText('Write to bob@example.com.')?.value).toBe('bob@example.com');
  });

  it('finds a URL and gives it a scheme when it lacks one', () => {
    // The renderer stops short of autolinking `www.` text (see linkify in
    // src/render.ts), which is why this is worth matching here.
    expect(refFromText('see www.example.com/docs')).toEqual({
      kind: 'url',
      value: 'www.example.com/docs',
      href: 'https://www.example.com/docs',
    });
  });

  it('leaves the bracket that closes the sentence out of the URL', () => {
    expect(refFromText('(see https://example.com/a)')?.value).toBe('https://example.com/a');
  });

  it('reads a URL with an address in its path as the URL', () => {
    expect(refFromText('https://example.com/u/bob@example.com')?.kind).toBe('url');
  });

  it('finds nothing in text that holds neither', () => {
    expect(refFromText('Widget, 3 in stock')).toBeNull();
    expect(refFromText('not.an.address@')).toBeNull();
    expect(refFromText('')).toBeNull();
  });
});

describe('nounFor', () => {
  it('names each kind the way the menu row reads', () => {
    expect(nounFor({ kind: 'email', value: 'a@b.co', href: 'mailto:a@b.co' })).toBe(
      'Email Address',
    );
    expect(nounFor({ kind: 'url', value: 'https://b.co', href: 'https://b.co' })).toBe('Link');
  });
});

describe('markdownLink', () => {
  it('leaves an ordinary address alone', () => {
    expect(markdownLink('the docs', 'https://example.com/a')).toBe(
      '[the docs](https://example.com/a)',
    );
  });

  it('escapes brackets in the text, which would end the label early', () => {
    expect(markdownLink('see [1]', 'https://example.com')).toBe(
      '[see \\[1\\]](https://example.com)',
    );
  });

  it('percent-encodes the parentheses and spaces that would end the target early', () => {
    expect(markdownLink('wiki', 'https://example.com/Foo_(bar)')).toBe(
      '[wiki](https://example.com/Foo_%28bar%29)',
    );
    expect(markdownLink('file', 'https://example.com/my file.pdf')).toBe(
      '[file](https://example.com/my%20file.pdf)',
    );
  });

  // The angle-bracket form this used to take ends at the first `>`, so an href
  // holding one alongside a paren pasted as a link pointing somewhere else
  // entirely. Only reachable from a real href, which is what the menu feeds it.
  it('survives an address holding both a paren and an angle bracket', () => {
    expect(markdownLink('odd', 'https://example.com/a(b)>c')).toBe(
      '[odd](https://example.com/a%28b%29>c)',
    );
  });
});
