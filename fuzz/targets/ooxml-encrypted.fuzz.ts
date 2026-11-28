import {
  describeEncryptionInfo,
  looksLikeCompoundFile,
  protectedFileNotice,
  refuseProtectedFile,
} from '../../src/ooxml/encrypted';
import { OpcError } from '../../src/ooxml/zip';
import { CostError, hasControl, MAX_MILLISECONDS } from './binaryOracle';

export { CostError, MAX_HEAP_GROWTH, MAX_HTML_CHARS, MAX_MILLISECONDS } from './binaryOracle';

// A password-protected Office file is a compound file holding an EncryptionInfo
// stream (a version, then for "agile" an XML description) beside an
// EncryptedPackage stream; src/ooxml/encrypted.ts names the cipher in the notice
// the xlsx, docx and pptx previews show instead of a refusal with no reason. The
// xlsx, docx and pptx targets feed the zip reader, which turns a compound file
// away at the magic, so none reaches this.
//
// The first byte picks the stage:
//   0  describeEncryptionInfo on the bytes as an EncryptionInfo stream
//   1  protectedFileNotice and refuseProtectedFile on the bytes as a file
// The description never throws and is a short line of text, the notice is the
// documented one, and refuseProtectedFile throws only an OpcError.
const MAX_LINE = 400;

function checkLine(label: string, text: string | undefined): void {
  if (text === undefined) {
    return;
  }
  if (hasControl(text) || text.length > MAX_LINE) {
    throw new Error(`${label} holds a control character or runs past ${MAX_LINE} characters`);
  }
}

// protectedFileNotice reads through a compound file reader, so this target is async.
export async function fuzz(data: Buffer): Promise<void> {
  if (data.length === 0) {
    return;
  }
  const rest = new Uint8Array(data.subarray(1));
  const started = performance.now();
  if (data[0] % 2 === 0) {
    checkLine('the encryption description', describeEncryptionInfo(rest));
  } else {
    const notice = await protectedFileNotice(rest);
    checkLine('the notice', notice);
    if (notice !== undefined && (!looksLikeCompoundFile(rest) || !notice.startsWith('it is '))) {
      throw new Error(`an unexpected notice: ${JSON.stringify(notice.slice(0, 80))}`);
    }
    let refused = false;
    try {
      await refuseProtectedFile(rest);
    } catch (err) {
      if (!(err instanceof OpcError)) {
        throw err;
      }
      refused = true;
    }
    if (refused !== (notice !== undefined)) {
      throw new Error(
        `refused ${refused} but the notice is ${notice === undefined ? 'absent' : 'present'}`,
      );
    }
  }
  if (performance.now() - started > MAX_MILLISECONDS) {
    throw new CostError(`${rest.length} bytes took too long`);
  }
}
