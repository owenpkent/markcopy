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
  destGate: null as Promise<void> | null,
  destGates: {} as Record<string, Promise<void>>,
  pageByNum: {} as Record<number, number>,
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
      getDestination: async (name: string) => {
        await h.destGate;
        await h.destGates[name];
        return h.dests[name] ?? null;
      },
      getPageIndex: (ref: { num: number }) => Promise.resolve(h.pageByNum[ref.num] ?? h.pageIndex),
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

// Every import of the viewer listens on the shared window and document; without
// removing them, a message or click would also reach each earlier test's copy
// and they would all rebuild the same page.
const listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];
for (const target of [window, document]) {
  const add = target.addEventListener.bind(target) as EventTarget['addEventListener'];
  target.addEventListener = ((
    type: string,
    fn: EventListenerOrEventListenerObject,
    o?: unknown,
  ) => {
    listeners.push([target, type, fn]);
    add(type, fn, o as AddEventListenerOptions);
  }) as EventTarget['addEventListener'];
}

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
  h.destGate = null;
  h.destGates = {};
  h.pageByNum = {};
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
  for (const [target, type, fn] of listeners.splice(0)) {
    target.removeEventListener(type, fn);
  }
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

describe("the reader's own navigation while a PDF is opening", () => {
  const FIRST = { subtype: 'Link', rect: [60, 70, 90, 90], action: 'FirstPage' };
  const label = () => document.getElementById('mc-page-label')!.textContent;
  const lastPage = () => (scrollIntoView.mock.contexts.at(-1) as HTMLElement).dataset.page;

  it('lets a later available-page link supersede an older pending one', async () => {
    h.annots[1] = [{ ...CHAPTER, action: 'LastPage' }, FIRST];
    let release!: () => void;
    h.gates[3] = new Promise<void>((r) => (release = r));
    await loadDoc();
    await showPage(1);
    clickAt(30, 80); // Last Page: page 5 does not exist yet, so it waits
    clickAt(75, 20); // First Page: exists, so it goes now
    expect(lastPage()).toBe('1');
    release();
    await settle();
    expect(document.querySelectorAll('.mc-page')).toHaveLength(5);
    expect(lastPage()).toBe('1'); // page 5 must not take over
  });

  it('keeps an available page chosen during load over the saved position', async () => {
    h.dests.two = [{ num: 1, gen: 0 }, { name: 'Fit' }];
    h.pageIndex = 1; // page 2
    h.annots[1] = [{ ...CHAPTER, dest: 'two' }];
    let release!: () => void;
    h.gates[4] = new Promise<void>((r) => (release = r));
    await loadDoc({ page: 5, y: 0, zoom: 1, fitWidth: false });
    await showPage(1);
    clickAt(30, 80);
    await settle();
    expect(label()).toBe('2 / 5');
    release();
    await settle();
    expect(label()).toBe('2 / 5'); // restoration must not put it back on page 5
  });

  it('drops the saved position when the reader scrolls first', async () => {
    let release!: () => void;
    h.gates[2] = new Promise<void>((r) => (release = r));
    await loadDoc({ page: 5, y: 0, zoom: 1, fitWidth: false });
    window.dispatchEvent(new Event('wheel'));
    release();
    await settle();
    expect(label()).toBe('1 / 5');
  });

  it('drops the saved position when the reader zooms first', async () => {
    let release!: () => void;
    h.gates[2] = new Promise<void>((r) => (release = r));
    await loadDoc({ page: 5, y: 0, zoom: 1, fitWidth: false });
    document.querySelector<HTMLElement>('[data-act="in"]')!.click();
    release();
    await settle();
    expect(label()).toBe('1 / 5');
  });
});

describe('a slow destination lookup', () => {
  it('does not override a newer selection when it finally returns', async () => {
    h.dests.late = [{ num: 1, gen: 0 }, { name: 'Fit' }];
    h.pageIndex = 4; // page 5
    h.annots[1] = [
      { ...CHAPTER, dest: 'late' },
      { subtype: 'Link', rect: [60, 70, 90, 90], action: 'FirstPage' },
    ];
    await loadDoc();
    await showPage(1);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    h.destGate = held;
    clickAt(30, 80); // named destination: the lookup is held
    clickAt(75, 20); // First Page
    const lastPage = () => (scrollIntoView.mock.contexts.at(-1) as HTMLElement).dataset.page;
    expect(lastPage()).toBe('1');
    release();
    await settle();
    expect(lastPage()).toBe('1');
    expect(document.getElementById('mc-page-label')!.textContent).toBe('1 / 5');
  });
});

describe('two destination links followed in a row', () => {
  async function twoLinks(): Promise<{ release: (n: 'two' | 'four') => void }> {
    h.dests.two = [{ num: 2, gen: 0 }, { name: 'Fit' }];
    h.dests.four = [{ num: 4, gen: 0 }, { name: 'Fit' }];
    h.pageByNum = { 2: 1, 4: 3 };
    h.annots[1] = [
      { ...CHAPTER, dest: 'two' },
      { subtype: 'Link', rect: [60, 70, 90, 90], dest: 'four' },
    ];
    await loadDoc();
    await vi.waitFor(() => expect(document.querySelectorAll('.mc-page')).toHaveLength(5));
    await showPage(1);
    const releases: Record<string, () => void> = {};
    for (const name of ['two', 'four']) {
      h.destGates[name] = new Promise<void>((r) => (releases[name] = r));
    }
    clickAt(30, 80); // page 2
    clickAt(75, 20); // page 4
    return { release: (n) => releases[n]() };
  }
  const label = () => document.getElementById('mc-page-label')!.textContent;

  it('lands on the newest when the lookups finish in click order', async () => {
    const { release } = await twoLinks();
    release('two');
    await settle();
    release('four');
    await vi.waitFor(() => expect(label()).toBe('4 / 5'));
  });

  it('lands on the newest when the newest lookup finishes first', async () => {
    const { release } = await twoLinks();
    release('four');
    await vi.waitFor(() => expect(label()).toBe('4 / 5'));
    release('two');
    await settle();
    expect(label()).toBe('4 / 5');
  });
});

describe('Page Down with a toolbar button focused while a PDF is opening', () => {
  it('keeps the view the key scrolled to instead of restoring the saved page', async () => {
    let release!: () => void;
    h.gates[2] = new Promise<void>((r) => (release = r));
    await loadDoc({ page: 5, y: 0, zoom: 1, fitWidth: false });
    const button = document.querySelector<HTMLElement>('[data-act="in"]')!;
    button.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }),
    );
    scrollTop = 306; // what the browser's default action does
    frames.splice(0).forEach((f) => f(0));
    release();
    await vi.waitFor(() => expect(document.querySelectorAll('.mc-page')).toHaveLength(5));
    await settle();
    expect(label()).not.toBe('5 / 5');
  });

  const label = () => document.getElementById('mc-page-label')!.textContent;
});

describe('an auto-scroll speed key while a PDF is opening', () => {
  it('keeps the saved page', async () => {
    let release!: () => void;
    h.gates[2] = new Promise<void>((r) => (release = r));
    await loadDoc({ page: 5, y: 0, zoom: 1, fitWidth: false });
    document.getElementById('mc-autoscroll-toggle')!.click();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    release();
    await settle();
    expect(document.getElementById('mc-page-label')!.textContent).toBe('5 / 5');
  });
});

describe('a link offset that needs pages still being laid out', () => {
  // Five 100 px pages, a 90 px view: page 3's top is 200, and 80 px into it is
  // 280, but while only three pages exist the view can scroll to 210 at most.
  function realLayout(): void {
    const pagesNow = () => document.querySelectorAll('.mc-page').length;
    const clamp = (v: number) => Math.max(0, Math.min(v, pagesNow() * 100 - 90));
    Object.defineProperty(document.documentElement, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = clamp(v);
      },
    });
    const prev = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains('mc-page')) {
        const n = Number((this as HTMLElement).dataset.page);
        const top = (n - 1) * 100 - scrollTop;
        return { left: 0, top, right: 100, bottom: top + 100, width: 100, height: 100 } as DOMRect;
      }
      return prev.call(this);
    };
    scrollIntoView.mockImplementation(function (this: HTMLElement) {
      scrollTop = clamp((Number(this.dataset.page) - 1) * 100);
    });
  }
  async function setup(): Promise<() => void> {
    h.dests.deep = [{ num: 1, gen: 0 }, { name: 'XYZ' }, 0, 20]; // 80 px down
    h.pageIndex = 2;
    h.annots[1] = [{ ...CHAPTER, dest: 'deep' }];
    let release!: () => void;
    h.gates[4] = new Promise<void>((r) => (release = r));
    realLayout();
    await loadDoc();
    await showPage(1);
    return release;
  }

  it('finishes landing on the destination once the layout reaches it', async () => {
    const release = await setup();
    clickAt(30, 80);
    await settle();
    expect(scrollTop).toBe(210); // all the range there is for now
    release();
    await settle();
    expect(scrollTop).toBe(280);
  });

  it('does not finish it if the reader moved elsewhere meanwhile', async () => {
    const release = await setup();
    clickAt(30, 80);
    await settle();
    window.dispatchEvent(new Event('wheel'));
    release();
    await settle();
    expect(scrollTop).toBe(210);
  });

  it('does not undo a Hand-tool drag made while the offset waits', async () => {
    const release = await setup();
    clickAt(30, 80);
    await settle();
    expect(scrollTop).toBe(210);
    const canvas = document.querySelector('.mc-canvas')!;
    const at = (y: number) => ({ bubbles: true, clientX: 50, clientY: y, button: 0 });
    canvas.dispatchEvent(new MouseEvent('pointerdown', at(100)));
    canvas.dispatchEvent(new MouseEvent('pointermove', at(160))); // drag down: 210 to 150
    canvas.dispatchEvent(new MouseEvent('pointerup', at(160)));
    expect(scrollTop).toBe(150);
    release();
    await settle();
    expect(scrollTop).toBe(150);
  });

  it('does not carry a waiting offset into a replacement document', async () => {
    h.dests.near = [{ num: 1, gen: 0 }, { name: 'XYZ' }, 0, 20]; // 80 px into page 1
    h.pageIndex = 0;
    h.annots[1] = [{ ...CHAPTER, dest: 'near' }];
    let release!: () => void;
    h.gates[2] = new Promise<void>((r) => (release = r));
    realLayout();
    await loadDoc();
    await showPage(1);
    clickAt(30, 80); // only page 1 exists, so the 80 px cannot be reached yet
    await settle();
    h.annots = {};
    scrollTop = 0;
    await loadDoc(); // a LaTeX recompile: a new document with no links
    release();
    await settle();
    expect(scrollTop).toBe(0);
  });
});

describe("an external link's tooltip and name", () => {
  it('shows the address as the tooltip and keeps the text as the accessible name', async () => {
    h.annots[1] = [
      { ...CHAPTER, url: 'https://example.com/guide', overlaidText: 'Read the guide' },
      { subtype: 'Link', rect: [60, 70, 90, 90], url: `https://example.com/${'a'.repeat(900)}` },
    ];
    await loadDoc();
    await showPage(1);
    const [named, long] = links();
    expect(named.title).toBe('https://example.com/guide');
    expect(named.getAttribute('aria-label')).toBe('Read the guide');
    expect(long.title.length).toBeLessThanOrEqual(200);
    expect(long.title.startsWith('https://example.com/aaa')).toBe(true);
  });
});

describe('the first checkpoint after a zoom step', () => {
  it('already carries the new zoom and the dropped fit-width mode', async () => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      get: () => 232, // 200 px of paper for a 100 px page: fits at 200%
    });
    await loadDoc(null);
    vi.useFakeTimers();
    document.getElementById('mc-fit-width')!.click();
    vi.advanceTimersByTime(5000); // idle: the next movement is a leading checkpoint
    posted.length = 0;
    document.querySelector<HTMLElement>('[data-act="in"]')!.click();
    const first = posted.find((m) => m.type === 'savePosition')!;
    expect(first).toMatchObject({ zoom: 2.5, fitWidth: false });
  });
});

describe('Enter held on a speed button', () => {
  it('stops at the slowest speed, while a fresh press may reverse', async () => {
    await loadDoc();
    document.getElementById('mc-autoscroll-toggle')!.click(); // 12 px/s down
    const minus = document.querySelector<HTMLElement>('[data-as="minus"]')!;
    const label = () =>
      document.querySelector<HTMLElement>('[data-as="dir"]')!.getAttribute('aria-label');
    // A keyboard click has detail 0 and arrives with every Enter keydown.
    const enter = (repeat: boolean) => {
      minus.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat, bubbles: true }));
      minus.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    };
    enter(false);
    for (let i = 0; i < 8; i++) enter(true);
    expect(label()).toBe('Scroll up'); // still going down, at the slowest
    minus.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    enter(false);
    expect(label()).toBe('Scroll down'); // reversed by a fresh press
  });
});
