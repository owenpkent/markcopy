// Display equations that wrap, driven through a real render.
//
// KaTeX never breaks a line in display mode, so renderKatex in
// src/webview/main.ts tries a display equation in inline mode with
// \displaystyle first, which can break after an operator. What is pinned here is
// which path each kind of equation takes. jsdom does no layout, so the wrapping
// itself is covered by the manual check in docs/TESTING.md.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { boot, type Harness } from '../webview/harness';
import { createMarkdownIt } from '../../src/render';

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

beforeEach(() => {
  h.reset();
});

async function show(source: string): Promise<HTMLElement> {
  await h.render({ html: createMarkdownIt().render(source), source });
  return h.find('.mc-math');
}

const LONG = Array.from({ length: 30 }, (_, i) => `a_{${i}} x^{${i}}`).join(' + ');

describe('display equations', () => {
  it('render in breakable inline mode at display size', async () => {
    const el = await show(`$$\nf(x) = ${LONG}\n$$\n`);
    expect(el.classList.contains('mc-math-wrap')).toBe(true);
    expect(el.querySelector('.katex')).not.toBeNull();
    // Not KaTeX's display wrapper, which never breaks a line.
    expect(el.querySelector('.katex-display')).toBeNull();
    // Each top-level term is its own .katex-base, which is where a line can break.
    expect(el.querySelectorAll('.katex-html > .katex-base').length).toBeGreaterThan(10);
    // The source is what was written, without the \displaystyle prefix.
    expect(el.dataset.tex?.trim()).toBe(`f(x) = ${LONG}`);
  });

  it('keep true display mode for \\tag, which inline mode refuses', async () => {
    const el = await show('$$\nE = mc^2 \\tag{1}\n$$\n');
    expect(el.classList.contains('mc-math-wrap')).toBe(false);
    expect(el.querySelector('.katex-display')).not.toBeNull();
    expect(el.querySelector('.katex-error')).toBeNull();
  });

  it('keep true display mode for a display-only environment', async () => {
    const el = await show('$$\n\\begin{align} a &= b \\\\ c &= d \\end{align}\n$$\n');
    expect(el.classList.contains('mc-math-wrap')).toBe(false);
    expect(el.querySelector('.katex-display')).not.toBeNull();
  });

  it('still report a mistake the way display mode does', async () => {
    const el = await show('$$\n\\frac{a}{\n$$\n');
    expect(el.classList.contains('mc-math-wrap')).toBe(false);
    expect(el.querySelector('.katex-error')).not.toBeNull();
  });

  it('leave inline math alone', async () => {
    const el = await show('Euler: $e^{i\\pi} + 1 = 0$.\n');
    expect(el.classList.contains('mc-math-wrap')).toBe(false);
    expect(el.querySelector('.katex')).not.toBeNull();
  });
});
