import { describe, expect, it } from 'vitest';
import { createRevealEcho } from '../src/revealEcho';

describe('createRevealEcho', () => {
  it('echoes only inside the window', () => {
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
    // A preview auto-scrolling at 12 px/s reveals a line every ~84 ms.
    let t = 0;
    const echo = createRevealEcho(250, () => t);
    for (let i = 0; i < 20; i++) {
      echo.mark('file:///a.md');
      t += 84;
      expect(echo.isEcho('file:///a.md')).toBe(true);
      expect(echo.isEcho('file:///b.md')).toBe(false);
    }
  });
});
