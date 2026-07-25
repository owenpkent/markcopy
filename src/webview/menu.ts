// Shared context-menu engine for both webviews (Markdown preview and PDF
// preview). Both surfaces render into the `#mc-menu` div their host HTML
// provides; nested submenu panels are created on demand and appended to
// <body>, so the top level of each menu stays short while every action remains
// reachable one level down.

// A plain clickable action ('item'), a nested panel ('submenu'), a group
// heading ('label', not interactive), a horizontal rule ('divider'), or a
// radio/checkbox setting toggle that renders a leading checkmark when active.
export type MenuEntry =
  | { kind: 'item'; label: string; run: () => void | Promise<void> }
  | { kind: 'submenu'; label: string; entries: MenuEntry[] }
  | { kind: 'label'; label: string }
  | { kind: 'divider' }
  | { kind: 'radio' | 'checkbox'; label: string; checked: boolean; run: () => void };

export interface MenuController {
  /** Open the menu with `entries` at a document-relative position. */
  show(pageX: number, pageY: number, entries: MenuEntry[]): void;
  /** Close the menu and every open submenu. */
  hide(): void;
}

export function createMenu(root: HTMLDivElement): MenuController {
  // Every panel currently on screen, shallowest first. panels[0] is `root`
  // while the menu is open, and the array is empty while it is closed, so a
  // panel's depth is its index.
  const panels: HTMLDivElement[] = [];
  // The submenu row a panel was opened from, so closing can un-expand it.
  const anchorOf = new WeakMap<HTMLDivElement, HTMLElement>();

  // Tear down every panel from `depth` down. closeFrom(0) closes the whole menu.
  function closeFrom(depth: number): void {
    while (panels.length > depth) {
      const panel = panels.pop() as HTMLDivElement;
      anchorOf.get(panel)?.setAttribute('aria-expanded', 'false');
      if (panel === root) {
        root.hidden = true;
        root.innerHTML = '';
      } else {
        panel.remove();
      }
    }
  }

  function rows(panel: HTMLDivElement | undefined): HTMLElement[] {
    return panel ? Array.from(panel.querySelectorAll<HTMLElement>('.mc-menu-item')) : [];
  }

  function focusFirst(panel: HTMLDivElement | undefined): void {
    rows(panel)[0]?.focus();
  }

  function moveFocus(panel: HTMLDivElement, current: HTMLElement, delta: number): void {
    const list = rows(panel);
    if (list.length === 0) return;
    const next = (list.indexOf(current) + delta + list.length) % list.length;
    list[next].focus();
  }

  function openSubmenu(anchor: HTMLElement, entries: MenuEntry[], depth: number): void {
    const parent = panels[depth - 1];
    if (!parent) return;
    const panel = document.createElement('div');
    panel.className = 'mc-menu mc-menu--sub';
    panel.setAttribute('role', 'menu');
    document.body.appendChild(panel);
    panels.push(panel);
    anchorOf.set(panel, anchor);
    anchor.setAttribute('aria-expanded', 'true');
    render(panel, entries, depth);

    // Sit just inside the parent's right edge (so the diagonal mouse path from
    // the row to the panel doesn't leave the menu), flipping to the left and
    // riding up from the bottom edge when the viewport runs out.
    const row = anchor.getBoundingClientRect();
    const box = parent.getBoundingClientRect();
    let left = box.right - 4;
    if (left + panel.offsetWidth > window.innerWidth) {
      left = Math.max(0, box.left - panel.offsetWidth + 4);
    }
    let top = row.top - 4;
    if (top + panel.offsetHeight > window.innerHeight) {
      top = Math.max(0, window.innerHeight - panel.offsetHeight);
    }
    panel.style.left = `${left + window.scrollX}px`;
    panel.style.top = `${top + window.scrollY}px`;
  }

  function rowFor(entry: MenuEntry, depth: number): HTMLElement {
    if (entry.kind === 'divider') {
      const el = document.createElement('div');
      el.className = 'mc-menu-divider';
      el.setAttribute('role', 'separator');
      return el;
    }
    if (entry.kind === 'label') {
      const el = document.createElement('div');
      el.className = 'mc-menu-group-label';
      el.textContent = entry.label;
      return el;
    }

    const el = document.createElement('div');
    el.tabIndex = 0;
    if (entry.kind === 'radio' || entry.kind === 'checkbox') {
      el.className = 'mc-menu-item mc-menu-item--check';
      el.setAttribute('role', entry.kind === 'radio' ? 'menuitemradio' : 'menuitemcheckbox');
      el.setAttribute('aria-checked', String(entry.checked));
      const check = document.createElement('span');
      check.className = 'mc-menu-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = entry.checked ? '✓' : '';
      const text = document.createElement('span');
      text.textContent = entry.label;
      el.append(check, text);
    } else if (entry.kind === 'submenu') {
      el.className = 'mc-menu-item mc-menu-item--submenu';
      el.setAttribute('role', 'menuitem');
      el.setAttribute('aria-haspopup', 'true');
      el.setAttribute('aria-expanded', 'false');
      const text = document.createElement('span');
      text.textContent = entry.label;
      const arrow = document.createElement('span');
      arrow.className = 'mc-menu-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '▸';
      el.append(text, arrow);
    } else {
      el.className = 'mc-menu-item';
      el.setAttribute('role', 'menuitem');
      el.textContent = entry.label;
    }

    // Hovering any row dismisses whatever the previously hovered row had open,
    // then opens this row's own panel. Keyboard focus only closes: submenus are
    // opened deliberately with ArrowRight or Enter, so arrowing past a submenu
    // row doesn't spray panels across the screen.
    el.addEventListener('mouseenter', () => {
      closeFrom(depth + 1);
      if (entry.kind === 'submenu') openSubmenu(el, entry.entries, depth + 1);
    });
    el.addEventListener('focus', () => closeFrom(depth + 1));

    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (entry.kind === 'submenu') {
        closeFrom(depth + 1);
        openSubmenu(el, entry.entries, depth + 1);
        focusFirst(panels[depth + 1]);
        return;
      }
      closeFrom(0);
      void entry.run();
    });

    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        el.click();
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        ev.stopPropagation();
        moveFocus(panels[depth], el, ev.key === 'ArrowDown' ? 1 : -1);
      } else if (ev.key === 'ArrowRight' && entry.kind === 'submenu') {
        ev.preventDefault();
        ev.stopPropagation();
        el.click();
      } else if (ev.key === 'ArrowLeft' || ev.key === 'Escape') {
        // Step back out of a submenu; at the top level, Escape falls through to
        // the document handler that closes the menu.
        if (depth === 0 && ev.key === 'Escape') return;
        ev.preventDefault();
        ev.stopPropagation();
        if (depth === 0) return;
        const parentRow = anchorOf.get(panels[depth]);
        closeFrom(depth);
        parentRow?.focus();
      }
    });
    return el;
  }

  function render(panel: HTMLDivElement, entries: MenuEntry[], depth: number): void {
    panel.innerHTML = '';
    for (const entry of entries) {
      panel.appendChild(rowFor(entry, depth));
    }
  }

  return {
    show(pageX, pageY, entries) {
      closeFrom(0);
      panels.push(root);
      render(root, entries, 0);
      root.style.left = `${pageX}px`;
      root.style.top = `${pageY}px`;
      root.hidden = false;
      // Keep the menu inside the viewport.
      const rect = root.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        root.style.left = `${Math.max(0, pageX - rect.width)}px`;
      }
      if (rect.bottom > window.innerHeight) {
        root.style.top = `${Math.max(0, pageY - rect.height)}px`;
      }
    },
    hide() {
      closeFrom(0);
    },
  };
}
