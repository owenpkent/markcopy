import { renderDocxHtml } from '../../src/docx/read';
import { isExpectedOoxmlError } from './expected';

export function fuzz(data: Buffer): void {
  try {
    renderDocxHtml(data);
  } catch (err) {
    if (!isExpectedOoxmlError(err)) {
      throw err;
    }
  }
}
