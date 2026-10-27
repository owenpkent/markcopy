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
  restorable: null,
  added: null,
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

const byLabel = (label: string): HTMLButtonElement | null =>
  root().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const field = () => root().querySelector<HTMLInputElement>('.mc-rv-field')!;
const chip = () => root().querySelector<HTMLElement>('.mc-rv-chip')!;
const fpsNote = () => root().querySelector<HTMLElement>('.mc-rv-fpsnote')!;

/** Put the playhead inside the frame that starts at this many seconds (30 fps). */
function at(video: HTMLVideoElement, seconds: number): void {
  video.currentTime = seconds + 1 / 60;
}

const key = (k: string, target: EventTarget = document) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

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

describe('composer', () => {
  it('lights In and Out, shows the chip and clears the range', async () => {
    const video = await open();
    fromHost(review());
    const inBtn = byLabel('Set In to this frame')!;
    const outBtn = byLabel('Set Out to this frame')!;
    expect(chip().hidden).toBe(true);
    expect(byLabel('Clear the range')!.hidden).toBe(true);

    at(video, 31);
    inBtn.click();
    expect(inBtn.getAttribute('aria-pressed')).toBe('true');
    expect(outBtn.getAttribute('aria-pressed')).toBe('false');
    expect(chip().textContent).toBe('00:00:31:00');
    expect(byLabel('Clear the range')!.hidden).toBe(false);

    at(video, 36);
    outBtn.click();
    expect(outBtn.getAttribute('aria-pressed')).toBe('true');
    expect(chip().textContent).toBe('00:00:31:00 to 00:00:36:00');
    expect(root().querySelectorAll('.mc-rv-pending')).toHaveLength(1);

    byLabel('Clear the range')!.click();
    expect(chip().hidden).toBe(true);
    expect(inBtn.getAttribute('aria-pressed')).toBe('false');
    expect(root().querySelectorAll('.mc-rv-pending')).toHaveLength(0);
  });

  it('draws In alone as a tick and follows the Out before In rules', async () => {
    const video = await open();
    fromHost(review());
    at(video, 10);
    byLabel('Set Out to this frame')!.click();
    expect(document.getElementById('mc-toast')?.textContent).toBe('Set In first');
    expect(chip().hidden).toBe(true);

    byLabel('Set In to this frame')!.click();
    expect(root().querySelector('.mc-rv-pending--point')).not.toBeNull();
    // Out at or before In is refused.
    byLabel('Set Out to this frame')!.click();
    expect(document.getElementById('mc-toast')?.textContent).toBe('Out must be after In');
    expect(chip().textContent).toBe('00:00:10:00');

    at(video, 20);
    byLabel('Set Out to this frame')!.click();
    // A later In past the Out drops the Out.
    at(video, 25);
    byLabel('Set In to this frame')!.click();
    expect(chip().textContent).toBe('00:00:25:00');
  });

  it('sends a range note, then clears the range and the field', async () => {
    const video = await open();
    fromHost(review());
    at(video, 31);
    byLabel('Set In to this frame')!.click();
    at(video, 36);
    byLabel('Set Out to this frame')!.click();
    field().value = '  tighten this  ';
    byLabel('Add note')!.click();

    const sent = posted.find((m) => m.type === 'reviewAdd')!;
    expect(sent.at).toBeCloseTo(31, 9);
    expect(sent).toMatchObject({ out: 36, text: 'tighten this' });
    expect(field().value).toBe('');
    expect(chip().hidden).toBe(true);
  });

  it('sends at the playhead frame without a range, and Enter sends', async () => {
    const video = await open();
    fromHost(review());
    at(video, 12);
    field().value = 'cut here';
    key('Enter', field());
    const sent = posted.filter((m) => m.type === 'reviewAdd');
    expect(sent).toHaveLength(1);
    expect(sent[0].at).toBeCloseTo(12, 9);
    expect(sent[0]).not.toHaveProperty('out');
    expect(sent[0].text).toBe('cut here');
    expect(field().value).toBe('');
  });

  it('does not send an empty note', async () => {
    await open();
    fromHost(review());
    key('Enter', field());
    expect(posted.some((m) => m.type === 'reviewAdd')).toBe(false);
  });

  it('pauses on focus and resumes on send when it was playing', async () => {
    const video = await open();
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    fromHost(review());
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();

    field().dispatchEvent(new FocusEvent('focus'));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    field().value = 'x';
    byLabel('Add note')!.click();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('leaves a paused video paused after a send', async () => {
    const video = await open();
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    fromHost(review());
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    field().dispatchEvent(new FocusEvent('focus'));
    field().value = 'x';
    byLabel('Add note')!.click();
    expect(play).not.toHaveBeenCalled();
  });

  it('respects a deliberate play button press while typing', async () => {
    const video = await open();
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    fromHost(review());
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    field().dispatchEvent(new FocusEvent('focus'));
    play.mockClear();
    // The focus stopped the video; the reader starts it, then stops it again.
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    video.dispatchEvent(new Event('pause'));
    byLabel('Play')!.click();
    expect(play).toHaveBeenCalledTimes(1);
    play.mockClear();
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    video.dispatchEvent(new Event('pause'));
    byLabel('Pause')!.click();
    field().value = 'x';
    byLabel('Add note')!.click();
    expect(play).not.toHaveBeenCalled();
  });

  it('leaves the field on Escape', async () => {
    await open();
    fromHost(review());
    field().focus();
    expect(document.activeElement).toBe(field());
    key('Escape', field());
    expect(document.activeElement).not.toBe(field());
  });

  it('is disabled while read-only', async () => {
    await open();
    fromHost(review({ readOnly: 'schema version 2', restorable: 'n4' }));
    expect(field().disabled).toBe(true);
    expect(byLabel('Add note')!.disabled).toBe(true);
    expect(byLabel('Set In to this frame')!.disabled).toBe(true);
    expect(byLabel('Set Out to this frame')!.disabled).toBe(true);
    expect(byLabel('Restore n4')!.disabled).toBe(true);
    cards()[0].click();
    expect(byLabel('Delete n1')!.disabled).toBe(true);
    expect(byLabel('Mark n1 done')!.disabled).toBe(true);
    key('i');
    expect(chip().hidden).toBe(true);
  });

  it('warns about an assumed rate before the first note and waits for a pending one', async () => {
    await open();
    fromHost(review({ sidecar: null, notes: [], fpsSource: 'assumed' }));
    expect(fpsNote().hidden).toBe(false);
    expect(fpsNote().textContent).toBe('Frame rate unknown: notes will be saved at 30 fps');
    expect(byLabel('Add note')!.disabled).toBe(false);

    fromHost(review({ sidecar: null, notes: [], fpsSource: 'pending' }));
    expect(fpsNote().hidden).toBe(true);
    expect(byLabel('Add note')!.disabled).toBe(true);

    fromHost(review({ fpsSource: 'assumed' }));
    expect(fpsNote().hidden).toBe(true);
  });
});

describe('card actions', () => {
  it('offers Done and Delete on the selected card only', async () => {
    await open();
    fromHost(review());
    expect(root().querySelectorAll('.mc-rv-actions')).toHaveLength(0);

    cards()[0].click();
    expect(root().querySelectorAll('.mc-rv-actions')).toHaveLength(1);
    expect(cards()[0].parentElement!.querySelector('.mc-rv-actions')).not.toBeNull();
    expect(byLabel('Delete n2')).toBeNull();

    byLabel('Mark n1 done')!.click();
    expect(posted).toContainEqual({ type: 'reviewSetDone', id: 'n1', done: true });
    byLabel('Delete n1')!.click();
    expect(posted).toContainEqual({ type: 'reviewDelete', id: 'n1' });
  });

  it('toggles a done note back', async () => {
    await open();
    fromHost(review());
    cards()[2].click();
    byLabel('Mark n3 not done')!.click();
    expect(posted).toContainEqual({ type: 'reviewSetDone', id: 'n3', done: false });
  });

  it('shows Restore when the host holds a note and posts reviewRestore', async () => {
    await open();
    fromHost(review());
    expect(root().querySelector<HTMLElement>('.mc-rv-panel > .mc-rv-btn')!.hidden).toBe(true);
    fromHost(review({ restorable: 'n4' }));
    const restore = byLabel('Restore n4')!;
    expect(restore.hidden).toBe(false);
    expect(restore.textContent).toBe('Restore n4');
    restore.click();
    expect(posted).toContainEqual({ type: 'reviewRestore' });
  });

  it('selects the note the host says was just added', async () => {
    await open();
    fromHost(review());
    fromHost(review({ notes: [note('n1', 1), note('n4', 20)], added: 'n4' }));
    expect(cards()[1].getAttribute('aria-pressed')).toBe('true');
    expect(markers()[1].getAttribute('aria-pressed')).toBe('true');
    expect(byLabel('Delete n4')).not.toBeNull();
  });
});

describe('review shortcuts', () => {
  it('sets In and Out with I and O', async () => {
    const video = await open();
    fromHost(review());
    at(video, 5);
    key('i');
    expect(chip().textContent).toBe('00:00:05:00');
    at(video, 9);
    key('O');
    expect(chip().textContent).toBe('00:00:05:00 to 00:00:09:00');
  });

  it('ignores letters typed in the note field', async () => {
    const video = await open();
    fromHost(review());
    at(video, 5);
    key('i', field());
    key('o', field());
    expect(chip().hidden).toBe(true);
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
