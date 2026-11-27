// A tolerant base64 decoder for armored text (PEM, OpenPGP and age armor),
// written here so the readers stay free of Node's Buffer and of atob's
// whitespace rules. Whitespace is skipped; the first character that is not
// base64 ends the data. The output is capped.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
  VALUES[ALPHABET.charCodeAt(i)] = i;
}

/** Decode at most `maxBytes` bytes. Returns what could be decoded. */
export function decodeBase64(text: string, maxBytes: number): Uint8Array {
  const out = new Uint8Array(Math.min(maxBytes, Math.ceil((text.length * 3) / 4)));
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length && n < out.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
      continue;
    }
    const v = c < 128 ? VALUES[c] : -1;
    if (v < 0) {
      break;
    }
    acc = ((acc << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}
