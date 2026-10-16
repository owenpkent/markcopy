// In-preview edit mode for Markdown: a read/edit toggle pill, and a per-block
// editor that edits the raw Markdown of one top-level block in place.
//
// The webview never writes the document. A commit posts `editBlock` and the host
// validates it and applies a WorkspaceEdit; the re-render that follows replaces
// the block. See docs/ARCHITECTURE.md.
import { highlightMarkdown } from './mdHighlight';

export type EditModeName = 'read' | 'edit';

export interface EditModeOptions {
  /** The element holding the rendered Markdown. */
  content: HTMLElement;
  /** The source lines of the render currently on screen. */
  getSourceLines: () => string[];
  /** The document key of the render currently on screen. */
  getDocKey: () => string;
  /** Send a message to the host. */
  post: (msg: unknown) => void;
  /** Read the remembered mode. */
  loadMode: () => EditModeName;
  /** Remember the mode. */
  saveMode: (mode: EditModeName) => void;
  /** Called after an open editor has closed, so a buffered render can be applied. */
  onClosed: () => void;
}

export interface EditMode {
  /** Show the pill for Markdown, hide it and leave edit mode for any other kind. */
  setKind(kind: string): void;
  /** True while a block editor is open (renders must wait). */
  isEditing(): boolean;
  /** Commit (or drop) an open editor, if any. */
  close(commit: boolean): void;
  /**
   * Called once a render has replaced the content. `ackEdit` is the id of the
   * block edit the host answered with this render, if any.
   */
  afterRender(ackEdit: number | undefined, docChanged: boolean): void;
}

const EDITABLE = '[data-source-line][data-source-end]';

// How long to wait for the host's answer to a commit before giving up on it.
// The host always answers, so this only matters if its document has gone away.
const ACK_TIMEOUT_MS = 3000;

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(paths: string[]): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

const LOCK_ICON = ['M4 7h8v6H4z', 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2'];
const PENCIL_ICON = ['M2.5 13.5l.7-3L10.8 3a1.4 1.4 0 0 1 2 2L5.2 12.6z', 'M9.5 4.3l2.2 2.2'];

/** Rows of text with trailing blank lines peeled off, remembering how many. */
export function splitTrailingBlank(lines: string[]): { body: string; trailing: number } {
  let end = lines.length;
  while (end > 1 && lines[end - 1].trim() === '') {
    end--;
  }
  return { body: lines.slice(0, end).join('\n'), trailing: lines.length - end };
}

export function createEditMode(opts: EditModeOptions): EditMode {
  const { content } = opts;
  let mode: EditModeName = opts.loadMode();
  let kindOk = false;

  const pill = document.createElement('div');
  pill.className = 'mc-modepill';
  pill.hidden = true;
  pill.setAttribute('role', 'group');
  pill.setAttribute('aria-label', 'Preview mode');

  function button(label: string, paths: string[], target: EditModeName): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.dataset.mcMode = target;
    b.appendChild(icon(paths));
    b.addEventListener('click', () => setMode(target));
    return b;
  }
  const readBtn = button('Read mode', LOCK_ICON, 'read');
  const editBtn = button('Edit mode', PENCIL_ICON, 'edit');
  pill.append(readBtn, editBtn);
  document.body.appendChild(pill);

  function effectiveMode(): EditModeName {
    return kindOk ? mode : 'read';
  }

  function refresh(): void {
    const active = effectiveMode();
    readBtn.setAttribute('aria-pressed', String(active === 'read'));
    editBtn.setAttribute('aria-pressed', String(active === 'edit'));
    document.body.classList.toggle('mc-editing-enabled', active === 'edit');
    pill.hidden = !kindOk;
    decorate();
  }

  // In edit mode every editable block is a tab stop, opened with Enter or F2.
  // Only tab stops added here are removed again; a block that brought its own
  // tabindex keeps it.
  function decorate(): void {
    const on = effectiveMode() === 'edit';
    for (const el of Array.from(content.children) as HTMLElement[]) {
      if (!el.matches(EDITABLE)) continue;
      if (on && !el.hasAttribute('tabindex')) {
        el.tabIndex = 0;
        el.dataset.mcEditTab = '1';
      } else if (!on && el.dataset.mcEditTab) {
        el.removeAttribute('tabindex');
        delete el.dataset.mcEditTab;
      }
    }
  }

  function blockAt(line: number): HTMLElement | undefined {
    return (Array.from(content.children) as HTMLElement[]).find(
      (el) => el.matches(EDITABLE) && Number(el.dataset.sourceLine) === line,
    );
  }

  function setMode(next: EditModeName): void {
    if (next === mode) return;
    if (next === 'read') {
      closeEditor(true);
    }
    mode = next;
    opts.saveMode(mode);
    refresh();
  }

  // -------------------------------------------------------------------------
  // The block editor
  // -------------------------------------------------------------------------
  interface Session {
    block: HTMLElement;
    box: HTMLElement;
    area: HTMLTextAreaElement;
    startLine: number;
    endLine: number;
    docKey: string;
    original: string;
    initial: string;
    trailing: number;
    done: boolean;
  }
  let session: Session | undefined;

  // A commit the host has not answered yet. Until its render arrives, the line
  // numbers on screen predate the edit, so no other editor may open: a block
  // asked for meanwhile is remembered by the line it will start on once the
  // edit lands (`queuedLine`) and opened then.
  interface Pending {
    id: number;
    endLine: number;
    delta: number;
    timer: number;
  }
  let pending: Pending | undefined;
  let nextEditId = 1;
  let queuedLine: number | undefined;
  // The block to focus once the answering render arrives (keyboard commits).
  let focusLine: number | undefined;

  function settle(): void {
    if (pending) window.clearTimeout(pending.timer);
    pending = undefined;
  }

  function forgetPending(): void {
    settle();
    queuedLine = undefined;
    focusLine = undefined;
  }

  function closeEditor(commit: boolean, refocus = false): void {
    const s = session;
    if (!s || s.done) return;
    s.done = true;
    session = undefined;
    const text = s.area.value.replace(/\r\n?/g, '\n');
    // The rendered block comes back first, so a commit leaves the old text in
    // place for the moment until the host's re-render replaces it.
    if (s.box.isConnected) {
      s.box.replaceWith(s.block);
    }
    const committed = commit && text !== s.initial;
    if (committed) {
      const replacement = text + '\n'.repeat(s.trailing);
      const id = nextEditId++;
      opts.post({
        type: 'editBlock',
        editId: id,
        docKey: s.docKey,
        startLine: s.startLine,
        endLine: s.endLine,
        original: s.original,
        text: replacement,
      });
      settle();
      const timer = window.setTimeout(() => {
        if (pending?.id === id) forgetPending();
      }, ACK_TIMEOUT_MS);
      pending = {
        id,
        endLine: s.endLine,
        delta: replacement.split('\n').length - (s.endLine - s.startLine),
        timer,
      };
      queuedLine = undefined;
      focusLine = refocus ? s.startLine : undefined;
    }
    // May apply a buffered render, which replaces the block just restored.
    opts.onClosed();
    if (refocus && !committed) {
      (s.block.isConnected ? s.block : blockAt(s.startLine))?.focus();
    }
  }

  function requestOpen(block: HTMLElement): void {
    if (pending) {
      const line = Number(block.dataset.sourceLine);
      queuedLine = line >= pending.endLine ? line + pending.delta : line;
      focusLine = undefined;
      return;
    }
    openEditor(block);
  }

  function openEditor(block: HTMLElement): void {
    const startLine = Number(block.dataset.sourceLine);
    const endLine = Number(block.dataset.sourceEnd);
    const lines = opts.getSourceLines();
    if (
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      startLine < 0 ||
      endLine <= startLine ||
      endLine > lines.length
    ) {
      return;
    }
    const slice = lines.slice(startLine, endLine);
    const { body, trailing } = splitTrailingBlank(slice);

    const box = document.createElement('div');
    box.className = 'mc-block-editor';
    const backdrop = document.createElement('div');
    backdrop.className = 'mc-be-layer mc-be-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    const area = document.createElement('textarea');
    area.className = 'mc-be-layer mc-be-input';
    area.spellcheck = false;
    area.setAttribute('aria-label', 'Edit Markdown block');
    area.value = body;
    // Only escaped, highlighter-built markup goes in; see mdHighlight.ts.
    const paint = (): void => {
      backdrop.innerHTML = highlightMarkdown(area.value);
    };
    paint();
    area.addEventListener('input', paint);
    box.append(backdrop, area);

    const s: Session = {
      block,
      box,
      area,
      startLine,
      endLine,
      docKey: opts.getDocKey(),
      original: slice.join('\n'),
      initial: body,
      trailing,
      done: false,
    };
    session = s;

    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeEditor(false, true);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        closeEditor(true, true);
      }
    });
    area.addEventListener('blur', () => {
      if (session === s) closeEditor(true);
    });

    block.replaceWith(box);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  // Capture phase on #content, ahead of the document-level link handler and the
  // menu-hiding listener, so a link click in edit mode neither navigates nor
  // opens an editor.
  content.addEventListener(
    'click',
    (e) => {
      if (effectiveMode() !== 'edit' || e.button !== 0) return;
      const target = e.target as Element | null;
      if (!target || (session && session.box.contains(target))) return;
      if (target.closest('a')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // A drag-selection ends in a click; leave it alone.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      // A click elsewhere has already blurred (and so committed) an open editor.
      if (session) closeEditor(true);
      if (!target.isConnected) return;
      const block = target.closest<HTMLElement>(EDITABLE);
      if (!block || block.parentElement !== content) return;
      e.stopPropagation();
      requestOpen(block);
    },
    true,
  );

  // Enter or F2 on a focused block opens it, the keyboard route into editing.
  content.addEventListener('keydown', (e) => {
    if (effectiveMode() !== 'edit' || session) return;
    if (e.key !== 'Enter' && e.key !== 'F2') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const target = e.target as HTMLElement | null;
    if (!target || target.parentElement !== content || !target.matches(EDITABLE)) return;
    e.preventDefault();
    requestOpen(target);
  });

  refresh();
  return {
    setKind(kind: string): void {
      const ok = kind === 'markdown';
      if (!ok) closeEditor(false);
      kindOk = ok;
      refresh();
    },
    isEditing: () => session !== undefined,
    close: (commit: boolean) => closeEditor(commit),
    afterRender(ackEdit: number | undefined, docChanged: boolean): void {
      decorate();
      if (docChanged) {
        forgetPending();
        return;
      }
      if (!pending || ackEdit === undefined || ackEdit < pending.id) return;
      settle();
      const open = queuedLine;
      const focus = focusLine;
      queuedLine = undefined;
      focusLine = undefined;
      if (open !== undefined) {
        const block = blockAt(open);
        if (block && effectiveMode() === 'edit') openEditor(block);
      } else if (focus !== undefined) {
        blockAt(focus)?.focus();
      }
    },
  };
}
