// Auto-scroll in the Markdown preview, driven through the real webview bundle
// (src/webview/main.ts) in jsdom. jsdom has no layout, so the page's scroll
// geometry is given by hand, and requestAnimationFrame is a queue the test runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HEIGHT = 5000;
const VIEW = 1000;

let scrollTop = 0;
let docHeight = HEIGHT;
let frames: Array<(ts: number) => void> = [];
let saved: unknown;
let posted: Array<Record<string, unknown>> = [];

const tick = () => new Promise((r) => setTimeout(r, 0));

function runFrames(ts: number): void {
  const queued = frames;
  frames = [];
  for (const f of queued) f(ts);
}

function send(
  html = '<p data-source-line="0">Hello</p>',
  kind = 'markdown',
  extra: Record<string, unknown> = {},
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: window.origin,
      data: {
        type: 'render',
        kind,
        html,
        source: 'Hello',
        docKey: 'file:///a.md',
        docVersion: 1,
        syncScroll: false,
        theme: 'auto',
        styleProfile: 'github',
        mermaidConfig: {},
        math: false,
        ...extra,
      },
    }),
  );
}

async function render(
  html = '<p data-source-line="0">Hello</p>',
  kind = 'markdown',
  whileRendering?: () => void,
  extra: Record<string, unknown> = {},
): Promise<void> {
  send(html, kind, extra);
  // The page is replaced synchronously; this is the moment layout would clamp it.
  whileRendering?.();
  for (let i = 0; i < 6; i++) await tick();
}

// By reference to the pill: a document heading may take the same id.
const toggle = () =>
  document.querySelector<HTMLButtonElement>('.mc-modepill #mc-autoscroll-toggle')!;
const puck = () => document.getElementById('mc-autoscroll') as HTMLElement;
const playLabel = () =>
  document.querySelector<HTMLElement>('[data-as="play"]')!.getAttribute('aria-label');
const key = (k: string, init: KeyboardEventInit = {}) =>
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));

// Every boot of the bundle adds listeners to the shared window and document, and a
// later test must not hear the earlier one, so they are recorded and removed.
type Listener = [EventTarget, string, EventListenerOrEventListenerObject, unknown];
let listeners: Listener[] = [];
const realWindowAdd = window.addEventListener.bind(window);
const realDocumentAdd = document.addEventListener.bind(document);

async function boot(): Promise<void> {
  vi.resetModules();
  await import('../src/webview/main');
}

afterEach(() => {
  for (const [target, type, fn, opts] of listeners) {
    target.removeEventListener(type, fn, opts as boolean);
  }
  listeners = [];
});

beforeEach(() => {
  window.addEventListener = ((type: string, fn: never, opts?: never) => {
    listeners.push([window, type, fn, opts]);
    realWindowAdd(type, fn, opts);
  }) as typeof window.addEventListener;
  document.addEventListener = ((type: string, fn: never, opts?: never) => {
    listeners.push([document, type, fn, opts]);
    realDocumentAdd(type, fn, opts);
  }) as typeof document.addEventListener;
  scrollTop = 0;
  docHeight = HEIGHT;
  frames = [];
  saved = undefined;
  posted = [];
  document.body.innerHTML =
    '<div id="content" class="markdown-body"></div>' +
    '<div id="mc-menu" class="mc-menu" role="menu" hidden></div>' +
    '<div id="mc-toast" class="mc-toast" hidden></div>';
  delete document.body.dataset.mcKind;
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: (m: Record<string, unknown>) => posted.push(m),
    getState: () => saved,
    setState: (s: unknown) => {
      saved = s;
    },
  }));
  vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = ((_x: number, y: number) => {
    scrollTop = y;
  }) as typeof window.scrollTo;
  const root = document.documentElement;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollTop });
  Object.defineProperty(root, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.max(0, Math.min(docHeight - VIEW, v));
    },
  });
  Object.defineProperty(root, 'scrollHeight', { configurable: true, get: () => docHeight });
  Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => VIEW });
  Object.defineProperty(document, 'scrollingElement', { configurable: true, get: () => root });
});

describe('auto-scroll in the Markdown preview', () => {
  it('offers a toggle and a menu entry, and starts and stops with the puck', async () => {
    await boot();
    await render();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    // It lives in the read/edit pill, beside the mode buttons.
    expect(toggle().closest('.mc-modepill')).not.toBeNull();
    toggle().click();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(puck().hidden).toBe(false);
    expect(playLabel()).toBe('Pause (scrolling down)');

    // The context menu says what the toggle will do.
    const entries = () => {
      document.body.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
      return Array.from(document.querySelectorAll('#mc-menu [role="menuitem"]')).map(
        (el) => el.textContent,
      );
    };
    expect(entries()).toContain('Stop Auto-scroll');

    // The first Escape closes the open menu, the second stops auto-scroll.
    key('Escape');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    key('Escape');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(puck().hidden).toBe(true);
    expect(entries()).toContain('Start Auto-scroll');
  });

  it('glides the page down at the saved speed, frame by frame', async () => {
    await boot();
    await render();
    toggle().click();
    runFrames(16);
    runFrames(32);
    runFrames(48);
    // 12 px/s: two timed frames of 16 ms each.
    expect(scrollTop).toBeGreaterThan(0);
    expect(scrollTop).toBeLessThan(2);
    runFrames(1000); // a long stall counts as at most 50 ms
    expect(scrollTop).toBeLessThan(3);
  });

  it('steps the speed with the keys, and Space pauses and resumes', async () => {
    await boot();
    await render();
    toggle().click();
    key('+');
    expect(saved).toMatchObject({ autoScroll: { speed: 16 } });
    key('ArrowDown');
    key('-');
    expect(saved).toMatchObject({ autoScroll: { speed: 9 } });
    key(' ');
    expect(playLabel()).toBe('Play (scrolling down)');
    key(' ');
    expect(playLabel()).toBe('Pause (scrolling down)');
  });

  it('remembers the speed for the next preview', async () => {
    saved = { autoScroll: { speed: -40, size: 2 } };
    await boot();
    await render();
    scrollTop = 500;
    toggle().click();
    expect(playLabel()).toBe('Pause (scrolling up)');
    expect(puck().dataset.size).toBe('2');
  });

  it('stops at the end and says so', async () => {
    await boot();
    await render();
    scrollTop = HEIGHT - VIEW - 0.3;
    saved = { autoScroll: { speed: 12, size: 1 } };
    toggle().click(); // too close to the end to go down: starts up
    expect(playLabel()).toBe('Pause (scrolling up)');
    key('-'); // 9 up
    // Reverse to down from the slowest speed, then run into the end.
    for (let i = 0; i < 6; i++) key('+', { repeat: false });
    scrollTop = HEIGHT - VIEW - 0.4;
    runFrames(16);
    runFrames(32);
    runFrames(48);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    await vi.waitFor(() =>
      expect(document.getElementById('mc-status')!.textContent).toBe('Auto-scroll reached the end'),
    );
  });

  it('stops at the top going up', async () => {
    saved = { autoScroll: { speed: -12, size: 1 } };
    await boot();
    await render();
    scrollTop = 1;
    toggle().click();
    runFrames(16);
    runFrames(32);
    runFrames(48);
    runFrames(64);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    await vi.waitFor(() =>
      expect(document.getElementById('mc-status')!.textContent).toBe('Auto-scroll reached the top'),
    );
  });

  it('adopts a wheel scroll instead of fighting it', async () => {
    await boot();
    await render();
    toggle().click();
    runFrames(16);
    runFrames(32);
    scrollTop = 2500; // the reader moved the page
    runFrames(48);
    runFrames(64);
    expect(scrollTop).toBeGreaterThanOrEqual(2500);
    expect(scrollTop).toBeLessThan(2502);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('stays on, and does not report the end, when the content re-renders and shrinks', async () => {
    await boot();
    await render();
    scrollTop = 3000;
    toggle().click();
    runFrames(16);
    runFrames(32);
    const before = scrollTop;

    // A live edit: the new page is shorter for a moment (a diagram placeholder),
    // which clamps the scroll position to the new end.
    await render('<p data-source-line="0">Hello again</p>', 'markdown', () => {
      docHeight = 3100;
      scrollTop = 2100;
    });
    docHeight = HEIGHT; // the diagram settled
    runFrames(48);
    runFrames(64);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('mc-status')!.textContent).toBe('');
    // Put back where the reader was, then gliding on from there.
    expect(scrollTop).toBeGreaterThanOrEqual(before);
    expect(scrollTop).toBeLessThan(before + 3);
  });

  it('does not undo a wheel scroll made while a redraw was in flight', async () => {
    await boot();
    await render();
    scrollTop = 1102;
    toggle().click();
    runFrames(16);
    runFrames(32);
    await render('<p data-source-line="0">Edited</p>', 'markdown', () => {
      docHeight = 1500;
      scrollTop = 500; // clamped by the shorter page
      window.dispatchEvent(new Event('wheel'));
      docHeight = HEIGHT;
      scrollTop = 1882; // the reader's wheel
    });
    runFrames(48);
    runFrames(64);
    expect(scrollTop).toBeGreaterThanOrEqual(1882);
    expect(scrollTop).toBeLessThan(1884);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('restores the position from the first of two overlapping redraws', async () => {
    await boot();
    await render();
    scrollTop = 3000;
    toggle().click();
    runFrames(16);
    runFrames(32);
    const before = scrollTop;
    send('<p data-source-line="0">One</p>');
    docHeight = 3100; // the first render's placeholder clamps the page
    scrollTop = 2100;
    send('<p data-source-line="0">Two</p>');
    for (let i = 0; i < 6; i++) await tick();
    docHeight = HEIGHT;
    runFrames(48);
    runFrames(64);
    expect(scrollTop).toBeGreaterThanOrEqual(before);
    expect(scrollTop).toBeLessThan(before + 3);
  });

  describe('with an image still loading', () => {
    let loaded = false;
    beforeEach(() => {
      loaded = false;
      Object.defineProperty(HTMLImageElement.prototype, 'complete', {
        configurable: true,
        get: () => loaded,
      });
    });
    afterEach(() => {
      delete (HTMLImageElement.prototype as { complete?: boolean }).complete;
    });

    it('does not report the end until the image has settled the page height', async () => {
      await boot();
      await render('<p data-source-line="0"><img src="x.png" alt="x"></p>');
      scrollTop = HEIGHT - VIEW - 0.6;
      toggle().click();
      for (let i = 1; i <= 4; i++) runFrames(i * 16);
      // The temporary page ends here, but the image is not in yet.
      expect(toggle().getAttribute('aria-pressed')).toBe('true');
      loaded = true;
      docHeight = HEIGHT + 2000;
      for (let i = 5; i <= 12; i++) runFrames(i * 16);
      expect(toggle().getAttribute('aria-pressed')).toBe('true');
      expect(scrollTop).toBeGreaterThan(HEIGHT - VIEW);
    });
  });

  it('leaves Space to a focused disclosure summary', async () => {
    await boot();
    await render('<details data-source-line="0"><summary>More</summary>Text</details>');
    toggle().click();
    const summary = document.querySelector('summary')!;
    const e = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    summary.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(playLabel()).toBe('Pause (scrolling down)');
  });

  it('returns focus to the toggle when Escape dismisses the focused puck', async () => {
    await boot();
    await render();
    scrollTop = 1400;
    toggle().click();
    const play = document.querySelector<HTMLElement>('[data-as="play"]')!;
    play.focus();
    play.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(toggle());
    expect(scrollTop).toBe(1400);
  });

  it('updates the real toggle when a heading has the same id', async () => {
    await boot();
    await render('<h1 id="mc-autoscroll-toggle" data-source-line="0">MC Autoscroll Toggle</h1>');
    toggle().click();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('h1')!.hasAttribute('aria-pressed')).toBe(false);
  });

  it('does not count its own frames as the reader scrolling, so the editor can still move it', async () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const line = Number((this as HTMLElement).dataset?.sourceLine);
      const top = Number.isFinite(line) ? line * 100 - scrollTop : 0;
      return { top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20 } as DOMRect;
    });
    try {
      await boot();
      await render(
        [0, 10, 20, 30].map((n) => `<p data-source-line="${n}">p${n}</p>`).join(''),
        'markdown',
        undefined,
        { syncScroll: true },
      );
      await new Promise((r) => setTimeout(r, 300)); // past the first render's echo window
      scrollTop = 1000;
      toggle().click();
      runFrames(16);
      runFrames(32);
      window.dispatchEvent(new Event('scroll'));
      runFrames(48);
      runFrames(64);
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.origin,
          data: { type: 'scrollToLine', line: 20 },
        }),
      );
      expect(scrollTop).toBeGreaterThanOrEqual(2000);
    } finally {
      rect.mockRestore();
    }
  });

  it('is not offered on a preview that does not take it, and switches off', async () => {
    await boot();
    await render();
    toggle().click();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    await render('<table class="mc-csv"></table>', 'csv');
    expect(document.querySelector<HTMLElement>('.mc-modepill')!.hidden).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(puck().hidden).toBe(true);
  });
});
