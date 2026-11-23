// Building xar archives and macOS installer packages as exact bytes.
//
// Written from the xar format description (the header and table of contents in
// the xar project's documentation) and Apple's installer layout (Distribution,
// PackageInfo, Bom, Payload, Scripts), not from src/pkg/xar.ts.
//
// Layout: a 28-byte big-endian header, the zlib-compressed XML table of
// contents, then the heap. Heap offset 0 holds the table's own checksum, so
// file data starts at 20 as it does in real archives.
import { zlibSync } from 'fflate';
import { tlv } from '../pe/fixture';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const xmlEscape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface XarFile {
  name: string;
  /** Directories hold `children`; files hold `data`. */
  children?: XarFile[];
  data?: Uint8Array | string;
  /** How the data is stored. `zlib` is what xar calls application/x-gzip. */
  encoding?: 'zlib' | 'stored' | 'bzip2';
  /** Replace the extracted size the table declares. */
  declaredSize?: number;
  /** Replace the stored length the table declares. */
  declaredLength?: number;
  /** Replace the heap offset the table declares. */
  declaredOffset?: number;
}

export interface XarSpec {
  files?: XarFile[];
  creationTime?: string;
  /** A bare DER certificate for the table's RSA signature. */
  certificate?: Uint8Array;
  /** Raw XML to use as the table instead of building one. */
  rawToc?: string;
}

const ENCODING_STYLE = {
  zlib: 'application/x-gzip',
  stored: 'application/octet-stream',
  bzip2: 'application/x-bzip2',
};

export function buildXar(spec: XarSpec = {}): Uint8Array {
  const heap: Uint8Array[] = [new Uint8Array(20)];
  let heapLength = 20;
  let id = 0;

  const fileXml = (file: XarFile): string => {
    id++;
    const name = `<name>${xmlEscape(file.name)}</name>`;
    if (file.children) {
      return `<file id="${id}">${name}<type>directory</type>${file.children.map(fileXml).join('')}</file>`;
    }
    const raw = typeof file.data === 'string' ? utf8(file.data) : (file.data ?? new Uint8Array(0));
    const encoding = file.encoding ?? 'stored';
    const stored = encoding === 'zlib' ? zlibSync(raw) : raw;
    const offset = heapLength;
    heap.push(stored);
    heapLength += stored.length;
    return (
      `<file id="${id}">${name}<type>file</type><data>` +
      `<length>${file.declaredLength ?? stored.length}</length>` +
      `<offset>${file.declaredOffset ?? offset}</offset>` +
      `<size>${file.declaredSize ?? raw.length}</size>` +
      `<encoding style="${ENCODING_STYLE[encoding]}"/>` +
      `</data></file>`
    );
  };

  const filesXml = (spec.files ?? []).map(fileXml).join('');
  const signature = spec.certificate
    ? `<signature style="RSA"><offset>20</offset><size>256</size><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data>` +
      `<X509Certificate>${btoa(String.fromCharCode(...spec.certificate))}</X509Certificate></X509Data></KeyInfo></signature>`
    : '';
  const tocXml =
    spec.rawToc ??
    `<?xml version="1.0" encoding="UTF-8"?><xar><toc>` +
      `<creation-time>${spec.creationTime ?? '2024-03-05T10:20:30'}</creation-time>` +
      `<checksum style="sha1"><offset>0</offset><size>20</size></checksum>${signature}${filesXml}</toc></xar>`;
  const tocRaw = utf8(tocXml);
  const toc = zlibSync(tocRaw);

  const header = new DataView(new ArrayBuffer(28));
  header.setUint32(0, 0x78617221, false); // "xar!"
  header.setUint16(4, 28, false);
  header.setUint16(6, 1, false);
  header.setBigUint64(8, BigInt(toc.length), false);
  header.setBigUint64(16, BigInt(tocRaw.length), false);
  header.setUint32(24, 1, false); // SHA-1

  const out = new Uint8Array(28 + toc.length + heapLength);
  out.set(new Uint8Array(header.buffer), 0);
  out.set(toc, 28);
  let at = 28 + toc.length;
  for (const part of heap) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---- Installer documents -------------------------------------------------

export interface PackageInfoSpec {
  identifier?: string;
  version?: string;
  installLocation?: string;
  auth?: string;
  installKBytes?: number;
  numberOfFiles?: number;
  preinstall?: boolean;
  postinstall?: boolean;
  bundles?: { id: string; version?: string; path?: string }[];
}

export function packageInfoXml(spec: PackageInfoSpec = {}): string {
  const attrs = [
    ['format-version', '2'],
    ['identifier', spec.identifier ?? 'com.example.tool'],
    ['version', spec.version ?? '1.2.3'],
    ['install-location', spec.installLocation ?? '/usr/local'],
    ['auth', spec.auth ?? 'root'],
  ]
    .map(([k, v]) => `${k}="${xmlEscape(v)}"`)
    .join(' ');
  const scripts =
    spec.preinstall || spec.postinstall
      ? `<scripts>${spec.preinstall ? '<preinstall file="./preinstall"/>' : ''}${spec.postinstall ? '<postinstall file="./postinstall"/>' : ''}</scripts>`
      : '';
  const bundles = (spec.bundles ?? [])
    .map(
      (b) =>
        `<bundle id="${xmlEscape(b.id)}" CFBundleShortVersionString="${xmlEscape(b.version ?? '')}" path="${xmlEscape(b.path ?? '')}"/>`,
    )
    .join('');
  return (
    `<?xml version="1.0" encoding="utf-8"?><pkg-info ${attrs}>` +
    `<payload installKBytes="${spec.installKBytes ?? 2048}" numberOfFiles="${spec.numberOfFiles ?? 12}"/>` +
    `${scripts}<bundle-version>${bundles}</bundle-version></pkg-info>`
  );
}

export interface DistributionSpec {
  title?: string;
  hostArchitectures?: string;
  minOs?: string;
  installationCheck?: boolean;
  license?: string;
  readme?: string;
  choices?: string[];
  refs?: { id: string; version?: string; installKBytes?: number }[];
  version?: string;
}

export function distributionXml(spec: DistributionSpec = {}): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><installer-gui-script minSpecVersion="2">` +
    `<title>${xmlEscape(spec.title ?? 'Example Tool')}</title>` +
    (spec.version
      ? `<product id="com.example.product" version="${xmlEscape(spec.version)}"/>`
      : '') +
    `<options customize="never" require-scripts="true" hostArchitectures="${spec.hostArchitectures ?? 'x86_64,arm64'}"/>` +
    `<volume-check><allowed-os-versions><os-version min="${spec.minOs ?? '10.13'}"/></allowed-os-versions></volume-check>` +
    (spec.installationCheck ? `<installation-check script="installCheck();"/>` : '') +
    (spec.license ? `<license file="${xmlEscape(spec.license)}"/>` : '') +
    (spec.readme ? `<readme file="${xmlEscape(spec.readme)}"/>` : '') +
    (spec.choices ?? []).map((c, i) => `<choice id="c${i}" title="${xmlEscape(c)}"/>`).join('') +
    (spec.refs ?? [])
      .map(
        (r) =>
          `<pkg-ref id="${xmlEscape(r.id)}"${r.version ? ` version="${xmlEscape(r.version)}"` : ''}` +
          `${r.installKBytes === undefined ? '' : ` installKBytes="${r.installKBytes}"`}>${xmlEscape(r.id)}.pkg</pkg-ref>`,
      )
      .join('') +
    `</installer-gui-script>`
  );
}

/** A bare X.509 certificate with a subject, an issuer and a validity period, as an installer signature carries. */
export function buildCertificate(subject: string, issuer: string): Uint8Array {
  const SEQUENCE = 0x30;
  const SET = 0x31;
  const oid = (...bytes: number[]): Uint8Array => tlv(0x06, Uint8Array.from(bytes));
  const rdn = (value: string): Uint8Array =>
    tlv(SEQUENCE, tlv(SET, tlv(SEQUENCE, oid(0x55, 0x04, 0x03), tlv(0x0c, utf8(value)))));
  const algorithm = tlv(
    SEQUENCE,
    oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b),
    tlv(0x05),
  );
  const tbs = tlv(
    SEQUENCE,
    tlv(0xa0, tlv(0x02, Uint8Array.from([2]))),
    tlv(0x02, Uint8Array.from([1])),
    algorithm,
    rdn(issuer),
    tlv(SEQUENCE, tlv(0x17, utf8('230615000000Z')), tlv(0x17, utf8('260615235959Z'))),
    rdn(subject),
    tlv(SEQUENCE, algorithm, tlv(0x03, Uint8Array.from([0, 1, 2, 3]))),
  );
  return tlv(SEQUENCE, tbs, algorithm, tlv(0x03, Uint8Array.from([0, 9])));
}

/** A product archive: a Distribution and one component directory. */
export function buildProduct(
  options: {
    distribution?: DistributionSpec;
    components?: { dir: string; info?: PackageInfoSpec; scripts?: boolean; gzip?: boolean }[];
    certificate?: Uint8Array;
  } = {},
): Uint8Array {
  const components = options.components ?? [{ dir: 'Tool.pkg', scripts: true }];
  return buildXar({
    certificate: options.certificate,
    files: [
      {
        name: 'Distribution',
        data: distributionXml(options.distribution),
        encoding: 'zlib',
      },
      ...components.map((c) => ({
        name: c.dir,
        children: [
          {
            name: 'PackageInfo',
            data: packageInfoXml(c.info),
            encoding: c.gzip === false ? ('stored' as const) : ('zlib' as const),
          },
          { name: 'Bom', data: 'BOMStore', encoding: 'zlib' as const },
          { name: 'Payload', data: 'x'.repeat(100), encoding: 'zlib' as const },
          ...(c.scripts ? [{ name: 'Scripts', data: 'scripts', encoding: 'zlib' as const }] : []),
        ],
      })),
    ],
  });
}
