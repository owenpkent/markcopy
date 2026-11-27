// OpenDocument files (.odt, .ods, .odp, .odg and their templates).
//
// An ODF file is a zip whose first entry, `mimetype`, names the kind, and whose
// META-INF/manifest.xml lists every part. A part that is encrypted carries a
// manifest:encryption-data element in its file-entry: the cipher, the key
// derivation and its cost are written there in the clear. The reader only
// labels what the manifest declares. It never asks for a password, derives a
// key or decrypts anything, and says nothing about strength beyond naming
// Blowfish as legacy.
//
// The manifest is scanned with a tolerant pattern match over its first 1 MiB,
// not parsed as XML, so a manifest that is cut short still yields the entries
// before the cut. Attribute names are matched without regard to their prefix.
import { printable } from '../binary/text';
import type { ZipArchive, ZipFlavour } from './zipRange';

const MAX_MIMETYPE_BYTES = 256;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_ATTRIBUTE = 200;

const KINDS: Record<string, string> = {
  text: 'OpenDocument text',
  'text-template': 'OpenDocument text template',
  'text-master': 'OpenDocument master document',
  'text-web': 'OpenDocument HTML template',
  spreadsheet: 'OpenDocument spreadsheet',
  'spreadsheet-template': 'OpenDocument spreadsheet template',
  presentation: 'OpenDocument presentation',
  'presentation-template': 'OpenDocument presentation template',
  graphics: 'OpenDocument drawing',
  'graphics-template': 'OpenDocument drawing template',
  chart: 'OpenDocument chart',
  formula: 'OpenDocument formula',
  image: 'OpenDocument image',
  database: 'OpenDocument database',
};
const MIME_PREFIX = 'application/vnd.oasis.opendocument.';

/** The format name for the zip's `mimetype` entry, or undefined when it is not an OpenDocument file. */
export async function odfFormat(zip: ZipArchive): Promise<string | undefined> {
  const entry = zip.find('mimetype');
  if (!entry || entry.encrypted) {
    return undefined;
  }
  const text = new TextDecoder().decode(await zip.readEntryHead(entry, MAX_MIMETYPE_BYTES)).trim();
  if (!text.startsWith(MIME_PREFIX)) {
    return undefined;
  }
  return KINDS[text.slice(MIME_PREFIX.length)] ?? 'OpenDocument file';
}

function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:[\w.-]+:)?([\w.-]+)\s*=\s*(?:"([^"]{0,200})"|'([^']{0,200})')/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) {
    out.set(m[1], (m[2] ?? m[3] ?? '').slice(0, MAX_ATTRIBUTE));
  }
  return out;
}

const ALGORITHMS: Array<[RegExp, string]> = [
  [/aes256-cbc$/i, 'AES-256-CBC'],
  [/aes192-cbc$/i, 'AES-192-CBC'],
  [/aes128-cbc$/i, 'AES-128-CBC'],
  [/aes256-gcm$/i, 'AES-256-GCM'],
  [/blowfish/i, 'Blowfish CFB (legacy)'],
];

function algorithmLabel(name: string | undefined): string {
  if (!name) {
    return 'cipher not determined';
  }
  return ALGORITHMS.find(([re]) => re.test(name))?.[1] ?? `cipher ${printable(name).slice(0, 80)}`;
}

function derivationLabel(tag: string | undefined): string | undefined {
  if (!tag) {
    return undefined;
  }
  const a = attributes(tag);
  const name = a.get('key-derivation-name') ?? '';
  const count = (key: string): string | undefined => {
    const n = Number(a.get(key));
    return Number.isSafeInteger(n) && n > 0 ? n.toLocaleString('en-US') : undefined;
  };
  if (/argon2id/i.test(name)) {
    const parts = [
      count('argon2-iterations') && `${count('argon2-iterations')} iterations`,
      count('argon2-memory') && `${count('argon2-memory')} KiB memory`,
      count('argon2-lanes') && `${count('argon2-lanes')} lanes`,
    ].filter(Boolean);
    return parts.length > 0 ? `Argon2id (${parts.join(', ')})` : 'Argon2id';
  }
  if (/pbkdf2/i.test(name)) {
    const iterations = count('iteration-count');
    return iterations ? `PBKDF2 (${iterations} iterations)` : 'PBKDF2';
  }
  return name ? printable(name).slice(0, 80) : undefined;
}

export interface OdfEncryption {
  encrypted: number;
  total: number;
  algorithms: string[];
  derivations: string[];
  /** True when the manifest ended inside an element. */
  cut: boolean;
}

/** What the manifest text declares. Never throws. */
export function scanManifest(xml: string): OdfEncryption {
  const out: OdfEncryption = {
    encrypted: 0,
    total: 0,
    algorithms: [],
    derivations: [],
    cut: false,
  };
  const algorithms = new Set<string>();
  const derivations = new Set<string>();
  // Each file-entry runs from its opening tag to the next file-entry, so a
  // self-closing one and a cut one are both handled.
  const parts = xml.split(/<(?:[\w.-]+:)?file-entry\b/);
  for (const part of parts.slice(1, MAX_ENTRIES + 1)) {
    const path = attributes(
      part.slice(0, part.indexOf('>') < 0 ? undefined : part.indexOf('>')),
    ).get('full-path');
    if (path === undefined || path.endsWith('/')) {
      continue;
    }
    out.total++;
    if (!/<(?:[\w.-]+:)?encryption-data\b/.test(part)) {
      continue;
    }
    out.encrypted++;
    const alg = /<(?:[\w.-]+:)?algorithm\b[^>]*/.exec(part)?.[0];
    algorithms.add(algorithmLabel(alg ? attributes(alg).get('algorithm-name') : undefined));
    const kdf = derivationLabel(/<(?:[\w.-]+:)?key-derivation\b[^>]*/.exec(part)?.[0]);
    if (kdf) {
      derivations.add(kdf);
    }
  }
  out.algorithms = [...algorithms];
  out.derivations = [...derivations];
  out.cut = !/<\/(?:[\w.-]+:)?manifest\s*>\s*$/.test(xml);
  return out;
}

/** The rows for the File section, or undefined when no entry declares encryption. */
export function encryptionRows(e: OdfEncryption): [string, string][] | undefined {
  if (e.encrypted === 0) {
    return undefined;
  }
  const noun = e.total === 1 ? 'entry' : 'entries';
  const lead = e.cut
    ? `${e.encrypted} of the ${e.total} ${noun} read`
    : `${e.encrypted} of ${e.total} ${noun}`;
  const rows: [string, string][] = [['Encryption', `${lead}: ${e.algorithms.join(', ')}`]];
  if (e.derivations.length > 0) {
    rows.push(['Key derivation', e.derivations.join(', ')]);
  }
  return rows;
}

/** The OpenDocument flavour of a zip, or undefined when it is not one. */
export async function readOdf(zip: ZipArchive): Promise<ZipFlavour | undefined> {
  const format = await odfFormat(zip);
  if (!format) {
    return undefined;
  }
  const warnings: string[] = [];
  let fileRows: [string, string][] | undefined;
  const manifest = zip.find('META-INF/manifest.xml');
  if (manifest && !manifest.encrypted) {
    try {
      const xml = new TextDecoder().decode(await zip.readEntryHead(manifest, MAX_MANIFEST_BYTES));
      fileRows = encryptionRows(scanManifest(xml));
    } catch {
      warnings.push('The manifest could not be read, so encryption was not determined.');
    }
  }
  return {
    format,
    summary: `An ${format} file.`,
    before: [],
    after: [],
    fileRows,
    warnings,
  };
}
