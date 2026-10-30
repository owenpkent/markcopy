// Coverage for src/webview/image.ts on jsdom. The host serves only
// `<div id="app">`, so the module builds everything else itself. jsdom decodes no
// images, so the <img> never fires load: the tests drive the menu, zoom keys and
// host messages, which is everything that does not need a real Chromium (the
// canvas copy is on the manual checklist in docs/TESTING.md).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DATA_URI_BYTES } from '../src/webview/imageInfo';
import { revealLabel } from '../src/webview/menu';

const posted = vi.fn();
const written: string[] = [];

function b64(bytes: number[] | string): string {
  const arr = typeof bytes === 'string' ? Array.from(bytes, (c) => c.charCodeAt(0)) : bytes;
  return btoa(String.fromCharCode(...arr));
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

const SVG_TEXT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script></svg>';

beforeEach(() => {
  vi.resetModules();
  document.body.className = '';
  document.body.removeAttribute('style');
  document.body.innerHTML = '<div id="app"></div>';
  posted.mockClear();
  written.length = 0;
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: posted,
    getState: () => undefined,
    setState: vi.fn(),
  }));
  URL.createObjectURL = vi.fn(() => 'blob:image-test');
  URL.revokeObjectURL = vi.fn();
  // Force the writeText path: execCommand reports failure.
  document.execCommand = vi.fn(() => false);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn((t: string) => {
        written.push(t);
        return Promise.resolve();
      }),
    },
  });
});

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
  window.dispatchEvent(new MessageEvent('message', { data }));
}

async function boot(): Promise<void> {
  await import('../src/webview/image');
}

function loadMsg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'load',
    name: 'my photo.png',
    path: '/w/img/my photo.png',
    relativePath: 'img/my photo.png',
    size: 1234,
    data: pngBase64(),
    ...over,
  };
}

function openMenu(): void {
  document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

function rowLabels(): string[] {
  return Array.from(document.querySelectorAll('.mc-menu-item')).map((r) => r.textContent ?? '');
}

function row(label: string): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>('.mc-menu-item')).find((r) =>
    (r.textContent ?? '').startsWith(label),
  );
  if (!found) {
    throw new Error(`no menu row "${label}" in: ${rowLabels().join(' | ')}`);
  }
  return found;
}

function click(label: string): void {
  row(label).click();
}

const key = (k: string, init: KeyboardEventInit = {}) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));

const scroller = () => document.getElementById('mc-image-scroll') as HTMLDivElement;
const img = () => document.getElementById('mc-image') as HTMLImageElement;

describe('image webview', () => {
  it('announces itself and shows a PNG from a sniffed-type blob', async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      return 'blob:image-test';
    });
    await boot();
    expect(posted).toHaveBeenCalledWith({ type: 'ready' });
    fromHost(loadMsg({ name: 'liar.jpg' }));
    expect(blobs[0].type).toBe('image/png');
    expect(img().getAttribute('src')).toBe('blob:image-test');
    const status = document.getElementById('mc-image-status')?.textContent ?? '';
    expect(status).toContain('liar.jpg');
    expect(status).toContain('8 x 6');
  });

  it('shows an error and a short menu for bytes that are not an image', async () => {
    await boot();
    fromHost(loadMsg({ data: b64('definitely not an image') }));
    expect(document.getElementById('mc-image-error')?.textContent).toBe('Not a recognised image');
    expect(img().hasAttribute('src')).toBe(false);
    openMenu();
    const labels = rowLabels();
    expect(labels).toContain('Copy as▸');
    expect(labels).toContain('Open in Default App');
    expect(labels.includes(revealLabel())).toBe(true);
    expect(labels).not.toContain('Copy Image as PNG');
    click('Copy as');
    expect(rowLabels()).toEqual(expect.arrayContaining(['File Name', 'Full Path']));
    expect(rowLabels()).not.toContain('Markdown Image');
  });

  it('shows a host error', async () => {
    await boot();
    fromHost({ type: 'error', message: 'too big' });
    expect(document.getElementById('mc-image-error')?.textContent).toBe('too big');
  });

  it('lists the raster rows without SVG ones', async () => {
    await boot();
    fromHost(loadMsg());
    openMenu();
    const top = rowLabels();
    expect(top).toEqual(
      expect.arrayContaining([
        'Copy Image as PNG',
        'Save as PNG…',
        'Copy as▸',
        'View▸',
        'Preferences▸',
        'Open in Default App',
      ]),
    );
    expect(top).not.toContain('Copy SVG Source');
    click('Copy as');
    const sub = rowLabels();
    expect(sub).toEqual(
      expect.arrayContaining([
        'File Name',
        'Full Path',
        'Markdown Image',
        'HTML Image',
        'Data URI',
      ]),
    );
    expect(sub).not.toContain('1x');
  });

  it('adds SVG rows only for SVG', async () => {
    await boot();
    fromHost(loadMsg({ name: 'icon.svg', data: b64(SVG_TEXT) }));
    openMenu();
    expect(rowLabels()).toContain('Copy SVG Source');
    click('Copy as');
    expect(rowLabels()).toEqual(expect.arrayContaining(['1x', '✓2x', '4x']));
    const two = row('✓2x');
    expect(two.getAttribute('aria-checked')).toBe('true');
  });

  it('copies the SVG source as text', async () => {
    await boot();
    fromHost(loadMsg({ name: 'icon.svg', data: b64(SVG_TEXT) }));
    openMenu();
    click('Copy SVG Source');
    expect(written).toEqual([SVG_TEXT]);
  });

  it('never gives SVG bytes to innerHTML or DOMParser', async () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const seen: string[] = [];
    const desc = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'innerHTML',
    ) as PropertyDescriptor;
    Object.defineProperty(Element.prototype, 'innerHTML', {
      configurable: true,
      get: desc.get,
      set(v: string) {
        seen.push(String(v));
        desc.set?.call(this, v);
      },
    });
    try {
      await boot();
      fromHost(loadMsg({ name: 'icon.svg', data: b64(SVG_TEXT) }));
      openMenu();
      click('Copy SVG Source');
    } finally {
      Object.defineProperty(Element.prototype, 'innerHTML', desc);
    }
    expect(parse).not.toHaveBeenCalled();
    expect(seen.some((s) => s.includes('<script') || s.includes('alert(1)'))).toBe(false);
    expect(document.body.innerHTML).not.toContain('alert(1)');
    expect(document.querySelector('script')).toBeNull();
  });

  it('greys the data URI row above the cap', async () => {
    await boot();
    fromHost(loadMsg({ size: MAX_DATA_URI_BYTES + 1 }));
    openMenu();
    click('Copy as');
    const r = row('Too large for a data URI');
    expect(r.getAttribute('aria-disabled')).toBe('true');
    r.click();
    expect(written).toEqual([]);
  });

  it('copies a data URI at or below the cap', async () => {
    await boot();
    const data = pngBase64();
    fromHost(loadMsg({ data, size: MAX_DATA_URI_BYTES }));
    openMenu();
    click('Copy as');
    click('Data URI');
    expect(written).toEqual([`data:image/png;base64,${data}`]);
  });

  it('copies the Markdown and HTML references', async () => {
    await boot();
    fromHost(loadMsg());
    openMenu();
    click('Copy as');
    click('Markdown Image');
    expect(written[0]).toBe('![my photo](img/my%20photo.png)');
    openMenu();
    click('Copy as');
    click('HTML Image');
    expect(written[1]).toBe('<img src="img/my%20photo.png" alt="my photo" width="8" height="6">');
  });

  it('copies the file name and full path', async () => {
    await boot();
    fromHost(loadMsg());
    openMenu();
    click('Copy as');
    click('File Name');
    openMenu();
    click('Copy as');
    click('Full Path');
    expect(written).toEqual(['my photo.png', '/w/img/my photo.png']);
  });

  it('posts open and reveal, and saves nothing without a decoded image', async () => {
    await boot();
    fromHost(loadMsg());
    openMenu();
    click('Open in Default App');
    expect(posted).toHaveBeenCalledWith({ type: 'openExternal' });
    openMenu();
    click(revealLabel());
    expect(posted).toHaveBeenCalledWith({ type: 'revealInOS' });
  });

  describe('zoom', () => {
    it('defaults to fit and follows the keys', async () => {
      await boot();
      fromHost(loadMsg());
      expect(img().style.maxWidth).toBe('100%');
      key('1');
      expect(img().style.width).toBe('8px');
      expect(img().style.maxWidth).toBe('none');
      key('=', { ctrlKey: true });
      expect(img().style.width).toBe('12px');
      key('=', { ctrlKey: true });
      key('=', { ctrlKey: true });
      expect(img().style.width).toBe('24px');
      expect(img().style.imageRendering).toBe('pixelated');
      key('-', { ctrlKey: true });
      expect(img().style.width).toBe('16px');
      expect(img().style.imageRendering).toBe('');
      key('f');
      expect(img().style.maxWidth).toBe('100%');
      expect(img().style.width).toBe('');
      key('1');
      key('0', { ctrlKey: true });
      expect(img().style.maxWidth).toBe('100%');
    });

    it('stops at 10% and 800%', async () => {
      await boot();
      fromHost(loadMsg());
      key('1');
      for (let i = 0; i < 20; i++) key('-', { ctrlKey: true });
      expect(img().style.width).toBe('0.8px');
      for (let i = 0; i < 40; i++) key('=', { ctrlKey: true });
      expect(img().style.width).toBe('64px');
    });

    it('handles Ctrl+wheel and leaves a plain wheel alone', async () => {
      await boot();
      fromHost(loadMsg());
      key('1');
      const plain = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
      scroller().dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
      expect(img().style.width).toBe('8px');
      const ctrl = new WheelEvent('wheel', {
        deltaY: -100,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      scroller().dispatchEvent(ctrl);
      expect(ctrl.defaultPrevented).toBe(true);
      expect(img().style.width).toBe('12px');
    });

    it('ignores the keys while the menu is open', async () => {
      await boot();
      fromHost(loadMsg());
      openMenu();
      key('1');
      expect(img().style.maxWidth).toBe('100%');
    });
  });

  describe('background', () => {
    it('is a checkerboard until told otherwise', async () => {
      await boot();
      expect(scroller().classList.contains('mc-image-bg-checkerboard')).toBe(true);
    });

    for (const value of ['light', 'dark', 'theme', 'checkerboard']) {
      it(`applies ${value} from the host`, async () => {
        await boot();
        fromHost({ type: 'setBackground', value });
        expect(scroller().classList.contains(`mc-image-bg-${value}`)).toBe(true);
        expect(scroller().className.match(/mc-image-bg-/g)).toHaveLength(1);
      });
    }

    it('treats a missing or unknown value as checkerboard', async () => {
      await boot();
      fromHost({ type: 'setBackground', value: 'dark' });
      fromHost({ type: 'setBackground' });
      expect(scroller().classList.contains('mc-image-bg-checkerboard')).toBe(true);
      fromHost({ type: 'setBackground', value: 'dark' });
      fromHost({ type: 'setBackground', value: 'plaid' });
      expect(scroller().classList.contains('mc-image-bg-checkerboard')).toBe(true);
      expect(scroller().classList.contains('mc-image-bg-dark')).toBe(false);
    });

    it('persists a menu choice through updateSetting', async () => {
      await boot();
      fromHost(loadMsg());
      openMenu();
      click('Preferences');
      click('Background');
      click('Dark');
      expect(posted).toHaveBeenCalledWith({
        type: 'updateSetting',
        key: 'image.background',
        value: 'dark',
      });
      expect(scroller().classList.contains('mc-image-bg-dark')).toBe(true);
    });
  });

  it('applies and persists the theme like the GIF viewer', async () => {
    await boot();
    fromHost({ type: 'setTheme', value: 'green' });
    expect(document.body.getAttribute('data-mc-theme')).toBe('green');
    fromHost(loadMsg());
    openMenu();
    click('Preferences');
    click('Theme');
    click('Light');
    expect(posted).toHaveBeenCalledWith({ type: 'updateSetting', key: 'theme', value: 'light' });
  });
});
