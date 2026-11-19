// The note text field shared by Video Notes (src/webview/videoReview.ts, also
// Audio Notes in clock mode) and Image Notes (src/webview/imageReview.ts).
//
// A textarea that wraps and grows with the note, up to a few lines and then
// scrolls, so a long note stays readable while it is typed. It was a one-line
// <input>, which scrolled the start of a long note out of sight. A note is still
// one line, as the sidecar has always stored it: Enter sends (the callers' own
// keydown), a line break pasted in becomes a space, and the callers send
// `oneLine` of the text, so a break that slips in some other way is not kept.
//
// The paste is rewritten before it lands, through an insertion the browser
// records, never by assigning `value` afterwards: that would leave Undo and Redo
// replaying an edit the field no longer holds.

/** Build the note field. */
export function createNoteField(): HTMLTextAreaElement {
  const field = document.createElement('textarea');
  field.className = 'mc-rv-field';
  field.rows = 1;
  field.maxLength = 10000;
  field.placeholder = 'Write a note';
  field.setAttribute('aria-label', 'Note text');
  field.spellcheck = true;
  field.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (/[\r\n]/.test(text)) {
      e.preventDefault();
      insertText(field, oneLine(text));
    }
  });
  // Shift+Enter and the like: a note has no second line.
  field.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      e.preventDefault();
    }
  });
  field.addEventListener('input', () => fitNoteField(field));
  // A wider or narrower pane rewraps the text: fit again when the width changes.
  if (typeof ResizeObserver === 'function') {
    let width = -1;
    new ResizeObserver(() => {
      if (field.clientWidth !== width) {
        width = field.clientWidth;
        fitNoteField(field);
      }
    }).observe(field);
  }
  return field;
}

/** Type `text` over the selection as one undoable edit, as a paste would have. */
function insertText(field: HTMLTextAreaElement, text: string): void {
  // execCommand is the one insertion Chromium puts on the field's undo stack.
  if (
    typeof document.execCommand === 'function' &&
    document.execCommand('insertText', false, text)
  ) {
    return;
  }
  // Without it (a test DOM), the text still goes in; there is no undo stack to keep.
  field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A note's text with every line break turned into a space. */
export function oneLine(text: string): string {
  return text.replace(/\r\n|[\r\n]/g, ' ');
}

/**
 * Size the field to its text. Call after setting its value from code, which
 * fires no `input`. The CSS max-height caps it, and it scrolls past that.
 */
export function fitNoteField(field: HTMLTextAreaElement): void {
  field.style.height = 'auto';
  const border = field.offsetHeight - field.clientHeight;
  if (field.scrollHeight > 0) {
    field.style.height = `${field.scrollHeight + border}px`;
  } else {
    // Not laid out (a hidden panel): leave the CSS height until it is.
    field.style.height = '';
  }
}
