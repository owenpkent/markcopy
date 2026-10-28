import './vscodeStub';
import { EditError, addNoteText, loadSidecar } from '../../src/videoReview';

// loadSidecar reports bad YAML or a schema violation in its result (readOnly)
// rather than throwing, so it is not wrapped. A file that validates is then
// edited the way the notes UI would, where EditError is the documented refusal
// for text the line-level editor cannot place a note in.
export function fuzz(data: Buffer): void {
  const text = data.toString('utf8');
  const load = loadSidecar(text);
  if (!load.file) {
    return;
  }
  try {
    addNoteText(text, { at: 1, text: 'fuzz', created: '2026-01-01T00:00:00' }, load.file);
  } catch (err) {
    if (!(err instanceof EditError)) {
      throw err;
    }
  }
}
