// xar archive reader, with the extra reading a macOS installer (.pkg) needs.
//
// A xar file is a 28-byte big-endian header, a zlib-compressed XML table of
// contents, then a "heap" that holds every file's bytes at offsets given in the
// table. An installer package is a xar whose entries follow Apple's layout: a
// product archive has a `Distribution` file plus one directory per component
// package; a flat component package has `PackageInfo`, `Bom`, `Payload` and
// `Scripts` at its root. Only the table and the two small XML files are read;
// payloads and scripts are never opened.
import { Unzlib } from 'fflate';
import { formatBytes, formatNumber } from '../binary/html';
import { printable } from '../binary/text';
import type { RangeReader } from '../binary/reader';
import { parseXmlBounded } from '../binary/xml';
import { attr } from '../ooxml/xml';
import { child, children, findAll, type XNode } from '../ooxml/xnode';
import { gunzipBounded } from './decompress';
import { PackageError, propertySection, tableSection } from './model';
import type { InfoSection, PackageInfo } from './model';
import { readCertificate, signatureSection } from './signature';

const HEADER_SIZE = 28;
// Compressed, the table may be as large as the reader's largest single read.
const MAX_TOC_COMPRESSED = 4 * 1024 * 1024;
// The tables of contents seen (a few KB for a product archive, tens of KB for a
// flat package) are far below this; 8 MiB inflated leaves room for an archive
// that lists tens of thousands of files and stops a bomb early.
const MAX_TOC = 8 * 1024 * 1024;
// A tree costs about 100 times its text, so the element count, not the text,
// is what bounds memory: 200,000 elements is roughly 20,000 files.
const MAX_TOC_NODES = 100_000;
// Distribution and PackageInfo are small documents; 20,000 elements is far past a real one.
const MAX_INFO_NODES = 20_000;
// Distribution and PackageInfo are tens of KB; localised Distribution files reach a few hundred.
const MAX_INFO_COMPRESSED = 1024 * 1024;
const MAX_INFO = 2 * 1024 * 1024;
// Each push can inflate at most about 1000 times its size, so small slices keep
// the work done after the output cap is crossed to a few megabytes.
const INFLATE_SLICE = 4096;
// Entries walked in the table, and how deep directories may nest.
const MAX_ENTRIES = 50_000;
// A file name is at most 255 characters on every file system this archive could
// come from; a path is cut at 1,024. Without these a long directory name is
// copied into every child's path.
const MAX_NAME = 255;
const MAX_PATH = 1024;
// Characters of path kept across all entries, so entries times path length
// cannot add up to more than this.
const MAX_PATH_CHARS = 4 * 1024 * 1024;
// Strings from attributes and elements (identifiers, versions, titles).
const MAX_TEXT = 512;
const MAX_REFS = 200;
const MAX_DEPTH = 32;
const MAX_ROWS = 200;
const MAX_COMPONENTS = 64;
const MAX_BUNDLES = 200;
const MAX_CHOICES = 100;
const MAX_CERTIFICATE_BYTES = 64 * 1024;

interface Entry {
  path: string;
  isFile: boolean;
  size: number;
  length: number;
  offset: number;
  encoding: string;
}

interface Component {
  /** Directory the component's files live in, '' for a flat package. */
  dir: string;
  identifier?: string;
  version?: string;
  installLocation?: string;
  auth?: string;
  installKBytes?: number;
  files?: number;
  preinstall: boolean;
  postinstall: boolean;
  hasScriptsArchive: boolean;
  bundles: { id: string; version?: string; path?: string }[];
}

/**
 * Inflate a zlib stream (RFC 1950), stopping at `cap` bytes of output.
 *
 * xar specifies zlib for the table of contents and for entries marked
 * `application/x-gzip` (Apple's xar writes them with zlib's deflate and the
 * two-byte zlib header; xar/lib/zxar.c and xar/lib/archive.c). The header is
 * checked here and Unzlib is used rather than the auto-detecting Decompress: a
 * gzip wrapper carries variable-length header fields that fflate rescans on
 * every push, which turns a slow feed into quadratic work before any output
 * exists for the cap to count.
 */
function unzlibCapped(input: Uint8Array, cap: number): { data: Uint8Array; truncated: boolean } {
  if (input.length < 2) {
    throw new PackageError('its compressed data is not a zlib stream.');
  }
  const cmf = input[0];
  const flg = input[1];
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 0x20) !== 0) {
    throw new PackageError('its compressed data is not a zlib stream.');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const stream = new Unzlib((chunk) => {
    if (truncated) {
      return;
    }
    if (total + chunk.length > cap) {
      chunks.push(chunk.subarray(0, cap - total));
      total = cap;
      truncated = true;
      return;
    }
    chunks.push(chunk);
    total += chunk.length;
  });
  for (let at = 0; at < input.length && !truncated; at += INFLATE_SLICE) {
    stream.push(input.subarray(at, at + INFLATE_SLICE), at + INFLATE_SLICE >= input.length);
  }
  const data = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    data.set(c, pos);
    pos += c.length;
  }
  return { data, truncated };
}

// Cut before trimming and cleaning: the text of an element may be megabytes.
const text = (node: XNode | undefined, max = MAX_TEXT): string =>
  printable((node?.text ?? '').slice(0, max).trim());
const int = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d+$/.test(value.slice(0, 32).trim())) {
    return undefined;
  }
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) ? n : undefined;
};
const attrText = (node: XNode | undefined, name: string): string | undefined => {
  const v = node?.attrs[name];
  return v === undefined ? undefined : printable(v.slice(0, MAX_TEXT).trim()) || undefined;
};

function utcDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime())
    ? undefined
    : `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

// A name that is not Latin-1 is written by Apple's xar as <name enctype="base64">
// holding the UTF-8 bytes in Base64 (xar/lib/filetree.c, xar_prop_serialize and
// xar_prop_unserialize); its reader accepts exactly enctype="base64" on a
// `name` element. 255 characters need at most 1,020 UTF-8 bytes, so only the
// first 1,360 Base64 characters are ever decoded.
const MAX_NAME_BASE64 = 1360;
const DIVISION_SLASH = String.fromCharCode(0x2215);

function decodeBase64Name(raw: string): string | undefined {
  // Slice first, so whitespace padding in a hostile name cannot cost a scan of megabytes.
  const chars = raw
    .slice(0, 4096)
    .replace(/[^A-Za-z0-9+/=]/g, '')
    .slice(0, MAX_NAME_BASE64);
  if (chars === '') {
    return undefined;
  }
  try {
    const binary = atob(chars);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    // Malformed Base64: show the text as written rather than nothing.
    return undefined;
  }
}

/**
 * One entry's name as displayed. A slash inside a single name would read as a
 * path separator and let an entry pose as another (an encoded name can decode
 * to anything), so it is shown as a look-alike character.
 */
function entryName(node: XNode | undefined): string {
  if (!node) {
    return '';
  }
  const decoded =
    attr(node.attrs, 'enctype') === 'base64' ? decodeBase64Name(node.text) : undefined;
  const name = printable((decoded ?? node.text.slice(0, MAX_NAME)).slice(0, MAX_NAME).trim());
  return name.split('/').join(DIVISION_SLASH);
}

/** Every file entry in the table, with the path built from the directories around it. */
function walkEntries(toc: XNode): { entries: Entry[]; truncated: boolean } {
  const entries: Entry[] = [];
  let pathChars = 0;
  const stack: { node: XNode; prefix: string; depth: number }[] = [];
  const push = (parent: XNode, prefix: string, depth: number): void => {
    const kids = children(parent, 'file');
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ node: kids[i], prefix, depth });
    }
  };
  push(toc, '', 0);
  while (stack.length > 0) {
    if (entries.length >= MAX_ENTRIES || pathChars >= MAX_PATH_CHARS) {
      return { entries, truncated: true };
    }
    const { node, prefix, depth } = stack.pop() as (typeof stack)[number];
    const path = `${prefix}${entryName(child(node, 'name'))}`.slice(0, MAX_PATH);
    pathChars += path.length;
    const data = child(node, 'data');
    const type = text(child(node, 'type'));
    entries.push({
      path,
      isFile: type === 'file' || (type === '' && data !== undefined),
      size: int(child(data ?? node, 'size')?.text) ?? 0,
      length: int(child(data ?? node, 'length')?.text) ?? 0,
      offset: int(child(data ?? node, 'offset')?.text) ?? -1,
      encoding: data ? (attrText(child(data, 'encoding'), 'style') ?? '') : '',
    });
    if (depth < MAX_DEPTH) {
      push(node, path.length < MAX_PATH ? `${path}/` : path, depth + 1);
    }
  }
  return { entries, truncated: false };
}

/** The (possibly compressed) XML file stored at `entry`, parsed. */
async function readXmlEntry(
  reader: RangeReader,
  heapStart: number,
  entry: Entry,
): Promise<XNode | undefined> {
  if (entry.offset < 0 || entry.length > MAX_INFO_COMPRESSED) {
    return undefined;
  }
  const stored = await reader.bytes(heapStart + entry.offset, entry.length);
  const style = entry.encoding;
  let bytes: Uint8Array;
  if (style === '' || style === 'application/octet-stream') {
    bytes = stored;
  } else if (style === 'application/x-gzip' || style === 'application/x-deflate') {
    // "gzip" in xar is zlib in practice. A true gzip member is the only other
    // thing seen, and goes through the bounded gzip reader; anything else is refused.
    if (stored[0] === 0x1f && stored[1] === 0x8b) {
      bytes = gunzipBounded(stored, MAX_INFO);
    } else {
      const out = unzlibCapped(stored, MAX_INFO);
      if (out.truncated) {
        return undefined;
      }
      bytes = out.data;
    }
  } else {
    // bzip2 and lzma are legal in xar but no installer is written with them.
    return undefined;
  }
  return parseXmlBounded(new TextDecoder().decode(bytes), {
    maxNodes: MAX_INFO_NODES,
    maxChars: MAX_INFO,
  });
}

function readComponent(root: XNode, dir: string, entries: Map<string, Entry>): Component {
  const payload = child(root, 'payload');
  const scripts = child(root, 'scripts');
  const versions = child(root, 'bundle-version');
  // pkgbuild describes a bundle in a <bundle> directly under the root (its
  // path and versions) and then lists the same id again, bare, under
  // <bundle-version>. Older tools put the whole description in the second
  // place. Both are read and merged by id, so neither layout leaves the
  // version and path blank.
  const merged = new Map<string, { id: string; version?: string; path?: string }>();
  const mentions = [...children(root, 'bundle'), ...(versions ? findAll(versions, 'bundle') : [])];
  for (const b of mentions.slice(0, MAX_BUNDLES * 2)) {
    const id = attrText(b, 'id') ?? '';
    const prior = merged.get(id);
    merged.set(id, {
      id,
      version:
        attrText(b, 'CFBundleShortVersionString') ??
        attrText(b, 'CFBundleVersion') ??
        prior?.version,
      path: attrText(b, 'path') ?? prior?.path,
    });
  }
  const bundles = [...merged.values()].slice(0, MAX_BUNDLES);
  return {
    dir,
    identifier: attrText(root, 'identifier'),
    version: attrText(root, 'version'),
    installLocation: attrText(root, 'install-location'),
    auth: attrText(root, 'auth'),
    installKBytes: int(payload?.attrs.installKBytes),
    files: int(payload?.attrs.numberOfFiles),
    preinstall: scripts !== undefined && child(scripts, 'preinstall') !== undefined,
    postinstall: scripts !== undefined && child(scripts, 'postinstall') !== undefined,
    hasScriptsArchive: entries.has(dir ? `${dir}/Scripts` : 'Scripts'),
    bundles,
  };
}

interface Distribution {
  title?: string;
  version?: string;
  hostArchitectures?: string;
  minOs?: string;
  checks: boolean;
  licence?: string;
  readme?: string;
  choices: string[];
  refs: { id: string; version?: string; installKBytes?: number }[];
}

function readDistribution(root: XNode): Distribution {
  const titles = findAll(root, 'title').map((t) => text(t));
  const options = findAll(root, 'options')[0];
  const refs = new Map<string, { id: string; version?: string; installKBytes?: number }>();
  for (const ref of findAll(root, 'pkg-ref')) {
    if (refs.size >= MAX_REFS) {
      break;
    }
    const id = attrText(ref, 'id');
    if (!id) {
      continue;
    }
    const prior = refs.get(id) ?? { id };
    prior.version ??= attrText(ref, 'version');
    prior.installKBytes ??= int(ref.attrs.installKBytes);
    refs.set(id, prior);
  }
  const choices: string[] = [];
  for (const c of findAll(root, 'choice')) {
    const title = attrText(c, 'title');
    if (title && !choices.includes(title) && choices.length < MAX_CHOICES) {
      choices.push(title);
    }
  }
  return {
    title: titles.find((t) => t !== ''),
    version: attrText(findAll(root, 'product')[0], 'version'),
    hostArchitectures: attrText(options, 'hostArchitectures'),
    minOs: findAll(root, 'os-version')
      .map((n) => attrText(n, 'min'))
      .find((v) => v),
    checks: findAll(root, 'installation-check').length > 0,
    licence: attrText(findAll(root, 'license')[0], 'file'),
    readme: attrText(findAll(root, 'readme')[0], 'file'),
    choices,
    refs: [...refs.values()],
  };
}

function signatureFrom(toc: XNode): InfoSection[] {
  const sig = child(toc, 'signature') ?? child(toc, 'x-signature');
  if (!sig) {
    return [];
  }
  const cert = findAll(sig, 'X509Certificate')[0];
  let signer;
  if (cert) {
    try {
      const base64 = (cert.text.length > MAX_CERTIFICATE_BYTES * 2 ? '' : cert.text).replace(
        /[^A-Za-z0-9+/=]/g,
        '',
      );
      if (base64.length > 0 && base64.length <= Math.ceil((MAX_CERTIFICATE_BYTES * 4) / 3)) {
        const raw = atob(base64);
        signer = readCertificate(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
      }
    } catch {
      signer = undefined;
    }
  }
  return [signatureSection('Apple installer', signer)];
}

export async function readXar(reader: RangeReader): Promise<PackageInfo> {
  if (reader.size < HEADER_SIZE) {
    throw new PackageError('it is too short to be a xar archive.');
  }
  const head = await reader.view(0, HEADER_SIZE);
  if (head.getUint32(0, false) !== 0x78617221) {
    throw new PackageError('it is not a xar archive.');
  }
  const headerSize = head.getUint16(4, false);
  const tocCompressed = Number(head.getBigUint64(8, false));
  const tocLength = Number(head.getBigUint64(16, false));
  if (headerSize < HEADER_SIZE || headerSize > reader.size) {
    throw new PackageError('its xar header is damaged.');
  }
  if (tocCompressed > MAX_TOC_COMPRESSED || tocLength > MAX_TOC) {
    throw new PackageError('its table of contents is larger than MarkCopy will read.');
  }
  if (headerSize + tocCompressed > reader.size) {
    throw new PackageError('the file ends before its table of contents does.');
  }
  const heapStart = headerSize + tocCompressed;

  let toc: XNode;
  try {
    const out = unzlibCapped(await reader.bytes(headerSize, tocCompressed), MAX_TOC);
    if (out.truncated) {
      throw new PackageError('its table of contents is larger than MarkCopy will read.');
    }
    const root = parseXmlBounded(new TextDecoder().decode(out.data), {
      maxNodes: MAX_TOC_NODES,
      maxChars: MAX_TOC,
    });
    const found = child(child(root, 'xar') ?? root, 'toc');
    if (!found) {
      throw new PackageError('it has no table of contents.');
    }
    toc = found;
  } catch (e) {
    if (e instanceof PackageError) {
      throw e;
    }
    throw new PackageError('its table of contents could not be read.');
  }

  const warnings: string[] = [];
  const { entries, truncated } = walkEntries(toc);
  if (truncated) {
    warnings.push(
      'The archive lists more entries than MarkCopy will read, so the file list is partial.',
    );
  }
  const byPath = new Map<string, Entry>();
  for (const e of entries) {
    byPath.set(e.path, e);
  }

  // Distribution and PackageInfo identify an installer. A parse failure in one
  // is a warning: the archive is still a xar archive with a file list.
  let distribution: Distribution | undefined;
  const distributionEntry = byPath.get('Distribution');
  if (distributionEntry) {
    try {
      const root = await readXmlEntry(reader, heapStart, distributionEntry);
      if (root) {
        distribution = readDistribution(root);
      } else {
        warnings.push('The Distribution file could not be read.');
      }
    } catch {
      warnings.push('The Distribution file could not be read.');
    }
  }
  const components: Component[] = [];
  const infoEntries = entries.filter((e) => e.isFile && /(^|\/)PackageInfo$/.test(e.path));
  if (infoEntries.length > MAX_COMPONENTS) {
    warnings.push(`Only the first ${MAX_COMPONENTS} of ${infoEntries.length} packages were read.`);
  }
  for (const e of infoEntries.slice(0, MAX_COMPONENTS)) {
    try {
      const root = await readXmlEntry(reader, heapStart, e);
      const info = root ? child(root, 'pkg-info') : undefined;
      if (info) {
        components.push(readComponent(info, e.path.slice(0, -'PackageInfo'.length - 1), byPath));
      } else {
        warnings.push(`The package description at ${e.path} could not be read.`);
      }
    } catch {
      warnings.push(`The package description at ${e.path} could not be read.`);
    }
  }

  const isInstaller = distribution !== undefined || infoEntries.length > 0;
  const files = entries.filter((e) => e.isFile);
  const totalSize = files.reduce((sum, e) => sum + e.size, 0);
  const contents = tableSection(
    'Contents',
    ['Path', 'Size'],
    files.slice(0, MAX_ROWS).map((e) => [e.path, formatBytes(e.size)]),
    {
      total: files.length,
      noun: 'files',
      lead: `${formatNumber(files.length)} ${files.length === 1 ? 'file' : 'files'}, ${formatBytes(totalSize)} when extracted.`,
    },
  );
  const created = utcDate(text(child(toc, 'creation-time')));
  const signature = signatureFrom(toc);

  if (!isInstaller) {
    return {
      format: 'xar archive',
      summary: `A xar archive of ${formatNumber(files.length)} ${files.length === 1 ? 'file' : 'files'}.`,
      sections: [...propertySection('Archive', [['Created', created]]), ...contents, ...signature],
      warnings,
    };
  }

  // Components come from each PackageInfo; a product archive that only
  // references its packages by id falls back to the Distribution's pkg-refs.
  const single = components.length === 1 ? components[0] : undefined;
  const fromRefs = components.length === 0 ? (distribution?.refs ?? []) : [];
  const installKBytes =
    components.length > 0
      ? components.reduce((s, c) => s + (c.installKBytes ?? 0), 0)
      : fromRefs.reduce((s, r) => s + (r.installKBytes ?? 0), 0);
  const fileCount = components.reduce((s, c) => s + (c.files ?? 0), 0);
  const asRoot = components.some((c) => c.auth === 'root');
  const version = distribution?.version ?? single?.version;
  const name = distribution?.title ?? single?.identifier;

  const componentRows = [
    ...components.map((c) => [
      c.identifier ?? c.dir ?? '',
      c.version ?? '',
      c.installLocation ?? '',
      c.installKBytes === undefined ? '' : formatBytes(c.installKBytes * 1024),
    ]),
    ...fromRefs.map((r) => [
      r.id,
      r.version ?? '',
      '',
      r.installKBytes === undefined ? '' : formatBytes(r.installKBytes * 1024),
    ]),
  ];
  const bundleRows = components.flatMap((c) =>
    c.bundles.map((b) => [b.id, b.version ?? '', b.path ?? '']),
  );
  const scriptRows = components
    .filter((c) => c.preinstall || c.postinstall || c.hasScriptsArchive)
    .map((c) => [
      c.identifier ?? c.dir,
      [c.preinstall ? 'preinstall' : '', c.postinstall ? 'postinstall' : '']
        .filter(Boolean)
        .join(', ') || 'scripts archive only',
      c.auth === 'root' ? 'root' : 'not stated',
    ]);

  return {
    format: 'macOS installer package',
    title: name ? (version ? `${name} ${version}` : name) : undefined,
    summary: distribution
      ? `A macOS product archive of ${components.length || fromRefs.length} ${components.length + fromRefs.length === 1 ? 'package' : 'packages'}.`
      : 'A macOS component package.',
    sections: [
      ...propertySection('Package', [
        ['Title', distribution?.title],
        ['Identifier', single?.identifier],
        ['Version', version],
        ['Install location', single?.installLocation],
        ['Installs as root', asRoot ? 'Yes' : components.length > 0 ? 'No' : undefined],
        ['Host architectures', distribution?.hostArchitectures],
        ['Minimum macOS', distribution?.minOs],
        ['Installed size', installKBytes > 0 ? formatBytes(installKBytes * 1024) : undefined],
        ['Files installed', fileCount > 0 ? formatNumber(fileCount) : undefined],
        [
          'Installation checks',
          distribution?.checks
            ? 'Yes (runs JavaScript to decide whether it can install)'
            : undefined,
        ],
        ['License', distribution?.licence],
        ['Read me', distribution?.readme],
        ['Created', created],
      ]),
      ...tableSection(
        'Components',
        ['Identifier', 'Version', 'Install location', 'Installed size'],
        componentRows,
        { noun: 'components' },
      ),
      ...tableSection(
        'Choices',
        ['Title'],
        (distribution?.choices ?? []).map((c) => [c]),
        {
          noun: 'choices',
        },
      ),
      ...tableSection('Bundles', ['Bundle', 'Version', 'Path'], bundleRows, {
        limit: MAX_BUNDLES,
        noun: 'bundles',
      }),
      ...tableSection('Scripts', ['Component', 'Scripts', 'Runs as'], scriptRows, {
        noun: 'components',
        lead: 'These components carry installer scripts. MarkCopy does not show them; they run during installation with the permissions listed.',
      }),
      ...contents,
      ...signature,
    ],
    warnings,
  };
}
