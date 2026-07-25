import { describe, it, expect, beforeEach } from 'vitest';
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

describe('createMenu', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = makeRoot();
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

  it('opens a submenu on hover and closes it when a sibling is hovered', () => {
    const menu = createMenu(root);
    menu.show(0, 0, [
      { kind: 'item', label: 'Copy Table', run: () => {} },
      {
        kind: 'submenu',
        label: 'Copy as',
        entries: [
          { kind: 'item', label: 'CSV', run: () => {} },
          { kind: 'item', label: 'PNG', run: () => {} },
        ],
      },
    ]);

    const [primary, submenuRow] = Array.from(root.querySelectorAll('.mc-menu-item'));
    expect(panels()).toHaveLength(1);
    expect(submenuRow.getAttribute('aria-expanded')).toBe('false');

    hover(submenuRow);
    expect(panels()).toHaveLength(2);
    expect(labels(panels()[1])).toEqual(['CSV', 'PNG']);
    expect(submenuRow.getAttribute('aria-expanded')).toBe('true');

    // Moving to a different row on the parent panel dismisses the submenu.
    hover(primary);
    expect(panels()).toHaveLength(1);
    expect(submenuRow.getAttribute('aria-expanded')).toBe('false');
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
});
