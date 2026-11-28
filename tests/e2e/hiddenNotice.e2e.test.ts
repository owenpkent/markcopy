import { beforeEach, describe, expect, it } from 'vitest';
import { scanHiddenText } from '../../src/hiddenText';
import { boot, type Harness } from '../webview/harness';

const tags = (ascii: string): string =>
  String.fromCodePoint(...[...ascii].map((c) => 0xe0000 + (c.codePointAt(0) as number)));

const bar = (): HTMLElement => document.querySelector('aside.mc-hidden-text') as HTMLElement;

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
    expect(h.posted.at(-1)).toEqual({
      type: 'revealHidden',
      line: 2,
      column: 5,
      docKey: 'file:///a.md',
      docVersion: 1,
    });
    const copy = [...bar().querySelectorAll('button')].find((b) =>
      /Copy without hidden/.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    copy.click();
    expect(h.posted.at(-1)).toEqual({ type: 'copyCleanSource', docKey: 'file:///a.md' });
  });

  it('has no id a Markdown heading link could resolve to', async () => {
    await renderWith(h, scanHiddenText(`a ${tags('hello')}`));
    expect(bar().id).toBe('');
    expect(document.getElementById('mc-hidden-text')).toBeNull();
  });

  it('keeps the keyboard focus on the same control across a redraw', async () => {
    const scan = scanHiddenText(`one
two ${tags('hi')}`);
    await renderWith(h, scan);
    const link = bar().querySelector('.mc-hidden-link') as HTMLButtonElement;
    link.focus();
    expect(document.activeElement).toBe(link);
    await renderWith(h, { ...scan });
    const again = bar().querySelector('.mc-hidden-link') as HTMLButtonElement;
    expect(again).not.toBe(link);
    expect(document.activeElement).toBe(again);
    const copy = bar().querySelector('.mc-hidden-actions button') as HTMLButtonElement;
    copy.focus();
    await renderWith(h, { ...scan });
    expect(document.activeElement).toBe(bar().querySelector('.mc-hidden-actions button'));
  });

  it('keeps the list scrolled where it was, so the focused link stays in view', async () => {
    const text = Array.from({ length: 55 }, (_, n) => `l${n} ${tags('x')}`).join(
      String.fromCharCode(10),
    );
    const scan = scanHiddenText(text);
    await renderWith(h, scan);
    const details = bar().querySelector('details') as HTMLDetailsElement;
    details.open = true;
    const list = bar().querySelector('.mc-hidden-list') as HTMLElement;
    list.scrollTop = 628;
    expect(list.scrollTop).toBe(628);
    const link = bar().querySelectorAll<HTMLButtonElement>('.mc-hidden-link')[40];
    link.focus();
    await renderWith(h, { ...scan });
    const again = bar().querySelector('.mc-hidden-list') as HTMLElement;
    expect(again).not.toBe(list);
    expect(again.scrollTop).toBe(628);
    expect(document.activeElement).toBe(bar().querySelectorAll('.mc-hidden-link')[40]);
  });

  // jsdom has no layout: give the list 200 px of height and every row 40 px, so
  // a row's position follows the list's scroll offset the way a browser's does.
  function withLayout(): () => void {
    const rect = Element.prototype.getBoundingClientRect;
    const height = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      let top = 0;
      let bottom = 0;
      if (this.classList.contains('mc-hidden-list')) {
        bottom = 200;
      } else if (this.closest('.mc-hidden-list')) {
        const li = this.closest('li') as HTMLElement;
        const list = li.parentElement as HTMLElement;
        top = Array.from(list.children).indexOf(li) * 40 - list.scrollTop;
        bottom = top + 40;
      }
      return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top } as DOMRect;
    };
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get(this: Element) {
        return this.classList.contains('mc-hidden-list') ? 200 : 0;
      },
    });
    return () => {
      Element.prototype.getBoundingClientRect = rect;
      if (height) {
        Object.defineProperty(Element.prototype, 'clientHeight', height);
      }
    };
  }
  const longFile = (clean: number): string =>
    Array.from({ length: 55 }, (_, n) => (n < clean ? `l${n}` : `l${n} ${tags('x')}`)).join(
      String.fromCharCode(10),
    );
  const linkTop = (label: RegExp): number => {
    const link = [...bar().querySelectorAll<HTMLElement>('.mc-hidden-link')].find((b) =>
      label.test(b.textContent ?? ''),
    ) as HTMLElement;
    expect(document.activeElement).toBe(link);
    return (link.closest('li') as HTMLElement).getBoundingClientRect().top;
  };

  it('brings the focused link into view when earlier results disappear', async () => {
    const restore = withLayout();
    try {
      await renderWith(h, scanHiddenText(longFile(0)));
      (bar().querySelector('details') as HTMLDetailsElement).open = true;
      const list = bar().querySelector('.mc-hidden-list') as HTMLElement;
      list.scrollTop = 1200;
      const link = [...bar().querySelectorAll<HTMLButtonElement>('.mc-hidden-link')].find((b) =>
        /^Line 31,/.test(b.textContent ?? ''),
      ) as HTMLButtonElement;
      link.focus();
      // The first 30 lines lose their characters; line 31 is now the first result.
      await renderWith(h, scanHiddenText(longFile(30)));
      const top = linkTop(/^Line 31,/);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top + 40).toBeLessThanOrEqual(200);
      // A link already in view does not move the list.
      const again = bar().querySelector('.mc-hidden-list') as HTMLElement;
      again.scrollTop = 0;
      (bar().querySelectorAll('.mc-hidden-link')[2] as HTMLElement).focus();
      await renderWith(h, scanHiddenText(longFile(30)));
      expect((bar().querySelector('.mc-hidden-list') as HTMLElement).scrollTop).toBe(0);
    } finally {
      restore();
    }
  });

  it('brings a focused link below the list into view', async () => {
    const restore = withLayout();
    try {
      await renderWith(h, scanHiddenText(longFile(0)));
      (bar().querySelector('details') as HTMLDetailsElement).open = true;
      const list = bar().querySelector('.mc-hidden-list') as HTMLElement;
      list.scrollTop = 0;
      const link = bar().querySelectorAll<HTMLButtonElement>('.mc-hidden-link')[40];
      link.focus();
      await renderWith(h, scanHiddenText(longFile(0)));
      const top = linkTop(/^Line 41,/);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top + 40).toBeLessThanOrEqual(200);
    } finally {
      restore();
    }
  });

  it('opens another document with its list at the top and nothing focused', async () => {
    await renderWith(h, scanHiddenText(longFile(0)), 'file:///a.md');
    (bar().querySelector('details') as HTMLDetailsElement).open = true;
    const list = bar().querySelector('.mc-hidden-list') as HTMLElement;
    list.scrollTop = 628;
    (bar().querySelectorAll('.mc-hidden-link')[40] as HTMLElement).focus();
    await renderWith(h, scanHiddenText(longFile(0)), 'file:///b.md');
    expect((bar().querySelector('.mc-hidden-list') as HTMLElement).scrollTop).toBe(0);
    expect(bar().contains(document.activeElement)).toBe(false);
    // Back on the same document, the redraw keeps its place again.
    (bar().querySelector('.mc-hidden-list') as HTMLElement).scrollTop = 300;
    await renderWith(h, scanHiddenText(longFile(0)), 'file:///b.md');
    expect((bar().querySelector('.mc-hidden-list') as HTMLElement).scrollTop).toBe(300);
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

  it('shows again when the payload changes but its size does not', async () => {
    await renderWith(h, scanHiddenText(`a ${tags('hello')}`));
    const dismiss = [...bar().querySelectorAll('button')].find(
      (b) => b.textContent === 'Dismiss',
    ) as HTMLButtonElement;
    dismiss.click();
    expect(bar().hidden).toBe(true);
    await renderWith(h, scanHiddenText(`a ${tags('world')}`));
    expect(bar().hidden).toBe(false);
  });

  it('hides again when the file is clean', async () => {
    await renderWith(h, scanHiddenText(`a ${tags('hello')}`));
    expect(bar().hidden).toBe(false);
    await renderWith(h, undefined);
    expect(bar().hidden).toBe(true);
  });

  // `calc(100vh - px)` is invalid CSS, so the grid height rule needs a unit
  // whether the notice is shown, hidden, or dismissed.
  it('publishes its height as a length with a unit', async () => {
    const height = (): string => document.body.style.getPropertyValue('--mc-hidden-h');
    expect(height()).toBe('0px');
    await renderWith(h, scanHiddenText(`a ${tags('hello')}`));
    expect(height()).toMatch(/^\d+px$/);
    (bar().querySelector('details') as HTMLDetailsElement).open = true;
    await renderWith(h, scanHiddenText(`a ${tags('hello')}`));
    expect(height()).toMatch(/^\d+px$/);
    const dismiss = [...bar().querySelectorAll('button')].find(
      (b) => b.textContent === 'Dismiss',
    ) as HTMLButtonElement;
    dismiss.click();
    expect(height()).toBe('0px');
  });
});
