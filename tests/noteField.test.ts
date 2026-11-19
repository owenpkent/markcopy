import { describe, expect, it } from 'vitest';
import { createNoteField, oneLine } from '../src/webview/noteField';

describe('oneLine', () => {
  it('turns every kind of line break into one space', () => {
    expect(oneLine('a\nb\r\nc\rd')).toBe('a b c d');
    expect(oneLine('no breaks')).toBe('no breaks');
  });
});

/** A paste event carrying `text`, as jsdom has no ClipboardEvent data. */
function paste(text: string): Event {
  const e = new Event('paste', { cancelable: true });
  Object.defineProperty(e, 'clipboardData', { value: { getData: () => text } });
  return e;
}

describe('createNoteField', () => {
  it('is a one-row textarea that wraps instead of scrolling sideways', () => {
    const field = createNoteField();
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.rows).toBe(1);
    expect(field.className).toBe('mc-rv-field');
    expect(field.maxLength).toBe(10000);
    expect(field.getAttribute('aria-label')).toBe('Note text');
  });

  it('pastes a multi-line text as one line, over the selection', () => {
    const field = createNoteField();
    document.body.append(field);
    field.value = 'draft  end';
    field.setSelectionRange(6, 6);
    const e = paste('line one\r\nline two');
    field.dispatchEvent(e);
    // The browser's own paste is replaced, not patched up after it landed.
    expect(e.defaultPrevented).toBe(true);
    expect(field.value).toBe('draft line one line two end');
    expect(field.selectionStart).toBe(23);
    field.remove();
  });

  it('leaves a one-line paste to the browser', () => {
    const field = createNoteField();
    const e = paste('plain');
    field.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('refuses a typed line break but not typed text', () => {
    const field = createNoteField();
    const brk = new InputEvent('beforeinput', { inputType: 'insertLineBreak', cancelable: true });
    field.dispatchEvent(brk);
    expect(brk.defaultPrevented).toBe(true);
    const typed = new InputEvent('beforeinput', { inputType: 'insertText', cancelable: true });
    field.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(false);
  });
});
