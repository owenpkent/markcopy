// The shared auto-scroll puck, loop and keys (src/webview/autoScroll.ts), driven
// through a fake host so both surfaces' contract is pinned in one place. The
// per-surface behaviour is in pdfViewer.links.test.ts and
// markdownAutoScroll.webview.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnnouncer, createAutoScroll, type AutoScrollHost } from '../src/webview/autoScroll';
import type { MenuController } from '../src/webview/menu';

let frames: Array<(ts: number) => void> = [];
const run = (ts: number): void => {
  const queued = frames;
  frames = [];
  for (const f of queued) f(ts);
};

function makeScroller(top = 0, height = 5000, view = 1000): HTMLElement {
  const el = document.createElement('div');
  let t = top;
  Object.defineProperty(el, 'scrollTop', {
    get: () => t,
    set: (v: number) => {
      t = Math.max(0, Math.min(height - view, v));
    },
  });
  Object.defineProperty(el, 'scrollHeight', { get: () => height });
  Object.defineProperty(el, 'clientHeight', { get: () => view });
  return el;
}

function setup(over: Partial<AutoScrollHost> = {}, scroller = makeScroller()) {
  let state: unknown;
  let menuOpen = false;
  const contextMenu = {
    isOpen: () => menuOpen,
    show: vi.fn(),
  } as unknown as MenuController;
  const host: AutoScrollHost = {
    scroller: () => scroller,
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    contextMenu,
    announce: vi.fn(),
    toast: vi.fn(),
    ...over,
  };
  const auto = createAutoScroll(host);
  return {
    auto,
    host,
    scroller,
    contextMenu,
    state: () => state as Record<string, unknown>,
    setMenuOpen: (v: boolean) => (menuOpen = v),
  };
}

const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, 'target', { value: target });
  return e;
};
const play = () => document.querySelector<HTMLElement>('[data-as="play"]')!;

beforeEach(() => {
  frames = [];
  document.body.innerHTML = '';
  vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('createAutoScroll', () => {
  it('builds the puck on first start and moves the scroller over time', () => {
    const s = setup();
    expect(document.getElementById('mc-autoscroll')).toBeNull();
    s.auto.start();
    expect(s.auto.isOn()).toBe(true);
    expect(document.getElementById('mc-autoscroll')!.hidden).toBe(false);
    expect(play().getAttribute('aria-label')).toBe('Pause (scrolling down)');
    run(16);
    run(1000); // a stall counts as 50 ms: 12 px/s gives 0.6 px
    expect(s.scroller.scrollTop).toBeCloseTo(0.6, 5);
    expect(s.auto.writes).toBe(1);
  });

  it('does not start when the host cannot, and holds still while held', () => {
    let held = false;
    let can = false;
    const s = setup({ isHeld: () => held, canStart: () => can });
    s.auto.start();
    expect(s.auto.isOn()).toBe(false);
    can = true;
    s.auto.start();
    held = true;
    run(0);
    run(16);
    s.scroller.scrollTop = 900; // transient, not the reader's
    run(32);
    expect(s.scroller.scrollTop).toBe(900);
    expect(s.auto.writes).toBe(0);
    held = false;
    s.auto.resync();
    run(48);
    run(64);
    expect(s.scroller.scrollTop).toBeGreaterThanOrEqual(900);
    expect(s.scroller.scrollTop).toBeLessThan(902);
    expect(s.auto.isOn()).toBe(true);
  });

  it('adopts a move it did not make and counts it', () => {
    const s = setup();
    s.auto.start();
    run(0);
    run(16);
    s.scroller.scrollTop = 3000;
    run(32);
    expect(s.auto.adoptedMoves).toBe(1);
    expect(s.scroller.scrollTop).toBeGreaterThanOrEqual(3000);
    expect(s.auto.wroteTop).toBe(s.scroller.scrollTop);
  });

  it('stops at the end, announces it and calls onStopped', () => {
    const onStopped = vi.fn();
    const s = setup({ onStopped }, makeScroller(3999.7));
    s.auto.start(); // too near the end to go down: starts up instead
    expect(play().getAttribute('aria-label')).toBe('Pause (scrolling up)');
    s.auto.stop('Auto-scroll off');
    expect(onStopped).toHaveBeenCalledTimes(1);

    document.body.innerHTML = '';
    const s2 = setup({ onStopped }, makeScroller(3999.4));
    s2.auto.start(); // just short of the end's tolerance, so it still heads down
    expect(play().getAttribute('aria-label')).toBe('Pause (scrolling down)');
    run(0);
    run(16);
    run(32);
    expect(s2.auto.isOn()).toBe(false);
    expect(onStopped).toHaveBeenCalledTimes(2);
    expect(s2.host.announce).toHaveBeenCalledWith('Auto-scroll reached the end');
    expect(s2.host.toast).toHaveBeenCalledWith('Auto-scroll reached the end');
  });

  it('keeps the speed and size in the host state beside other keys', () => {
    const s = setup();
    s.host.setState({ editMode: 'edit' });
    s.auto.start();
    s.auto.key(key('+'));
    expect(s.state()).toMatchObject({ editMode: 'edit', autoScroll: { speed: 16, size: 1 } });
    s.auto.stop('Auto-scroll off');
    // A new instance reads the same state back.
    document.body.innerHTML = '';
    const again = setup({ getState: () => s.state() });
    again.auto.start();
    expect(again.state()).toBeUndefined();
    expect(play().getAttribute('aria-label')).toBe('Pause (scrolling down)');
    again.auto.key(key('+'));
    expect(again.state().autoScroll).toMatchObject({ speed: 21 });
  });

  it('handles Space, arrows, + and -, and leaves fields, menus and chords alone', () => {
    const s = setup();
    s.auto.start();
    expect(s.auto.key(key(' '))).toBe(true);
    expect(play().getAttribute('aria-label')).toBe('Play (scrolling down)');
    expect(s.auto.key(key(' ', { repeat: true }))).toBe(true);
    expect(play().getAttribute('aria-label')).toBe('Play (scrolling down)');
    expect(s.auto.key(key('ArrowUp'))).toBe(true);
    expect(s.state().autoScroll).toMatchObject({ speed: 16 });
    expect(s.auto.key(key('ArrowDown'))).toBe(true);
    expect(s.auto.key(key('a'))).toBe(false);
    expect(s.auto.key(key('+', { ctrlKey: true }))).toBe(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(s.auto.key(key('+', {}, input))).toBe(false);
    s.setMenuOpen(true);
    expect(s.auto.key(key('+'))).toBe(false);
  });

  it('does not take Space from a focused button', () => {
    const s = setup();
    s.auto.start();
    expect(s.auto.key(key(' ', {}, play()))).toBe(false);
  });

  it('leaves Space to a focused disclosure summary', () => {
    const s = setup();
    s.auto.start();
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    details.append(summary);
    document.body.append(details);
    const e = key(' ', {}, summary);
    expect(s.auto.key(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(play().getAttribute('aria-label')).toBe('Pause (scrolling down)');
  });

  it('returns focus to the host toggle when Escape-style stop hides the focused puck', () => {
    const toggleBtn = document.createElement('button');
    document.body.append(toggleBtn);
    const s = setup({ toggleButton: () => toggleBtn });
    s.auto.start();
    play().focus();
    expect(document.activeElement).toBe(play());
    s.auto.stop('Auto-scroll off');
    expect(document.activeElement).toBe(toggleBtn);
  });

  it('sets aria-pressed on the host toggle, not on a heading with the same id', () => {
    const heading = document.createElement('h1');
    heading.id = 'mc-autoscroll-toggle';
    const toggleBtn = document.createElement('button');
    document.body.append(heading, toggleBtn);
    const s = setup({ toggleButton: () => toggleBtn });
    s.auto.start();
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
    expect(heading.hasAttribute('aria-pressed')).toBe(false);
  });

  it('keeps going at an apparent end while the host defers the edge, then stops', () => {
    let defer = true;
    const s = setup({ deferEdge: () => defer }, makeScroller(3999.4));
    s.auto.start();
    run(0);
    run(16);
    run(32);
    expect(s.auto.isOn()).toBe(true);
    defer = false;
    run(48);
    expect(s.auto.isOn()).toBe(false);
  });

  it('stops a held minus at the slowest speed, while a fresh press reverses', () => {
    const s = setup();
    s.auto.start(); // 12 down
    s.auto.key(key('-')); // 9
    for (let i = 0; i < 8; i++) s.auto.key(key('-', { repeat: true }));
    expect(play().getAttribute('aria-label')).toBe('Pause (scrolling down)');
    s.auto.key(key('-'));
    expect(play().getAttribute('aria-label')).toBe('Pause (scrolling up)');
  });

  it('steps from the - and + buttons by keyboard click, and size from the puck menu', () => {
    const s = setup();
    s.auto.start();
    const plus = document.querySelector<HTMLElement>('[data-as="plus"]')!;
    plus.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(s.state().autoScroll).toMatchObject({ speed: 16 });
    // A mouse click already stepped on pointerdown, so it must not step again.
    plus.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(s.state().autoScroll).toMatchObject({ speed: 16 });

    document
      .getElementById('mc-autoscroll')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const entries = (s.contextMenu.show as ReturnType<typeof vi.fn>).mock.calls[0][2] as Array<{
      label: string;
      run: () => void;
    }>;
    expect(entries.map((e) => e.label)).toEqual(['Small', 'Medium', 'Large', 'Extra large']);
    entries[3].run();
    expect(document.getElementById('mc-autoscroll')!.dataset.size).toBe('3');
    expect(s.state().autoScroll).toMatchObject({ size: 3 });
  });

  it('toggle starts and stops, and stop says why', () => {
    const s = setup();
    s.auto.toggle();
    expect(s.auto.isOn()).toBe(true);
    s.auto.toggle();
    expect(s.auto.isOn()).toBe(false);
    expect(s.host.announce).toHaveBeenCalledWith('Auto-scroll off');
    expect(document.getElementById('mc-autoscroll')!.hidden).toBe(true);
  });
});

describe('createAnnouncer', () => {
  it('writes to a persistent polite status region, even for repeated text', async () => {
    vi.useFakeTimers();
    const say = createAnnouncer();
    const region = document.getElementById('mc-status')!;
    expect(region.getAttribute('role')).toBe('status');
    say('one');
    expect(region.textContent).toBe('');
    vi.advanceTimersByTime(40);
    expect(region.textContent).toBe('one');
    say('one');
    expect(region.textContent).toBe('');
    vi.advanceTimersByTime(40);
    expect(region.textContent).toBe('one');
    vi.useRealTimers();
  });
});
