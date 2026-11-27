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
// The manifest is scanned by one linear tokenizer over its first 1 MiB, not
// parsed as XML (comments and text are skipped, only elements are read), so a
// manifest that is cut short still yields the entries before the cut. Attribute names are matched without regard to their prefix.
import { own } from '../binary/own';
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
  let text: string;
  try {
    text = new TextDecoder().decode(await zip.readEntryHead(entry, MAX_MIMETYPE_BYTES)).trim();
  } catch {
    // Only a probe: an unreadable member (an unsupported method, say) leaves a
    // generic zip to be listed as one.
    return undefined;
  }
  if (!text.startsWith(MIME_PREFIX)) {
    return undefined;
  }
  return own(KINDS, text.slice(MIME_PREFIX.length)) ?? 'OpenDocument file';
}

/** One start tag of the manifest: its local name and its attributes (prefixes dropped). */
interface Tag {
  name: string;
  attrs: Map<string, string>;
  selfClosing: boolean;
}

const isSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Walks the manifest once, left to right, calling `onOpen` for each start tag and
 * `onClose` for each end tag with its local name. Comments, processing
 * instructions, CDATA and text are skipped, so only real elements are seen. A
 * quoted attribute value longer than MAX_ATTRIBUTE is skipped in one step
 * (the attribute is dropped), so the cost is linear in the text however long a
 * value is. Text that ends inside a tag yields the tag with the attributes
 * completed so far.
 */
function walk(
  xml: string,
  onOpen: (tag: Tag) => boolean | void,
  onClose: (name: string) => void,
): void {
  const n = xml.length;
  let i = xml.indexOf('<');
  while (i >= 0 && i < n) {
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      i = end < 0 ? -1 : xml.indexOf('<', end + 3);
      continue;
    }
    if (xml.startsWith('<![CDATA[', i) || xml.startsWith('<?', i) || xml.startsWith('<!', i)) {
      const close = xml.startsWith('<![CDATA[', i) ? ']]>' : xml.startsWith('<?', i) ? '?>' : '>';
      const end = xml.indexOf(close, i + 2);
      i = end < 0 ? -1 : xml.indexOf('<', end + close.length);
      continue;
    }
    const closing = xml[i + 1] === '/';
    let j = i + (closing ? 2 : 1);
    const nameStart = j;
    while (j < n && !isSpace(xml[j]) && xml[j] !== '>' && xml[j] !== '/') {
      j++;
    }
    const name = xml.slice(nameStart, j).replace(/^.*:/, '');
    if (closing) {
      onClose(name);
      const end = xml.indexOf('>', j);
      i = end < 0 ? -1 : xml.indexOf('<', end + 1);
      continue;
    }
    const attrs = new Map<string, string>();
    let selfClosing = false;
    let ended = false;
    while (j < n && !ended) {
      const c = xml[j];
      if (isSpace(c)) {
        j++;
      } else if (c === '>') {
        j++;
        ended = true;
      } else if (c === '/') {
        selfClosing = xml[j + 1] === '>';
        j += selfClosing ? 2 : 1;
        ended = selfClosing;
      } else if (c === '<') {
        // A tag that never closed: the next element starts here.
        ended = true;
      } else {
        const keyStart = j;
        while (j < n && !isSpace(xml[j]) && !'=/>'.includes(xml[j])) {
          j++;
        }
        const key = xml.slice(keyStart, j).replace(/^.*:/, '');
        while (isSpace(xml[j])) {
          j++;
        }
        if (xml[j] !== '=') {
          continue;
        }
        j++;
        while (isSpace(xml[j])) {
          j++;
        }
        const quote = xml[j];
        if (quote === '"' || quote === "'") {
          const end = xml.indexOf(quote, j + 1);
          if (end < 0) {
            j = n;
            break;
          }
          if (end - j - 1 <= MAX_ATTRIBUTE && key) {
            attrs.set(key, xml.slice(j + 1, end));
          }
          j = end + 1;
        } else {
          while (j < n && !isSpace(xml[j]) && xml[j] !== '>') {
            j++;
          }
        }
      }
    }
    if (onOpen({ name, attrs, selfClosing }) === false) {
      return;
    }
    i = xml.indexOf('<', j);
  }
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

function derivationLabel(a: Map<string, string> | undefined): string | undefined {
  if (!a) {
    return undefined;
  }
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
  // An entry is the file-entry element and the elements inside it. A cut one is
  // closed by the next file-entry or the end of the text, and a self-closing
  // one has no children, so a comment or text after it belongs to nothing.
  let entries = 0;
  let open: { encrypted: boolean; algorithm?: string; kdf?: string } | undefined;
  const finish = (): void => {
    if (open?.encrypted) {
      out.encrypted++;
      algorithms.add(algorithmLabel(open.algorithm));
      if (open.kdf) {
        derivations.add(open.kdf);
      }
    }
    open = undefined;
  };
  walk(
    xml,
    (tag) => {
      if (tag.name === 'file-entry') {
        finish();
        if (entries++ >= MAX_ENTRIES) {
          return false;
        }
        const path = tag.attrs.get('full-path');
        if (path === undefined || path.endsWith('/')) {
          return;
        }
        out.total++;
        if (!tag.selfClosing) {
          open = { encrypted: false };
        }
      } else if (open && tag.name === 'encryption-data') {
        open.encrypted = true;
      } else if (open?.encrypted && tag.name === 'algorithm' && open.algorithm === undefined) {
        open.algorithm = tag.attrs.get('algorithm-name') ?? '';
      } else if (open?.encrypted && tag.name === 'key-derivation' && open.kdf === undefined) {
        open.kdf = derivationLabel(tag.attrs) ?? '';
      }
    },
    (name) => {
      if (name === 'file-entry') {
        finish();
      }
    },
  );
  finish();
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
