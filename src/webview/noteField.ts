// The note text field shared by Video Notes (src/webview/videoReview.ts, also
// Audio Notes in clock mode) and Image Notes (src/webview/imageReview.ts).
//
// A textarea that wraps and grows with the note, up to a few lines and then
// scrolls, so a long note stays readable while it is typed. It was a one-line
// <input>, which scrolled the start of a long note out of sight. A note is still
// one line, as the sidecar has always stored it: Enter sends (the callers' own
// keydown), and a line break pasted in becomes a space.

/** Build the note field. */
export function createNoteField(): HTMLTextAreaElement {
  const field = document.createElement('textarea');
  field.className = 'mc-rv-field';
  field.rows = 1;
  field.maxLength = 10000;
  field.placeholder = 'Write a note';
  field.setAttribute('aria-label', 'Note text');
  field.spellcheck = true;
  field.addEventListener('input', () => {
    if (/[\r\n]/.test(field.value)) {
      const at = field.selectionStart;
      field.value = oneLine(field.value);
      field.setSelectionRange(at, at);
    }
    fitNoteField(field);
  });
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
