import { describe, expect, it } from 'vitest';
import { playingAfterReport, pushesEditorScroll, reportIsCurrent } from '../src/scrollGate';

describe('reportIsCurrent', () => {
  it('drops a scroll report measured in another document', () => {
    expect(reportIsCurrent('file:///a.md', 'file:///a.md')).toBe(true);
    // A's report arriving after the preview switched to B.
    expect(reportIsCurrent('file:///a.md', 'file:///b.md')).toBe(false);
    expect(reportIsCurrent('', 'file:///b.md')).toBe(false);
  });
});

describe('playingAfterReport', () => {
  const b = 'file:///b.md';
  it('follows a report for the current document', () => {
    expect(playingAfterReport(false, { playing: true, docKey: b }, b)).toBe(true);
    expect(playingAfterReport(true, { playing: false, docKey: b }, b)).toBe(false);
  });
  it('ignores a stale report from the previous document', () => {
    expect(playingAfterReport(false, { playing: true, docKey: 'file:///a.md' }, b)).toBe(false);
    expect(playingAfterReport(true, { playing: false, docKey: 'file:///a.md' }, b)).toBe(true);
  });
});

describe('pushesEditorScroll', () => {
  it('holds the editor back while the preview plays, however old its last reveal', () => {
    expect(pushesEditorScroll(true)).toBe(false);
  });
  it('lets the source lead when paused, stopped or never reported', () => {
    expect(pushesEditorScroll(false)).toBe(true);
    expect(pushesEditorScroll(undefined)).toBe(true);
  });
});
