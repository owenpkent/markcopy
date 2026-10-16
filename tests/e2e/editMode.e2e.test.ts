// Edit mode in the Markdown preview, driven through the real webview bundle.
//
// The host is simulated: each captured `editBlock` goes through the real
// planBlockEdit against a document text, and the answering `render` (carrying
// `ackEdit`) is delivered by the test, so a test controls exactly when the
// answer arrives relative to the next click.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { boot, type Harness, type Posted } from '../webview/harness';
import { createMarkdownIt } from '../../src/render';
import { planBlockEdit } from '../../src/blockEdit';

let h: Harness;
let docText = '';
let docKey = '';
let counter = 0;

beforeAll(async () => {
  h = await boot();
});

beforeEach(() => {
  h.reset();
});

afterEach(() => {
  // Leave no editor open for the next test's render to be buffered behind.
  const area = document.querySelector<HTMLTextAreaElement>('.mc-be-input');
  if (area) key(area, 'Escape');
  vi.useRealTimers();
});

async function start(source: string): Promise<void> {
  docText = source;
  docKey = `file:///edit-${counter++}`;
  await show();
  const editBtn = document.querySelector<HTMLElement>('[data-mc-mode="edit"]');
  editBtn?.click();
}

function show(ackEdit?: number): Promise<void> {
  return h.render({
    html: createMarkdownIt().render(docText),
    source: docText,
    kind: 'markdown',
    docKey,
    ackEdit,
  });
}

function block(line: number): HTMLElement {
  return h.find(`#content > [data-source-line="${line}"]`);
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function key(el: Element, k: string, init: KeyboardEventInit = {}): void {
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  );
}

function editor(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('.mc-be-input');
}

function commit(text: string): void {
  const area = editor();
  if (!area) throw new Error('no editor is open');
  area.value = text;
  key(area, 'Enter', { ctrlKey: true });
}

function lastEdit(): Posted {
  const edits = h.posted.filter((m) => m.type === 'editBlock');
  return edits[edits.length - 1];
}

/** What the host does with a captured edit: plan it against the document. */
function hostApply(msg: Posted): string {
  const plan = planBlockEdit(docText, '\n', msg as never);
  if (plan.ok) {
    docText = docText.slice(0, plan.start) + plan.text + docText.slice(plan.end);
    return 'ok';
  }
  return plan.reason;
}

describe('a click while a commit is unanswered', () => {
  it('opens the block it meant after a shrinking edit, never a later one', async () => {
    await start('alpha\nbeta\ngamma\n\ntail\n\nend');
    click(block(0));
    commit('short');
    expect(hostApply(lastEdit())).toBe('ok');

    click(block(0));
    expect(editor()).toBeNull();

    await show(lastEdit().editId as number);
    expect(editor()?.value).toBe('short');
  });

  it('maps a block after the edit through a shrinking replacement', async () => {
    await start('alpha\nbeta\ngamma\n\ntail\n\nend');
    click(block(0));
    commit('short');
    hostApply(lastEdit());
    click(block(4));
    expect(editor()).toBeNull();
    await show(lastEdit().editId as number);
    expect(editor()?.value).toBe('tail');
  });

  it('maps through a longer replacement', async () => {
    await start('alpha\nbeta\ngamma\n\ntail\n\nend');
    click(block(0));
    commit('1\n2\n3\n4\n5\n6');
    expect(hostApply(lastEdit())).toBe('ok');
    click(block(4));
    expect(editor()).toBeNull();
    await show(lastEdit().editId as number);
    expect(editor()?.value).toBe('tail');
  });

  it('survives the reviewer sequence across two edits', async () => {
    await start('a\n\nb\n\nc\n\nd');
    click(block(0));
    commit('a\nmore');
    expect(hostApply(lastEdit())).toBe('ok');

    click(block(2));
    expect(editor()).toBeNull();
    await show(lastEdit().editId as number);
    expect(editor()?.value).toBe('b');

    commit('b\nextra');
    expect(hostApply(lastEdit())).toBe('ok');
    click(block(5));
    expect(editor()).toBeNull();
    await show(lastEdit().editId as number);
    expect(editor()?.value).toBe('c');

    commit('C');
    expect(hostApply(lastEdit())).toBe('ok');
    expect(docText).toBe('a\nmore\n\nb\nextra\n\nC\n\nd');
  });

  it('opens editors again after the 3s timeout if the host never answers', async () => {
    await start('a\n\nb');
    vi.useFakeTimers();
    click(block(0));
    commit('A');
    click(block(2));
    expect(editor()).toBeNull();
    vi.advanceTimersByTime(3000);
    click(block(2));
    expect(editor()?.value).toBe('b');
  });
});

describe('keyboard access', () => {
  it('opens with Enter, cancels with Escape, commits with Ctrl+Enter, and cleans up', async () => {
    await start('one\n\ntwo');
    const first = block(0);
    expect(first.tabIndex).toBe(0);
    expect(first.dataset.mcEditTab).toBe('1');

    first.focus();
    key(first, 'Enter');
    expect(editor()).not.toBeNull();
    expect(document.activeElement).toBe(editor());

    key(editor() as HTMLElement, 'Escape');
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(block(0));

    key(block(2), 'F2');
    expect(editor()?.value).toBe('two');
    key(editor() as HTMLElement, 'Escape');

    key(block(0), 'F2');
    commit('uno');
    expect(lastEdit().startLine).toBe(0);
    expect(hostApply(lastEdit())).toBe('ok');
    await show(lastEdit().editId as number);
    expect(document.activeElement).toBe(block(0));

    document.querySelector<HTMLElement>('[data-mc-mode="read"]')?.click();
    expect(block(0).hasAttribute('tabindex')).toBe(false);
    expect(block(0).dataset.mcEditTab).toBeUndefined();
  });
});
