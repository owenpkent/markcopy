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

beforeEach(() => {
  vi.resetModules();
  document.body.className = 'mc-video';
  document.body.innerHTML = BODY;
  play.mockClear();
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: vi.fn(),
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
  window.dispatchEvent(new MessageEvent('message', { data }));
}

const load = (src: string, extra: Record<string, unknown> = {}) => ({
  type: 'load',
  src,
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

    fromHost(load('https://file.test/clip.mp4'));
    // jsdom loads nothing, so fake an original that has metadata and is playing
    // at 2x, three seconds in.
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    Object.defineProperty(video, 'currentTime', { value: 3, writable: true, configurable: true });
    video.playbackRate = 2;

    fromHost(
      load('https://file.test/proxy.mp4', { proxyNote: 'ffmpeg copy · sound re-encoded to MP3' }),
    );
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
    fromHost(load('https://file.test/clip.mp4', { autoplay: true }));
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
      load('https://file.test/proxy.mp4', {
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
