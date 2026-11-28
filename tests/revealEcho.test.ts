import { describe, expect, it } from 'vitest';
import { createRevealEcho } from '../src/revealEcho';

describe('createRevealEcho', () => {
  it('echoes only inside the window', () => {
    let t = 1000;
    const echo = createRevealEcho(250, () => t);
    expect(echo.isEcho('a', 5)).toBe(false);
    echo.mark('a', 5);
    t += 249;
    expect(echo.isEcho('a', 5)).toBe(true);
    t += 1;
    expect(echo.isEcho('a', 5)).toBe(false);
  });

  it('does not let one document mute scroll sync for another', () => {
    // A preview auto-scrolling at 12 px/s reveals a line every ~84 ms.
    let t = 0;
    const echo = createRevealEcho(250, () => t);
    for (let i = 0; i < 20; i++) {
      echo.mark('file:///a.md', 19);
      t += 84;
      expect(echo.isEcho('file:///a.md', 19)).toBe(true);
      expect(echo.isEcho('file:///b.md', 19)).toBe(false);
    }
  });

  it('forwards a genuine scroll of the playing document to another line', () => {
    let t = 0;
    const echo = createRevealEcho(250, () => t);
    for (let i = 0; i < 14; i++) {
      echo.mark('file:///a.md', 19);
      t += 84;
      // The reader scrolled the source to line 180: not what we revealed.
      expect(echo.isEcho('file:///a.md', 180)).toBe(false);
    }
  });

  it('still recognises an older reveal when a newer one has been made', () => {
    let t = 0;
    const echo = createRevealEcho(250, () => t);
    echo.mark('a', 19);
    t += 50;
    echo.mark('a', 20);
    expect(echo.isEcho('a', 19)).toBe(true);
    expect(echo.isEcho('a', 20)).toBe(true);
  });

  it('matches a reveal anywhere in the range it is given, and only there', () => {
    let t = 0;
    const echo = createRevealEcho(250, () => t);
    // Near the end of the file the editor stops short: line 95 shows below the top.
    echo.mark('a', 95);
    expect(echo.isEcho('a', 80)).toBe(false);
    expect(echo.isEcho('a', 80, 100)).toBe(true);
    expect(echo.isEcho('a', 60, 90)).toBe(false);
    t += 250;
    expect(echo.isEcho('a', 80, 100)).toBe(false);
  });
});
