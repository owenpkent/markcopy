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

// A PNG header declaring w x h.
function headerPng(w: number, h: number): string {
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const ihdr = Array.from('IHDR', (c) => c.charCodeAt(0));
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
    ...ihdr,
    ...be(w),
    ...be(h),
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
const frame = () => document.getElementById('mc-image-frame') as HTMLDivElement;
const grid = () => document.getElementById('mc-grid') as HTMLButtonElement;
const JPEG_B64 = () => b64([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

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

    it('uses quiet theme-mixed greys in 12px squares', async () => {
      await boot();
      fromHost(loadMsg());
      const st = frame().style;
      expect(st.backgroundImage).toContain('--mc-bg');
      expect(st.backgroundImage).toContain('--mc-fg');
      expect(st.backgroundColor).toContain('--mc-fg');
      expect(st.backgroundSize).toBe('12px 12px');
      expect(st.backgroundImage).not.toMatch(/#|rgb\(|black|white/);
    });

    it('puts the checkerboard on the frame and never on the scroller', async () => {
      await boot();
      fromHost(loadMsg());
      expect(frame().contains(img())).toBe(true);
      expect(frame().style.backgroundImage).toContain('conic-gradient');
      expect(scroller().style.backgroundImage).toBe('');
      expect(scroller().style.backgroundColor).toBe('var(--mc-bg)');
    });

    for (const [value, colour] of [
      ['checkerboard', 'var(--mc-bg)'],
      ['theme', 'var(--mc-bg)'],
      ['light', 'rgb(255, 255, 255)'],
      ['dark', 'rgb(30, 30, 30)'],
    ]) {
      it(`gives the scroller the ${colour} backdrop for ${value}`, async () => {
        await boot();
        fromHost(loadMsg());
        fromHost({ type: 'setBackground', value });
        expect(scroller().style.backgroundColor).toBe(colour);
        expect(scroller().style.backgroundImage).toBe('');
        expect(frame().style.backgroundImage !== '').toBe(value === 'checkerboard');
      });
    }

    it('sizes the frame with the zoom', async () => {
      await boot();
      fromHost(loadMsg({ data: headerPng(80, 40) }));
      Object.defineProperty(img(), 'naturalWidth', { configurable: true, value: 80 });
      Object.defineProperty(img(), 'naturalHeight', { configurable: true, value: 40 });
      img().dispatchEvent(new Event('load'));
      key('1');
      expect(frame().style.width).toBe('80px');
      expect(frame().style.height).toBe('40px');
      key('+', { ctrlKey: true });
      expect(frame().style.width).toBe('120px');
      expect(frame().style.height).toBe('60px');
      expect(img().style.width).toBe('120px');
    });

    it('draws no checkerboard for a JPEG and disables the toggle', async () => {
      await boot();
      fromHost(loadMsg({ data: JPEG_B64() }));
      expect(frame().style.backgroundImage).toBe('');
      expect(grid().disabled).toBe(true);
      expect(grid().title).toBe('No transparency in a JPEG');
      fromHost(loadMsg());
      expect(frame().style.backgroundImage).toContain('conic-gradient');
      expect(grid().disabled).toBe(false);
    });

    it('toggles the grid from the toolbar and persists the choice', async () => {
      await boot();
      fromHost(loadMsg());
      expect(grid().getAttribute('aria-pressed')).toBe('true');
      expect(grid().title).toBe('Transparency grid (click to hide)');
      grid().click();
      expect(posted).toHaveBeenCalledWith({
        type: 'updateSetting',
        key: 'image.background',
        value: 'theme',
      });
      expect(grid().getAttribute('aria-pressed')).toBe('false');
      expect(grid().title).toBe('Transparency grid (click to show)');
      expect(frame().style.backgroundImage).toBe('');
      grid().click();
      expect(posted).toHaveBeenCalledWith({
        type: 'updateSetting',
        key: 'image.background',
        value: 'checkerboard',
      });
      expect(grid().getAttribute('aria-pressed')).toBe('true');
    });

    it('keeps the grid button in step with host background changes', async () => {
      await boot();
      fromHost(loadMsg());
      fromHost({ type: 'setBackground', value: 'dark' });
      expect(grid().getAttribute('aria-pressed')).toBe('false');
      fromHost({ type: 'setBackground', value: 'checkerboard' });
      expect(grid().getAttribute('aria-pressed')).toBe('true');
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

  describe('review fixes', () => {
    function setNatural(w: number, h: number): void {
      Object.defineProperty(img(), 'naturalWidth', { configurable: true, value: w });
      Object.defineProperty(img(), 'naturalHeight', { configurable: true, value: h });
    }
    const loadEvt = () => img().dispatchEvent(new Event('load'));
    const status = () => document.getElementById('mc-image-status')?.textContent ?? '';

    it('loads an SVG through a data URL and never a blob', async () => {
      await boot();
      fromHost(loadMsg({ name: 'icon.svg', data: b64(SVG_TEXT) }));
      expect(img().getAttribute('src')).toBe(`data:image/svg+xml;base64,${b64(SVG_TEXT)}`);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('prefers the decoded size for rasters (EXIF orientation)', async () => {
      await boot();
      fromHost(loadMsg({ data: headerPng(80, 40) }));
      expect(status()).toContain('80 x 40');
      setNatural(40, 80);
      loadEvt();
      expect(status()).toContain('40 x 80');
      openMenu();
      click('Copy as');
      click('HTML Image');
      expect(written[0]).toContain('width="40" height="80"');
    });

    describe('SVG export size', () => {
      async function exportSize(svg: string, natural: [number, number]): Promise<number[]> {
        const sizes: number[] = [];
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: () => undefined }),
          toBlob: (cb: (b: Blob | null) => void) => {
            sizes.push(canvas.width, canvas.height);
            cb(new Blob(['x']));
          },
        };
        const create = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
          tag === 'canvas' ? canvas : create(tag)) as typeof document.createElement);
        Object.defineProperty(navigator.clipboard, 'write', {
          configurable: true,
          value: vi.fn(() => Promise.resolve()),
        });
        vi.stubGlobal('ClipboardItem', class {});
        await boot();
        fromHost(loadMsg({ name: 'a.svg', data: b64(svg) }));
        setNatural(...natural);
        loadEvt();
        openMenu();
        click('Copy Image as PNG');
        await new Promise((r) => setTimeout(r, 0));
        return sizes;
      }

      it('uses the resolved size for a width-only SVG', async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="50"/>';
        expect(await exportSize(svg, [50, 150])).toEqual([100, 300]);
      });

      it('uses the resolved size for a 10cm SVG', async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10cm" height="5cm"/>';
        expect(await exportSize(svg, [378, 189])).toEqual([756, 378]);
      });

      it('uses the viewBox when there is no width or height', async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"/>';
        expect(await exportSize(svg, [300, 150])).toEqual([48, 24]);
      });

      it('caps the longest side at 16384', async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20000 100"/>';
        expect(await exportSize(svg, [300, 150])).toEqual([16384, 82]);
      });
    });

    it('reports a decode failure and disables the copy rows', async () => {
      await boot();
      fromHost(loadMsg({ name: 'icon.svg', data: b64(SVG_TEXT) }));
      img().dispatchEvent(new Event('error'));
      expect(document.getElementById('mc-image-error')?.textContent).toBe(
        'Could not decode icon.svg',
      );
      expect(status()).toMatch(/^icon\.svg · [^·]+ · SVG$/);
      openMenu();
      expect(row('Copy Image as PNG').getAttribute('aria-disabled')).toBe('true');
      expect(row('Save as PNG…').getAttribute('aria-disabled')).toBe('true');
      click('Copy as');
      expect(rowLabels().some((l) => l.endsWith('2x'))).toBe(false);
      click('HTML Image');
      expect(written[0]).not.toContain('width=');
    });

    it('drops the previous image on a host error and recovers on the next load', async () => {
      await boot();
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"/>';
      fromHost(loadMsg({ name: 'icon.svg', data: b64(svg) }));
      loadEvt();
      expect(status()).toContain('100 x 50');
      fromHost({ type: 'error', message: 'icon.svg was deleted.' });
      expect(document.getElementById('mc-image-error')?.textContent).toBe('icon.svg was deleted.');
      expect(status()).toBe('');
      expect(img().hasAttribute('src')).toBe(false);
      openMenu();
      const top = rowLabels();
      expect(top).not.toContain('Copy SVG Source');
      expect(top).toContain('Open in Default App');
      const png = top.find((l) => l.startsWith('Copy Image as PNG'));
      expect(
        png === undefined || row('Copy Image as PNG').getAttribute('aria-disabled') === 'true',
      ).toBe(true);
      click('Copy as');
      expect(rowLabels()).toEqual(expect.arrayContaining(['File Name', 'Full Path']));
      expect(rowLabels()).not.toContain('Data URI');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      fromHost(loadMsg({ name: 'icon.svg', data: b64(svg) }));
      loadEvt();
      expect(status()).toContain('100 x 50');
      openMenu();
      expect(rowLabels()).toContain('Copy SVG Source');
      expect(row('Copy Image as PNG').getAttribute('aria-disabled')).not.toBe('true');
      click('Copy as');
      expect(rowLabels()).toContain('Data URI');
    });

    it('makes the Theme background follow --mc-bg', async () => {
      await boot();
      fromHost({ type: 'setBackground', value: 'theme' });
      expect(scroller().style.backgroundColor).toContain('--mc-bg');
      expect(scroller().style.backgroundColor).not.toContain('--vscode-editor-background');
    });
  });

  describe('toolbar and hand tool', () => {
    const $ = (id: string) => document.getElementById(id) as HTMLElement;
    const label = () => $('mc-zoom-label').textContent;
    const ptr = (type: string, target: EventTarget, init: MouseEventInit = {}) =>
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }),
      );

    it('renders the six controls with labels', async () => {
      await boot();
      fromHost(loadMsg());
      const buttons = Array.from($('mc-toolbar').querySelectorAll('button'));
      expect(buttons).toHaveLength(6);
      expect(buttons.every((b) => b.getAttribute('aria-label'))).toBe(true);
      expect($('mc-hand').title).toBe('Hand Tool (Drag to Pan)');
      expect($('mc-fit').getAttribute('aria-pressed')).toBe('true');
    });

    it('zooms with the buttons and updates the label', async () => {
      await boot();
      fromHost(loadMsg());
      expect(label()).toBe('100%');
      (document.querySelector('[data-act="in"]') as HTMLElement).click();
      expect(label()).toBe('150%');
      (document.querySelector('[data-act="out"]') as HTMLElement).click();
      (document.querySelector('[data-act="out"]') as HTMLElement).click();
      expect(label()).toBe('75%');
      $('mc-fit').click();
      expect(img().style.maxWidth).toBe('100%');
    });

    describe('typed zoom', () => {
      const input = () => document.getElementById('mc-zoom-input') as HTMLInputElement | null;
      const typeKey = (key: string) =>
        input()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      const open = async (value?: string) => {
        await boot();
        fromHost(loadMsg());
        $('mc-zoom-label').click();
        if (value !== undefined) {
          input()!.value = value;
        }
      };

      it('swaps in a prefilled, focused input', async () => {
        await open();
        expect(input()).not.toBeNull();
        expect(input()!.value).toBe('100');
        expect(input()!.getAttribute('inputmode')).toBe('numeric');
        expect(document.activeElement).toBe(input());
        expect($('mc-zoom-label').hidden).toBe(true);
        expect($('mc-zoom-label').getAttribute('aria-label')).toBe('Zoom level');
        expect($('mc-zoom-label').title).toBe('Zoom level (click to type)');
      });

      it('applies " 150% " on Enter and restores the label', async () => {
        await open(' 150% ');
        typeKey('Enter');
        expect(input()).toBeNull();
        expect($('mc-zoom-label').hidden).toBe(false);
        expect(label()).toBe('150%');
        expect(document.activeElement).toBe($('mc-zoom-label'));
        expect($('mc-fit').getAttribute('aria-pressed')).toBe('false');
      });

      it('accepts a bare number', async () => {
        await open('150');
        typeKey('Enter');
        expect(label()).toBe('150%');
      });

      it('cancels on Escape', async () => {
        await open('300');
        typeKey('Escape');
        expect(input()).toBeNull();
        expect(label()).toBe('100%');
        expect($('mc-fit').getAttribute('aria-pressed')).toBe('true');
      });

      it('clamps to 10..800', async () => {
        await open('5000');
        typeKey('Enter');
        expect(label()).toBe('800%');
        $('mc-zoom-label').click();
        input()!.value = '1';
        typeKey('Enter');
        expect(label()).toBe('10%');
      });

      it('ignores junk', async () => {
        await open('abc');
        typeKey('Enter');
        expect(input()).toBeNull();
        expect(label()).toBe('100%');
        expect($('mc-fit').getAttribute('aria-pressed')).toBe('true');
      });

      it('applies a changed value on blur', async () => {
        await open('200');
        input()!.dispatchEvent(new FocusEvent('blur'));
        expect(label()).toBe('200%');
      });
    });

    it('toggles fit with aria-pressed', async () => {
      await boot();
      fromHost(loadMsg());
      $('mc-fit').click();
      expect($('mc-fit').getAttribute('aria-pressed')).toBe('false');
      expect(label()).toBe('100%');
      $('mc-fit').click();
      expect($('mc-fit').getAttribute('aria-pressed')).toBe('true');
    });

    it('toggles the hand tool from the bar and the menu', async () => {
      await boot();
      fromHost(loadMsg());
      expect(document.body.classList.contains('mc-mode-hand')).toBe(true);
      $('mc-hand').click();
      expect(document.body.classList.contains('mc-mode-hand')).toBe(false);
      expect($('mc-hand').getAttribute('aria-pressed')).toBe('false');
      openMenu();
      click('View');
      expect(row('Hand Tool').getAttribute('aria-checked')).toBe('false');
      click('Hand Tool');
      expect(document.body.classList.contains('mc-mode-hand')).toBe(true);
    });

    it('drags to scroll in hand mode', async () => {
      await boot();
      fromHost(loadMsg());
      scroller().scrollLeft = 50;
      scroller().scrollTop = 40;
      ptr('pointerdown', img(), { clientX: 100, clientY: 100 });
      expect(document.body.classList.contains('mc-grabbing')).toBe(true);
      ptr('pointermove', document, { clientX: 90, clientY: 70 });
      expect(scroller().scrollLeft).toBe(60);
      expect(scroller().scrollTop).toBe(70);
      ptr('pointerup', document);
      expect(document.body.classList.contains('mc-grabbing')).toBe(false);
      ptr('pointermove', document, { clientX: 0, clientY: 0 });
      expect(scroller().scrollLeft).toBe(60);
    });

    it('does not drag with the right button, from the toolbar, or outside hand mode', async () => {
      await boot();
      fromHost(loadMsg());
      ptr('pointerdown', img(), { button: 2, clientX: 100, clientY: 100 });
      ptr('pointermove', document, { clientX: 50, clientY: 50 });
      expect(scroller().scrollLeft).toBe(0);
      ptr('pointerdown', $('mc-zoom-label'), { clientX: 100, clientY: 100 });
      ptr('pointermove', document, { clientX: 50, clientY: 50 });
      expect(scroller().scrollLeft).toBe(0);
      expect(document.body.classList.contains('mc-grabbing')).toBe(false);
      $('mc-hand').click();
      ptr('pointerdown', img(), { clientX: 100, clientY: 100 });
      ptr('pointermove', document, { clientX: 50, clientY: 50 });
      expect(scroller().scrollLeft).toBe(0);
    });
  });
});
