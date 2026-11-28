// SHA-1, in plain code, for the certificate thumbprint Windows shows.
//
// This is not node:crypto because the readers that call it may run where that
// module does not exist (a webview). It is a thumbprint, a name for a
// certificate that people compare by eye, not a security check: nothing here
// trusts a SHA-1 to prove anything, and the page says SHA-1 is weak.

const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n));

/** The SHA-1 of `bytes` as 40 uppercase hex digits. */
export function sha1Hex(bytes: Uint8Array): string {
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  // The message, a 0x80 byte, zeros, then the bit length as 64 bits: padded to
  // a whole number of 64-byte blocks. Only the last one or two blocks are
  // built, so a large input is never copied.
  const full = bytes.length - (bytes.length % 64);
  const tail = new Uint8Array(bytes.length - full + 9 <= 64 ? 64 : 128);
  tail.set(bytes.subarray(full));
  tail[bytes.length - full] = 0x80;
  const view = new DataView(tail.buffer);
  const bits = bytes.length * 8;
  view.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(tail.length - 4, bits >>> 0);

  const w = new Int32Array(80);
  const block = (data: Uint8Array, at: number): void => {
    const dv = new DataView(data.buffer, data.byteOffset + at, 64);
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getInt32(i * 4);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  };
  for (let at = 0; at < full; at += 64) {
    block(bytes, at);
  }
  for (let at = 0; at < tail.length; at += 64) {
    block(tail, at);
  }
  return [h0, h1, h2, h3, h4]
    .map((h) => (h >>> 0).toString(16).padStart(8, '0'))
    .join('')
    .toUpperCase();
}
