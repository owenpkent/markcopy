// Labels for key files: PKCS#12 (.p12, .pfx) and PEM (.pem, .key). Only what
// the file states about how it is protected is shown: the password-based
// encryption scheme and its public parameters (PRF, iteration count, cipher),
// the MAC algorithm and iterations, counts of bags, and the kind of each PEM
// block. Salts, IVs, keys, MACs, certificate contents and subject names are
// never read into a result. No password is asked for or tried and nothing is
// decrypted.
//
// PKCS#12 follows RFC 7292, with the PBES2 parameters of RFC 8018. PEM
// follows RFC 7468, with the legacy Proc-Type and DEK-Info headers of RFC 1421
// (as written by OpenSSL for "traditional" private keys) and the OpenSSH
// private key layout (PROTOCOL.key in the OpenSSH sources).
import type { RangeReader } from '../binary/reader';
import { decodeBase64 } from './base64';
import { Der, type DerNode } from './der';
import { ENCRYPTION_NOTE, NOT_DETERMINED, Cursor, Undetermined, count, safeText } from './labels';
import { propertySection, tableSection, type PackageInfo } from './model';

/** The most of a PKCS#12 file read. A larger file is not determined. */
const MAX_PKCS12_BYTES = 4 * 1024 * 1024;
const MAX_CONTAINERS = 16;
const MAX_BAGS = 4096;
/** Text read from a PEM file, blocks listed, and bytes decoded from one block. */
const MAX_PEM_CHARS = 1024 * 1024;
const MAX_PEM_BLOCKS = 32;
const MAX_PEM_BLOCK_BYTES = 64 * 1024;
const MAX_OPENSSH_LINES = 16;
const MAX_HEADER_LINES = 8;
/** Bcrypt rounds beyond this are not shown as a number. */
const MAX_BCRYPT_ROUNDS = 1 << 20;

const OIDS: Record<string, string> = {
  '1.2.840.113549.1.5.13': 'PBES2',
  '1.2.840.113549.1.5.12': 'PBKDF2',
  '1.3.6.1.4.1.11591.4.11': 'scrypt',
  '1.2.840.113549.2.7': 'HMAC-SHA1',
  '1.2.840.113549.2.8': 'HMAC-SHA224',
  '1.2.840.113549.2.9': 'HMAC-SHA256',
  '1.2.840.113549.2.10': 'HMAC-SHA384',
  '1.2.840.113549.2.11': 'HMAC-SHA512',
  '2.16.840.1.101.3.4.1.2': 'AES-128-CBC',
  '2.16.840.1.101.3.4.1.22': 'AES-192-CBC',
  '2.16.840.1.101.3.4.1.42': 'AES-256-CBC',
  '2.16.840.1.101.3.4.1.6': 'AES-128-GCM',
  '2.16.840.1.101.3.4.1.46': 'AES-256-GCM',
  '1.2.840.113549.3.7': 'TripleDES-CBC',
  '1.2.840.113549.3.2': 'RC2-CBC',
  '1.3.14.3.2.7': 'DES-CBC',
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.4': 'SHA-224',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};
/** Password-based schemes older than PBES2, with the iteration count in their parameters. */
const LEGACY_PBE: Record<string, string> = {
  '1.2.840.113549.1.12.1.1': 'pbeWithSHAAnd128BitRC4',
  '1.2.840.113549.1.12.1.2': 'pbeWithSHAAnd40BitRC4',
  '1.2.840.113549.1.12.1.3': 'pbeWithSHAAnd3-KeyTripleDES-CBC',
  '1.2.840.113549.1.12.1.4': 'pbeWithSHAAnd2-KeyTripleDES-CBC',
  '1.2.840.113549.1.12.1.5': 'pbeWithSHAAnd128BitRC2-CBC',
  '1.2.840.113549.1.12.1.6': 'pbeWithSHAAnd40BitRC2-CBC',
  '1.2.840.113549.1.5.1': 'pbeWithMD2AndDES-CBC',
  '1.2.840.113549.1.5.3': 'pbeWithMD5AndDES-CBC',
  '1.2.840.113549.1.5.4': 'pbeWithMD2AndRC2-CBC',
  '1.2.840.113549.1.5.6': 'pbeWithMD5AndRC2-CBC',
  '1.2.840.113549.1.5.10': 'pbeWithSHA1AndDES-CBC',
  '1.2.840.113549.1.5.11': 'pbeWithSHA1AndRC2-CBC',
};
const OID_DATA = '1.2.840.113549.1.7.1';
const OID_ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const OID_ENVELOPED_DATA = '1.2.840.113549.1.7.3';
const BAG_KEY = '1.2.840.113549.1.12.10.1.1';
const BAG_SHROUDED = '1.2.840.113549.1.12.10.1.2';
const BAG_CERT = '1.2.840.113549.1.12.10.1.3';

const name = (oid: string): string => (Object.hasOwn(OIDS, oid) ? OIDS[oid] : `algorithm ${oid}`);

/** True when the bytes are a PFX: a SEQUENCE that starts with the INTEGER 3 and a SEQUENCE. Cheap. */
export function looksLikePkcs12(head: Uint8Array): boolean {
  if (head.length < 8 || head[0] !== 0x30) {
    return false;
  }
  let pos = 2;
  if (head[1] & 0x80 && head[1] !== 0x80) {
    pos += head[1] & 0x7f;
  }
  return (
    head[pos] === 0x02 && head[pos + 1] === 0x01 && head[pos + 2] === 0x03 && head[pos + 3] === 0x30
  );
}

/** The scheme of an AlgorithmIdentifier that protects data with a password, with its public parameters. */
export function describePbe(der: Der, alg: DerNode): string {
  const parts = der.children(alg, 2);
  const oid = der.oid(parts[0]);
  const params = parts[1];
  if (oid === '1.2.840.113549.1.5.13' && params) {
    const [kdf, enc] = der.children(params, 2);
    const [kdfOid, kdfParams] = der.children(kdf, 2);
    const kdfId = der.oid(kdfOid);
    const cipher = enc ? name(der.oid(der.children(enc, 2)[0])) : NOT_DETERMINED;
    if (kdfId === '1.2.840.113549.1.5.12' && kdfParams) {
      const fields = der.children(kdfParams, 5);
      const iterations = der.int(fields[1]);
      let prf = 'HMAC-SHA1';
      for (const f of fields.slice(2)) {
        if (f.tag === 0x30) {
          prf = name(der.oid(der.children(f, 1)[0]));
        }
      }
      return `PBES2: PBKDF2 (${prf}, ${iterations === undefined ? NOT_DETERMINED : count(iterations)} iterations), ${cipher}`;
    }
    if (kdfId === '1.3.6.1.4.1.11591.4.11' && kdfParams) {
      const fields = der.children(kdfParams, 5);
      const [n, r, p] = [1, 2, 3].map((i) => der.int(fields[i]));
      const show = (v: number | undefined): string => (v === undefined ? NOT_DETERMINED : count(v));
      return `PBES2: scrypt (N=${show(n)}, r=${show(r)}, p=${show(p)}), ${cipher}`;
    }
    return `PBES2: ${name(kdfId)}, ${cipher}`;
  }
  if (Object.hasOwn(LEGACY_PBE, oid)) {
    const iterations = params ? der.int(der.children(params, 2)[1]) : undefined;
    return `${LEGACY_PBE[oid]} (legacy), ${iterations === undefined ? NOT_DETERMINED : count(iterations)} iterations`;
  }
  return `algorithm ${oid}`;
}

interface Container {
  kind: string;
  protection: string;
  contents: string;
}

function readBags(
  der: Der,
  safeContents: DerNode,
  keys: { shrouded: string[]; plain: number; certs: number },
): string {
  const bags = der.children(safeContents, MAX_BAGS);
  let shrouded = 0;
  let plain = 0;
  let certs = 0;
  let others = 0;
  for (const bag of bags) {
    const [id, value] = der.children(bag, 2);
    const oid = der.oid(id);
    if (oid === BAG_SHROUDED && value) {
      const alg = der.children(der.children(value, 1)[0], 2)[0];
      keys.shrouded.push(describePbe(der, alg));
      shrouded++;
    } else if (oid === BAG_KEY) {
      keys.plain++;
      plain++;
    } else if (oid === BAG_CERT) {
      keys.certs++;
      certs++;
    } else {
      others++;
    }
  }
  const parts: string[] = [];
  if (shrouded) parts.push(`${count(shrouded)} encrypted key bag${shrouded === 1 ? '' : 's'}`);
  if (plain) parts.push(`${count(plain)} key bag${plain === 1 ? '' : 's'} not encrypted`);
  if (certs) parts.push(`${count(certs)} certificate${certs === 1 ? '' : 's'}`);
  if (others) parts.push(`${count(others)} other`);
  return parts.length ? parts.join(', ') : 'empty';
}

/** What a PKCS#12 file declares. Never throws. */
export async function readPkcs12(reader: RangeReader): Promise<PackageInfo> {
  const rows: [string, string][] = [];
  const containers: Container[] = [];
  const warnings: string[] = [];
  const keys = { shrouded: [] as string[], plain: 0, certs: 0 };
  let encryptedContainers = 0;
  try {
    if (reader.size > MAX_PKCS12_BYTES) {
      throw new Undetermined('the file is larger than will be read');
    }
    const der = new Der(await reader.bytes(0, reader.size));
    const pfx = der.read(0);
    const [version, authSafe, mac] = der.children(pfx, 3);
    rows.push(['Format', `PKCS#12 (PFX) version ${der.int(version) ?? NOT_DETERMINED}`]);
    const [contentType, explicit] = der.children(authSafe, 2);
    if (der.oid(contentType) !== OID_DATA) {
      throw new Undetermined('the contents are signed, not password-protected');
    }
    const inner = new Der(der.octets(der.children(explicit, 1)[0]));
    for (const info of inner.children(inner.read(0), MAX_CONTAINERS)) {
      const [type, wrap] = inner.children(info, 2);
      const oid = inner.oid(type);
      if (oid === OID_DATA) {
        const bags = new Der(inner.octets(inner.children(wrap, 1)[0]));
        containers.push({
          kind: 'Data',
          protection: 'not encrypted',
          contents: readBags(bags, bags.read(0), keys),
        });
      } else if (oid === OID_ENCRYPTED_DATA) {
        encryptedContainers++;
        const encrypted = inner.children(inner.children(wrap, 1)[0], 2)[1];
        const alg = inner.children(encrypted, 3)[1];
        containers.push({
          kind: 'Encrypted data',
          protection: describePbe(inner, alg),
          contents: 'not shown (encrypted)',
        });
      } else if (oid === OID_ENVELOPED_DATA) {
        encryptedContainers++;
        containers.push({
          kind: 'Enveloped data',
          protection: 'public-key encrypted',
          contents: 'not shown (encrypted)',
        });
      } else {
        containers.push({ kind: `Content ${oid}`, protection: NOT_DETERMINED, contents: '' });
      }
    }
    const keyBags = keys.shrouded.length + keys.plain;
    const schemes = [...new Set(keys.shrouded)];
    rows.push([
      'Key bags',
      keyBags === 0
        ? encryptedContainers > 0
          ? `none seen outside the ${count(encryptedContainers)} encrypted container${encryptedContainers === 1 ? '' : 's'}`
          : 'none'
        : [
            keys.shrouded.length ? `${count(keys.shrouded.length)} encrypted` : '',
            keys.plain ? `${count(keys.plain)} not encrypted` : '',
          ]
            .filter(Boolean)
            .join(', '),
    ]);
    for (const s of schemes) {
      rows.push(['Key bag encryption', s]);
    }
    if (keys.plain > 0) {
      rows.push(['Unencrypted keys', 'a private key in this file is stored without a password']);
    }
    rows.push([
      'Certificates',
      keys.certs > 0
        ? `${count(keys.certs)} not encrypted`
        : encryptedContainers > 0
          ? `${NOT_DETERMINED} (in encrypted containers)`
          : 'none',
    ]);
    if (mac && mac.tag === 0x30) {
      const [digestInfo, , iterations] = der.children(mac, 3);
      const algorithm = name(der.oid(der.children(der.children(digestInfo, 1)[0], 1)[0]));
      const n = iterations ? der.int(iterations) : 1;
      rows.push(['MAC', `${algorithm}, ${n === undefined ? NOT_DETERMINED : count(n)} iterations`]);
    } else {
      rows.push(['MAC', 'none']);
    }
  } catch {
    rows.push(['Protection', `${NOT_DETERMINED} (the structure could not be read to the end)`]);
    warnings.push(
      'Part of the PKCS#12 structure could not be read, so some labels are not determined.',
    );
  }
  return {
    format: 'PKCS#12 file',
    summary: 'A PKCS#12 key store. The labels below come from its structure only.',
    sections: [
      ...propertySection('Encryption', rows, ENCRYPTION_NOTE),
      ...tableSection(
        'Containers',
        ['Container', 'Protection', 'Contents'],
        containers.map((c) => [c.kind, c.protection, c.contents]),
      ),
    ],
    warnings,
  };
}

// ---- PEM ----

export interface Block {
  label: string;
  headers: string[];
  body: string;
}

/** True when the head is plain text with a PEM boundary line in it that does not belong to OpenPGP or age. */
export function looksLikePem(head: Uint8Array): boolean {
  for (const b of head.subarray(0, 4096)) {
    if (b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09)) {
      return false;
    }
  }
  const text = new TextDecoder().decode(head.subarray(0, 4096));
  const m = /(^|\n)-----BEGIN ([A-Z0-9 ]{1,48})-----\r?\n/.exec(text);
  return m !== null && !m[2].startsWith('PGP ') && !m[2].startsWith('AGE ');
}

export function parsePemBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.slice(0, MAX_PEM_CHARS).split(/\r?\n/);
  for (let i = 0; i < lines.length && blocks.length < MAX_PEM_BLOCKS; i++) {
    const m = /^-----BEGIN ([A-Z0-9 ]{1,48})-----$/.exec(lines[i]);
    if (!m) {
      continue;
    }
    const headers: string[] = [];
    const body: string[] = [];
    let size = 0;
    let inHeaders = true;
    for (i++; i < lines.length && !lines[i].startsWith('-----END'); i++) {
      const line = lines[i];
      if (inHeaders && line.includes(':')) {
        if (headers.length < MAX_HEADER_LINES) {
          headers.push(line);
        }
      } else if (inHeaders && line.trim() === '') {
        inHeaders = false;
      } else {
        inHeaders = false;
        size += line.length;
        if (size <= MAX_PEM_BLOCK_BYTES * 2) {
          body.push(line);
        }
      }
    }
    blocks.push({ label: m[1], headers, body: body.join('') });
  }
  return blocks;
}

function opensshLabel(block: Block): string {
  const bytes = decodeBase64(block.body.slice(0, MAX_OPENSSH_LINES * 76), 1024);
  const c = new Cursor(bytes);
  const magic = new TextDecoder().decode(c.take(15));
  if (magic !== 'openssh-key-v1\0') {
    throw new Undetermined('not an OpenSSH key');
  }
  const string = (): Uint8Array => c.take(c.u32be());
  const cipher = safeText(new TextDecoder().decode(string()), 32);
  const kdf = safeText(new TextDecoder().decode(string()), 32);
  const options = new Cursor(string());
  if (cipher === 'none' && kdf === 'none') {
    return 'OpenSSH private key, not encrypted';
  }
  let rounds = '';
  if (kdf === 'bcrypt') {
    options.skip(options.u32be());
    const n = options.u32be();
    rounds =
      n >= 1 && n <= MAX_BCRYPT_ROUNDS ? `, ${count(n)} rounds` : `, rounds ${NOT_DETERMINED}`;
  }
  return `OpenSSH private key, encrypted (${cipher}, ${kdf === 'bcrypt' ? 'bcrypt KDF' : `KDF ${kdf}`}${rounds})`;
}

function describeBlock(block: Block): [string, string] {
  const label = block.label;
  switch (label) {
    case 'CERTIFICATE':
    case 'TRUSTED CERTIFICATE':
    case 'X509 CERTIFICATE':
      return [label, 'Certificate'];
    case 'X509 CRL':
      return [label, 'Certificate revocation list'];
    case 'CERTIFICATE REQUEST':
    case 'NEW CERTIFICATE REQUEST':
      return [label, 'Certificate request'];
    case 'PUBLIC KEY':
    case 'RSA PUBLIC KEY':
      return [label, 'Public key'];
    case 'PKCS7':
    case 'CMS':
      return [label, 'PKCS#7 or CMS message'];
    case 'DH PARAMETERS':
    case 'EC PARAMETERS':
      return [label, 'Parameters'];
    case 'PRIVATE KEY':
      return [label, 'Private key, not encrypted'];
    case 'ENCRYPTED PRIVATE KEY': {
      try {
        const der = new Der(decodeBase64(block.body, MAX_PEM_BLOCK_BYTES));
        const alg = der.children(der.read(0), 2)[0];
        return [label, `Private key, encrypted (${describePbe(der, alg)})`];
      } catch {
        return [label, `Private key, encrypted (${NOT_DETERMINED})`];
      }
    }
    case 'OPENSSH PRIVATE KEY':
      try {
        return [label, opensshLabel(block)];
      } catch {
        return [label, `OpenSSH private key (${NOT_DETERMINED})`];
      }
    case 'RSA PRIVATE KEY':
    case 'EC PRIVATE KEY':
    case 'DSA PRIVATE KEY': {
      const kind = `${label.split(' ')[0]} private key (traditional format)`;
      const encrypted = block.headers.some((h) => /^Proc-Type:\s*4,ENCRYPTED\s*$/.test(h));
      if (!encrypted) {
        return [label, `${kind}, not encrypted`];
      }
      const dek = block.headers
        .map((h) => /^DEK-Info:\s*([A-Za-z0-9-]{1,24})\s*,/.exec(h))
        .find((m) => m !== null);
      return [
        label,
        `${kind}, encrypted (legacy PEM encryption${dek ? `: ${safeText(dek[1], 24)}` : `, cipher ${NOT_DETERMINED}`})`,
      ];
    }
    default:
      return [safeText(label, 48), 'Other PEM block'];
  }
}

/** What a PEM file holds. Never throws. */
export async function readPem(reader: RangeReader): Promise<PackageInfo> {
  const warnings: string[] = [];
  let blocks: Block[] = [];
  try {
    const bytes = await reader.upTo(0, Math.min(reader.size, MAX_PEM_CHARS));
    blocks = parsePemBlocks(new TextDecoder().decode(bytes));
  } catch {
    warnings.push('The file could not be read.');
  }
  const described = blocks.map(describeBlock);
  const privateKeys = described.filter(([, what]) => what.includes('rivate key'));
  const summary =
    described.length === 0
      ? 'A text file with no PEM block in it.'
      : described.length === 1
        ? `${described[0][1]}.`
        : `${count(described.length)} PEM blocks.`;
  return {
    format: 'PEM file',
    summary,
    sections: [
      ...propertySection(
        'Encryption',
        [
          ['Blocks', count(described.length)],
          ['Private keys', privateKeys.length === 0 ? 'none' : count(privateKeys.length)],
        ],
        ENCRYPTION_NOTE,
      ),
      ...tableSection(
        'Blocks',
        ['Block', 'What it is'],
        described.map(([a, b]) => [a, b]),
      ),
    ],
    warnings,
  };
}
