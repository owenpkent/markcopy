// Coverage for src/webview/audio.ts on jsdom: keys to currentTime and playback,
// folder stepping messages, the hidden folder controls for a lone file, and the
// message for a file the <audio> element cannot decode. jsdom decodes no media,
// so duration and currentTime are replaced on the element and play/pause are
// stubbed; real playback is on the manual checklist in docs/TESTING.md.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posted = vi.fn();
const play = vi.fn(() => Promise.resolve());
const pause = vi.fn();

// The module adds document and window listeners on every import; remove them
// between tests so a stale module does not also answer the next test's keys.
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

beforeEach(() => {
  vi.resetModules();
  document.body.className = 'mc-audio';
  document.body.removeAttribute('style');
  document.body.innerHTML = '<div id="app"></div>';
  document.body.dataset.mcSrc = 'vscode-resource://x/take 1.flac';
  posted.mockClear();
  play.mockClear();
  pause.mockClear();
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: posted,
    getState: () => undefined,
    setState: vi.fn(),
  }));
  HTMLMediaElement.prototype.play = play;
  HTMLMediaElement.prototype.pause = pause;
  HTMLMediaElement.prototype.load = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [target, type, fn] of listeners.splice(0)) {
    target.removeEventListener(type, fn);
  }
});

function fromHost(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin: window.origin }));
}

const loadMsg = (over: Record<string, unknown> = {}) => ({
  type: 'load',
  name: 'take 1.flac',
  path: '/audio/take 1.flac',
  size: 2048,
  position: { index: 2, count: 3 },
  autoplay: false,
  loop: false,
  ...over,
});

interface Booted {
  audio: HTMLAudioElement;
  clock: { time: number };
}

/** Import the module, give the element a duration and a clock, and deliver a load. */
async function boot(over: Record<string, unknown> = {}, duration = 120): Promise<Booted> {
  await import('../src/webview/audio');
  const audio = document.getElementById('mc-audio') as HTMLAudioElement;
  const clock = { time: 0 };
  Object.defineProperty(audio, 'duration', { configurable: true, get: () => duration });
  Object.defineProperty(audio, 'currentTime', {
    configurable: true,
    get: () => clock.time,
    set: (v: number) => {
      clock.time = v;
    },
  });
  fromHost(loadMsg(over));
  return { audio, clock };
}

function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

describe('audio webview keys', () => {
  it('asks the host for its load on start and shows the file', async () => {
    await boot();
    expect(posted).toHaveBeenCalledWith({ type: 'ready' });
    expect(document.getElementById('mc-audio-name')?.textContent).toBe('take 1.flac');
    expect(document.getElementById('mc-audio-info')?.textContent).toContain('FLAC');
  });

  it('seeks 5 s with the arrows and 30 s with Shift, clamped to the file', async () => {
    const { clock } = await boot();
    clock.time = 50;
    key('ArrowRight');
    expect(clock.time).toBe(55);
    key('ArrowLeft');
    key('ArrowLeft');
    expect(clock.time).toBe(45);
    key('ArrowRight', { shiftKey: true });
    expect(clock.time).toBe(75);
    key('ArrowRight', { shiftKey: true });
    key('ArrowRight', { shiftKey: true });
    expect(clock.time).toBe(120);
    clock.time = 3;
    key('ArrowLeft');
    expect(clock.time).toBe(0);
  });

  it('does not seek twice when the slider has focus', async () => {
    const { clock } = await boot();
    const seek = document.getElementById('mc-seek') as HTMLInputElement;
    clock.time = 50;
    const e = key('ArrowRight', {}, seek);
    expect(clock.time).toBe(55);
    // The range input's own step is cancelled, so it cannot move the value again.
    expect(e.defaultPrevented).toBe(true);
  });

  it('jumps to the start and end with Home and End', async () => {
    const { clock } = await boot();
    clock.time = 40;
    key('End');
    expect(clock.time).toBe(120);
    key('Home');
    expect(clock.time).toBe(0);
  });

  it('plays and pauses with Space and K', async () => {
    const { audio } = await boot();
    key(' ');
    expect(play).toHaveBeenCalledTimes(1);
    Object.defineProperty(audio, 'paused', { configurable: true, get: () => false });
    key('k');
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('leaves Space to a focused button and ignores keys typed in a text field', async () => {
    await boot();
    const button = document.getElementById('mc-play') as HTMLButtonElement;
    key(' ', {}, button);
    expect(play).not.toHaveBeenCalled();
    const input = document.createElement('input');
    input.type = 'text';
    document.body.append(input);
    key(' ', {}, input);
    key('ArrowRight', {}, input);
    expect(play).not.toHaveBeenCalled();
  });

  it('steps the speed with J and L along the ladder', async () => {
    const { audio } = await boot();
    audio.playbackRate = 1;
    key('l');
    expect(audio.playbackRate).toBe(1.25);
    key('j');
    key('j');
    expect(audio.playbackRate).toBe(0.75);
    expect(document.getElementById('mc-speed')?.textContent).toBe('0.75x');
  });

  it('starts playing on load when autoplay is on', async () => {
    await boot({ autoplay: true });
    expect(play).toHaveBeenCalledTimes(1);
  });
});

describe('audio webview folder stepping', () => {
  it('posts navigate for Page Up, Page Down and the buttons', async () => {
    await boot();
    key('PageUp');
    key('PageDown');
    (document.getElementById('mc-prev') as HTMLButtonElement).click();
    (document.getElementById('mc-next') as HTMLButtonElement).click();
    const steps = posted.mock.calls
      .map((c) => c[0] as { type: string; step?: number })
      .filter((m) => m.type === 'navigate')
      .map((m) => m.step);
    expect(steps).toEqual([-1, 1, -1, 1]);
  });

  it('hides the previous and next controls and their separator for a lone file', async () => {
    await boot({ position: { index: 1, count: 1 } });
    for (const id of ['mc-prev', 'mc-next', 'mc-nav-sep']) {
      expect((document.getElementById(id) as HTMLElement).style.display).toBe('none');
    }
    key('PageDown');
    expect(posted.mock.calls.some((c) => (c[0] as { type: string }).type === 'navigate')).toBe(
      false,
    );
  });

  it('shows them when the folder has several audio files', async () => {
    await boot();
    expect((document.getElementById('mc-prev') as HTMLElement).style.display).toBe('');
    expect((document.getElementById('mc-nav-sep') as HTMLElement).style.display).toBe('');
  });
});

describe('audio webview errors', () => {
  it('names the extension and says VS Code cannot decode it', async () => {
    const { audio } = await boot({ name: 'voice.m4a' });
    audio.dispatchEvent(new Event('error'));
    const msg = document.getElementById('mc-audio-error') as HTMLElement;
    expect(msg.style.display).not.toBe('none');
    expect(msg.textContent).toContain('.m4a');
    expect(msg.textContent).toContain('cannot decode');
    expect(msg.textContent).toContain('AAC');
    expect((document.getElementById('mc-play') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers the default player', async () => {
    const { audio } = await boot({ name: 'voice.m4a' });
    audio.dispatchEvent(new Event('error'));
    (document.getElementById('mc-audio-open') as HTMLButtonElement).click();
    expect(posted).toHaveBeenCalledWith({ type: 'openExternal' });
  });
});
