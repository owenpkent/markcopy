import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMenu, type MenuEntry } from '../src/webview/menu';

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

    // At the top level it falls through, so the host can close the menu.
    press(anchor, 'Escape');
    expect(reachedHost).toBe(1);

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
});
