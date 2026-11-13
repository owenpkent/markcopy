// Audio Notes in the audio webview (src/webview/audio.ts mounting src/webview/videoReview.ts
// in clock mode), on jsdom. jsdom has no layout, so the width the markers are laid out
// by is faked, and the element's duration and time are defined by hand. The module adds
// document and window listeners on every import, so they are removed between tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioReviewStateMessage, ReviewNote } from '../src/review/protocol';

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

beforeEach(() => {
  vi.resetModules();
  document.body.className = 'mc-audio';
  document.body.removeAttribute('style');
  document.body.innerHTML = '<div id="app"></div>';
  document.body.dataset.mcSrc = 'vscode-resource://x/take 1.flac';
  posted.mockClear();
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
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 800,
  });
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
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

const note = (id: string, at: number, extra: Partial<ReviewNote> = {}): ReviewNote => ({
  id,
  at,
  text: `text of ${id}`,
  kind: 'note',
  done: false,
  created: '2026-01-01T00:00:00',
  ...extra,
});

const state = (extra: Partial<AudioReviewStateMessage> = {}): AudioReviewStateMessage => ({
  type: 'review',
  sidecar: 'take 1.flac.review.yaml',
  notes: [note('n1', 1.5), note('n2', 60), note('n3', 100, { out: 110, kind: 'keep', done: true })],
  readOnly: null,
  restorable: null,
  added: null,
  ...extra,
});

async function boot(count = 3): Promise<{ audio: HTMLAudioElement; clock: { time: number } }> {
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
  fromHost({
    type: 'load',
    name: 'take 1.flac',
    path: '/audio/take 1.flac',
    size: 2048,
    position: { index: 2, count },
  });
  return { audio, clock };
}

const root = () => document.querySelector<HTMLElement>('.mc-rv')!;
const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const field = () => document.querySelector<HTMLInputElement>('.mc-rv-field')!;
const cards = () => [...document.querySelectorAll<HTMLButtonElement>('.mc-rv-card')];
const markers = () => [...document.querySelectorAll<HTMLButtonElement>('.mc-rv-marker')];
const lastPost = () => posted.mock.calls.at(-1)?.[0] as Record<string, unknown>;

function key(k: string, target: EventTarget = document.body) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe('Audio Notes webview', () => {
  it('builds nothing until the host sends a review state', async () => {
    await boot();
    expect(root()).toBeNull();
    expect(document.body.classList.contains('mc-review')).toBe(false);
  });

  it('shows the panel with clock times, and no pin layer, frame stepping or frame rate', async () => {
    await boot();
    fromHost(state());
    expect(root().hidden).toBe(false);
    expect(document.body.classList.contains('mc-review')).toBe(true);
    expect(document.querySelector('.mc-rv-pins')).toBeNull();
    expect(document.querySelector('.mc-rv-pin')).toBeNull();
    expect(document.querySelector('.mc-rv-ring')).toBeNull();
    expect(byLabel('Pin a spot')).toBeNull();
    expect(byLabel('Back one frame')).toBeNull();
    expect(document.querySelector('.mc-rv-fpsnote')).toBeNull();
    expect(document.querySelector('.mc-rv-rate')).toBeNull();
    expect(document.querySelector('.mc-rv-time')?.textContent).toBe('00:00:00.000');
    expect(document.querySelector('.mc-rv-total')?.textContent).toBe('/ 00:02:00.000');
    expect(document.querySelector('.mc-rv-remain')?.textContent).toBe('-00:02:00.000');
    expect(document.querySelector('.mc-rv-count')?.textContent).toBe('3 notes');
    const when = cards().map((c) => c.querySelector('.mc-rv-tc')?.textContent);
    expect(when).toEqual(['00:00:01.500', '00:01:00.000', '00:01:40.000 to 00:01:50.000']);
    // The player's toolbar stays, as the transport.
    expect(document.getElementById('mc-toolbar')).not.toBeNull();
  });

  it('the Notes button asks the host for the state and remembers the choice', async () => {
    await boot();
    const btn = document.getElementById('mc-notes') as HTMLButtonElement;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    expect(posted).toHaveBeenCalledWith({
      type: 'updateSetting',
      key: 'audio.review',
      value: true,
    });
    expect(posted).toHaveBeenCalledWith({ type: 'reviewEnable' });
    fromHost(state());
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    btn.click();
    expect(posted).toHaveBeenCalledWith({
      type: 'updateSetting',
      key: 'audio.review',
      value: false,
    });
    expect(root().hidden).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    // Closed notes stay closed when the host posts again.
    fromHost(state());
    expect(root().hidden).toBe(true);
  });

  it('puts a marker on the timeline for each note, and a click seeks to it', async () => {
    const { clock } = await boot();
    fromHost(state());
    expect(markers()).toHaveLength(3);
    markers()[1].click();
    expect(clock.time).toBe(60);
    markers()[0].click();
    expect(clock.time).toBe(1.5);
    expect(document.querySelectorAll('.mc-rv-band')).toHaveLength(1);
  });

  it('a note card seeks to its time', async () => {
    const { clock } = await boot();
    fromHost(state());
    cards()[2].click();
    expect(clock.time).toBe(100);
  });

  it('adds a note at the playhead, to the millisecond, with no pin', async () => {
    const { clock } = await boot();
    fromHost(state());
    clock.time = 12.3456789;
    field().value = 'Click here';
    byLabel('Add note at the playhead')!.click();
    expect(lastPost()).toEqual({ type: 'reviewAdd', at: 12.346, text: 'Click here' });
  });

  it('Enter in the field adds, and an empty note is not sent', async () => {
    const { clock } = await boot();
    fromHost(state());
    clock.time = 5;
    byLabel('Add note at the playhead')!.click();
    expect(posted.mock.calls.some(([m]) => m.type === 'reviewAdd')).toBe(false);
    field().value = 'Hiss';
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(lastPost()).toEqual({ type: 'reviewAdd', at: 5, text: 'Hiss' });
  });

  it('Set In and Set Out make a range note, and the chip shows it', async () => {
    const { clock } = await boot();
    fromHost(state());
    clock.time = 10;
    byLabel('Set In to the playhead')!.click();
    clock.time = 12.5;
    byLabel('Set Out to the playhead')!.click();
    expect(document.querySelector('.mc-rv-chip')?.textContent).toBe('00:00:10.000 to 00:00:12.500');
    field().value = 'Range';
    byLabel('Add note at the playhead')!.click();
    expect(lastPost()).toEqual({ type: 'reviewAdd', at: 10, out: 12.5, text: 'Range' });
  });

  it('the keys I, O and N set the range and go to the note field', async () => {
    const { clock } = await boot();
    fromHost(state());
    clock.time = 4;
    expect(key('i').defaultPrevented).toBe(true);
    clock.time = 6;
    key('O');
    expect(document.querySelector('.mc-rv-chip')?.textContent).toBe('00:00:04.000 to 00:00:06.000');
    key('n');
    expect(document.activeElement).toBe(field());
    // Typing in the field is the field's, not a shortcut.
    expect(key('i', field()).defaultPrevented).toBe(false);
  });

  it('P does not start a pin', async () => {
    await boot();
    fromHost(state());
    expect(key('p').defaultPrevented).toBe(false);
    expect(document.querySelector('.mc-rv--pin')).toBeNull();
  });

  it('keeps the transport keys: arrows seek 5 s, Page Up and Down change file', async () => {
    const { clock } = await boot();
    fromHost(state());
    clock.time = 50;
    key('ArrowRight');
    expect(clock.time).toBe(55);
    key('ArrowLeft', document.body);
    expect(clock.time).toBe(50);
    key('PageDown');
    expect(posted).toHaveBeenCalledWith({ type: 'navigate', step: 1 });
    key('PageUp');
    expect(posted).toHaveBeenCalledWith({ type: 'navigate', step: -1 });
  });

  it('delete, restore and copy post their messages', async () => {
    await boot();
    fromHost(state());
    cards()[0].click();
    byLabel('Delete n1')!.click();
    expect(lastPost()).toEqual({ type: 'reviewDelete', id: 'n1' });
    fromHost(state({ restorable: 'n1', notes: [note('n2', 60)] }));
    byLabel('Restore n1')!.click();
    expect(lastPost()).toEqual({ type: 'reviewRestore' });
    byLabel('Copy notes as Markdown')!.click();
    expect(lastPost()).toEqual({ type: 'reviewCopy' });
  });

  it('a read-only sidecar locks the composer and the note keys', async () => {
    const { clock } = await boot();
    fromHost(state({ readOnly: 'Not an audio review (this file is for a video)' }));
    expect(document.querySelector('.mc-rv-banner')?.textContent).toContain('Read-only');
    expect((byLabel('Add note at the playhead') as HTMLButtonElement).disabled).toBe(true);
    expect((byLabel('Set In to the playhead') as HTMLButtonElement).disabled).toBe(true);
    clock.time = 3;
    expect(key('i').defaultPrevented).toBe(false);
  });

  it('settles the draft when the host acknowledges the note', async () => {
    const { clock } = await boot();
    fromHost(state());
    clock.time = 2;
    field().value = 'Mine';
    byLabel('Add note at the playhead')!.click();
    fromHost(state({ added: 'n4', notes: [note('n1', 1.5), note('n4', 2, { text: 'Mine' })] }));
    expect(field().value).toBe('');
    expect(cards().some((c) => c.classList.contains('mc-rv-card--selected'))).toBe(true);
    expect(root().querySelector('.mc-rv-meta .mc-rv-tc')?.textContent).toBe('00:00:01.500');
  });
});
