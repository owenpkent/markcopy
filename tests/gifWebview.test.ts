// Coverage for the no-ImageDecoder path of src/webview/gif.ts. jsdom has no
// WebCodecs, so the real module takes its fallback: a plain <img> on a blob:
// URL, with the status line still filled in from the header parser. Real
// ImageDecoder playback needs a real Chromium and is checked by hand (see
// docs/TESTING.md).
//
// The DOM mirrors the ids written by src/gifEditor.ts's html().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BODY = `
  <div id="mc-stage" hidden>
    <canvas id="mc-canvas" hidden></canvas>
    <img id="mc-img" alt="" hidden />
  </div>
  <div id="mc-error" hidden></div>
  <div id="mc-status"></div>
  <div id="mc-menu" hidden></div>
  <div id="mc-toast" hidden></div>`;

// A two-frame GIF89a, 8x6, delays 20 and 50 cs, looping forever, in the layout
// tests/gifInfo.test.ts assembles.
function gifBase64(): string {
  const bytes: number[] = [];
  const push = (...b: number[]) => bytes.push(...b);
  for (const c of 'GIF89a') push(c.charCodeAt(0));
  push(8, 0, 6, 0, 0, 0, 0);
  push(0x21, 0xff, 11);
  for (const c of 'NETSCAPE2.0') push(c.charCodeAt(0));
  push(3, 1, 0, 0, 0);
  for (const delay of [20, 50]) {
    push(0x21, 0xf9, 4, 0, delay, 0, 0, 0);
    push(0x2c, 0, 0, 0, 0, 8, 0, 6, 0, 0, 2, 2, 0x4c, 0x01, 0);
  }
  push(0x3b);
  return btoa(String.fromCharCode(...bytes));
}

const posted = vi.fn();

beforeEach(() => {
  vi.resetModules();
  document.body.className = 'mc-gif';
  document.body.innerHTML = BODY;
  posted.mockClear();
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: posted,
    getState: () => undefined,
    setState: vi.fn(),
  }));
  vi.stubGlobal('ImageDecoder', undefined);
  URL.createObjectURL = vi.fn(() => 'blob:gif-test');
  URL.revokeObjectURL = vi.fn();
});

// Each test re-imports the module, which subscribes to window and document;
// drop those so an earlier test's instance does not answer a later test's events.
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
  for (const [target, type, fn] of listeners.splice(0)) {
    target.removeEventListener(type, fn);
  }
});

function fromHost(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('gif webview fallback', () => {
  it('announces itself to the host on startup', async () => {
    await import('../src/webview/gif');
    expect(posted).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('shows the file in an img and reports its info on the status line', async () => {
    await import('../src/webview/gif');
    fromHost({
      type: 'load',
      name: 'anim.gif',
      path: '/p/anim.gif',
      size: 2048,
      data: gifBase64(),
    });
    await tick();

    const img = document.getElementById('mc-img') as HTMLImageElement;
    expect(img.hidden).toBe(false);
    expect(img.getAttribute('src')).toBe('blob:gif-test');
    expect((document.getElementById('mc-canvas') as HTMLCanvasElement).hidden).toBe(true);
    expect((document.getElementById('mc-stage') as HTMLDivElement).hidden).toBe(false);

    const status = document.getElementById('mc-status')?.textContent ?? '';
    expect(status).toContain('anim.gif');
    expect(status).toContain('8x6');
    expect(status).toContain('2 frames');
    expect(status).toContain('700 ms');
    expect(status).toContain('loops forever');
  });

  it('says so for data that is not a GIF', async () => {
    await import('../src/webview/gif');
    fromHost({ type: 'load', name: 'x.gif', path: '/p/x.gif', size: 4, data: btoa('nope') });
    await tick();
    const error = document.getElementById('mc-error') as HTMLDivElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('not a GIF');
  });

  it('shows a host error in the viewport', async () => {
    await import('../src/webview/gif');
    fromHost({ type: 'error', message: 'too big' });
    expect(document.getElementById('mc-error')?.textContent).toBe('too big');
  });

  it('applies a theme change from the host', async () => {
    await import('../src/webview/gif');
    fromHost({ type: 'setTheme', value: 'green' });
    expect(document.body.getAttribute('data-mc-theme')).toBe('green');
  });

  it('greys the frame actions in its context menu', async () => {
    await import('../src/webview/gif');
    fromHost({ type: 'load', name: 'anim.gif', path: '/p/anim.gif', size: 1, data: gifBase64() });
    await tick();
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const menu = document.getElementById('mc-menu') as HTMLDivElement;
    expect(menu.textContent).toContain('Frames unavailable in this viewer');
    expect(menu.textContent).toContain('Copy Frame as PNG');
    expect(menu.textContent).toContain('Open in Default App');
  });
});

// The ImageDecoder path, with a stub whose decodes the test can hold open.
describe('gif webview playback', () => {
  let draws: number;
  let pending: Array<{ index: number; release: () => void }>;
  let hold: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    draws = 0;
    pending = [];
    hold = false;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return {
        clearRect: () => undefined,
        drawImage: () => {
          if (this.isConnected) {
            draws += 1;
          }
        },
      };
    } as never;
    class FakeDecoder {
      tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 2 } };
      decode({ frameIndex }: { frameIndex: number }): Promise<{ image: { close(): void } }> {
        const image = { close: () => undefined };
        if (!hold) {
          return Promise.resolve({ image });
        }
        return new Promise((resolve) => {
          pending.push({ index: frameIndex, release: () => resolve({ image }) });
        });
      }
      close(): void {}
    }
    vi.stubGlobal('ImageDecoder', FakeDecoder);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loadAndPlay(): Promise<void> {
    await import('../src/webview/gif');
    fromHost({ type: 'load', name: 'anim.gif', path: '/p/anim.gif', size: 1, data: gifBase64() });
    await vi.advanceTimersByTimeAsync(0);
    expect(draws).toBe(1);
  }

  async function startDecodeThenPause(how: 'space' | 'click'): Promise<void> {
    await loadAndPlay();
    hold = true;
    // The first frame's 200 ms delay elapses and advance() starts decoding frame 1.
    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(1);
    if (how === 'space') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    } else {
      document
        .getElementById('mc-canvas')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  }

  for (const how of ['space', 'click'] as const) {
    it(`does not paint a pending decode after pausing with ${how}`, async () => {
      await startDecodeThenPause(how);
      pending[0].release();
      await vi.advanceTimersByTimeAsync(1000);
      expect(draws).toBe(1);
      expect(document.getElementById('mc-status')?.textContent).toContain('frame 1');
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it('still paints a seek made while paused, and only the latest of several', async () => {
    await loadAndPlay();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    hold = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '.', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(pending.map((p) => p.index)).toEqual([1, 0]);
    pending[0].release();
    pending[1].release();
    await vi.advanceTimersByTimeAsync(0);
    expect(draws).toBe(2);
    expect(document.getElementById('mc-status')?.textContent).toContain('frame 1');
  });
});
