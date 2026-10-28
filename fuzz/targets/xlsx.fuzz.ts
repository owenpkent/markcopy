import { renderWorkbookHtml } from '../../src/xlsx';
import { isExpectedOoxmlError } from './expected';

export function fuzz(data: Buffer): void {
  try {
    renderWorkbookHtml(data);
  } catch (err) {
    if (!isExpectedOoxmlError(err)) {
      throw err;
    }
  }
}
