import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMenu, fit, revealLabel, type MenuEntry } from '../src/webview/menu';

function makeRoot(): HTMLDivElement {
  document.body.innerHTML = '<div id="mc-menu" class="mc-menu" role="menu" hidden></div>';
  return document.getElementById('mc-menu') as HTMLDivElement;
}

// Rows of a panel, in order, as their visible text.
function labels(panel: Element): string[] {
  return Array.from(panel.querySelectorAll('.mc-menu-item')).map((el) =>
    (el.textContent ?? '').replace('▸', '').trim(),
  );
}

// Every panel on screen: the root first, then any open submenus.
function panels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.mc-menu'));
}

function hover(el: Element): void {
  el.dispatchEvent(new MouseEvent('mouseenter'));
}

function press(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

// A menu whose first row opens a submenu, used by most of the nesting tests.
function nested(): MenuEntry[] {
  return [
    {
      kind: 'submenu',
      label: 'Copy as',
      entries: [
        { kind: 'item', label: 'CSV', run: () => {} },
        { kind: 'item', label: 'PNG', run: () => {} },
      ],
    },
    { kind: 'item', label: 'Copy Table', run: () => {} },
  ];
}

describe('createMenu', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders items, dividers, group labels and checkmarks', () => {
    const menu = createMenu(root);
    menu.show(10, 10, [
      { kind: 'item', label: 'Copy Table', run: () => {} },
      { kind: 'divider' },
      { kind: 'label', label: 'Theme' },
      { kind: 'radio', label: 'Dark', checked: true, run: () => {} },
      { kind: 'checkbox', label: 'Sync scroll', checked: false, run: () => {} },
    ]);

    expect(root.hidden).toBe(false);
    expect(labels(root)).toEqual(['Copy Table', '✓Dark', 'Sync scroll']);
    expect(root.querySelectorAll('.mc-menu-divider')).toHaveLength(1);
    expect(root.querySelector('.mc-menu-group-label')?.textContent).toBe('Theme');
    expect(root.querySelector('[role="menuitemradio"]')?.getAttribute('aria-checked')).toBe('true');
    expect(root.querySelector('[role="menuitemcheckbox"]')?.getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('opens a submenu on hover and closes it once the pointer settles on a sibling', () => {
    vi.useFakeTimers();
    const menu = createMenu(root);
    menu.show(0, 0, nested());

    const [submenuRow, primary] = Array.from(root.querySelectorAll('.mc-menu-item'));
    expect(panels()).toHaveLength(1);
    expect(submenuRow.getAttribute('aria-expanded')).toBe('false');

    hover(submenuRow);
    expect(panels()).toHaveLength(2);
    expect(labels(panels()[1])).toEqual(['CSV', 'PNG']);
    expect(submenuRow.getAttribute('aria-expanded')).toBe('true');

    // Moving to a different row queues the dismissal rather than firing it.
    hover(primary);
    expect(panels()).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(panels()).toHaveLength(1);
    expect(submenuRow.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a submenu open when the pointer clips a sibling row on the way in', () => {
    vi.useFakeTimers();
    const menu = createMenu(root);
    menu.show(0, 0, nested());

    const [submenuRow, primary] = Array.from(root.querySelectorAll('.mc-menu-item'));
    hover(submenuRow);
    const panel = panels()[1];

    // The diagonal path from the row to its panel crosses the row below it.
    hover(primary);
    panel.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(500);

    expect(panels()).toHaveLength(2);
    expect(panels()[1]).toBe(panel);
  });

  it('does not rebuild a submenu when the pointer returns to the row that opened it', () => {
    const menu = createMenu(root);
    menu.show(0, 0, nested());

    const submenuRow = root.querySelector('.mc-menu-item') as HTMLElement;
    hover(submenuRow);
    const panel = panels()[1];

    hover(submenuRow);
    expect(panels()).toHaveLength(2);
    expect(panels()[1]).toBe(panel);
  });

  it('nests submenus and tears down every level on hide', () => {
    const menu = createMenu(root);
    menu.show(0, 0, [
      {
        kind: 'submenu',
        label: 'Preferences',
        entries: [
          {
            kind: 'submenu',
            label: 'Theme',
            entries: [{ kind: 'radio', label: 'Auto', checked: true, run: () => {} }],
          },
        ],
      },
    ]);

    hover(root.querySelector('.mc-menu-item') as Element);
    hover(panels()[1].querySelector('.mc-menu-item') as Element);
    expect(panels()).toHaveLength(3);
    expect(labels(panels()[2])).toEqual(['✓Auto']);

    menu.hide();
    expect(panels()).toHaveLength(1); // the root div survives, emptied
    expect(root.hidden).toBe(true);
    expect(labels(root)).toEqual([]);
  });

  it('runs an item and closes the menu on click, but keeps it open for a submenu row', () => {
    const menu = createMenu(root);
    let ran = 0;
    menu.show(0, 0, [
      { kind: 'item', label: 'Copy', run: () => void ran++ },
      {
        kind: 'submenu',
        label: 'Copy as',
        entries: [{ kind: 'item', label: 'CSV', run: () => {} }],
      },
    ]);

    const [item, submenuRow] = Array.from(root.querySelectorAll<HTMLElement>('.mc-menu-item'));

    submenuRow.click();
    expect(ran).toBe(0);
    expect(root.hidden).toBe(false);
    expect(panels()).toHaveLength(2);

    item.click();
    expect(ran).toBe(1);
    expect(root.hidden).toBe(true);
    expect(panels()).toHaveLength(1);
  });

  it('marks a disabled item, and neither runs it nor closes the menu', () => {
    const menu = createMenu(root);
    let ran = 0;
    menu.show(0, 0, [
      { kind: 'item', label: 'Copy Frame as PNG', run: () => void ran++, disabled: true },
    ]);

    const [item] = Array.from(root.querySelectorAll<HTMLElement>('.mc-menu-item'));
    expect(item.classList.contains('mc-menu-item--disabled')).toBe(true);
    expect(item.getAttribute('aria-disabled')).toBe('true');
    // Still in the tab order: a row nobody can reach cannot say why it is greyed.
    expect(item.tabIndex).toBe(0);

    item.click();
    expect(ran).toBe(0);
    // Closing would read as the action having been taken.
    expect(root.hidden).toBe(false);

    // Enter routes through the same click handler, so it is held back too.
    press(item, 'Enter');
    expect(ran).toBe(0);
    expect(root.hidden).toBe(false);
  });

  it('reuses the root panel across shows without stacking stale submenus', () => {
    const menu = createMenu(root);
    const entries: MenuEntry[] = [
      {
        kind: 'submenu',
        label: 'Copy as',
        entries: [{ kind: 'item', label: 'CSV', run: () => {} }],
      },
    ];

    menu.show(0, 0, entries);
    hover(root.querySelector('.mc-menu-item') as Element);
    expect(panels()).toHaveLength(2);

    menu.show(5, 5, entries);
    expect(panels()).toHaveLength(1);
    expect(labels(root)).toEqual(['Copy as']);
  });

  it('focuses the first row when it opens, so the arrow keys work straight away', () => {
    const menu = createMenu(root);
    menu.show(0, 0, [
      { kind: 'label', label: 'Theme' },
      { kind: 'item', label: 'Copy Table', run: () => {} },
    ]);

    // The group heading isn't focusable, so the first real row takes it.
    expect(document.activeElement).toBe(root.querySelector('.mc-menu-item'));
  });

  it('moves focus with the arrow keys, skipping chrome and wrapping at both ends', () => {
    const menu = createMenu(root);
    menu.show(0, 0, [
      { kind: 'item', label: 'One', run: () => {} },
      { kind: 'divider' },
      { kind: 'item', label: 'Two', run: () => {} },
      { kind: 'item', label: 'Three', run: () => {} },
    ]);

    const items = Array.from(root.querySelectorAll<HTMLElement>('.mc-menu-item'));
    expect(document.activeElement).toBe(items[0]);

    press(items[0], 'ArrowDown'); // steps over the divider
    expect(document.activeElement).toBe(items[1]);

    press(items[1], 'ArrowUp');
    expect(document.activeElement).toBe(items[0]);

    press(items[0], 'ArrowUp'); // wraps to the end
    expect(document.activeElement).toBe(items[2]);

    press(items[2], 'ArrowDown'); // and back round
    expect(document.activeElement).toBe(items[0]);
  });

  it('opens a submenu with ArrowRight and steps back out with ArrowLeft', () => {
    const menu = createMenu(root);
    menu.show(0, 0, nested());

    const anchor = root.querySelector('.mc-menu-item') as HTMLElement;
    expect(document.activeElement).toBe(anchor);

    press(anchor, 'ArrowRight');
    expect(panels()).toHaveLength(2);
    expect(document.activeElement).toBe(panels()[1].querySelector('.mc-menu-item'));

    press(document.activeElement as Element, 'ArrowLeft');
    expect(panels()).toHaveLength(1);
    expect(document.activeElement).toBe(anchor);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
  });

  it('lets Escape pop one level, and reach the host only at the top', () => {
    let reachedHost = 0;
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') reachedHost++;
    };
    document.addEventListener('keydown', onKeydown);

    const menu = createMenu(root);
    menu.show(0, 0, nested());
    const anchor = root.querySelector('.mc-menu-item') as HTMLElement;

    press(anchor, 'ArrowRight');
    expect(panels()).toHaveLength(2);

    // Inside a submenu, Escape closes that panel and stops there: the host's
    // handler would otherwise tear down the whole menu.
    press(document.activeElement as Element, 'Escape');
    expect(panels()).toHaveLength(1);
    expect(reachedHost).toBe(0);

    // At the top level it falls through to the document, which closes the menu.
    press(anchor, 'Escape');
    expect(reachedHost).toBe(1);
    expect(menu.isOpen()).toBe(false);

    document.removeEventListener('keydown', onKeydown);
  });

  it('links each submenu to the row that opened it, and unlinks it on close', () => {
    const menu = createMenu(root);
    menu.show(0, 0, nested());
    const anchor = root.querySelector('.mc-menu-item') as HTMLElement;
    expect(anchor.getAttribute('aria-haspopup')).toBe('true');
    expect(anchor.hasAttribute('aria-controls')).toBe(false);

    hover(anchor);
    const panel = panels()[1];
    expect(panel.id).not.toBe('');
    expect(anchor.id).not.toBe('');
    // Nothing links the two structurally: the panel hangs off <body>.
    expect(panel.parentElement).toBe(document.body);
    expect(anchor.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(anchor.id);

    menu.hide();
    expect(anchor.hasAttribute('aria-controls')).toBe(false);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
  });

  it('swallows clicks on panel chrome so the host does not close the menu', () => {
    let reachedHost = 0;
    const onClick = (): void => void reachedHost++;
    document.addEventListener('click', onClick);

    const menu = createMenu(root);
    menu.show(0, 0, [
      { kind: 'label', label: 'Theme' },
      { kind: 'divider' },
      { kind: 'item', label: 'Auto', run: () => {} },
    ]);

    (root.querySelector('.mc-menu-group-label') as HTMLElement).click();
    (root.querySelector('.mc-menu-divider') as HTMLElement).click();
    root.click(); // the panel's own padding

    expect(reachedHost).toBe(0);
    expect(root.hidden).toBe(false);

    document.removeEventListener('click', onClick);
  });

  // The video and GIF viewers once shipped with no dismissal of their own, and
  // the menu stayed on screen until a menu row was clicked.
  describe('closes itself, with no help from the host', () => {
    it('on a click outside every panel', () => {
      const outside = document.createElement('div');
      document.body.appendChild(outside);
      const menu = createMenu(root);
      menu.show(0, 0, nested());
      hover(root.querySelector('.mc-menu-item') as HTMLElement);
      expect(panels()).toHaveLength(2);

      outside.click();
      expect(menu.isOpen()).toBe(false);
      expect(panels()).toHaveLength(1); // the hidden root
      expect(root.hidden).toBe(true);
    });

    it('on Escape, without passing that press on to the host', () => {
      const menu = createMenu(root);
      let reachedHost = 0;
      const onKeydown = (): void => void reachedHost++;
      document.addEventListener('keydown', onKeydown);
      menu.show(0, 0, nested());

      press(document.body, 'Escape');
      expect(menu.isOpen()).toBe(false);
      expect(reachedHost).toBe(0);

      document.removeEventListener('keydown', onKeydown);
    });

    it('when the webview loses focus', () => {
      const menu = createMenu(root);
      menu.show(0, 0, nested());
      window.dispatchEvent(new FocusEvent('blur'));
      expect(menu.isOpen()).toBe(false);
    });
  });
});

describe('revealLabel', () => {
  it('words the row the way VS Code does on each platform', () => {
    expect(revealLabel('MacIntel', '')).toBe('Reveal in Finder');
    expect(revealLabel('Win32', '')).toBe('Reveal in File Explorer');
    expect(revealLabel('Linux x86_64', 'X11; Linux')).toBe('Open Containing Folder');
  });
});

describe('fit', () => {
  // A 300px-tall menu in a 600px-tall window, opened at various pointer rows.
  it('opens below the pointer when there is room', () => {
    expect(fit(100, 300, 600, 100)).toBe(100);
  });

  it('flips above the pointer near the bottom edge', () => {
    expect(fit(550, 300, 600, 550)).toBe(250);
  });

  it('pins to the bottom edge when neither side has room', () => {
    // 200px above, 150px below: the whole menu stays on screen, 4px from the edge.
    expect(fit(200, 300, 350, 200)).toBe(46);
  });

  it('never starts above the top edge, even when taller than the window', () => {
    expect(fit(100, 900, 600, 100)).toBe(4);
  });
});

// A fixed panel cannot be scrolled to, so one wider than a narrow split pane
// hid its submenu arrows and the ends of its labels past the right edge with
// no way to reach them. The window's width, less the edge gap, is handed to
// the stylesheet on every panel, and it is the stylesheet that makes the
// panel's minimum width give way to it.
describe('menu width in a narrow window', () => {
  const sized = (width: number, height: number): void => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      value: width,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: height,
      configurable: true,
    });
  };
  // jsdom lays nothing out, so widths are given by the test: a label "is cut"
  // when its text is longer than the 12 characters said to fit.
  const widths = (): (() => void) => {
    const scroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth');
    const client = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return (this.textContent ?? '').length * 10;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this === document.documentElement ? 200 : 120;
      },
    });
    return () => {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
      if (scroll) Object.defineProperty(Element.prototype, 'scrollWidth', scroll);
      if (client) Object.defineProperty(Element.prototype, 'clientWidth', client);
    };
  };

  afterEach(() => {
    delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;
    delete (document.documentElement as unknown as Record<string, unknown>).clientHeight;
  });

  it('caps the root panel at the window width less the gap at both edges', () => {
    sized(200, 300);
    const root = makeRoot();
    createMenu(root).show(150, 50, nested());
    expect(root.style.getPropertyValue('--mc-menu-max')).toBe('192px');
    expect(root.style.maxHeight).toBe('292px');
  });

  it('caps a submenu the same way', () => {
    sized(200, 300);
    const root = makeRoot();
    createMenu(root).show(150, 50, nested());
    hover(root.querySelector('.mc-menu-item--submenu') as Element);
    expect(panels()).toHaveLength(2);
    expect(panels()[1].style.getPropertyValue('--mc-menu-max')).toBe('192px');
  });

  it('follows the window: a wider one gets a wider cap, and a tiny one never a negative', () => {
    const root = makeRoot();
    const menu = createMenu(root);
    sized(900, 600);
    menu.show(10, 10, nested());
    expect(root.style.getPropertyValue('--mc-menu-max')).toBe('892px');
    menu.hide();
    sized(5, 5);
    menu.show(0, 0, nested());
    expect(root.style.getPropertyValue('--mc-menu-max')).toBe('0px');
  });

  it('marks the label of a submenu row and of a checkbox row, apart from arrow and check', () => {
    const root = makeRoot();
    createMenu(root).show(10, 10, [
      {
        kind: 'submenu',
        label: 'Copy as',
        entries: [{ kind: 'item', label: 'CSV', run: () => {} }],
      },
      { kind: 'checkbox', label: 'Wrap code', checked: true, run: () => {} },
    ]);
    const submenu = root.querySelector('.mc-menu-item--submenu') as HTMLElement;
    expect(submenu.querySelector('.mc-menu-label')?.textContent).toBe('Copy as');
    expect(submenu.querySelector('.mc-menu-arrow')).not.toBeNull();
    expect(submenu.querySelector('.mc-menu-arrow')?.classList.contains('mc-menu-label')).toBe(
      false,
    );
    const check = root.querySelector('.mc-menu-item--check') as HTMLElement;
    expect(check.querySelector('.mc-menu-label')?.textContent).toBe('Wrap code');
    expect(check.querySelector('.mc-menu-check')?.classList.contains('mc-menu-label')).toBe(false);
  });

  it('gives a row whose label is cut a tooltip with all of it, and no other row one', () => {
    const restore = widths();
    try {
      const root = makeRoot();
      createMenu(root).show(10, 10, [
        { kind: 'item', label: 'Copy', run: () => {} },
        { kind: 'item', label: 'Search Google for "a long selection"', run: () => {} },
        {
          kind: 'submenu',
          label: 'Copy as something with a long name',
          entries: [{ kind: 'item', label: 'CSV', run: () => {} }],
        },
      ]);
      const rows = Array.from(root.querySelectorAll<HTMLElement>('.mc-menu-item'));
      expect(rows[0].hasAttribute('title')).toBe(false);
      expect(rows[1].title).toBe('Search Google for "a long selection"');
      // The tooltip is the label, without the arrow that shares the row.
      expect(rows[2].title).toBe('Copy as something with a long name');
    } finally {
      restore();
    }
  });

  it('places a panel as wide as the cap inside both edges', () => {
    // A 192px panel in a 200px window, wherever the pointer was.
    for (const x of [0, 4, 100, 150, 199]) {
      const left = fit(x, 192, 200, x);
      expect(left).toBeGreaterThanOrEqual(4);
      expect(left + 192).toBeLessThanOrEqual(196);
    }
  });
});

describe('fit: a flipped panel keeps the gap at the far edge', () => {
  // Opened with the pointer a pixel from the right edge, a panel that flips to
  // the left of it used to end at the pointer, inside the gap the others keep.
  it('ends at the gap, not at a pointer that is inside it', () => {
    expect(fit(199, 150, 200, 199)).toBe(46);
    expect(fit(199, 150, 200, 199) + 150).toBe(196);
  });

  it('still ends at the pointer when the pointer is clear of the gap', () => {
    expect(fit(180, 150, 200, 180)).toBe(30);
  });
});
