// The parts tree beside the 3D view (stl.ts owns the scene; this owns the rows).
//
// The panel keeps two things: which parts are shown (one flag per leaf, in the
// row order buildPartModel gives) and which row is selected. It tells stl.ts
// when either changes, and stl.ts turns them into geometry groups. Names reach
// the page only through textContent. Every control is a visible button or
// checkbox with a 44 px hit area; double-click and the arrow keys are shortcuts
// for what the buttons already do.
import type { PartItem, PartModel } from './parts';

export interface PartsPanelElements {
  /** The scrolling list the rows go in. */
  list: HTMLElement;
  /** Shows "N parts". */
  count: HTMLElement;
  /** The "Show all" button. */
  showAll: HTMLButtonElement;
}

export interface PartsPanelHooks {
  /** Visibility or selection changed: redraw. */
  onChange(): void;
  /** Isolate was chosen for `item`; the visibility is already set. */
  onIsolate(item: PartItem): void;
}

export interface PartsPanel {
  setModel(model: PartModel | null): void;
  model(): PartModel | null;
  /** Whether leaf `leaf` is shown. */
  isVisible(leaf: number): boolean;
  /** True when every part is shown. */
  allVisible(): boolean;
  /** The selected row's leaves, as `[from, to)`, or null. */
  selection(): [number, number] | null;
  showAll(): void;
  isolate(id: number): void;
  /** Select the row of a part picked in the 3D view: opens its ancestors and scrolls to it. */
  selectLeaf(leaf: number): void;
  clearSelection(): void;
}

export function createPartsPanel(els: PartsPanelElements, hooks: PartsPanelHooks): PartsPanel {
  const { list } = els;
  let model: PartModel | null = null;
  let visible = new Uint8Array(0);
  // Shown leaves before leaf i, so a row's state is two lookups.
  let prefix = new Int32Array(1);
  let expanded = new Set<number>();
  let selected = -1;
  let rows = new Map<number, HTMLElement>();

  const shownIn = (item: PartItem): number => prefix[item.leafTo] - prefix[item.leafFrom];

  function recount(): void {
    prefix = new Int32Array(visible.length + 1);
    for (let i = 0; i < visible.length; i++) {
      prefix[i + 1] = prefix[i] + visible[i];
    }
  }

  function setRange(from: number, to: number, value: 0 | 1): void {
    visible.fill(value, from, to);
    recount();
  }

  function refreshRows(): void {
    els.showAll.disabled = model === null || prefix[visible.length] === visible.length;
    if (model) {
      const shown = prefix[visible.length];
      els.count.textContent =
        shown === visible.length
          ? `${visible.length.toLocaleString()} parts`
          : `${shown.toLocaleString()} of ${visible.length.toLocaleString()} shown`;
    } else {
      els.count.textContent = '';
    }
    for (const [id, row] of rows) {
      const item = model?.byId[id];
      if (!item) {
        continue;
      }
      const shown = shownIn(item);
      const total = item.leafTo - item.leafFrom;
      const check = row.querySelector<HTMLInputElement>('input.mc-part-check');
      if (check) {
        check.checked = shown === total;
        check.indeterminate = shown > 0 && shown < total;
      }
      row.classList.toggle('mc-part-off', shown === 0);
      const isSelected = id === selected;
      row.classList.toggle('mc-part-selected', isSelected);
      row.setAttribute('aria-selected', String(isSelected));
    }
  }

  function render(): void {
    list.textContent = '';
    rows = new Map();
    if (!model) {
      return;
    }
    const fragment = document.createDocumentFragment();
    const walk = (items: PartItem[]): void => {
      for (const item of items) {
        const row = makeRow(item);
        rows.set(item.id, row);
        fragment.append(row);
        if (item.children.length > 0 && expanded.has(item.id)) {
          walk(item.children);
        }
      }
    };
    walk(model.items);
    list.append(fragment);
    refreshRows();
  }

  function makeRow(item: PartItem): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mc-part-row';
    row.dataset.id = String(item.id);
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(item.depth + 1));
    row.tabIndex = 0;
    row.style.setProperty('--mc-depth', String(item.depth));

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mc-part-toggle';
    if (item.children.length > 0) {
      const open = expanded.has(item.id);
      toggle.textContent = open ? '▾' : '▸';
      toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${item.name}`);
      row.setAttribute('aria-expanded', String(open));
    } else {
      toggle.disabled = true;
      toggle.classList.add('mc-part-leaf');
      toggle.setAttribute('aria-hidden', 'true');
    }

    const box = document.createElement('label');
    box.className = 'mc-part-showbox';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'mc-part-check';
    check.setAttribute('aria-label', `Show ${item.name}`);
    box.append(check);

    const name = document.createElement('span');
    name.className = 'mc-part-name';
    name.textContent = item.name;
    name.title = item.name;

    const qty = document.createElement('span');
    qty.className = 'mc-part-qty';
    qty.textContent = item.kind === 'group' ? `x${item.qty}` : '';

    const tris = document.createElement('span');
    tris.className = 'mc-part-tris';
    tris.textContent = item.triangles.toLocaleString();
    tris.title = 'Triangles';

    const isolate = document.createElement('button');
    isolate.type = 'button';
    isolate.className = 'mc-part-isolate';
    isolate.textContent = 'Isolate';
    isolate.setAttribute('aria-label', `Isolate ${item.name}`);

    row.append(toggle, box, name, qty, tris, isolate);
    return row;
  }

  function toggleExpanded(item: PartItem): void {
    if (item.children.length === 0) {
      return;
    }
    if (!expanded.delete(item.id)) {
      expanded.add(item.id);
    }
    render();
  }

  function select(item: PartItem | null): void {
    selected = item ? item.id : -1;
    refreshRows();
    hooks.onChange();
  }

  function itemOf(target: EventTarget | null): PartItem | null {
    const row = (target as HTMLElement | null)?.closest?.<HTMLElement>('.mc-part-row');
    return row && model ? (model.byId[Number(row.dataset.id)] ?? null) : null;
  }

  list.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const item = itemOf(target);
    if (!item) {
      return;
    }
    if (target.closest('.mc-part-showbox')) {
      // The checkbox's own change event does the work.
      return;
    }
    if (target.closest('.mc-part-toggle')) {
      toggleExpanded(item);
    } else if (target.closest('.mc-part-isolate')) {
      isolate(item.id);
    } else {
      select(item.id === selected ? null : item);
    }
  });

  list.addEventListener('change', (event) => {
    const target = event.target as HTMLElement;
    const item = itemOf(target);
    if (!item || !target.classList.contains('mc-part-check')) {
      return;
    }
    // A shown row hides everything under it; a hidden or mixed one shows it all.
    const allShown = shownIn(item) === item.leafTo - item.leafFrom;
    setRange(item.leafFrom, item.leafTo, allShown ? 0 : 1);
    refreshRows();
    hooks.onChange();
  });

  // Shortcuts only: a double-click opens or closes a row, the arrows move
  // between rows, and Enter or Space selects.
  list.addEventListener('dblclick', (event) => {
    const target = event.target as HTMLElement;
    const item = itemOf(target);
    if (item && !target.closest('button, label')) {
      toggleExpanded(item);
    }
  });
  list.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains('mc-part-row')) {
      return;
    }
    const item = itemOf(target);
    if (!item) {
      return;
    }
    const sibling = (step: 1 | -1) =>
      (step === 1
        ? target.nextElementSibling
        : target.previousElementSibling) as HTMLElement | null;
    switch (event.key) {
      case 'ArrowDown':
        sibling(1)?.focus();
        break;
      case 'ArrowUp':
        sibling(-1)?.focus();
        break;
      case 'ArrowRight':
        if (item.children.length > 0 && !expanded.has(item.id)) {
          toggleExpanded(item);
          rows.get(item.id)?.focus();
        }
        break;
      case 'ArrowLeft':
        if (expanded.has(item.id)) {
          toggleExpanded(item);
          rows.get(item.id)?.focus();
        }
        break;
      case 'Enter':
      case ' ':
        select(item.id === selected ? null : item);
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  els.showAll.addEventListener('click', () => showAll());

  function showAll(): void {
    if (!model) {
      return;
    }
    setRange(0, visible.length, 1);
    refreshRows();
    hooks.onChange();
  }

  function isolate(id: number): void {
    const item = model?.byId[id];
    if (!model || !item) {
      return;
    }
    setRange(0, visible.length, 0);
    setRange(item.leafFrom, item.leafTo, 1);
    refreshRows();
    hooks.onChange();
    hooks.onIsolate(item);
  }

  return {
    setModel(next) {
      model = next;
      visible = new Uint8Array(next ? next.leaves.length : 0).fill(1);
      recount();
      selected = -1;
      // Open the top level of a small tree; a big one starts closed.
      expanded = new Set();
      if (next && next.byId.length <= 200) {
        for (const item of next.byId) {
          if (item.children.length > 0 && item.depth < 2) {
            expanded.add(item.id);
          }
        }
      }
      render();
    },
    model: () => model,
    isVisible: (leaf) => visible[leaf] === 1,
    allVisible: () => prefix[visible.length] === visible.length,
    selection() {
      const item = selected >= 0 ? model?.byId[selected] : undefined;
      return item ? [item.leafFrom, item.leafTo] : null;
    },
    showAll,
    isolate,
    selectLeaf(leaf) {
      const found = model?.byId.find((item) => item.leaf === leaf);
      if (!model || !found) {
        return;
      }
      for (let up = found.parent; up; up = up.parent) {
        expanded.add(up.id);
      }
      selected = found.id;
      render();
      rows.get(found.id)?.scrollIntoView?.({ block: 'nearest' });
      hooks.onChange();
    },
    clearSelection() {
      if (selected >= 0) {
        select(null);
      }
    },
  };
}
