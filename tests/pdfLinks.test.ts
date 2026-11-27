// Link handling for the PDF viewer: destination resolution, link targets, link
// placement (src/webview/pdfLinks.ts) and the host-side address check that
// stands between a webview message and vscode.env.openExternal.
import { describe, expect, it, vi } from 'vitest';
import {
  linkBox,
  linkTargetOf,
  namedActionPage,
  resolveDestination,
} from '../src/webview/pdfLinks';
import { MAX_LINK_URL_LENGTH, parseLinkUrl } from '../src/pdfLinkUrl';
import { parsePdfMessage } from '../src/messages/pdf';
import { parseTexMessage } from '../src/messages/tex';

const REF = { num: 7, gen: 0 };

function fakeDoc() {
  return {
    getDestination: vi.fn(async (name: string) =>
      name === 'chap2' ? [REF, { name: 'XYZ' }, 72, 600, null] : null,
    ),
    getPageIndex: vi.fn(async () => 3),
  };
}

describe('resolveDestination', () => {
  it('resolves a named destination to its page and position', async () => {
    expect(await resolveDestination(fakeDoc(), 'chap2')).toEqual({
      pageIndex: 3,
      left: 72,
      top: 600,
    });
  });

  it('resolves an explicit destination array', async () => {
    expect(await resolveDestination(fakeDoc(), [REF, { name: 'Fit' }])).toEqual({
      pageIndex: 3,
      left: null,
      top: null,
    });
  });

  it('reads the position out of each destination type', async () => {
    const doc = fakeDoc();
    const at = (...rest: unknown[]) => resolveDestination(doc, [REF, ...rest]);
    expect(await at({ name: 'FitH' }, 500)).toMatchObject({ left: null, top: 500 });
    expect(await at({ name: 'FitBH' }, 480)).toMatchObject({ left: null, top: 480 });
    expect(await at({ name: 'FitV' }, 20)).toMatchObject({ left: 20, top: null });
    expect(await at({ name: 'FitR' }, 10, 20, 30, 40)).toMatchObject({ left: 10, top: 40 });
    expect(await at({ name: 'XYZ' }, null, null, null)).toMatchObject({ left: null, top: null });
    expect(await at({ name: 'XYZ' }, 'x', Infinity)).toMatchObject({ left: null, top: null });
  });

  it('takes a plain integer as a 0-based page index', async () => {
    const doc = fakeDoc();
    expect(await resolveDestination(doc, [2, { name: 'Fit' }])).toMatchObject({ pageIndex: 2 });
    expect(doc.getPageIndex).not.toHaveBeenCalled();
  });

  it('returns null for what it cannot place', async () => {
    const doc = fakeDoc();
    expect(await resolveDestination(doc, 'nope')).toBeNull();
    expect(await resolveDestination(doc, null)).toBeNull();
    expect(await resolveDestination(doc, [])).toBeNull();
    expect(await resolveDestination(doc, ['x', { name: 'Fit' }])).toBeNull();
    expect(await resolveDestination(doc, [-1])).toBeNull();
    expect(await resolveDestination(doc, [1.5])).toBeNull();
  });

  it('rejects a page past the end of the document', async () => {
    expect(await resolveDestination(fakeDoc(), [REF], 3)).toBeNull();
    expect(await resolveDestination(fakeDoc(), [REF], 4)).toMatchObject({ pageIndex: 3 });
  });

  it('returns null when the document throws', async () => {
    const doc = {
      getDestination: vi.fn(async () => {
        throw new Error('bad');
      }),
      getPageIndex: vi.fn(async () => {
        throw new Error('bad');
      }),
    };
    expect(await resolveDestination(doc, 'x')).toBeNull();
    expect(await resolveDestination(doc, [REF])).toBeNull();
  });
});

describe('linkTargetOf', () => {
  it('follows http, https and mailto links', () => {
    expect(linkTargetOf({ subtype: 'Link', url: 'https://example.com/a' })).toEqual({
      kind: 'url',
      url: 'https://example.com/a',
    });
    expect(linkTargetOf({ subtype: 'Link', url: 'mailto:a@example.com' })).toMatchObject({
      kind: 'url',
    });
  });

  it('drops any other scheme, and a link that carries a URL never falls back to a dest', () => {
    expect(linkTargetOf({ subtype: 'Link', url: 'javascript:alert(1)' })).toBeNull();
    expect(linkTargetOf({ subtype: 'Link', url: 'file:///C:/x.exe' })).toBeNull();
    expect(linkTargetOf({ subtype: 'Link', url: 'ftp://x/y', dest: 'a' })).toBeNull();
  });

  it('returns internal destinations and named actions', () => {
    expect(linkTargetOf({ subtype: 'Link', dest: 'chap2' })).toEqual({
      kind: 'dest',
      dest: 'chap2',
    });
    expect(linkTargetOf({ subtype: 'Link', dest: [REF, { name: 'Fit' }] })).toMatchObject({
      kind: 'dest',
    });
    expect(linkTargetOf({ subtype: 'Link', action: 'NextPage' })).toEqual({
      kind: 'named',
      action: 'NextPage',
    });
    expect(linkTargetOf({ subtype: 'Link', action: 'Print' })).toBeNull();
  });

  it('ignores annotations that are not links', () => {
    expect(linkTargetOf({ subtype: 'Text', url: 'https://example.com/' })).toBeNull();
    expect(linkTargetOf({ subtype: 'Link' })).toBeNull();
  });
});

describe('linkBox', () => {
  // A 200 x 400 page, y flipped as pdf.js does.
  const viewport = {
    width: 200,
    height: 400,
    convertToViewportPoint: (x: number, y: number) => [x, 400 - y],
  };

  it('gives the box in percent of the page, whatever order the corners come in', () => {
    expect(linkBox(viewport, [20, 300, 120, 380])).toEqual({
      left: 10,
      top: 5,
      width: 50,
      height: 20,
    });
  });

  it('is independent of zoom: the same rect at scale 2 gives the same percentages', () => {
    const doubled = {
      width: 400,
      height: 800,
      convertToViewportPoint: (x: number, y: number) => [x * 2, 800 - y * 2],
    };
    expect(linkBox(doubled, [20, 300, 120, 380])).toEqual(linkBox(viewport, [20, 300, 120, 380]));
  });

  it('rejects a malformed or empty rect', () => {
    expect(linkBox(viewport, undefined)).toBeNull();
    expect(linkBox(viewport, [1, 2, 3])).toBeNull();
    expect(linkBox(viewport, [1, 2, NaN, 4])).toBeNull();
    expect(linkBox(viewport, [10, 10, 10, 50])).toBeNull();
  });
});

describe('namedActionPage', () => {
  it('moves within the document and clamps at its ends', () => {
    expect(namedActionPage('NextPage', 2, 5)).toBe(3);
    expect(namedActionPage('NextPage', 5, 5)).toBe(5);
    expect(namedActionPage('PrevPage', 1, 5)).toBe(1);
    expect(namedActionPage('PrevPage', 3, 5)).toBe(2);
    expect(namedActionPage('FirstPage', 4, 5)).toBe(1);
    expect(namedActionPage('LastPage', 1, 5)).toBe(5);
  });
});

describe('parseLinkUrl (host-side check)', () => {
  it('passes http, https and mailto through unchanged', () => {
    for (const u of [
      'http://example.com',
      'https://example.com/a?q=AT%26T%2BCo#x',
      'HTTPS://EXAMPLE.COM/',
      'mailto:a@example.com?subject=Hi%20there',
    ]) {
      expect(parseLinkUrl(u)).toBe(u);
    }
  });

  it('rejects every other scheme', () => {
    for (const u of [
      'javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'vscode://file/C:/x',
      'command:workbench.action.reloadWindow',
      'data:text/html,<b>x</b>',
      'ftp://example.com/',
      'tel:+15551234',
    ]) {
      expect(parseLinkUrl(u)).toBeUndefined();
    }
  });

  it('rejects non-strings, empty, over-long, unparsable and control-character input', () => {
    expect(parseLinkUrl(undefined)).toBeUndefined();
    expect(parseLinkUrl(42)).toBeUndefined();
    expect(parseLinkUrl({ href: 'https://example.com' })).toBeUndefined();
    expect(parseLinkUrl('')).toBeUndefined();
    expect(parseLinkUrl('not a url')).toBeUndefined();
    expect(parseLinkUrl('//example.com')).toBeUndefined();
    expect(parseLinkUrl('https://example.com/\nevil')).toBeUndefined();
    expect(parseLinkUrl(' https://example.com')).toBeUndefined();
    expect(parseLinkUrl('https://example.com/\u0000')).toBeUndefined();
    const long = 'https://example.com/' + 'a'.repeat(MAX_LINK_URL_LENGTH);
    expect(parseLinkUrl(long)).toBeUndefined();
    expect(parseLinkUrl(long.slice(0, MAX_LINK_URL_LENGTH))).toBeDefined();
  });
});

describe('the openLink message', () => {
  it('is accepted with a valid address and carries only type and url', () => {
    const raw = { type: 'openLink', url: 'https://example.com/', extra: 1 };
    expect(parsePdfMessage(raw)).toEqual({ type: 'openLink', url: 'https://example.com/' });
    expect(parseTexMessage(raw)).toEqual({ type: 'openLink', url: 'https://example.com/' });
  });

  it('is dropped for a bad address, and openExternal keeps meaning the PDF file', () => {
    expect(parsePdfMessage({ type: 'openLink', url: 'javascript:alert(1)' })).toBeUndefined();
    expect(parsePdfMessage({ type: 'openLink' })).toBeUndefined();
    expect(parseTexMessage({ type: 'openLink', url: 7 })).toBeUndefined();
    expect(parsePdfMessage({ type: 'openExternal', url: 'https://example.com/' })).toEqual({
      type: 'openExternal',
    });
  });
});
