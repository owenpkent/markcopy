// A driver for the real preview webview bundle.
//
// The manual checklist exists because the interesting behavior lives inside a
// webview, where "the automated harnesses cannot reach" (docs/TESTING.md). That
// is true of the parts that need a browser the host does not give jsdom: canvas
// rasterisation for PNG, and how a flavor actually pastes into Word. It is not
// true of the rest. The bundle is plain DOM code that talks to the host over
// postMessage, so booting it against the host's own renderers exercises the same
// path a human does, without a human.
//
// What separates this from a unit test is that nothing here reassembles the
// bundle's steps. A test drives the menu the user drives and reads what landed
// on the clipboard, so a copy action that stops being wired to its menu row
// fails here and passes every unit test in tests/.
import { vi } from 'vitest';

/** One clipboard write, as the flavors `writeClipboard` actually set. */
export interface Clip {
  html: string | null;
  plain: string;
}

/** A message the bundle posted back to the host. */
export interface Posted {
  type: string;
  [key: string]: unknown;
}

/** SYNC_ECHO_MS in src/webview/main.ts. Pinned by the shell contract test. */
const ECHO_WINDOW_MS = 250;

/** Consecutive silent ticks that count as the bundle having finished. */
const QUIET_TICKS = 3;

/**
 * Ceiling on settle()'s quiescence loop. Only reached when the bundle never goes
 * quiet, so hitting it should surface as the assertion failing on stale state
 * rather than as a suite that hangs until the runner's own timeout.
 */
const MAX_SETTLE_TICKS = 50;

/** What `src/previewShell.ts` serves. Pinned by the shell contract test. */
const SHELL =
  '<div id="content" class="markdown-body"></div>' +
  '<div id="mc-menu" class="mc-menu" role="menu" hidden></div>' +
  '<div id="mc-toast" class="mc-toast" hidden></div>';

/** The render message fields the host sends that a caller rarely cares about. */
const RENDER_DEFAULTS = {
  source: '',
  docKey: 'file:///doc',
  docVersion: -1,
  syncScroll: true,
  autoPreview: true,
  math: true,
  theme: 'auto',
  styleProfile: 'github',
  mermaidConfig: {},
};

export interface RenderOptions {
  /** Body HTML, as produced by src/csv.ts, src/xlsx.ts, or markdown-it. */
  html: string;
  /** 'markdown' | 'csv' | 'xlsx'. Drives the grid layout in preview.css. */
  kind?: string;
  /** The document text behind the preview, for scroll sync and block copies. */
  source?: string;
  /**
   * Whether this surface takes part in scroll sync at all. The host sends false
   * for a sheet, which has no TextDocument to reveal into. Left at the host's
   * own default rather than defaulting to false here: a harness that quietly
   * switches sync off is how a "stays out of sync" assertion passes for the
   * wrong reason.
   */
  supportsSync?: boolean;
  syncScroll?: boolean;
  theme?: string;
  docKey?: string;
  docVersion?: number;
  math?: boolean;
}

/** A menu panel stack, driven the way a pointer drives it. */
export interface MenuDriver {
  /** Row text of the deepest open panel, in order, arrows stripped. */
  labels(): string[];
  /** Row text of every open panel, root first. */
  allLabels(): string[][];
  /** Section headings of the deepest open panel (SELECTION, TABLE, ...). */
  sections(): string[];
  /**
   * Walk a path of rows, clicking each. A submenu row opens its panel, a
   * leaf row runs its action. Matches the first row with that text in the
   * deepest open panel, so a path is needed to disambiguate the formats that
   * repeat across sections.
   */
  click(...path: string[]): Promise<void>;
  /** Whether the menu is on screen at all. */
  open(): boolean;
}

/** A stand-in for the layout jsdom does not do. */
export interface FakeLayout {
  /** Scroll the preview and let it react, the way a wheel or a drag does. */
  scrollTo(offset: number): void;
  /** Where the preview is scrolled to now. */
  offset(): number;
  /** Top of the block rendered from `line`, in the same coordinates. */
  topOfBlock(index: number): number;
  /** The furthest the preview can scroll. */
  maxOffset(): number;
  /**
   * Put jsdom's own layout back.
   *
   * Optional in practice: the next `fakeLayout()` unwinds this one first, and
   * Vitest isolates per file. Worth calling from an `afterEach` in any file that
   * mixes sync tests with tests that want real (zero) measurements, where a
   * stale stand-in would answer for elements it has never seen.
   */
  restore(): void;
}

export interface LayoutOptions {
  /** Height of each `[data-source-line]` block. */
  blockHeight?: number;
  /** Height of the visible window. */
  viewport?: number;
  /**
   * Blocks that are taller than the rest, by index. Scroll sync interpolates
   * within a block, so a checklist row about tracking part way through a long
   * code block needs one block that is worth being part way through.
   */
  tall?: Record<number, number>;
}

export interface Harness {
  /** Everything the bundle has posted to the host, oldest first. */
  posted: Posted[];
  /** Every clipboard write, oldest first. */
  clips: Clip[];
  /** The last clipboard write, or undefined if nothing was copied. */
  lastClip(): Clip | undefined;
  /** Post a `render` the way the host does, and let its awaits settle. */
  render(options: RenderOptions): Promise<void>;
  /** The preview's content root. */
  content(): HTMLElement;
  /** First match inside the content root. Throws rather than returning null. */
  find(selector: string): HTMLElement;
  /** Right-click an element and return a driver for the menu it opens. */
  rightClick(target: Element): MenuDriver;
  /** Let pending microtasks and dynamic imports finish. */
  settle(): Promise<void>;
  /**
   * Let the scroll-sync echo window close and the deferred re-check run.
   *
   * The bundle mutes sync for SYNC_ECHO_MS after it moves the preview itself,
   * and re-decides on a timer once the window shuts. A test that asserts before
   * that timer fires sees no message and reads it as sync being broken; one
   * that never waits at all leaks the deferred post into the next test.
   */
  settleSync(): Promise<void>;
  /** Forget posted messages and clipboard writes. */
  reset(): void;
  /**
   * Give the current render a synthetic layout, so scroll sync has offsets to
   * work with. Call after `render()`: it measures whatever blocks are on screen.
   */
  fakeLayout(options?: LayoutOptions): FakeLayout;
}

// The in-flight or finished boot, not the resolved harness: `bootOnce` awaits a
// dynamic import part way through, so storing the result would let two callers
// that both arrive before that await resolves import the bundle twice.
let booted: Promise<Harness> | undefined;

/**
 * Boot the bundle. Call once per test file, from `beforeAll`.
 *
 * The bundle captures `#content` and `#mc-menu` at module scope, so it can only
 * be imported once per module registry and the DOM it captured has to outlive
 * every test in the file. Tests re-`render()` instead of rebuilding the shell.
 */
export function boot(): Promise<Harness> {
  if (!booted) {
    booted = bootOnce();
  }
  return booted;
}

async function bootOnce(): Promise<Harness> {
  const posted: Posted[] = [];
  const clips: Clip[] = [];

  document.body.innerHTML = SHELL;

  (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (message: Posted) => posted.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });

  // jsdom has no layout, so the grid's resize handles measure nothing and
  // neither scrolling a cell into view nor scrolling the window exists. Left
  // unstubbed, `scrollTo` prints a "Not implemented" trace on every render.
  (Element.prototype as unknown as Record<string, unknown>).scrollIntoView = vi.fn();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;

  // jsdom implements neither execCommand nor ClipboardEvent, so the bundle's
  // synchronous copy-event write has nothing to write into. Standing in for
  // both is what makes a clipboard flavor readable from a test: the bundle's
  // own `onCopy` handler runs and sets the flavors on this shim.
  (document as unknown as Record<string, unknown>).execCommand = (command: string): boolean => {
    if (command !== 'copy') {
      return false;
    }
    const flavors = new Map<string, string>();
    const event = new Event('copy', { cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        setData: (type: string, value: string) => flavors.set(type, value),
        getData: (type: string) => flavors.get(type) ?? '',
      },
    });
    document.dispatchEvent(event);
    clips.push({ html: flavors.get('text/html') ?? null, plain: flavors.get('text/plain') ?? '' });
    return true;
  };

  // The fallback path when execCommand reports failure. Recorded in the same
  // list so a test asserting on what was copied does not have to know which of
  // the two routes the bundle took.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        clips.push({ html: null, plain: text });
        return Promise.resolve();
      },
    },
  });

  await import('../../src/webview/main');

  const content = () => document.getElementById('content') as HTMLElement;

  // Anything the bundle writes to the DOM, counted. Together with `posted` and
  // `clips` this is every observable the bundle has, which is what lets settle()
  // ask "has it stopped doing things" instead of guessing how many ticks it
  // needed. MutationObserver delivers on the microtask queue, so the count is
  // current by the time the next macrotask runs.
  let domWrites = 0;
  new MutationObserver((records) => {
    domWrites += records.length;
  }).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });

  const settle = async (): Promise<void> => {
    // Tick until the bundle has been quiet for QUIET_TICKS in a row.
    //
    // A copy action awaits its own render, then a dynamic import (Turndown,
    // html-to-image), then whatever that import resolves into, and each lands a
    // tick apart. A fixed tick count is a guess at how deep that chain is, and
    // guessing low is the worst failure this layer can have: `lastClip()` comes
    // back empty and reads as a copy action that stopped being wired up, which
    // is the exact bug the suite exists to catch. Waiting on quiescence instead
    // survives a chain that grows a step.
    let quiet = 0;
    for (let i = 0; i < MAX_SETTLE_TICKS && quiet < QUIET_TICKS; i++) {
      const before = `${posted.length}:${clips.length}:${domWrites}`;
      await new Promise((resolve) => setTimeout(resolve, 0));
      quiet = before === `${posted.length}:${clips.length}:${domWrites}` ? quiet + 1 : 0;
    }
  };

  const settleSync = async (): Promise<void> => {
    // The echo window is a real timer in the bundle, so this one has to be real
    // time; quiescence cannot tell "still muted" from "finished and said
    // nothing", which is precisely the distinction the echo tests assert on.
    await new Promise((resolve) => setTimeout(resolve, ECHO_WINDOW_MS + 60));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await settle();
  };

  const harness: Harness = {
    posted,
    clips,
    lastClip: () => clips[clips.length - 1],
    content,
    settle,
    settleSync,
    reset: () => {
      posted.length = 0;
      clips.length = 0;
    },

    async render(options: RenderOptions): Promise<void> {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'render', kind: 'markdown', ...RENDER_DEFAULTS, ...options },
        }),
      );
      await settle();
    },

    find(selector: string): HTMLElement {
      const el = content().querySelector<HTMLElement>(selector);
      if (!el) {
        throw new Error(`no element matched ${selector}`);
      }
      return el;
    },

    rightClick(target: Element): MenuDriver {
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return menuDriver(settle);
    },

    fakeLayout(options: LayoutOptions = {}): FakeLayout {
      return installLayout(content(), options);
    },
  };

  return harness;
}

/** The layout currently patched over jsdom's, if any. */
let activeLayout: FakeLayout | undefined;

/**
 * Stack the blocks of the current render into a synthetic page.
 *
 * Scroll sync is the one part of the bundle that is all measurement, and jsdom
 * measures everything as zero: every anchor lands on offset 0, so any assertion
 * about which line the preview is showing passes for the wrong reason. Giving
 * the blocks real heights is what makes the difference between testing the
 * interpolation and testing that 0 equals 0.
 */
function installLayout(content: HTMLElement, options: LayoutOptions): FakeLayout {
  // A previous layout's patches are still on the prototypes, and capturing those
  // as "the originals" would make restore() reinstate a stand-in. Unwind first,
  // so what gets saved below is always jsdom's own.
  activeLayout?.restore();

  const blockHeight = options.blockHeight ?? 100;
  // Deliberately shorter than the content by several blocks. `anchors()` drops
  // every anchor at or past `maxScroll()`, so a viewport close to the document
  // height leaves two anchors standing and every offset interpolates to line 0,
  // which reads as sync being broken when it is the fixture that is too short.
  const viewport = options.viewport ?? 150;
  const tall = options.tall ?? {};

  const blocks = Array.from(content.querySelectorAll<HTMLElement>('[data-source-line]'));
  const tops: number[] = [];
  let running = 0;
  for (let i = 0; i < blocks.length; i++) {
    tops.push(running);
    running += tall[i] ?? blockHeight;
  }
  const documentHeight = running;

  let offset = 0;

  // Everything below is a global. Saved so restore() can put jsdom back rather
  // than leaving a stranded closure answering getBoundingClientRect for elements
  // from a render that is three tests out of date.
  const patched: (() => void)[] = [];
  const patch = (target: object, key: string, descriptor: PropertyDescriptor): void => {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    patched.push(() => {
      if (original) {
        Object.defineProperty(target, key, original);
      } else {
        delete (target as Record<string, unknown>)[key];
      }
    });
  };

  patch(window, 'scrollY', { get: () => offset });
  patch(window, 'innerHeight', { get: () => viewport });
  patch(document.documentElement, 'scrollHeight', { get: () => documentHeight });
  const fakeScrollTo = ((...args: unknown[]) => {
    const y = typeof args[0] === 'object' ? (args[0] as ScrollToOptions).top : args[1];
    offset = Math.max(0, Math.min(documentHeight - viewport, Number(y ?? 0)));
  }) as unknown as typeof window.scrollTo;
  patch(window, 'scrollTo', { value: fakeScrollTo, writable: true });

  // The bundle measures a block as `getBoundingClientRect().top`, which is
  // viewport-relative, and adds the scroll offset back. Mirroring that here
  // rather than handing it absolute tops is what keeps this a stand-in for
  // layout rather than a second implementation of the anchor maths.
  const rectFor = (el: HTMLElement): DOMRect => {
    const index = blocks.indexOf(el);
    const top = index >= 0 ? tops[index] - offset : 0;
    const height = index >= 0 ? (tall[index] ?? blockHeight) : 0;
    return {
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
    } as DOMRect;
  };
  patch(HTMLElement.prototype, 'getBoundingClientRect', {
    writable: true,
    value(this: HTMLElement) {
      return rectFor(this);
    },
  });

  const layout: FakeLayout = {
    scrollTo(next: number): void {
      offset = Math.max(0, Math.min(documentHeight - viewport, next));
      window.dispatchEvent(new Event('scroll'));
    },
    offset: () => offset,
    topOfBlock: (index: number) => tops[index],
    maxOffset: () => Math.max(0, documentHeight - viewport),
    restore(): void {
      if (activeLayout !== layout) {
        return;
      }
      for (const undo of patched.reverse()) {
        undo();
      }
      activeLayout = undefined;
    },
  };
  activeLayout = layout;
  return layout;
}

/** Panels on screen, root first. A hidden root means no menu at all. */
function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.mc-menu')).filter(
    (panel) => !panel.hidden,
  );
}

function rowText(el: Element): string {
  return (el.textContent ?? '').replaceAll('▸', '').replaceAll('✓', '').trim();
}

function menuDriver(settle: () => Promise<void>): MenuDriver {
  const deepest = (): HTMLElement | undefined => panels()[panels().length - 1];

  return {
    open: () => panels().length > 0,

    labels: () => Array.from(deepest()?.querySelectorAll('.mc-menu-item') ?? []).map(rowText),

    allLabels: () =>
      panels().map((panel) => Array.from(panel.querySelectorAll('.mc-menu-item')).map(rowText)),

    sections: () =>
      Array.from(deepest()?.querySelectorAll('.mc-menu-group-label') ?? []).map(rowText),

    async click(...path: string[]): Promise<void> {
      for (const label of path) {
        const panel = deepest();
        const row = Array.from(panel?.querySelectorAll<HTMLElement>('.mc-menu-item') ?? []).find(
          (candidate) => rowText(candidate) === label,
        );
        if (!row) {
          const seen = Array.from(panel?.querySelectorAll('.mc-menu-item') ?? []).map(rowText);
          throw new Error(`no menu row "${label}"; the open panel has: ${JSON.stringify(seen)}`);
        }
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await settle();
      }
    },
  };
}
