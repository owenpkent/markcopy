// The webview side of Word and PowerPoint pictures: media messages become
// blob: URLs on the <img> elements that reference them, and a detached clone
// for export gets data: URIs back. jsdom has no object URLs or canvas, so
// those are stubbed where the test needs them and the downscale path (a real
// browser's createImageBitmap) is left to the manual checks in docs/TESTING.md.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addMedia,
  applyMedia,
  beginMediaSet,
  materializeMedia,
  mediaIds,
} from '../src/webview/ooxmlMedia';

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';
const SVG_B64 = Buffer.from(SVG).toString('base64');

let created: string[];
let revoked: string[];

beforeEach(() => {
  // A fresh, empty set first, so one test's images never leak into the next,
  // and the revocation that empties it is not counted against the test.
  beginMediaSet(`set-${Math.random()}`);
  created = [];
  revoked = [];
  let n = 0;
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:null/${++n}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('addMedia', () => {
  it('turns an item into a blob: URL on every img that references it', () => {
    beginMediaSet('s1');
    const el = root(
      '<img data-mc-media="m1"><p>x</p><img data-mc-media="m1"><img data-mc-media="m2">',
    );
    const added = addMedia('s1', [{ id: 'm1', mime: 'image/png', base64: PNG_B64 }], el);
    expect(added).toBe(1);
    const imgs = el.querySelectorAll('img');
    expect(imgs[0].getAttribute('src')).toBe(created[0]);
    expect(imgs[1].getAttribute('src')).toBe(created[0]);
    expect(imgs[2].hasAttribute('src')).toBe(false);
  });

  it('drops media for a set other than the current one', () => {
    beginMediaSet('s2');
    const el = root('<img data-mc-media="m1">');
    expect(addMedia('s1', [{ id: 'm1', mime: 'image/png', base64: PNG_B64 }], el)).toBe(0);
    expect(el.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(created).toEqual([]);
  });

  it('refuses a malformed item: bad id, unknown MIME type, junk bytes, or a repeat', () => {
    beginMediaSet('s3');
    const el = root('');
    const bad = [
      { id: 'm1" onerror="x', mime: 'image/png', base64: PNG_B64 },
      { id: 'm2', mime: 'text/html', base64: PNG_B64 },
      { id: 'm3', mime: 'image/png', base64: '***' },
      null,
      'm4',
    ];
    expect(addMedia('s3', bad, el)).toBe(0);
    expect(addMedia('s3', [{ id: 'm5', mime: 'image/png', base64: PNG_B64 }], el)).toBe(1);
    expect(addMedia('s3', [{ id: 'm5', mime: 'image/png', base64: PNG_B64 }], el)).toBe(0);
    expect(mediaIds()).toEqual(['m5']);
  });

  it('revokes the previous set when a new one begins', () => {
    beginMediaSet('s4');
    addMedia('s4', [{ id: 'm1', mime: 'image/png', base64: PNG_B64 }], root(''));
    beginMediaSet('s5');
    expect(revoked).toEqual([created[0]]);
    expect(mediaIds()).toEqual([]);
    // The same set again is not a new one: a stashed render must keep its images.
    addMedia('s5', [{ id: 'm1', mime: 'image/png', base64: PNG_B64 }], root(''));
    beginMediaSet('s5');
    expect(mediaIds()).toEqual(['m1']);
  });
});

describe('applyMedia', () => {
  it('fills in references rendered after their media arrived', () => {
    beginMediaSet('s6');
    addMedia('s6', [{ id: 'm1', mime: 'image/png', base64: PNG_B64 }], root(''));
    const el = root('<img data-mc-media="m1"><img data-mc-media="m9">');
    applyMedia(el);
    const imgs = el.querySelectorAll('img');
    expect(imgs[0].getAttribute('src')).toBe(created[0]);
    expect(imgs[1].hasAttribute('src')).toBe(false);
  });
});

describe('materializeMedia', () => {
  it('replaces each reference with a data: URI of the bytes and drops the reference attribute', async () => {
    beginMediaSet('s7');
    addMedia('s7', [{ id: 'm1', mime: 'image/svg+xml', base64: SVG_B64 }], root(''));
    const clone = root('<img data-mc-media="m1" src="blob:null/1" alt="logo">');
    await materializeMedia(clone);
    const img = clone.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(`data:image/svg+xml;base64,${SVG_B64}`);
    expect(img.hasAttribute('data-mc-media')).toBe(false);
    expect(img.getAttribute('alt')).toBe('logo');
  });

  it('leaves an image that never arrived with its alt text and no src', async () => {
    beginMediaSet('s8');
    const clone = root('<img data-mc-media="m1" alt="missing">');
    await materializeMedia(clone);
    const img = clone.querySelector('img')!;
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.hasAttribute('data-mc-media')).toBe(false);
    expect(img.getAttribute('alt')).toBe('missing');
  });
});
