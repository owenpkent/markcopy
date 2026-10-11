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
      load('https://file.test/proxy.mp4', { proxyNote: 'ffmpeg copy · sound re-encoded to Opus' }),
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
