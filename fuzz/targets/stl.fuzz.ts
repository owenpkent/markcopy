import { checkStl, sniffStl, toBytes } from '../../src/webview/stlInfo';

// None of these throw on purpose: toBytes turns junk into an empty array, and
// sniffStl/checkStl report a bad file in their result. The input is checked as
// the file itself, and also as the host's message payload would arrive: a
// base64 string, or JSON that parses to an object, array or number.
export function fuzz(data: Buffer): void {
  sniffStl(data);
  checkStl(data);

  const text = data.toString('latin1');
  checkStl(toBytes(text));
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      throw err;
    }
    return;
  }
  checkStl(toBytes(payload));
}
