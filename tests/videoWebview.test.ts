// Regression coverage for the sound-copy swap in src/webview/video.ts keeping
// the reader's playback speed. Assigning `src` runs the media load algorithm,
// which puts `playbackRate` back to `defaultPlaybackRate`, so a reader at 2x
// used to land on the copy at 1x. jsdom implements none of that algorithm, so
// the test plays the spec's part by hand: it resets the rate itself before the
// new source's `loadedmetadata`, which is exactly the moment the webview has to
// put it back.
//
// The real module is imported, after the DOM it expects (the ids written by
// src/videoEditor.ts's html()) and the globals it reaches for at the top level
// are in place: acquireVsCodeApi, and a ResizeObserver stub since jsdom has
// none. HTMLMediaElement play/pause/load are stubbed for the same reason.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BODY = `
  <div id="mc-stage" hidden><video id="mc-video" controls></video></div>
  <div id="mc-error" hidden></div>
  <div id="mc-notice" hidden></div>
  <div id="mc-status"></div>
  <div id="mc-menu" hidden></div>
  <div id="mc-toast" hidden></div>`;

const play = vi.fn(() => Promise.resolve());
let posted = vi.fn();

beforeEach(() => {
  vi.resetModules();
  document.body.className = 'mc-video';
  document.body.dataset.mcSrc = 'https://file.test/clip.mp4';
  document.body.dataset.mcProxySrc = 'https://file.test/proxy.mp4';
  document.body.innerHTML = BODY;
  play.mockClear();
  posted = vi.fn();
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: posted,
    getState: () => undefined,
    setState: vi.fn(),
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  HTMLMediaElement.prototype.play = play;
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Deliver a host message the way the webview receives it. */
function fromHost(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin: window.origin }));
}

const load = (source: 'file' | 'proxy', extra: Record<string, unknown> = {}) => ({
  type: 'load',
  source,
  name: 'clip.mp4',
  path: '/videos/clip.mp4',
  size: 1,
  autoplay: false,
  loop: false,
  ...extra,
});

describe('video webview sound-copy swap', () => {
  it('keeps the playback rate, position and playing state across the swap', async () => {
    await import('../src/webview/video');
    const video = document.getElementById('mc-video') as HTMLVideoElement;

    fromHost(load('file'));
    expect(video.src).toBe('https://file.test/clip.mp4');
    // jsdom loads nothing, so fake an original that has metadata and is playing
    // at 2x, three seconds in.
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    Object.defineProperty(video, 'currentTime', { value: 3, writable: true, configurable: true });
    video.playbackRate = 2;

    fromHost(load('proxy', { proxyNote: 'ffmpeg copy · sound re-encoded to MP3' }));
    expect(video.src).toBe('https://file.test/proxy.mp4');
    // What the browser does when the new source starts loading.
    video.playbackRate = 1;
    video.currentTime = 0;
    video.dispatchEvent(new Event('loadedmetadata'));

    expect(video.playbackRate).toBe(2);
    expect(video.currentTime).toBe(3);
    expect(play).toHaveBeenCalled();
  });
});

describe('video webview autoplay', () => {
  const refused = () =>
    Promise.reject(Object.assign(new Error('play() needs a gesture'), { name: 'NotAllowedError' }));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  async function openAutoplay(firstPlay: () => Promise<void>): Promise<HTMLVideoElement> {
    await import('../src/webview/video');
    const video = document.getElementById('mc-video') as HTMLVideoElement;
    play.mockImplementationOnce(firstPlay);
    fromHost(load('file', { autoplay: true }));
    // The attempt waits for metadata, and does not use the autoplay attribute.
    expect(video.autoplay).toBe(false);
    expect(play).not.toHaveBeenCalled();
    video.dispatchEvent(new Event('loadedmetadata'));
    await tick();
    return video;
  }

  it('plays with sound when the browser allows it', async () => {
    const video = await openAutoplay(() => Promise.resolve());
    expect(play).toHaveBeenCalledTimes(1);
    expect(video.muted).toBe(false);
    expect(document.getElementById('mc-toast')?.hidden).toBe(true);
  });

  it('falls back to muted, then unmutes on the first click', async () => {
    const video = await openAutoplay(refused);
    expect(play).toHaveBeenCalledTimes(2);
    expect(video.muted).toBe(true);
    expect(document.getElementById('mc-toast')?.textContent).toContain('Playing muted');

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(video.muted).toBe(false);
  });

  it('still unmutes on the first click after the sound copy swaps in', async () => {
    const video = await openAutoplay(refused);
    expect(video.muted).toBe(true);

    // The muted autoplay of an AAC file is exactly what the sound copy replaces,
    // so the click the toast promised has to survive the swap.
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    fromHost(
      load('proxy', {
        autoplay: true,
        proxyNote: 'ffmpeg copy · sound re-encoded to MP3',
      }),
    );
    video.dispatchEvent(new Event('loadedmetadata'));
    await tick();
    expect(video.muted).toBe(true);

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(video.muted).toBe(false);
  });

  it('leaves a pause alone when it cancels the pending autoplay', async () => {
    await import('../src/webview/video');
    const video = document.getElementById('mc-video') as HTMLVideoElement;
    let reject: (err: Error) => void = () => undefined;
    play.mockImplementationOnce(
      () => new Promise<void>((_resolve, rejectPlay) => (reject = rejectPlay)),
    );
    fromHost(load('file', { autoplay: true }));
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(play).toHaveBeenCalledTimes(1);

    // The reader pauses (the native control, or Space) while the first play() is
    // still waiting for frames, and the pause rejects that promise with
    // AbortError, as the spec requires. Paused on the element itself: modules
    // booted by earlier tests still listen on the shared document.
    video.pause();
    reject(Object.assign(new Error('interrupted by pause()'), { name: 'AbortError' }));
    await tick();

    expect(play).toHaveBeenCalledTimes(1);
    expect(video.muted).toBe(false);
    expect(document.getElementById('mc-toast')?.textContent).not.toContain('Playing muted');
  });

  it('does not override a mute the reader changed themselves', async () => {
    const video = await openAutoplay(refused);
    expect(video.muted).toBe(true);

    // The reader presses the native control, which toggles muted and reports it.
    video.muted = false;
    video.dispatchEvent(new Event('volumechange'));
    video.muted = true;
    video.dispatchEvent(new Event('volumechange'));

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(video.muted).toBe(true);
  });
});

describe('video webview volume', () => {
  const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
  const savedVolumes = () =>
    posted.mock.calls
      .map(([msg]) => msg as { type: string; key?: string; value?: unknown })
      .filter((msg) => msg.type === 'updateSetting' && msg.key === 'video.volume')
      .map((msg) => msg.value);

  async function open(extra: Record<string, unknown> = {}): Promise<HTMLVideoElement> {
    await import('../src/webview/video');
    fromHost(load('file', extra));
    return document.getElementById('mc-video') as HTMLVideoElement;
  }

  const key = (k: string) =>
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  it('opens at the remembered level without saving it back', async () => {
    const video = await open({ volume: 40 });
    expect(video.volume).toBeCloseTo(0.4);
    await tick(600);
    expect(savedVolumes()).toEqual([]);
  });

  it('opens at full volume when the host sends no level', async () => {
    const video = await open();
    expect(video.volume).toBe(1);
  });

  it('steps 10% with Up and Down, unmutes, and saves the level once', async () => {
    const video = await open({ volume: 50 });
    video.muted = true;
    key('ArrowUp');
    key('ArrowUp');
    expect(video.volume).toBeCloseTo(0.7);
    expect(video.muted).toBe(false);
    expect(document.getElementById('mc-toast')?.textContent).toBe('Volume 70%');
    key('ArrowDown');
    await tick(600);
    expect(savedVolumes()).toEqual([60]);
  });

  it('clamps at the ends', async () => {
    const video = await open({ volume: 95 });
    key('ArrowUp');
    expect(video.volume).toBe(1);
    video.volume = 0.05;
    key('ArrowDown');
    expect(video.volume).toBe(0);
  });

  it('turns the wheel over the picture into volume, 5% a notch', async () => {
    const video = await open({ volume: 50 });
    const down = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    video.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(video.volume).toBeCloseTo(0.45);
    video.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }));
    expect(video.volume).toBeCloseTo(0.55);
  });

  it('leaves the wheel alone off the picture', async () => {
    const video = await open({ volume: 50 });
    const stage = document.getElementById('mc-stage') as HTMLDivElement;
    const wheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    stage.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(video.volume).toBe(0.5);
  });

  it('m mutes without touching the saved level', async () => {
    const video = await open({ volume: 80 });
    key('m');
    expect(video.muted).toBe(true);
    expect(document.getElementById('mc-toast')?.textContent).toBe('Muted');
    await tick(600);
    expect(savedVolumes()).toEqual([]);
  });
});
