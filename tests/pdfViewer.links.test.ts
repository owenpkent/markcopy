// DOM-level checks of the PDF viewer's links, reading-position checkpoints and
// auto-scroll against a fake pdf.js and jsdom (no layout: page boxes are given
// by a stubbed getBoundingClientRect, and the IntersectionObserver is driven by
// hand so a chosen page rasterises and gets its link layer).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BODY = `
  <div id="pdf-root"></div>
  <div id="mc-menu" hidden></div>
  <div id="mc-toast" hidden></div>`;

const h = vi.hoisted(() => ({
  pageCount: 5,
  gates: {} as Record<number, Promise<void>>,
  annots: {} as Record<number, unknown[]>,
  dests: {} as Record<string, unknown[]>,
  pageIndex: 3,
  observed: [] as Array<{ cb: (e: unknown[]) => void }>,
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  OPS: {},
  TextLayer: class {
    render(): Promise<void> {
      return Promise.resolve();
    }
  },
  getDocument: () => ({
    destroy: () => Promise.resolve(),
    promise: Promise.resolve({
      numPages: h.pageCount,
      getDestination: (name: string) => Promise.resolve(h.dests[name] ?? null),
      getPageIndex: () => Promise.resolve(h.pageIndex),
      getPage: async (n: number) => {
        await h.gates[n];
        return {
          getViewport: ({ scale }: { scale: number }) => ({
            width: 100 * scale,
            height: 100 * scale,
            rotation: 0,
            convertToViewportPoint: (x: number, y: number) => [x * scale, (100 - y) * scale],
          }),
          getAnnotations: () => Promise.resolve(h.annots[n] ?? []),
          getTextContent: () => Promise.resolve({ items: [] }),
          render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
        };
      },
    }),
  }),
}));

let posted: Array<Record<string, unknown>> = [];
let scrollTop = 0;
let frames: Array<(ts: number) => void> = [];
const scrollIntoView = vi.fn();

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await tick();
}

beforeEach(async () => {
  vi.resetModules();
  posted = [];
  scrollTop = 0;
  frames = [];
  scrollIntoView.mockClear();
  h.pageCount = 5;
  h.gates = {};
  h.annots = {};
  h.dests = {};
  h.pageIndex = 3;
  h.observed = [];
  document.body.innerHTML = BODY;
  document.body.dataset.workerSrc = 'w.js';
  const mine = posted;
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: (msg: Record<string, unknown>) => mine.push(msg),
    getState: () => undefined,
    setState: vi.fn(),
  }));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (e: unknown[]) => void) {
        h.observed.push({ cb });
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ text: () => Promise.resolve('') })),
  );
  vi.stubGlobal(
    'Worker',
    class {
      terminate(): void {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
  Element.prototype.scrollIntoView = scrollIntoView;
  // Every page is a 100 x 100 box at the top left of the window.
  const real = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.classList.contains('mc-page')) {
      return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 } as DOMRect;
    }
    if (this.classList.contains('mc-link')) {
      // Where CHAPTER sits; the viewer hit-tests the page, but a box of its own is honest.
      return { left: 10, top: 70, right: 50, bottom: 90, width: 40, height: 20 } as DOMRect;
    }
    return real.call(this);
  };
  Object.defineProperty(document.documentElement, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    get: () => 1000,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    get: () => 100,
  });
  await import('../src/webview/pdf');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.querySelectorAll('.mc-note').forEach((n) => n.remove());
});

async function loadDoc(resume: unknown = undefined): Promise<void> {
  const data: Record<string, unknown> = { type: 'load', data: btoa('x'), comments: [] };
  if (resume !== undefined) data.resume = resume;
  window.dispatchEvent(new MessageEvent('message', { data, origin: window.origin }));
  await settle();
}

// Make page n visible so it rasterises and gets its link layer.
async function showPage(n: number): Promise<void> {
  const wrap = document.querySelector(`.mc-page[data-page="${n}"]`)!;
  h.observed.at(-1)!.cb([{ target: wrap, isIntersecting: true }]);
  await settle();
}

function links(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.mc-link')];
}

function clickAt(x: number, y: number, target: Element = document.body): void {
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  target.dispatchEvent(new MouseEvent('pointerdown', init));
  target.dispatchEvent(new MouseEvent('pointerup', init));
  target.dispatchEvent(new MouseEvent('click', init));
}

const openLinks = () => posted.filter((m) => m.type === 'openLink');

// PDF y runs up: this rect is the box left 10, top 70, 40 wide, 20 tall.
const CHAPTER = { subtype: 'Link', rect: [10, 10, 50, 30] };

describe('an internal link before its page exists', () => {
  it('waits for the target page instead of failing, then jumps', async () => {
    h.dests.ch4 = [{ num: 1, gen: 0 }, { name: 'Fit' }];
    h.pageIndex = 3; // page 4
    h.annots[1] = [{ ...CHAPTER, dest: 'ch4' }];
    let release!: () => void;
    h.gates[2] = new Promise<void>((r) => (release = r));
    await loadDoc();
    await showPage(1);
    expect(document.querySelectorAll('.mc-page')).toHaveLength(1); // page 2 is pending
    clickAt(30, 80);
    await settle();
    expect(document.querySelector('.mc-error')).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();

    release();
    await settle();
    expect(document.querySelectorAll('.mc-page')).toHaveLength(5);
    expect(document.querySelector('.mc-error')).toBeNull();
    const target = scrollIntoView.mock.contexts.at(-1) as HTMLElement;
    expect(target.dataset.page).toBe('4');
  });

  it('does the same for a Last Page action', async () => {
    h.annots[1] = [{ ...CHAPTER, action: 'LastPage' }];
    let release!: () => void;
    h.gates[2] = new Promise<void>((r) => (release = r));
    await loadDoc();
    await showPage(1);
    clickAt(30, 80);
    await settle();
    expect(document.querySelector('.mc-error')).toBeNull();
    release();
    await settle();
    expect((scrollIntoView.mock.contexts.at(-1) as HTMLElement).dataset.page).toBe('5');
  });
});

describe('link hit regions and names', () => {
  it('follows a wrapped link on its lines and not in the gap between them', async () => {
    h.annots[1] = [
      {
        subtype: 'Link',
        url: 'https://example.com/',
        rect: [10, 60, 90, 90],
        quadPoints: [10, 90, 90, 90, 10, 80, 90, 80, 10, 70, 40, 70, 10, 60, 40, 60],
      },
    ];
    await loadDoc();
    await showPage(1);
    expect(links()).toHaveLength(1); // one keyboard stop
    clickAt(50, 25); // the gap inside the rect
    expect(openLinks()).toHaveLength(0);
    clickAt(20, 15); // first line
    expect(openLinks()).toEqual([{ type: 'openLink', url: 'https://example.com/' }]);
  });

  it('names two internal links by their text, and falls back to the page', async () => {
    h.dests.a = [{ num: 1, gen: 0 }, { name: 'Fit' }];
    h.annots[1] = [
      { ...CHAPTER, dest: 'a', overlaidText: 'Chapter One' },
      { subtype: 'Link', rect: [10, 40, 50, 60], dest: 'a', overlaidText: ' Chapter\nTwo ' },
      { subtype: 'Link', rect: [10, 70, 50, 90], dest: 'a' },
      { subtype: 'Link', rect: [60, 70, 90, 90], dest: 'nowhere' },
      { subtype: 'Link', rect: [60, 40, 90, 60], dest: 'a', overlaidText: 'x'.repeat(500) },
    ];
    await loadDoc();
    await showPage(1);
    const names = links().map((l) => l.getAttribute('aria-label'));
    expect(names.slice(0, 4)).toEqual([
      'Chapter One',
      'Chapter Two',
      'Go to page 4',
      'Go to destination',
    ]);
    expect(names[4]!.length).toBeLessThanOrEqual(120);
  });
});

describe('a comment control over a link', () => {
  it('saves the comment without opening the link beneath the Save button', async () => {
    h.annots[1] = [{ ...CHAPTER, url: 'https://example.com/' }];
    await loadDoc();
    await showPage(1);
    const link = links()[0];
    document.elementFromPoint = () => link; // what is left once the note is gone
    const page = document.querySelector('.mc-page')!;
    page.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const add = [...document.querySelectorAll<HTMLElement>('.mc-menu-item')].find((i) =>
      i.textContent?.startsWith('Add Comment Here'),
    )!;
    add.click();
    document.querySelector<HTMLTextAreaElement>('.mc-note-text')!.value = 'a note';
    clickAt(30, 80, document.querySelector('.mc-note-save')!);
    expect(posted.some((m) => m.type === 'saveComments')).toBe(true);
    expect(openLinks()).toHaveLength(0);
  });
});

describe('reading position checkpoints', () => {
  it('reports on first movement and every couple of seconds while moving, then settles', async () => {
    await loadDoc(null);
    vi.useFakeTimers();
    const sent = () => posted.filter((m) => m.type === 'savePosition').length;
    expect(sent()).toBe(0);
    for (let t = 0; t < 4500; t += 100) {
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(100);
    }
    // First movement, then checkpoints near 2 s and 4 s; the debounce never fired.
    expect(sent()).toBe(3);
    vi.advanceTimersByTime(700);
    expect(sent()).toBe(4); // the final one after settling
  });
});

describe('auto-scroll', () => {
  function pressed(): string | null {
    return document.getElementById('mc-autoscroll-toggle')!.getAttribute('aria-pressed');
  }
  function runFrames(ts: number): void {
    const queued = frames;
    frames = [];
    for (const f of queued) f(ts);
  }
  function startUpward(): void {
    document.getElementById('mc-autoscroll-toggle')!.click();
    document.querySelector<HTMLElement>('[data-as="dir"]')!.click(); // down to up
  }

  it('stays on while a recompile rebuilds the pages, and carries on from the restored page', async () => {
    await loadDoc();
    scrollTop = 300;
    startUpward();
    runFrames(16);
    expect(pressed()).toBe('true');

    // A recompile: the old pages go, the top is only transient, page 2 is late.
    let release!: () => void;
    h.gates[2] = new Promise<void>((r) => (release = r));
    await loadDoc();
    scrollTop = 0;
    runFrames(32);
    expect(pressed()).toBe('true');
    expect(document.getElementById('mc-status')!.textContent).toBe('');

    release();
    await settle();
    scrollTop = 300; // the reading page is restored
    runFrames(48);
    runFrames(64);
    expect(pressed()).toBe('true');
    expect(scrollTop).toBeLessThan(300); // gliding up from where it was put back
  });

  it('announces the automatic stop through a status region outside the puck', async () => {
    await loadDoc();
    scrollTop = 0;
    startUpward();
    runFrames(16);
    runFrames(32);
    expect(pressed()).toBe('false');
    await tick();
    await vi.waitFor(() =>
      expect(document.getElementById('mc-status')!.textContent).toBe('Auto-scroll reached the top'),
    );
    const region = document.getElementById('mc-status')!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.closest('#mc-autoscroll')).toBeNull();
  });

  it('keeps a held speed key from crossing zero, while a fresh press may reverse', async () => {
    await loadDoc();
    scrollTop = 300;
    document.getElementById('mc-autoscroll-toggle')!.click(); // 12 px/s down
    const down = () =>
      document.querySelector<HTMLElement>('[data-as="dir"]')!.getAttribute('aria-label');
    const key = (repeat: boolean) =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: '-', repeat, bubbles: true }),
      );
    key(false); // 12 down to 9 down
    for (let i = 0; i < 7; i++) key(true);
    // Held: stopped at the slowest speed, still going down ("Scroll up" is the reverse button).
    expect(down()).toBe('Scroll up');
    key(false); // a fresh press reverses
    expect(down()).toBe('Scroll down');
  });
});
