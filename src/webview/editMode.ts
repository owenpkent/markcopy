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
}

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
    original: string;
    initial: string;
    trailing: number;
    done: boolean;
  }
  let session: Session | undefined;

  function closeEditor(commit: boolean): void {
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
    if (commit && text !== s.initial) {
      const replacement = text + '\n'.repeat(s.trailing);
      opts.post({
        type: 'editBlock',
        startLine: s.startLine,
        endLine: s.endLine,
        original: s.original,
        text: replacement,
      });
      shiftAfterEdit(s.startLine, s.endLine, replacement.split('\n'));
    }
    opts.onClosed();
  }

  // Mirror the edit locally until the host's re-render arrives, so a block
  // opened in the meantime (clicking the next paragraph commits this one first)
  // names the lines it will have once the edit lands. If the host refuses the
  // edit it re-renders, which resets both.
  function shiftAfterEdit(startLine: number, endLine: number, newLines: string[]): void {
    const delta = newLines.length - (endLine - startLine);
    opts.getSourceLines().splice(startLine, endLine - startLine, ...newLines);
    if (delta === 0) return;
    for (const el of content.querySelectorAll<HTMLElement>('[data-source-line][data-source-end]')) {
      const line = Number(el.dataset.sourceLine);
      if (line >= endLine) {
        el.dataset.sourceLine = String(line + delta);
        el.dataset.sourceEnd = String(Number(el.dataset.sourceEnd) + delta);
      }
    }
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
        closeEditor(false);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        closeEditor(true);
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
      const block = target.closest<HTMLElement>('[data-source-line][data-source-end]');
      if (!block || block.parentElement !== content) return;
      e.stopPropagation();
      openEditor(block);
    },
    true,
  );

  refresh();
  return {
    setKind(kind: string): void {
      const ok = kind === 'markdown';
      if (!ok) closeEditor(false);
      kindOk = ok;
      refresh();
    },
    isEditing: () => session !== undefined,
    close: closeEditor,
  };
}
