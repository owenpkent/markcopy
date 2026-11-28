import { ageHeaderText, parseAgeHeader } from '../../src/pkg/age';
import { decodeBase64 } from '../../src/pkg/base64';
import { Der, type DerNode } from '../../src/pkg/der';
import { parsePemBlocks } from '../../src/pkg/keyFiles';
import { Undetermined } from '../../src/pkg/labels';
import { dearmor } from '../../src/pkg/openpgp';
import { CostError, MAX_MILLISECONDS } from './binaryOracle';

export { CostError, MAX_HEAP_GROWTH, MAX_HTML_CHARS, MAX_MILLISECONDS } from './binaryOracle';

// The encodings under the key-file and encrypted-container readers: DER and BER
// (src/pkg/der.ts, the walker PKCS #12 and PEM use), the tolerant base64 decoder
// (src/pkg/base64.ts), PEM block splitting, OpenPGP armor and the age header. The
// pkg variants reach them behind a whole file whose first bytes have to survive
// mutation; here the input is the encoding itself.
//
// The first input byte picks the stage:
//   0  Der: read the root node and walk every child, taking OIDs, integers and
//      octet strings. Only an Undetermined may escape; nodes stay inside their
//      parent and inside the buffer
//   1  decodeBase64 against Node's decoder over the same characters
//   2  parsePemBlocks: block, header and size caps, labels in the allowed set
//   3  dearmor and the age header (binary, and armored then decoded)
const MODES = 4;
const MAX_VISITS = 40000;
const BASE64 = /^[A-Za-z0-9+/]*/;

function walk(der: Der, node: DerNode, parentEnd: number, visits: { count: number }): void {
  if (++visits.count > MAX_VISITS) {
    throw new CostError(`more than ${MAX_VISITS} nodes walked`);
  }
  if (node.start > node.end || node.end > parentEnd || node.next < node.end) {
    throw new Error(`node ${node.start}..${node.end} next ${node.next} outside ${parentEnd}`);
  }
  if (node.tag === 0x06) {
    try {
      der.oid(node);
    } catch (err) {
      if (!(err instanceof Undetermined)) {
        throw err;
      }
    }
  }
  if (node.tag === 0x02) {
    const value = der.int(node);
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`an integer of ${value}`);
    }
  }
  if ((node.tag & 0xdf) === 0x04) {
    try {
      der.octets(node);
    } catch (err) {
      if (!(err instanceof Undetermined)) {
        throw err;
      }
    }
  }
  if (node.constructed) {
    for (const child of der.children(node, 64)) {
      walk(der, child, node.end, visits);
    }
  }
}

function checkDer(bytes: Uint8Array): void {
  const der = new Der(bytes);
  try {
    walk(der, der.read(0), bytes.length, { count: 0 });
  } catch (err) {
    if (!(err instanceof Undetermined)) {
      throw err;
    }
  }
}

/** Node's decoder over the characters the tolerant decoder takes: whitespace skipped, the first other character ends it. */
function referenceBase64(text: string): Uint8Array {
  const squeezed = text.replace(/[ \n\r\t]/g, '');
  const prefix = BASE64.exec(squeezed)?.[0] ?? '';
  return Buffer.from(prefix, 'base64');
}

function checkBase64(text: string, max: number): void {
  const decoded = decodeBase64(text, max);
  if (decoded.length > max) {
    throw new CostError(`${decoded.length} bytes decoded past the cap of ${max}`);
  }
  // The cap cuts the output; compare the part both give.
  const expected = referenceBase64(text);
  const same = Buffer.compare(
    Buffer.from(decoded),
    Buffer.from(expected.subarray(0, decoded.length)),
  );
  if (same !== 0 || (decoded.length < max && decoded.length !== expected.length)) {
    // Text that ends the data early at a character the reference would also stop on is the
    // same; anything else is a disagreement.
    throw new Error(
      `decodeBase64 gave ${decoded.length} bytes and Node ${expected.length} for ${JSON.stringify(text.slice(0, 60))}`,
    );
  }
}

function checkPem(text: string): void {
  const blocks = parsePemBlocks(text);
  if (blocks.length > 32) {
    throw new CostError(`${blocks.length} PEM blocks`);
  }
  for (const block of blocks) {
    if (!/^[A-Z0-9 ]{1,48}$/.test(block.label) || block.headers.length > 8) {
      throw new Error(`a PEM block labelled ${JSON.stringify(block.label)}`);
    }
    if (block.body.length > 2 * 64 * 1024 + 1) {
      throw new CostError(`a PEM body of ${block.body.length} characters`);
    }
  }
}

function checkArmorAndAge(bytes: Uint8Array, text: string): void {
  const armor = dearmor(text);
  if (armor !== undefined && (!armor.label.startsWith('PGP ') || armor.bytes.length > 768 * 1024)) {
    throw new Error(
      `armor ${JSON.stringify(armor.label.slice(0, 40))} of ${armor.bytes.length} bytes`,
    );
  }
  const header = ageHeaderText(bytes);
  if (header !== undefined) {
    const parsed = parseAgeHeader(header.text);
    if (parsed !== undefined) {
      if (parsed.total > 1000 || parsed.stanzas.length > 16) {
        throw new CostError(`${parsed.total} stanzas of ${parsed.stanzas.length} types`);
      }
      const counted = parsed.stanzas.reduce((n, s) => n + s.count, 0);
      if (counted > parsed.total) {
        throw new Error(`${counted} stanzas counted of ${parsed.total}`);
      }
    }
  }
}

export function fuzz(data: Buffer): void {
  if (data.length === 0) {
    return;
  }
  const mode = data[0] % MODES;
  const rest = data.subarray(1);
  const started = performance.now();
  if (mode === 0) {
    checkDer(new Uint8Array(rest));
  } else if (mode === 1) {
    checkBase64(rest.toString('latin1'), 1 + (data[1] ?? 0) * 8);
  } else if (mode === 2) {
    checkPem(rest.toString('latin1'));
  } else {
    checkArmorAndAge(new Uint8Array(rest), rest.toString('latin1'));
  }
  if (performance.now() - started > MAX_MILLISECONDS) {
    throw new CostError(`${rest.length} bytes took too long (stage ${mode})`);
  }
}
