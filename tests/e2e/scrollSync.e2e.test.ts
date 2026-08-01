// Scroll sync, driven through the bundle rather than through its maths.
//
// tests/scrollSync.test.ts already covers the interpolation as a pure function.
// What it cannot see is the wiring: which offsets the bundle feeds that function,
// whether a scroll event reaches it at all, and whether the reply it posts is
// suppressed when the scroll was the host's own doing. Those are the three
// things this branch changed, and all three are checklist rows
// (docs/TESTING.md:60-63).
import { describe, it, expect, beforeAll } from 'vitest';
import {
  boot,
  type Harness,
  type FakeLayout,
  type LayoutOptions,
  type RenderOptions,
} from '../webview/harness';
import { createMarkdownIt } from '../../src/render';

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

// Six one-line paragraphs, so a block's index is half its source line.
const SOURCE = ['zero', '', 'two', '', 'four', '', 'six', '', 'eight', '', 'ten', ''].join('\n');
const HTML = createMarkdownIt().render(SOURCE);

/**
 * Render, stack the blocks into a page tall enough to scroll, then wait out the
 * echo window the render itself opened. Every test starts from silence, so a
 * message that arrives after this point can only be the one it provoked.
 */
async function withLayout(
  options: LayoutOptions & { render?: Partial<RenderOptions> } = {},
): Promise<FakeLayout> {
  const { render, ...layoutOptions } = options;
  await h.render({ html: HTML, source: SOURCE, kind: 'markdown', ...render });
  const layout = h.fakeLayout(layoutOptions);
  await h.settleSync();
  h.reset();
  return layout;
}

/** Every line the bundle asked the editor to reveal, oldest first. */
function revealed(): number[] {
  return h.posted.filter((m) => m.type === 'revealLine').map((m) => Number(m.line));
}

describe('scrolling the preview moves the editor', () => {
  it('reports the line of whatever block is at the top', async () => {
    const layout = await withLayout();

    layout.scrollTo(layout.topOfBlock(2));
    await h.settleSync();

    // Block 2 is the paragraph `four`, which is source line 4.
    expect(revealed().at(-1)).toBe(4);
  });

  it('tracks part way through a tall block instead of snapping to its edges', async () => {
    // A code block or a table taller than the window is the case the checklist
    // calls out: sync used to jump between block boundaries, so the editor sat
    // still through a whole screen of scrolling and then leapt.
    const layout = await withLayout({ tall: { 2: 1000 } });

    layout.scrollTo(layout.topOfBlock(2) + 500);
    await h.settleSync();
    const middle = revealed().at(-1) ?? -1;

    // Strictly inside the block: past its own first line, short of the next
    // block's. Equal to either end is exactly the snapping this rules out.
    expect(middle).toBeGreaterThan(4);
    expect(middle).toBeLessThan(6);
  });

  it('reaches the last line when scrolled to the bottom', async () => {
    const layout = await withLayout();

    layout.scrollTo(layout.maxOffset());
    await h.settleSync();

    // Falling short here is what leaves the editor a screen above the end when
    // the preview is already as far down as it goes.
    expect(revealed().at(-1)).toBeGreaterThanOrEqual(8);
  });

  it('says nothing when the user has sync scroll off', async () => {
    const layout = await withLayout({ render: { syncScroll: false } });

    layout.scrollTo(layout.topOfBlock(3));
    await h.settleSync();

    expect(revealed()).toEqual([]);
  });
});

describe('a scroll the host caused', () => {
  it('does not echo back as a reveal', async () => {
    const layout = await withLayout();

    // The editor moved, so the host tells the preview to follow. The preview
    // scrolling is a consequence of that, not a user gesture, and reporting it
    // back is how the two surfaces used to fight: the round trip lands on a
    // slightly different line and knocks the editor off where it was put.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'scrollToLine', line: 6 } }));
    await h.settle();
    window.dispatchEvent(new Event('scroll'));
    await h.settleSync();

    expect(revealed()).toEqual([]);
    // The preview did move, so this is not passing because nothing happened.
    expect(layout.offset()).toBeGreaterThan(0);
  });

  it('still reports if the reader scrolls somewhere else during the window', async () => {
    const layout = await withLayout();

    // The deferral exists to catch exactly this: the host moved the preview,
    // and before the echo window closed the reader took over. Muting that is
    // how a genuine scroll gets swallowed.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'scrollToLine', line: 6 } }));
    await h.settle();
    layout.scrollTo(layout.topOfBlock(1));
    await h.settleSync();

    expect(revealed().at(-1)).toBe(2);
  });
});
