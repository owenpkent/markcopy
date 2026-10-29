import { OpcError, openZip } from '../../src/ooxml/zip';

export function fuzz(data: Buffer): void {
  try {
    openZip(data);
  } catch (err) {
    if (err instanceof OpcError) {
      return;
    }
    throw err;
  }
}
