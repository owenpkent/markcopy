import { describe, expect, it } from 'vitest';
import { createRevealEcho } from '../src/revealEcho';

describe('createRevealEcho', () => {
  it('mutes a document only inside the window', () => {
    let t = 1000;
    const echo = createRevealEcho(250, () => t);
    expect(echo.isEcho('a')).toBe(false);
    echo.mark('a');
    t += 249;
    expect(echo.isEcho('a')).toBe(true);
    t += 1;
    expect(echo.isEcho('a')).toBe(false);
  });

  it('does not let one document mute scroll sync for another', () => {
    let t = 0;
    const echo = createRevealEcho(250, () => t);
    echo.mark('file:///a.md');
    expect(echo.isEcho('file:///a.md')).toBe(true);
    expect(echo.isEcho('file:///b.md')).toBe(false);
    t += 100;
    echo.mark('file:///b.md');
    t += 200; // a's reveal is 300 ms old, b's 200 ms
    expect(echo.isEcho('file:///a.md')).toBe(false);
    expect(echo.isEcho('file:///b.md')).toBe(true);
  });

  it('keeps a document muted while reveals keep coming (a playing preview)', () => {
    let t = 0;
    const echo = createRevealEcho(250, () => t);
    for (let i = 0; i < 20; i++) {
      echo.mark('a');
      t += 84;
      expect(echo.isEcho('a')).toBe(true);
    }
    t += 250;
    expect(echo.isEcho('a')).toBe(false);
  });

  it('stays bounded over many documents, keeping the newest', () => {
    const echo = createRevealEcho(250, () => 0);
    for (let i = 0; i < 500; i++) {
      echo.mark('doc' + i);
    }
    expect(echo.isEcho('doc499')).toBe(true);
    expect(echo.isEcho('doc0')).toBe(false);
  });
});
