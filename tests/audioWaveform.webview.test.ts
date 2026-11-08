// Coverage for the waveform and the details panel in src/webview/audio.ts on jsdom.
// jsdom has no canvas, no layout and no Web Audio: getContext, getBoundingClientRect,
// fetch and AudioContext are stubbed. How the waveform actually looks is on the manual
// checklist in docs/TESTING.md.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posted = vi.fn();

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

let decodeFails = false;
const closeCtx = vi.fn(() => Promise.resolve());

class FakeAudioContext {
  decodeAudioData(): Promise<unknown> {
    if (decodeFails) {
      return Promise.reject(new Error('cannot decode'));
    }
    const left = new Float32Array(4800);
    const right = new Float32Array(4800);
    left[10] = 0.5;
    right[20] = -1;
    return Promise.resolve({
      numberOfChannels: 2,
      duration: 120,
      getChannelData: (c: number) => (c === 0 ? left : right),
    });
  }
  close = closeCtx;
}

beforeEach(() => {
  vi.resetModules();
  decodeFails = false;
  closeCtx.mockClear();
  document.body.className = 'mc-audio';
  document.body.removeAttribute('style');
  document.body.innerHTML = '<div id="app"></div>';
  posted.mockClear();
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: posted,
    getState: () => undefined,
    setState: vi.fn(),
  }));
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    ),
  );
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  const ctx = new Proxy({ measureText: () => ({ width: 40 }) } as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
    set: () => true,
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
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

async function boot(size = 2048, showTags?: boolean) {
  await import('../src/webview/audio');
  const audio = document.getElementById('mc-audio') as HTMLAudioElement;
  const clock = { time: 0 };
  Object.defineProperty(audio, 'duration', { configurable: true, get: () => 120 });
  Object.defineProperty(audio, 'currentTime', {
    configurable: true,
    get: () => clock.time,
    set: (v: number) => {
      clock.time = v;
    },
  });
  const wave = document.getElementById('mc-wave') as HTMLElement;
  wave.getBoundingClientRect = () =>
    ({
      left: 100,
      top: 10,
      width: 400,
      height: 120,
      right: 500,
      bottom: 130,
      x: 100,
      y: 10,
    }) as DOMRect;
  fromHost({
    type: 'load',
    src: 'vscode-resource://x/take.flac',
    name: 'take.flac',
    path: '/a/take.flac',
    size,
    position: { index: 1, count: 1 },
    showTags,
  });
  return { audio, clock, wave };
}

const canvasShown = () => document.getElementById('mc-wave-canvas')?.hidden === false;

function press(el: Element, type: string, clientX: number, clientY: number): void {
  el.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true }));
}

describe('waveform', () => {
  it('shows a quiet drawing state, then the canvas, and closes the context', async () => {
    const { wave } = await boot();
    expect(document.getElementById('mc-wave-status')?.textContent).toBe('Drawing waveform...');
    await vi.waitFor(() => expect(canvasShown()).toBe(true));
    expect(wave.hidden).toBe(false);
    expect(document.getElementById('mc-wave-status')?.hidden).toBe(true);
    expect(closeCtx).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith('vscode-resource://x/take.flac');
  });

  it('fills the level rows from the one decode pass', async () => {
    await boot();
    await vi.waitFor(() => expect(canvasShown()).toBe(true));
    const text = document.getElementById('mc-audio-details')?.textContent ?? '';
    expect(text).toContain('Peak');
    expect(text).toContain('0.0 dBFS');
    expect(text).toContain('Clipping');
    expect(text).toContain('1 sample ');
  });

  it('seeks to the time under a click, and follows a drag', async () => {
    const { clock, wave } = await boot();
    await vi.waitFor(() => expect(canvasShown()).toBe(true));
    // x = 300 is 200 px into a 400 px wave: half of 120 s.
    press(wave, 'pointerdown', 300, 70);
    expect(clock.time).toBeCloseTo(60, 5);
    press(wave, 'pointermove', 400, 70);
    expect(clock.time).toBeCloseTo(90, 5);
    press(wave, 'pointerup', 400, 70);
    press(wave, 'pointermove', 500, 70);
    expect(clock.time).toBeCloseTo(90, 5);
    press(wave, 'pointerdown', 50, 70);
    expect(clock.time).toBe(0);
  });

  it('does not take the arrow keys: the document handler seeks once', async () => {
    const { clock, wave } = await boot();
    await vi.waitFor(() => expect(canvasShown()).toBe(true));
    clock.time = 50;
    wave.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(clock.time).toBe(55);
    const canvas = document.getElementById('mc-wave-canvas');
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(canvas?.hasAttribute('tabindex')).toBe(false);
  });

  it('skips decoding above the size cap and says why', async () => {
    await boot(200 * 1024 * 1024);
    expect(fetch).not.toHaveBeenCalled();
    expect(document.getElementById('mc-wave-status')?.textContent).toContain('Waveform skipped');
  });

  it('hides the waveform when decoding fails and keeps the player', async () => {
    decodeFails = true;
    const { wave, clock } = await boot();
    await vi.waitFor(() => expect(wave.hidden).toBe(true));
    expect(document.getElementById('mc-audio-error')?.style.display).toBe('none');
    clock.time = 10;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(clock.time).toBe(15);
  });
});

describe('details panel', () => {
  const details = {
    format: 'MP3',
    codec: 'MP3',
    sampleRate: 44100,
    channels: 2,
    layout: 'stereo',
    bitRate: 192000,
    duration: 61.5,
    tags: {
      title: '<img src=x onerror=alert(1)>',
      artist: 'Band',
      comment: 'a very long comment '.repeat(40),
    },
  };

  it('renders rows and tags as text, never as markup', async () => {
    await boot(2048, true);
    fromHost({ type: 'details', details });
    const panel = document.getElementById('mc-audio-details') as HTMLElement;
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain('44.1 kHz');
    expect(panel.textContent).toContain('2 (stereo)');
    expect(panel.textContent).toContain('192 kbps');
    expect(panel.textContent).toContain('0:01:01.500');
    expect(panel.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(panel.querySelector('img')).toBeNull();
    const labels = [...panel.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(['Format', 'Codec', 'Title', 'Artist', 'Comment']),
    );
  });

  it('ignores a malformed details message without an error', async () => {
    await boot();
    fromHost({ type: 'details', details: 'nope' });
    expect(document.getElementById('mc-audio-error')?.style.display).toBe('none');
    // The rows the page knows itself (format from the name, size) are still there.
    expect(document.getElementById('mc-audio-details')?.textContent).toContain('FLAC');
  });

  it('copies the panel as Markdown', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await boot(2048, true);
    fromHost({ type: 'details', details });
    (document.getElementById('mc-audio-copy-details') as HTMLButtonElement).click();
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain('## take.flac');
    expect(text).toContain('- **Sample rate:** 44.1 kHz');
    expect(text).toContain('- **Artist:** Band');
  });

  const tagsHead = () =>
    [...document.querySelectorAll('#mc-audio-details h2')].find((h) => h.textContent === 'Tags') as
      HTMLElement | undefined;

  it('hides the tags by default and leaves them out of Copy details', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await boot();
    fromHost({ type: 'details', details });
    const panel = document.getElementById('mc-audio-details') as HTMLElement;
    expect(panel.textContent).toContain('44.1 kHz');
    expect(panel.textContent).not.toContain('Band');
    expect(tagsHead()?.hidden).toBe(true);
    (document.getElementById('mc-audio-copy-details') as HTMLButtonElement).click();
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text).not.toContain('Artist');
  });

  it('shows the tags when the load message says so', async () => {
    await boot(2048, true);
    fromHost({ type: 'details', details });
    expect(document.getElementById('mc-audio-details')?.textContent).toContain('Band');
    expect(tagsHead()?.hidden).toBe(false);
  });
});

describe('context menu', () => {
  const details = { format: 'MP3', tags: { artist: 'Band' } };

  function openMenu(target: Element = document.body) {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  }

  const item = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('.mc-menu-item')].find(
      (el) => el.textContent?.replace(/^✓/, '').replace(/▸$/, '') === label,
    );

  it('opens on right-click with Show Tags unchecked', async () => {
    await boot();
    const e = openMenu();
    expect(e.defaultPrevented).toBe(true);
    expect(document.getElementById('mc-menu')?.hidden).toBe(false);
    const show = item('Show Tags');
    expect(show?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(show?.getAttribute('aria-checked')).toBe('false');
    for (const label of ['Copy', 'Playback', 'Preferences', 'Open Audio Notes']) {
      expect(item(label), label).toBeDefined();
    }
  });

  it('toggles the tags and saves audio.showTags', async () => {
    await boot();
    fromHost({ type: 'details', details });
    const panel = document.getElementById('mc-audio-details') as HTMLElement;
    expect(panel.textContent).not.toContain('Band');
    openMenu();
    item('Show Tags')?.click();
    expect(posted).toHaveBeenCalledWith({
      type: 'updateSetting',
      key: 'audio.showTags',
      value: true,
    });
    expect(panel.textContent).toContain('Band');
    openMenu();
    expect(item('Show Tags')?.getAttribute('aria-checked')).toBe('true');
    item('Show Tags')?.click();
    expect(posted).toHaveBeenCalledWith({
      type: 'updateSetting',
      key: 'audio.showTags',
      value: false,
    });
    expect(panel.textContent).not.toContain('Band');
  });

  it('saves Loop from the Playback submenu', async () => {
    await boot();
    openMenu();
    item('Playback')?.click();
    item('Loop')?.click();
    expect(posted).toHaveBeenCalledWith({ type: 'updateSetting', key: 'audio.loop', value: true });
  });

  it('leaves the native menu over a text field', async () => {
    await boot();
    const input = document.createElement('textarea');
    document.body.append(input);
    expect(openMenu(input).defaultPrevented).toBe(false);
    expect(document.getElementById('mc-menu')?.hidden).toBe(true);
  });
});
