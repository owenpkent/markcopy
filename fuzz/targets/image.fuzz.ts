import { sniffImage, statusLine } from '../../src/webview/imageInfo';

// sniffImage answers anything it does not recognise with undefined and never
// throws on truncated or hostile headers, so nothing is wrapped. A result is then
// read the way the preview's status line reads it.
export function fuzz(data: Buffer): void {
  const info = sniffImage(data);
  if (!info) {
    return;
  }
  statusLine('fuzz.img', data.byteLength, info, info.width, info.height);
  statusLine('fuzz.img', data.byteLength, info);
}
