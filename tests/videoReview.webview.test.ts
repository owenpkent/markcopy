// Review mode in the video webview (src/webview/videoReview.ts, wired up by
// src/webview/video.ts). Same harness as videoWebview.test.ts: the real module
// against a jsdom body that mirrors src/videoEditor.ts's html().
//
// jsdom has no layout, so the widths the scrubber lays markers out by are faked on
// HTMLElement.prototype, and the video's duration and time are defined by hand.
// Modules booted by earlier tests still listen on the shared window and build
// their own panels, so queries go to the newest `.mc-rv`, which is this test's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewNote, ReviewStateMessage } from '../src/review/protocol';
import { fpsLabel } from '../src/webview/videoReview';

const BODY = `
  <div id="mc-stage"><video id="mc-video" controls></video></div>
  <div id="mc-error" hidden></div>
  <div id="mc-notice" hidden></div>
  <div id="mc-status"></div>
  <div id="mc-menu" hidden></div>
  <div id="mc-toast" hidden></div>`;

let posted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.resetModules();
  document.body.className = 'mc-video';
  document.body.innerHTML = BODY;
  const mine: Array<Record<string, unknown>> = [];
  posted = mine;
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: (msg: Record<string, unknown>) => mine.push(msg),
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
});

function fromHost(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
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

const review = (extra: Partial<ReviewStateMessage> = {}): ReviewStateMessage => ({
  type: 'review',
  fps: 30,
  fpsSource: 'probe',
  sidecar: 'clip.review.yaml',
  notes: [note('n1', 1), note('n2', 8), note('n3', 30, { out: 40, kind: 'keep', done: true })],
  readOnly: null,
  ...extra,
});

async function open(): Promise<HTMLVideoElement> {
  await import('../src/webview/video');
  const video = document.getElementById('mc-video') as HTMLVideoElement;
  Object.defineProperty(video, 'duration', { value: 60, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true, configurable: true });
  return video;
}

/** This test's panel: the newest one, since earlier tests' modules also build theirs. */
function root(): HTMLElement {
  const all = document.querySelectorAll<HTMLElement>('.mc-rv');
  return all[all.length - 1];
}

const cards = () => [...root().querySelectorAll<HTMLButtonElement>('.mc-rv-card')];
const markers = () => [...root().querySelectorAll<HTMLButtonElement>('.mc-rv-marker')];
const copyButton = () =>
  [...root().querySelectorAll<HTMLButtonElement>('.mc-rv-btn')].find(
    (b) => b.textContent === 'Copy notes as Markdown',
  ) as HTMLButtonElement;

/** Right-click, then press the menu row with this label. */
function pressMenu(label: string): HTMLElement {
  document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const rows = [...document.querySelectorAll<HTMLElement>('#mc-menu [role^="menuitem"]')];
  const row = rows.find((r) => r.textContent?.includes(label));
  expect(row, `menu row ${label}`).toBeDefined();
  row!.click();
  return row!;
}

describe('review mode', () => {
  it('builds cards and markers and turns the native controls off', async () => {
    const video = await open();
    expect(video.controls).toBe(true);
    fromHost(review());

    expect(video.controls).toBe(false);
    expect(cards()).toHaveLength(3);
    expect(markers()).toHaveLength(3);
    expect(root().querySelector('.mc-rv-count')?.textContent).toBe('3 notes');

    const [first, , ranged] = cards();
    expect(first.textContent).toContain('00:00:01:00');
    expect(first.textContent).toContain('n1');
    // `note` is the default kind and is not shown; anything else is.
    expect(first.querySelector('.mc-rv-kind')).toBeNull();
    expect(ranged.textContent).toContain('00:00:30:00 to 00:00:40:00');
    expect(ranged.querySelector('.mc-rv-kind')?.textContent).toBe('keep');
    expect(ranged.textContent).toContain('Done');
    expect(markers()[1].getAttribute('aria-label')).toBe('Note n2 at 00:00:08:00');
    expect(root().querySelectorAll('.mc-rv-band')).toHaveLength(1);
  });

  it('shows the empty state and the read-only banner', async () => {
    await open();
    fromHost(review({ notes: [], readOnly: 'schema version 2' }));
    expect(cards()).toHaveLength(0);
    expect(root().querySelector('.mc-rv-empty')).not.toBeNull();
    const banner = root().querySelector<HTMLElement>('.mc-rv-banner')!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('schema version 2');
  });

  it('selects and seeks on a card or marker press', async () => {
    const video = await open();
    fromHost(review());

    cards()[1].click();
    // Frame 150 at 30 fps, half a frame in.
    expect(video.currentTime).toBeCloseTo((240 * (1000 / 30) + 1000 / 60) / 1000, 6);
    expect(cards()[1].getAttribute('aria-pressed')).toBe('true');
    expect(cards()[1].classList.contains('mc-rv-card--selected')).toBe(true);

    markers()[0].click();
    expect(video.currentTime).toBeCloseTo((30 * (1000 / 30) + 1000 / 60) / 1000, 6);
    expect(cards()[0].getAttribute('aria-pressed')).toBe('true');
    expect(markers()[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('clusters close notes into fewer markers and cycles through them', async () => {
    const video = await open();
    fromHost(
      review({ notes: [note('n1', 10), note('n2', 10.1), note('n3', 10.2), note('n4', 50)] }),
    );
    expect(cards()).toHaveLength(4);
    expect(markers()).toHaveLength(2);
    const cluster = markers()[0];
    expect(cluster.textContent).toBe('3');

    cluster.click();
    expect(cards()[0].getAttribute('aria-pressed')).toBe('true');
    cluster.click();
    expect(cards()[1].getAttribute('aria-pressed')).toBe('true');
    expect(video.currentTime).toBeGreaterThan(10.05);
  });

  it('copies only when there is a sidecar', async () => {
    await open();
    fromHost(review({ sidecar: null, notes: [] }));
    expect(copyButton().disabled).toBe(true);
    copyButton().click();
    expect(posted.some((m) => m.type === 'reviewCopy')).toBe(false);

    fromHost(review());
    expect(copyButton().disabled).toBe(false);
    copyButton().click();
    expect(posted).toContainEqual({ type: 'reviewCopy' });
  });

  it('shows the toast for a reviewError', async () => {
    await open();
    fromHost({ type: 'reviewError', message: 'Could not write clip.review.md' });
    expect(document.getElementById('mc-toast')?.textContent).toBe('Could not write clip.review.md');
  });

  it('steps one frame at the real rate with the arrow keys', async () => {
    const video = await open();
    fromHost(review({ fps: 25 }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(video.currentTime).toBeCloseTo((40 + 20) / 1000, 6);
    // A text field keeps its own keys.
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(video.currentTime).toBeCloseTo(0.06, 6);
  });
});

describe('review toggle', () => {
  it('turns off from the menu, restores controls and ignores later reviews', async () => {
    const video = await open();
    fromHost(review());
    expect(video.controls).toBe(false);

    pressMenu('Review Notes');
    expect(posted).toContainEqual({ type: 'updateSetting', key: 'video.review', value: false });
    expect(video.controls).toBe(true);
    expect(root().hidden).toBe(true);

    fromHost(review());
    expect(video.controls).toBe(true);
    expect(root().hidden).toBe(true);
  });

  it('turns back on from the menu and asks the host', async () => {
    const video = await open();
    fromHost(review());
    pressMenu('Review Notes');
    posted.length = 0;

    pressMenu('Review Notes');
    expect(posted).toContainEqual({ type: 'updateSetting', key: 'video.review', value: true });
    expect(posted).toContainEqual({ type: 'reviewEnable' });
    expect(video.controls).toBe(false);
    fromHost(review());
    expect(root().hidden).toBe(false);
  });

  it('copies from the menu only with a sidecar', async () => {
    await open();
    fromHost(review({ sidecar: null, notes: [] }));
    pressMenu('Copy Notes as Markdown');
    expect(posted.some((m) => m.type === 'reviewCopy')).toBe(false);

    fromHost(review());
    pressMenu('Copy Notes as Markdown');
    expect(posted).toContainEqual({ type: 'reviewCopy' });
  });
});

describe('frame rate label', () => {
  it('names the rate for each source', () => {
    expect(fpsLabel(30000 / 1001, 'probe')).toBe('29.97 fps');
    expect(fpsLabel(25, 'sidecar')).toBe('25 fps');
    expect(fpsLabel(30, 'assumed')).toBe('30 fps (assumed)');
    expect(fpsLabel(30, 'pending')).toBe('reading frame rate');
  });

  it('shows it beside the timecode', async () => {
    await open();
    for (const [fpsSource, text] of [
      ['probe', '29.97 fps'],
      ['assumed', '29.97 fps (assumed)'],
      ['pending', 'reading frame rate'],
    ] as const) {
      fromHost(review({ fps: 30000 / 1001, fpsSource }));
      expect(root().querySelector('.mc-rv-rate')?.textContent).toBe(text);
    }
  });
});
