import { beforeEach, describe, expect, it } from 'vitest';
import { scanHiddenText } from '../../src/hiddenText';
import { boot, type Harness } from '../webview/harness';

const tags = (ascii: string): string =>
  String.fromCodePoint(...[...ascii].map((c) => 0xe0000 + (c.codePointAt(0) as number)));

const bar = (): HTMLElement => document.getElementById('mc-hidden-text') as HTMLElement;

// The harness render has no field for the scan, so post the message the host does.
async function renderWith(h: Harness, hidden: unknown, docKey = 'file:///a.md'): Promise<void> {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        type: 'render',
        kind: 'markdown',
        html: '<p>Hello</p>',
        source: 'Hello',
        docKey,
        docVersion: 1,
        syncScroll: true,
        autoPreview: true,
        math: true,
        footnotes: true,
        wrapCode: true,
        theme: 'auto',
        styleProfile: 'github',
        mermaidConfig: {},
        hidden,
      },
      origin: window.origin,
    }),
  );
  await h.settle();
}

describe('the hidden characters notice', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
    h.reset();
    await renderWith(h, undefined, 'file:///reset.md');
  });

  it('stays hidden when the host sends nothing', () => {
    expect(bar().hidden).toBe(true);
  });

  it('sits outside the copied content, and the content is untouched', async () => {
    await renderWith(h, scanHiddenText(`a ${tags('hello')}`));
    expect(bar().hidden).toBe(false);
    expect(bar().getAttribute('role')).toBe('status');
    expect(h.content().contains(bar())).toBe(false);
    expect(h.content().textContent).toBe('Hello');
    expect(bar().nextElementSibling).toBe(h.content());
  });

  it('states what the file establishes, with plural forms', async () => {
    await renderWith(
      h,
      scanHiddenText(
        `a ${tags('hello')} b ${String.fromCodePoint(0x200b, 0x200c, 0x200b, 0x200c)}`,
      ),
    );
    expect(bar().querySelector('.mc-hidden-message')?.textContent).toBe(
      'This file has 2 runs of invisible characters (9 characters). 1 spells out hidden text. Copies include them.',
    );
    expect(bar().classList.contains('mc-hidden-warn')).toBe(true);
    await renderWith(h, scanHiddenText(`a${String.fromCodePoint(0x200b)}b`));
    expect(bar().querySelector('.mc-hidden-message')?.textContent).toBe(
      'This file has 1 run of invisible characters (1 character). Copies include them.',
    );
    expect(bar().classList.contains('mc-hidden-info')).toBe(true);
  });

  it('shows decoded text as text, never as HTML', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    await renderWith(h, scanHiddenText(`a ${tags(payload)}`));
    const code = bar().querySelector('.mc-hidden-decoded') as HTMLElement;
    expect(code.textContent).toBe(payload);
    expect(bar().querySelector('img')).toBeNull();
    expect(code.children).toHaveLength(0);
  });

  it('does not trust the shape of a scan it was sent', async () => {
    await renderWith(h, {
      totalRuns: 1,
      totalChars: 2,
      encoded: true,
      runs: [{ line: '<b>', column: 1 }, null, 5],
    });
    expect(bar().querySelector('b')).toBeNull();
    expect(bar().querySelectorAll('li')).toHaveLength(0);
    await renderWith(h, { totalRuns: 'many' });
    expect(bar().hidden).toBe(true);
  });

  it('posts revealHidden from a run and copyCleanSource from the button', async () => {
    await renderWith(h, scanHiddenText(`one\ntwo ${tags('hi')}`));
    (bar().querySelector('.mc-hidden-link') as HTMLButtonElement).click();
    expect(h.posted.at(-1)).toEqual({ type: 'revealHidden', line: 2, column: 5 });
    const copy = [...bar().querySelectorAll('button')].find((b) =>
      /Copy without hidden/.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    copy.click();
    expect(h.posted.at(-1)).toEqual({ type: 'copyCleanSource' });
  });

  it('stays dismissed until the flagged set changes', async () => {
    await renderWith(h, scanHiddenText(`a ${tags('hello')}`));
    const dismiss = [...bar().querySelectorAll('button')].find(
      (b) => b.textContent === 'Dismiss',
    ) as HTMLButtonElement;
    expect(dismiss.getAttribute('aria-label')).toBeTruthy();
    dismiss.click();
    expect(bar().hidden).toBe(true);
    await renderWith(h, scanHiddenText(`a ${tags('hello')}`));
    expect(bar().hidden).toBe(true);
    await renderWith(h, scanHiddenText(`a ${tags('hello!')}`));
    expect(bar().hidden).toBe(false);
  });

  it('hides again when the file is clean', async () => {
    await renderWith(h, scanHiddenText(`a ${tags('hello')}`));
    expect(bar().hidden).toBe(false);
    await renderWith(h, undefined);
    expect(bar().hidden).toBe(true);
  });
});
