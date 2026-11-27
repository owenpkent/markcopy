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

async function render(
  html = '<p data-source-line="0">Hello</p>',
  kind = 'markdown',
  whileRendering?: () => void,
): Promise<void> {
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
      },
    }),
  );
  // The page is replaced synchronously; this is the moment layout would clamp it.
  whileRendering?.();
  for (let i = 0; i < 6; i++) await tick();
}

const toggle = () => document.getElementById('mc-autoscroll-toggle') as HTMLButtonElement;
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
