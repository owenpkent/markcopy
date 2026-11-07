// Image Notes in the image webview (src/webview/imageReview.ts, wired up by
// src/webview/image.ts). Same harness as imageWebview.test.ts: the real module
// against a jsdom body that mirrors src/imageEditor.ts's html().
//
// jsdom has no layout, so the picture frame's box is faked on the element, and
// there is no decoding, so the frame is the only geometry the drawing reads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageNote, ImageReviewStateMessage } from '../src/review/imageProtocol';
import { anchorLabel, pct } from '../src/webview/imageReview';

const posted: Array<Record<string, unknown>> = [];

function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

// A PNG signature and IHDR for an 8x6 image: all sniffImage reads.
function pngBase64(): string {
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return b64([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be(13),
    ...Array.from('IHDR', (c) => c.charCodeAt(0)),
    ...be(8),
    ...be(6),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

beforeEach(() => {
  vi.resetModules();
  document.body.className = 'mc-image';
  document.body.removeAttribute('style');
  document.body.innerHTML = '<div id="app"></div>';
  posted.length = 0;
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: (m: Record<string, unknown>) => posted.push(m),
    getState: () => undefined,
    setState: vi.fn(),
  }));
  URL.createObjectURL = vi.fn(() => 'blob:image-test');
  URL.revokeObjectURL = vi.fn();
  document.execCommand = vi.fn(() => false);
});

// Modules from earlier tests keep listening on the shared window and document; drop them.
const listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];
for (const target of [window, document]) {
  const add = target.addEventListener.bind(target) as EventTarget['addEventListener'];
  target.addEventListener = ((
    type: string,
    fn: EventListenerOrEventListenerObject,
    opts?: never,
  ) => {
    listeners.push([target, type, fn]);
    add(type, fn, opts);
  }) as EventTarget['addEventListener'];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [target, type, fn] of listeners.splice(0)) {
    target.removeEventListener(type, fn);
  }
  document.querySelectorAll('.mc-menu--sub').forEach((n) => n.remove());
});

function fromHost(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin: window.origin }));
}

const note = (id: string, extra: Partial<ImageNote> = {}): ImageNote => ({
  id,
  text: `text of ${id}`,
  kind: 'note',
  done: false,
  created: '2026-01-01T00:00:00',
  ...extra,
});

const review = (extra: Partial<ImageReviewStateMessage> = {}): ImageReviewStateMessage => ({
  type: 'review',
  sidecar: 'my photo.review.yaml',
  notes: [
    note('n1', { region: [0.1, 0.21, 0.3, 0.4], author: 'ann' }),
    note('n2', { point: [0.42, 0.3] }),
    note('n3', { kind: 'keep', done: true }),
  ],
  readOnly: null,
  restorable: null,
  added: null,
  ...extra,
});

const frame = () => document.getElementById('mc-image-frame') as HTMLDivElement;
const img = () => document.getElementById('mc-image') as HTMLImageElement;
const scroller = () => document.getElementById('mc-image-scroll') as HTMLDivElement;
const panel = () => document.querySelector<HTMLElement>('.mc-rv-panel');
const cards = () => [...document.querySelectorAll<HTMLButtonElement>('.mc-rv-card')];
const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const field = () => document.querySelector<HTMLInputElement>('.mc-rv-field')!;
const chip = () => document.querySelector<HTMLElement>('.mc-rv-chip')!;
const reviewPosts = () => posted.filter((m) => String(m.type).startsWith('review'));

async function boot(): Promise<void> {
  await import('../src/webview/image');
  fromHost({
    type: 'load',
    name: 'my photo.png',
    path: '/w/my photo.png',
    relativePath: 'my photo.png',
    size: 10,
    data: pngBase64(),
  });
  // The picture is drawn 200 x 100 px at (50, 20).
  frame().getBoundingClientRect = () =>
    ({ left: 50, top: 20, width: 200, height: 100, right: 250, bottom: 120 }) as DOMRect;
}

async function open(extra: Partial<ImageReviewStateMessage> = {}): Promise<void> {
  await boot();
  fromHost(review(extra));
}

function openMenu(): void {
  document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

function menuRow(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.mc-menu-item')].find(
    (r) => r.textContent === label,
  );
  if (!found) {
    throw new Error(`no menu row "${label}"`);
  }
  return found;
}

const key = (k: string, target: EventTarget = document) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

function pointer(type: string, x: number, y: number, target: EventTarget = img()): PointerEvent {
  const e = new PointerEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(e);
  return e;
}

/** Drag across the picture with the Area tool. */
function drag(x0: number, y0: number, x1: number, y1: number): void {
  pointer('pointerdown', x0, y0);
  pointer('pointermove', x1, y1);
  pointer('pointerup', x1, y1);
}

describe('anchor labels', () => {
  it('rounds half up', () => {
    expect(pct(0.125)).toBe(13);
    expect(pct(0.1)).toBe(10);
    expect(anchorLabel({ region: [0.1, 0.21, 0.3, 0.4] })).toBe('Area 10%, 21%, 30% x 40%');
    expect(anchorLabel({ point: [0.42, 0.3] })).toBe('Pin 42%, 30%');
    expect(anchorLabel({})).toBe('Whole image');
  });
});

describe('entering and leaving', () => {
  it('stays out of notes mode until asked', async () => {
    await boot();
    expect(panel()).toBeNull();
    expect(document.body.classList.contains('mc-image-review')).toBe(false);
  });

  it('enters on the host review message and makes room for the panel', async () => {
    await open();
    expect(document.body.classList.contains('mc-image-review')).toBe(true);
    expect(document.querySelector('aside.mc-rv-panel')).not.toBeNull();
    expect(scroller().style.right).toBe('320px');
    expect(scroller().style.bottom).toBe('30px');
    expect(document.getElementById('mc-toolbar')!.style.right).toBe('338px');
    expect(document.querySelector('.mc-rv-count')?.textContent).toBe('3 notes');
  });

  it('moves the panel under the picture when narrow', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    try {
      await open();
      expect(document.querySelector('.mc-rv')!.classList.contains('mc-rv--narrow')).toBe(true);
      expect(scroller().style.right).toBe('0px');
      expect(scroller().style.bottom).toContain('calc(');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    }
  });

  it('opens from the menu: posts the setting and reviewEnable, then waits for the host', async () => {
    await boot();
    openMenu();
    menuRow('Open Image Notes').click();
    expect(posted).toContainEqual({ type: 'updateSetting', key: 'image.review', value: true });
    expect(posted).toContainEqual({ type: 'reviewEnable' });
    expect(document.body.classList.contains('mc-image-review')).toBe(false);
    fromHost(review());
    expect(document.body.classList.contains('mc-image-review')).toBe(true);
  });

  it('closes from the menu, posts the setting off, and ignores later review messages', async () => {
    await open();
    openMenu();
    menuRow('Close Image Notes').click();
    expect(posted).toContainEqual({ type: 'updateSetting', key: 'image.review', value: false });
    expect(document.body.classList.contains('mc-image-review')).toBe(false);
    expect(scroller().style.right).toBe('0px');
    fromHost(review());
    expect(document.body.classList.contains('mc-image-review')).toBe(false);
    openMenu();
    expect(menuRow('Open Image Notes')).toBeTruthy();
  });

  it('closes from the x button', async () => {
    await open();
    byLabel('Close image notes').click();
    expect(posted).toContainEqual({ type: 'updateSetting', key: 'image.review', value: false });
    expect(document.body.classList.contains('mc-image-review')).toBe(false);
    expect(document.querySelector<HTMLElement>('.mc-rv')!.hidden).toBe(true);
  });
});

describe('cards and the overlay', () => {
  it('renders cards in file order with anchor labels', async () => {
    await open();
    const text = cards().map((c) => c.textContent ?? '');
    expect(text).toHaveLength(3);
    expect(text[0]).toContain('n1');
    expect(text[0]).toContain('Area 10%, 21%, 30% x 40%');
    expect(text[0]).toContain('ann');
    expect(text[0]).toContain('text of n1');
    expect(text[1]).toContain('Pin 42%, 30%');
    expect(text[2]).toContain('Whole image');
    expect(text[2]).toContain('keep');
    expect(text[2]).toContain('Done');
  });

  it('draws regions and pins inside the frame, diffed by id', async () => {
    await open();
    const region = frame().querySelector<HTMLElement>('.mc-rv-region')!;
    const pin = frame().querySelector<HTMLElement>('.mc-rv-pin')!;
    expect(region.textContent).toBe('1');
    expect(region.style.left).toBe('10%');
    expect(region.style.top).toBe('21%');
    expect(region.style.width).toBe('30%');
    expect(pin.textContent).toBe('2');
    expect(frame().querySelectorAll('.mc-rv-region, .mc-rv-pin')).toHaveLength(2);
    fromHost(review({ notes: [note('n1', { region: [0.5, 0.5, 0.2, 0.2] })] }));
    expect(frame().querySelector('.mc-rv-region')).toBe(region);
    expect(region.style.left).toBe('50%');
    expect(frame().querySelector('.mc-rv-pin')).toBeNull();
  });

  it('selects a card on click, reveals Delete, and highlights the shape', async () => {
    await open();
    cards()[0].click();
    expect(cards()[0].getAttribute('aria-pressed')).toBe('true');
    expect(frame().querySelector('.mc-rv-region--selected')).not.toBeNull();
    byLabel('Delete n1').click();
    expect(posted).toContainEqual({ type: 'reviewDelete', id: 'n1' });
  });

  it('a press on a saved shape selects it instead of starting a hand-tool pan', async () => {
    await open();
    for (const [selector, card] of [
      ['.mc-rv-region', 0],
      ['.mc-rv-pin', 1],
    ] as const) {
      const shape = frame().querySelector<HTMLElement>(selector)!;
      // jsdom has no pointer capture; the hand tool calls it when it starts a pan.
      const capture = vi.fn();
      scroller().setPointerCapture = capture;
      pointer('pointerdown', 60, 30, shape);
      expect(capture).not.toHaveBeenCalled();
      expect(document.body.classList.contains('mc-grabbing')).toBe(false);
      pointer('pointerup', 60, 30, shape);
      shape.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(cards()[card].getAttribute('aria-pressed')).toBe('true');
    }
  });

  it('selects the card when a shape is clicked', async () => {
    await open();
    frame().querySelector<HTMLElement>('.mc-rv-pin')!.click();
    expect(cards()[1].getAttribute('aria-pressed')).toBe('true');
    expect(byLabel('Delete n2')).toBeTruthy();
  });

  it('selects the note the panel just added', async () => {
    await open();
    fromHost(review({ added: 'n3' }));
    expect(cards()[2].getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Area mode', () => {
  it('is off by default, and a drag then draws nothing', async () => {
    await open();
    expect(byLabel('Area').getAttribute('aria-pressed')).toBe('false');
    expect(byLabel('Pin').getAttribute('aria-pressed')).toBe('false');
    drag(60, 30, 160, 90);
    expect(chip().hidden).toBe(true);
  });

  it('lets the hand tool pan when no mode is on, and not when Area is on', async () => {
    await open();
    pointer('pointerdown', 60, 30);
    expect(document.body.classList.contains('mc-grabbing')).toBe(true);
    pointer('pointerup', 60, 30);
    key('a');
    pointer('pointerdown', 60, 30);
    expect(document.body.classList.contains('mc-grabbing')).toBe(false);
    pointer('pointerup', 60, 30);
  });

  it('draws a region from a drag and focuses the field', async () => {
    await open();
    byLabel('Area').click();
    expect(document.body.classList.contains('mc-image-aim')).toBe(true);
    const down = pointer('pointerdown', 70, 40);
    expect(down.defaultPrevented).toBe(true);
    pointer('pointermove', 150, 90);
    expect(frame().querySelector<HTMLElement>('.mc-rv-draft')!.hidden).toBe(false);
    pointer('pointerup', 150, 90);
    // (70-50)/200 = 0.1, (40-20)/100 = 0.2, width 80/200 = 0.4, height 50/100 = 0.5.
    expect(chip().textContent).toBe('Area 10%, 20%, 40% x 50%');
    expect(document.activeElement).toBe(field());
    field().value = 'fix this';
    key('Enter', field());
    expect(reviewPosts().at(-1)).toEqual({
      type: 'reviewAdd',
      text: 'fix this',
      region: [0.1, 0.2, 0.4, 0.5],
    });
  });

  it('clamps to the picture, to 4 decimals, with x + w and y + h at most 1', async () => {
    await open();
    key('a');
    drag(200, 100, 900, 700);
    field().value = 'edge';
    key('Enter', field());
    expect((reviewPosts().at(-1) as { region: number[] }).region).toEqual([0.75, 0.8, 0.25, 0.2]);
    key('a');
    drag(74.3, 30.1, 130.7, 60.9);
    field().value = 'odd';
    key('Enter', field());
    const odd = (reviewPosts().at(-1) as { region: number[] }).region;
    for (const v of odd) {
      expect(Math.round(v * 10000) / 10000).toBe(v);
    }
    expect(odd[0] + odd[2]).toBeLessThanOrEqual(1);
    expect(odd[1] + odd[3]).toBeLessThanOrEqual(1);
    expect(odd[2]).toBeGreaterThan(0);
    expect(odd[3]).toBeGreaterThan(0);
  });

  it('ends a drag released outside the frame', async () => {
    await open();
    key('a');
    pointer('pointerdown', 100, 50);
    pointer('pointerup', 5000, 5000, document.body);
    expect(chip().textContent).toBe('Area 25%, 30%, 75% x 70%');
  });

  it('ignores a drag under 4 screen px in either dimension', async () => {
    await open();
    key('a');
    drag(100, 50, 102, 90);
    expect(chip().hidden).toBe(true);
    drag(100, 50, 160, 52);
    expect(chip().hidden).toBe(true);
    expect(frame().querySelector<HTMLElement>('.mc-rv-draft')!.hidden).toBe(true);
  });
});

describe('Pin mode', () => {
  it('sets the pending point on a click and sends it', async () => {
    await open();
    key('p');
    expect(byLabel('Pin').getAttribute('aria-pressed')).toBe('true');
    expect(byLabel('Area').getAttribute('aria-pressed')).toBe('false');
    pointer('pointerdown', 150, 70);
    expect(chip().textContent).toBe('Pin 50%, 50%');
    expect(frame().querySelector<HTMLElement>('.mc-rv-ring')!.hidden).toBe(false);
    field().value = 'here';
    byLabel('Send').click();
    expect(reviewPosts().at(-1)).toEqual({ type: 'reviewAdd', text: 'here', point: [0.5, 0.5] });
  });

  it('ignores a press on the margin around the picture', async () => {
    await open();
    key('p');
    pointer('pointerdown', 20, 70);
    expect(chip().textContent).not.toMatch(/^Pin /);
    pointer('pointerdown', 250, 120);
    expect(chip().textContent).toBe('Pin 100%, 100%');
  });

  it('keeps the modes exclusive', async () => {
    await open();
    key('a');
    key('p');
    expect(byLabel('Area').getAttribute('aria-pressed')).toBe('false');
    expect(byLabel('Pin').getAttribute('aria-pressed')).toBe('true');
    byLabel('Pin').click();
    expect(byLabel('Pin').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('composer', () => {
  it('sends a whole-image note with no anchor keys', async () => {
    await open();
    field().value = '  looks soft  ';
    byLabel('Send').click();
    expect(reviewPosts().at(-1)).toEqual({ type: 'reviewAdd', text: 'looks soft' });
    expect(Object.keys(reviewPosts().at(-1)!)).toEqual(['type', 'text']);
  });

  it('does nothing for empty text with no anchor', async () => {
    await open();
    byLabel('Send').click();
    key('Enter', field());
    expect(reviewPosts()).toHaveLength(0);
  });

  it('clears the mode and anchor after Enter but keeps focus in the field', async () => {
    await open();
    key('p');
    pointer('pointerdown', 150, 70);
    field().focus();
    field().value = 'x';
    key('Enter', field());
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe('');
    expect(chip().hidden).toBe(true);
    expect(byLabel('Pin').getAttribute('aria-pressed')).toBe('false');
    expect(document.body.classList.contains('mc-image-aim')).toBe(false);
  });

  it('blurs the field on Escape', async () => {
    await open();
    field().focus();
    key('Escape', field());
    expect(document.activeElement).not.toBe(field());
  });

  it('keeps viewer shortcuts from firing while typing', async () => {
    await open();
    field().focus();
    for (const k of ['1', 'f', 'ArrowRight', 'PageDown', 'a', 'p']) {
      key(k, field());
    }
    expect(posted.some((m) => m.type === 'navigate')).toBe(false);
    expect(byLabel('Area').getAttribute('aria-pressed')).toBe('false');
    expect(byLabel('Pin').getAttribute('aria-pressed')).toBe('false');
    // 1 and F would each flash a zoom toast.
    expect(document.getElementById('mc-toast')!.hidden).toBe(true);
  });

  it('holds a second Send until the first note is answered, so its draft survives', async () => {
    await open();
    field().value = 'first';
    key('Enter', field());
    expect(reviewPosts().filter((m) => m.type === 'reviewAdd')).toHaveLength(1);
    key('a');
    drag(70, 40, 150, 90);
    field().value = 'second';
    key('Enter', field());
    // Not sent while the first is in flight: the draft stays in the composer.
    expect(reviewPosts().filter((m) => m.type === 'reviewAdd')).toHaveLength(1);
    expect(field().value).toBe('second');
    fromHost(review({ added: 'n3' }));
    expect(field().value).toBe('second');
    expect(chip().textContent).toBe('Area 10%, 20%, 40% x 50%');
    key('Enter', field());
    expect(reviewPosts().at(-1)).toEqual({
      type: 'reviewAdd',
      text: 'second',
      region: [0.1, 0.2, 0.4, 0.5],
    });
    fromHost({ type: 'reviewError', message: 'disk full', failed: 'add' });
    expect(field().value).toBe('second');
    expect(chip().textContent).toBe('Area 10%, 20%, 40% x 50%');
  });

  it('Escape during an Area drag cancels it, so the release draws nothing', async () => {
    await open();
    key('a');
    pointer('pointerdown', 70, 40);
    pointer('pointermove', 150, 90, document);
    key('Escape');
    pointer('pointerup', 150, 90, document);
    expect(byLabel('Area').getAttribute('aria-pressed')).toBe('false');
    field().value = 'no area';
    byLabel('Send').click();
    expect(reviewPosts().at(-1)).toEqual({ type: 'reviewAdd', text: 'no area' });
  });

  it('gives the draft back on a failed add and toasts every reviewError', async () => {
    await open();
    key('a');
    drag(70, 40, 150, 90);
    field().value = 'keep me';
    key('Enter', field());
    expect(field().value).toBe('');
    fromHost({ type: 'reviewError', message: 'disk full', failed: 'add' });
    expect(field().value).toBe('keep me');
    expect(chip().textContent).toBe('Area 10%, 20%, 40% x 50%');
    expect(byLabel('Area').getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('mc-toast')?.textContent).toBe('disk full');
    fromHost({ type: 'reviewError', message: 'bad delete' });
    expect(document.getElementById('mc-toast')?.textContent).toBe('bad delete');
  });

  it('Clear drops the mode and the pending anchor', async () => {
    await open();
    key('a');
    drag(70, 40, 150, 90);
    byLabel('Clear').click();
    expect(chip().hidden).toBe(true);
    expect(byLabel('Area').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('panel actions', () => {
  it('posts reviewCopy, flashes on the host toast, and shows that toast', async () => {
    await open();
    byLabel('Copy notes as Markdown').click();
    expect(posted).toContainEqual({ type: 'reviewCopy' });
    fromHost({ type: 'toast', message: 'Copied review notes' });
    expect(document.getElementById('mc-toast')?.textContent).toBe('Copied review notes');
    expect(byLabel('Copy notes as Markdown').textContent).toBe('Copied');
  });

  it('disables copy until the image has a notes file', async () => {
    await open({ sidecar: null, notes: [] });
    expect(byLabel('Copy notes as Markdown').disabled).toBe(true);
    expect(document.querySelector('.mc-rv-empty')).not.toBeNull();
  });

  it('shows Restore when restorable and posts reviewRestore', async () => {
    await open({ restorable: 'n9' });
    const restore = byLabel('Restore n9');
    expect(restore.hidden).toBe(false);
    restore.click();
    expect(posted).toContainEqual({ type: 'reviewRestore' });
  });

  it('is read-only with a banner and a disabled composer', async () => {
    await open({ readOnly: 'not an image review' });
    expect(document.querySelector<HTMLElement>('.mc-rv-banner')!.hidden).toBe(false);
    expect(document.querySelector('.mc-rv-banner')!.textContent).toContain('not an image review');
    expect(field().disabled).toBe(true);
    expect(byLabel('Send').disabled).toBe(true);
    expect(byLabel('Area').disabled).toBe(true);
    expect(byLabel('Pin').disabled).toBe(true);
    key('a');
    expect(document.body.classList.contains('mc-image-aim')).toBe(false);
    cards()[0].click();
    expect(byLabel('Delete n1').disabled).toBe(true);
  });
});

describe('overlay tokens in media/preview.css', () => {
  // The shapes sit in #mc-image-frame, outside the .mc-rv panel root, so every
  // --rv-* token an image shape rule uses must be set on body.mc-image or the
  // shapes lose their outline and fill. jsdom applies no CSS, so this reads the file.
  it('defines on body.mc-image every --rv-* token the shape rules use', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // jsdom gives import.meta.url an http scheme, so resolve from the repo root.
    const css = readFileSync(join(process.cwd(), 'media', 'preview.css'), 'utf8');
    const body = /(?:^|\n)body\.mc-image \{([^}]*)\}/.exec(css);
    expect(body).not.toBeNull();
    const defined = new Set([...body![1].matchAll(/(--rv-[a-z]+):/g)].map((m) => m[1]));
    const used = new Set<string>();
    for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (/body\.mc-image[^,{]*\.mc-rv-(region|pin|ring|draft|num|pins)/.test(rule[1])) {
        for (const m of rule[2].matchAll(/var\((--rv-[a-z]+)/g)) {
          used.add(m[1]);
        }
      }
    }
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((v) => !defined.has(v))).toEqual([]);
  });
});
