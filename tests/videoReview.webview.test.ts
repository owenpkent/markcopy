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
import { arrangeNotes, fpsLabel } from '../src/webview/videoReview';

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
    (b) => b.textContent === 'Copy as Markdown',
  ) as HTMLButtonElement;

const byLabel = (label: string): HTMLButtonElement | null =>
  root().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const field = () => root().querySelector<HTMLInputElement>('.mc-rv-field')!;
const chip = () => root().querySelector<HTMLElement>('.mc-rv-chip')!;
const fpsNote = () => root().querySelector<HTMLElement>('.mc-rv-fpsnote')!;

/** The host saved the note: the state message that names it as added. */
const ack = () =>
  fromHost(review({ added: 'n4', notes: [note('n1', 1), note('n4', 2, { text: 'sent' })] }));

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
    expect(cluster.textContent).toBe('×3');

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

  it('says Copied for a moment once the host confirms the copy, then goes back', async () => {
    vi.useFakeTimers();
    try {
      await open();
      fromHost(review());
      const btn = copyButton();
      btn.click();
      // Not before the host has written the file and the clipboard.
      expect(btn.textContent).toBe('Copy as Markdown');
      fromHost({ type: 'toast', message: 'Copied 2 notes, saved clip.review.md' });
      expect(btn.textContent).toBe('Copied');
      expect(btn.querySelector('svg')).not.toBeNull();
      expect(document.getElementById('mc-toast')?.textContent).toBe(
        'Copied 2 notes, saved clip.review.md',
      );
      vi.advanceTimersByTime(1600);
      expect(btn.textContent).toBe('Copy as Markdown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never says Copied when the copy fails', async () => {
    await open();
    fromHost(review());
    const btn = copyButton();
    btn.click();
    fromHost({ type: 'reviewError', message: 'Could not save clip.review.md' });
    // A later, unrelated toast must not be taken for the copy's success.
    fromHost({ type: 'toast', message: 'Something else' });
    expect(btn.textContent).toBe('Copy as Markdown');
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
    expect(byLabel('Clear range and pin')!.hidden).toBe(true);

    at(video, 31);
    inBtn.click();
    expect(inBtn.getAttribute('aria-pressed')).toBe('true');
    expect(outBtn.getAttribute('aria-pressed')).toBe('false');
    expect(chip().textContent).toBe('00:00:31:00');
    expect(byLabel('Clear range and pin')!.hidden).toBe(false);

    at(video, 36);
    outBtn.click();
    expect(outBtn.getAttribute('aria-pressed')).toBe('true');
    expect(chip().textContent).toBe('00:00:31:00 to 00:00:36:00');
    expect(root().querySelectorAll('.mc-rv-pending')).toHaveLength(1);

    byLabel('Clear range and pin')!.click();
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
    // The draft stays, locked, until the host acknowledges the save.
    expect(field().value).toBe('  tighten this  ');
    expect(chip().hidden).toBe(false);
    ack();
    expect(field().value).toBe('');
    expect(chip().hidden).toBe(true);
  });

  it('locks the draft while a send is pending, then restores it on a failed save', async () => {
    const video = await open();
    fromHost(review());
    at(video, 31);
    byLabel('Set In to this frame')!.click();
    at(video, 36);
    byLabel('Set Out to this frame')!.click();
    field().value = 'tighten this';
    byLabel('Add note')!.click();
    expect(byLabel('Add note')!.disabled).toBe(true);
    expect(field().disabled).toBe(true);
    key('Enter', field());
    byLabel('Add note')!.click();
    expect(posted.filter((m) => m.type === 'reviewAdd')).toHaveLength(1);

    fromHost({ type: 'reviewError', message: 'Could not write clip.review.yaml', failed: 'add' });
    expect(field().value).toBe('tighten this');
    expect(field().disabled).toBe(false);
    expect(byLabel('Add note')!.disabled).toBe(false);
    expect(chip().textContent).toBe('00:00:31:00 to 00:00:36:00');
    expect(byLabel('Set In to this frame')!.getAttribute('aria-pressed')).toBe('true');
    expect(byLabel('Set Out to this frame')!.getAttribute('aria-pressed')).toBe('true');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

    // A retry sends the same draft again.
    byLabel('Add note')!.click();
    const sent = posted.filter((m) => m.type === 'reviewAdd');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ out: 36, text: 'tighten this' });
  });

  it('restores a pin on a failed save and does not resume playback', async () => {
    const video = await open();
    Object.defineProperty(video, 'videoWidth', { value: 500, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 500, configurable: true });
    const box = { left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 } as DOMRect;
    video.getBoundingClientRect = () => box;
    document.getElementById('mc-stage')!.getBoundingClientRect = () => box;
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    fromHost(review());
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    byLabel('Pin a spot')!.click();
    video.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 250, clientY: 250 }),
    );
    field().value = 'look here';
    byLabel('Add note')!.click();
    expect(root().querySelector<HTMLElement>('.mc-rv-ring')!.hidden).toBe(false);

    fromHost({ type: 'reviewError', message: 'Could not write', failed: 'add' });
    expect(chip().hidden).toBe(true);
    expect(byLabel('Clear range and pin')!.hidden).toBe(false);
    expect(root().querySelector<HTMLElement>('.mc-rv-ring')!.hidden).toBe(false);
    expect(play).not.toHaveBeenCalled();
    byLabel('Add note')!.click();
    const sent = posted.filter((m) => m.type === 'reviewAdd');
    expect(sent[1]).toMatchObject({ text: 'look here', point: [0.5, 0.5] });
  });

  it('leaves a pending draft alone on a reviewError that is not a failed add', async () => {
    await open();
    fromHost(review());
    field().value = 'keep me';
    byLabel('Add note')!.click();
    fromHost({ type: 'reviewError', message: 'Could not delete n1' });
    expect(field().disabled).toBe(true);
    expect(byLabel('Add note')!.disabled).toBe(true);
    expect(posted.filter((m) => m.type === 'reviewAdd')).toHaveLength(1);
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
    ack();
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
    // Playback picks up only once the save is acknowledged.
    expect(play).not.toHaveBeenCalled();
    ack();
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
    ack();
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
    ack();
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
  it('offers Delete on the selected card only, and no Done toggle', async () => {
    await open();
    fromHost(review());
    expect(root().querySelectorAll('.mc-rv-actions')).toHaveLength(0);

    cards()[0].click();
    expect(root().querySelectorAll('.mc-rv-actions')).toHaveLength(1);
    expect(cards()[0].parentElement!.querySelector('.mc-rv-actions')).not.toBeNull();
    expect(byLabel('Delete n2')).toBeNull();

    expect(byLabel('Mark n1 done')).toBeNull();
    byLabel('Delete n1')!.click();
    expect(posted).toContainEqual({ type: 'reviewDelete', id: 'n1' });
  });

  it('shows a note already done in Marker as done, read-only', async () => {
    await open();
    fromHost(review());
    cards()[2].click();
    expect(cards()[2].querySelector('.mc-rv-done')?.textContent).toBe('Done');
    expect(byLabel('Mark n3 not done')).toBeNull();
    expect(posted.some((m) => m.type === 'reviewSetDone')).toBe(false);
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

    const close = pressMenu('Close Video Notes');
    expect(close.getAttribute('role')).toBe('menuitem');
    expect(posted).toContainEqual({ type: 'updateSetting', key: 'video.review', value: false });
    expect(video.controls).toBe(true);
    expect(root().hidden).toBe(true);

    fromHost(review());
    expect(video.controls).toBe(true);
    expect(root().hidden).toBe(true);
  });

  it('closes from the panel header like the menu does', async () => {
    const video = await open();
    fromHost(review());
    byLabel('Close video notes')!.click();
    expect(posted).toContainEqual({ type: 'updateSetting', key: 'video.review', value: false });
    expect(video.controls).toBe(true);
    expect(root().hidden).toBe(true);
  });

  it('turns back on from the menu and asks the host', async () => {
    const video = await open();
    fromHost(review());
    pressMenu('Close Video Notes');
    posted.length = 0;

    pressMenu('Open Video Notes');
    expect(posted).toContainEqual({ type: 'updateSetting', key: 'video.review', value: true });
    expect(posted).toContainEqual({ type: 'reviewEnable' });
    expect(video.controls).toBe(false);
    fromHost(review());
    expect(root().hidden).toBe(false);
  });

  it('settles a pending draft acknowledged while review mode is off', async () => {
    const video = await open();
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    fromHost(review());
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    field().value = 'saved while hidden';
    byLabel('Add note')!.click();
    expect(posted.filter((m) => m.type === 'reviewAdd')).toHaveLength(1);
    expect(field().disabled).toBe(true);

    pressMenu('Close Video Notes');
    fromHost(review({ added: 'n3', notes: [note('n1', 1), note('n3', 2, { text: 'saved' })] }));
    expect(play).not.toHaveBeenCalled();

    pressMenu('Open Video Notes');
    fromHost(review({ added: null, notes: [note('n1', 1), note('n3', 2, { text: 'saved' })] }));
    expect(cards().some((c) => c.textContent?.includes('saved'))).toBe(true);
    expect(field().disabled).toBe(false);
    expect(byLabel('Add note')!.disabled).toBe(false);
    expect(field().value).toBe('');
    expect(play).not.toHaveBeenCalled();

    field().value = 'second';
    byLabel('Add note')!.click();
    expect(posted.filter((m) => m.type === 'reviewAdd')).toHaveLength(2);
  });

  it('keeps Copy off the right-click menu: it lives on the panel', async () => {
    await open();
    fromHost(review());
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const rows = [...document.querySelectorAll<HTMLElement>('#mc-menu [role^="menuitem"]')].map(
      (r) => r.textContent ?? '',
    );
    expect(rows.some((t) => t.includes('Close Video Notes'))).toBe(true);
    expect(rows.some((t) => /copy notes/i.test(t))).toBe(false);
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

const names = () => cards().map((c) => c.querySelector('.mc-rv-id')?.textContent);

describe('sort', () => {
  const mixed = () =>
    review({
      notes: [
        note('n1', 5, { created: '2026-01-01T00:00:03' }),
        note('n2', 1, { done: true, created: '2026-01-01T00:00:05' }),
        note('n3', 9, { created: '2026-01-01T00:00:05' }),
        note('n4', 3, { done: true, created: '2026-01-01T00:00:01' }),
      ],
    });

  it('has no filter, keeps every note, and walks the sort', async () => {
    await open();
    fromHost(mixed());
    expect(root().querySelector('[aria-label^="Filter"]')).toBeNull();
    expect(names()).toEqual(['n2', 'n4', 'n1', 'n3']);
    expect(root().querySelector('.mc-rv-count')?.textContent).toBe('4 notes');
    expect(byLabel('Sort: Time')!.textContent).toBe('Time');

    byLabel('Sort: Time')!.click();
    expect(byLabel('Sort: Newest')).not.toBeNull();
    // Latest created first, ties by id number (higher first).
    expect(names()).toEqual(['n3', 'n2', 'n1', 'n4']);
    expect(markers()[0].textContent).toBe('×4');

    byLabel('Sort: Newest')!.click();
    expect(names()).toEqual(['n2', 'n4', 'n1', 'n3']);
  });

  it('restores from getState and saves with setState', async () => {
    const setState = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage: (msg: Record<string, unknown>) => posted.push(msg),
      getState: () => ({ review: { filter: 'done', sort: 'newest' } }),
      setState,
    }));
    await open();
    fromHost(mixed());
    expect(names()).toEqual(['n3', 'n2', 'n1', 'n4']);
    expect(byLabel('Sort: Newest')).not.toBeNull();

    byLabel('Sort: Newest')!.click();
    expect(setState).toHaveBeenLastCalledWith({ review: { sort: 'time' } });
  });

  it('arranges without changing its input', () => {
    const input = [note('n2', 9), note('n1', 1)];
    expect(arrangeNotes(input, 'time').map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(input.map((n) => n.id)).toEqual(['n2', 'n1']);
  });
});

describe('range bands', () => {
  it('draws a band per range note, brighter when selected', async () => {
    await open();
    fromHost(review());
    const band = () => root().querySelector<HTMLElement>('.mc-rv-band')!;
    expect(band().dataset.id).toBe('n3');
    expect(band().classList.contains('mc-rv-band--selected')).toBe(false);
    markers()[2].click();
    expect(band().classList.contains('mc-rv-band--selected')).toBe(true);
    markers()[0].click();
    expect(band().classList.contains('mc-rv-band--selected')).toBe(false);
  });

  it('draws the pending range, the In bracket alone until Out is set', async () => {
    const video = await open();
    fromHost(review());
    at(video, 5);
    byLabel('Set In to this frame')!.click();
    expect(root().querySelector('.mc-rv-pending--point')).not.toBeNull();
    at(video, 9);
    byLabel('Set Out to this frame')!.click();
    expect(root().querySelector('.mc-rv-pending')).not.toBeNull();
    expect(root().querySelector('.mc-rv-pending--point')).toBeNull();
  });
});

describe('pins', () => {
  const pinNotes = () =>
    review({
      notes: [
        note('n1', 1, { point: [0.5, 0.5] }),
        note('n2', 8, { point: [0.1, 0.9], out: 12, kind: 'reject' }),
        note('n3', 20),
      ],
    });

  /** A 1000 x 500 stage showing a square picture: 250 px of letterbox each side. */
  async function openSized(): Promise<HTMLVideoElement> {
    const video = await open();
    Object.defineProperty(video, 'videoWidth', { value: 500, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 500, configurable: true });
    const box = {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
    video.getBoundingClientRect = () => box;
    document.getElementById('mc-stage')!.getBoundingClientRect = () => box;
    return video;
  }
  const studs = () => [...root().querySelectorAll<HTMLButtonElement>('.mc-rv-pin')];
  const ring = () => root().querySelector<HTMLButtonElement>('.mc-rv-ring')!;
  const press = (video: HTMLVideoElement, x: number, y: number) =>
    video.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );

  it('shows a pin only while its note is in view, mapped through the letterbox', async () => {
    const video = await openSized();
    fromHost(pinNotes());
    expect(studs()).toHaveLength(0);

    at(video, 1);
    video.dispatchEvent(new Event('timeupdate'));
    expect(studs()).toHaveLength(1);
    expect(studs()[0].getAttribute('aria-label')).toBe('Pin for n1');
    expect(studs()[0].textContent).toBe('1');
    // Picture spans x 250..750; the centre minus half of 44 px.
    expect(studs()[0].style.left).toBe('478px');
    expect(studs()[0].style.top).toBe('228px');

    at(video, 10);
    video.dispatchEvent(new Event('timeupdate'));
    expect(studs().map((s) => s.getAttribute('aria-label'))).toEqual(['Pin for n2']);
    expect(studs()[0].style.left).toBe(`${250 + 50 - 22}px`);

    at(video, 12.5);
    video.dispatchEvent(new Event('timeupdate'));
    expect(studs()).toHaveLength(0);
  });

  it('places a pin again when the picture size arrives after the review state', async () => {
    const video = await open();
    const box = { left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500 } as DOMRect;
    video.getBoundingClientRect = () => box;
    document.getElementById('mc-stage')!.getBoundingClientRect = () => box;
    // State arrives with the playhead at frame zero and no intrinsic size yet.
    fromHost(review({ notes: [note('n1', 0, { point: [0.1, 0.5], out: 5 })] }));
    expect(studs()).toHaveLength(1);
    expect(studs()[0].style.left).not.toBe('278px');

    Object.defineProperty(video, 'videoWidth', { value: 500, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 500, configurable: true });
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(studs()[0].style.left).toBe(`${250 + 50 - 22}px`);

    // A source switch changes the intrinsic size without a new frame.
    Object.defineProperty(video, 'videoWidth', { value: 1000, configurable: true });
    video.dispatchEvent(new Event('resize'));
    expect(studs()[0].style.left).toBe(`${100 - 22}px`);
  });

  it('selects and seeks on a stud press, and marks the card with the word Pin', async () => {
    const video = await openSized();
    fromHost(pinNotes());
    at(video, 1);
    video.dispatchEvent(new Event('timeupdate'));
    expect(cards()[0].textContent).toContain('Pin');
    expect(cards()[2].textContent).not.toContain('Pin');
    studs()[0].click();
    expect(cards()[0].getAttribute('aria-pressed')).toBe('true');
    expect(video.currentTime).toBeCloseTo((30 * (1000 / 30) + 1000 / 60) / 1000, 6);
    expect(studs()[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('places a pending pin from a picture press and sends it as a point', async () => {
    const video = await openSized();
    fromHost(review());
    byLabel('Pin a spot')!.click();
    at(video, 5);
    expect(ring().hidden).toBe(true);

    press(video, 500, 250);
    expect(ring().hidden).toBe(false);
    expect(ring().getAttribute('aria-label')).toBe('Pending pin, press the picture to move it');
    // Only the range is written in the chip; the lit Pin toggle says there is a pin.
    expect(chip().hidden).toBe(true);
    expect(byLabel('Clear range and pin')!.hidden).toBe(false);
    expect(byLabel('Pin a spot')!.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(field());
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

    // Pressing again moves it.
    press(video, 750, 0);
    expect(ring().style.left).toBe(`${750 - 22}px`);

    byLabel('Set In to this frame')!.click();
    expect(chip().textContent).toBe('00:00:05:00');

    field().value = 'look here';
    byLabel('Add note')!.click();
    expect(posted).toContainEqual({
      type: 'reviewAdd',
      at: 5,
      text: 'look here',
      point: [1, 0],
    });
    ack();
    expect(ring().hidden).toBe(true);
    expect(chip().hidden).toBe(true);
  });

  it('ignores a press in the letterbox and clears the pin with Clear', async () => {
    const video = await openSized();
    fromHost(review());
    byLabel('Pin a spot')!.click();
    press(video, 100, 250);
    expect(ring().hidden).toBe(true);
    expect(chip().hidden).toBe(true);

    press(video, 500, 250);
    byLabel('Clear range and pin')!.click();
    expect(ring().hidden).toBe(true);
    expect(chip().hidden).toBe(true);
  });

  it('resumes after sending only when it was playing before the first press', async () => {
    const video = await openSized();
    fromHost(review());
    byLabel('Pin a spot')!.click();
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    press(video, 500, 250);
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    press(video, 520, 250);
    field().value = 'x';
    byLabel('Add note')!.click();
    ack();
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();

    (HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>).mockClear();
    // A sent note leaves pin mode.
    byLabel('Pin a spot')!.click();
    press(video, 500, 250);
    field().value = 'y';
    byLabel('Add note')!.click();
    ack();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('plays and pauses on a picture press while pin mode is off, and pins with it on', async () => {
    const video = await openSized();
    fromHost(review());
    const pin = byLabel('Pin a spot')!;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    expect(pin.title).toBe('Pin a spot (P)');
    press(video, 500, 250);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(ring().hidden).toBe(true);

    pin.click();
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    expect(root().classList.contains('mc-rv--pin')).toBe(true);
    press(video, 500, 250);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(ring().hidden).toBe(false);

    // Off again: the pending pin goes and presses play and pause.
    pin.click();
    expect(ring().hidden).toBe(true);
    expect(chip().hidden).toBe(true);
    press(video, 500, 250);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it('toggles pin mode with P, but not while typing, and leaves it with Clear', async () => {
    await open();
    fromHost(review());
    const pin = byLabel('Pin a spot')!;
    key('p');
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    key('p', field());
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    key('P');
    expect(pin.getAttribute('aria-pressed')).toBe('false');

    pin.click();
    byLabel('Clear range and pin')!.click();
    expect(pin.getAttribute('aria-pressed')).toBe('false');
  });

  it('turns pin mode off on a successful send and restores it after a failed one', async () => {
    const video = await openSized();
    fromHost(review());
    const pin = byLabel('Pin a spot')!;
    pin.click();
    press(video, 500, 250);
    field().value = 'look';
    byLabel('Add note')!.click();
    expect(pin.disabled).toBe(true);

    fromHost({ type: 'reviewError', message: 'Could not save', failed: 'add' });
    expect(pin.disabled).toBe(false);
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    expect(ring().hidden).toBe(false);

    byLabel('Add note')!.click();
    ack();
    expect(pin.getAttribute('aria-pressed')).toBe('false');
  });

  it('disables the pin chip while read-only', async () => {
    await open();
    fromHost(review({ readOnly: 'schema version 2' }));
    expect(byLabel('Pin a spot')!.disabled).toBe(true);
    key('p');
    expect(byLabel('Pin a spot')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the picture press as play and pause outside review mode', async () => {
    const video = await openSized();
    press(video, 500, 250);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

    fromHost(review({ readOnly: 'schema version 2' }));
    press(video, 500, 250);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });
});
