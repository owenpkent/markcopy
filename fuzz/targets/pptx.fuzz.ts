import { renderDeckHtml } from '../../src/pptx/read';
import { isExpectedOoxmlError } from './expected';

export function fuzz(data: Buffer): void {
  try {
    renderDeckHtml(data);
  } catch (err) {
    if (!isExpectedOoxmlError(err)) {
      throw err;
    }
  }
}
