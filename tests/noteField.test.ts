import { describe, expect, it } from 'vitest';
import { createNoteField, oneLine } from '../src/webview/noteField';

describe('oneLine', () => {
  it('turns every kind of line break into one space', () => {
    expect(oneLine('a\nb\r\nc\rd')).toBe('a b c d');
    expect(oneLine('no breaks')).toBe('no breaks');
  });
});

describe('createNoteField', () => {
  it('is a one-row textarea that wraps instead of scrolling sideways', () => {
    const field = createNoteField();
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.rows).toBe(1);
    expect(field.className).toBe('mc-rv-field');
    expect(field.maxLength).toBe(10000);
    expect(field.getAttribute('aria-label')).toBe('Note text');
  });

  it('keeps a note on one line when a break is pasted in', () => {
    const field = createNoteField();
    document.body.append(field);
    field.value = 'first line\nsecond line';
    field.setSelectionRange(11, 11);
    field.dispatchEvent(new Event('input'));
    expect(field.value).toBe('first line second line');
    expect(field.selectionStart).toBe(11);
    field.remove();
  });
});
