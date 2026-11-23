// Re-encoding a PKCS #7 SignedData so its encapsulated ContentInfo carries
// signature-file bytes, the form `jarsigner -internalsf` writes. Written from
// RFC 2315: ContentInfo { contentType, [0] SignedData }, SignedData { version,
// digestAlgorithms, contentInfo { contentType, [0] OCTET STRING }, certificates,
// signerInfos }. The block it starts from comes from tests/pe/fixture.ts.

interface Tlv {
  tag: number;
  /** Where the header begins, where the content begins, where it ends. */
  from: number;
  start: number;
  end: number;
}

function read(b: Uint8Array, at: number): Tlv {
  let length = b[at + 1];
  let p = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) {
      length = length * 256 + b[p++];
    }
  }
  return { tag: b[at], from: at, start: p, end: p + length };
}

function encode(tag: number, content: Uint8Array): Uint8Array {
  const length: number[] = [];
  if (content.length < 0x80) {
    length.push(content.length);
  } else {
    const bytes: number[] = [];
    for (let n = content.length; n > 0; n = Math.floor(n / 256)) {
      bytes.unshift(n % 256);
    }
    length.push(0x80 | bytes.length, ...bytes);
  }
  return Uint8Array.from([tag, ...length, ...content]);
}

const join = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]));

/** The same signature with `sf` as the encapsulated content (an empty string gives an empty OCTET STRING). */
export function embedSignatureFile(der: Uint8Array, sf: string): Uint8Array {
  const outer = read(der, 0);
  const type = read(der, outer.start);
  const wrapper = read(der, type.end);
  const signed = read(der, wrapper.start);
  const items: Tlv[] = [];
  for (let at = signed.start; at < signed.end;) {
    const item = read(der, at);
    items.push(item);
    at = item.end;
  }
  const raw = (t: Tlv): Uint8Array => der.subarray(t.from, t.end);
  const contentType = read(der, items[2].start);
  const octets = encode(0x04, new TextEncoder().encode(sf));
  const info = encode(0x30, join(raw(contentType), encode(0xa0, octets)));
  const rebuilt = encode(
    0x30,
    join(raw(items[0]), raw(items[1]), info, ...items.slice(3).map(raw)),
  );
  return encode(0x30, join(raw(type), encode(0xa0, rebuilt)));
}
