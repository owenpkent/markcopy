import { parseXml } from '../../src/ooxml/xnode';
import { isExpectedXmlError } from './expected';

export function fuzz(data: Buffer): void {
  try {
    parseXml(data.toString('utf8'));
  } catch (err) {
    if (!isExpectedXmlError(err)) {
      throw err;
    }
  }
}
