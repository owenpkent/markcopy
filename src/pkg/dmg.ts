// Apple disk image (.dmg) reader.
//
// A UDIF image ends with a 512-byte "koly" trailer. It points at an XML
// property list that holds one "mish" table per partition, and each table lists
// the chunks the partition is stored in. Layouts come from the UDIF
// descriptions that open-source implementations share (libdmg-hfsplus, the
// Rust apple-dmg crate); the trailer fields are all big-endian.
//
// Only the trailer, the property list and the optional code signature are
// read. The file system inside the image is not: reading it would mean
// decompressing gigabytes and walking HFS+ or APFS, which is a different tool.
import { formatBytes } from '../binary/html';
import { printable } from '../binary/text';
import type { RangeReader } from '../binary/reader';
import { child, parseXml, type XNode } from '../ooxml/xnode';
import { PackageError, propertySection, tableSection } from './model';
import type { InfoSection, PackageInfo } from './model';
import { readSigner, signatureSection } from './signature';

const KOLY_SIZE = 512;
const SECTOR = 512;
// A property list lists a few KB per partition. 4 MiB is the reader's largest
// single read and is far beyond any real image's list.
const MAX_PLIST_BYTES = 4 * 1024 * 1024;
// One partition's mish table: 204 header bytes and 40 per chunk. 2 MiB is
// 50,000 chunks, enough for a 50 GB partition stored in 1 MiB chunks.
const MAX_MISH_BYTES = 2 * 1024 * 1024;
const MISH_HEADER = 204;
const CHUNK_SIZE = 40;
// A real image has at most a dozen partitions (GPT headers, free space, the volumes).
const MAX_PARTITIONS = 64;
// A CMS signature with its certificate chain is a few KB.
const MAX_SIGNATURE_BYTES = 256 * 1024;
const MAX_SIGNATURE_BLOBS = 16;

const CHECKSUMS: Record<number, string> = { 0: 'None', 1: 'CRC-28', 2: 'CRC-32' };

const CHUNK_KINDS: Record<number, string> = {
  0: 'Zero-fill',
  1: 'Uncompressed',
  0x80000004: 'ADC',
  0x80000005: 'zlib',
  0x80000006: 'bzip2',
  0x80000007: 'LZFSE',
  0x80000008: 'LZMA',
};
// Chunks that hold no data and so say nothing about how the image is compressed.
const IGNORED_CHUNKS = new Set([2, 0x7ffffffe, 0xffffffff]);

const GENERIC_NAMES = new Set([
  'disk image',
  'Protective Master Boot Record',
  'GPT Header',
  'GPT Partition Data',
  'Primary GPT Header',
  'Primary GPT Table',
  'Backup GPT Header',
  'Backup GPT Table',
  'Apple_Free',
]);

const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

/** True for a file whose last 512 bytes are a UDIF trailer, or that is an encrypted image. Never throws. */
export async function looksLikeDmg(reader: RangeReader): Promise<boolean> {
  try {
    if (reader.size >= 8) {
      if (ascii(await reader.bytes(0, 8)) === 'encrcdsa') {
        return true;
      }
      if (ascii(await reader.bytes(reader.size - 8, 8)) === 'cdsaencr') {
        return true;
      }
    }
    if (reader.size >= KOLY_SIZE) {
      return ascii(await reader.bytes(reader.size - KOLY_SIZE, 4)) === 'koly';
    }
    return false;
  } catch {
    return false;
  }
}

interface Partition {
  name: string;
  volume?: string;
  sectors: number;
  kinds: string[];
}

/** The value node that follows `key` in a property-list dictionary. */
function dictGet(dict: XNode | undefined, key: string): XNode | undefined {
  if (!dict) {
    return undefined;
  }
  for (let i = 0; i + 1 < dict.children.length; i++) {
    const k = dict.children[i];
    if (k.name === 'key' && k.text.trim() === key) {
      return dict.children[i + 1];
    }
  }
  return undefined;
}

function decodeBase64(text: string, maxBytes: number): Uint8Array {
  // The property list wraps its base64 across lines and tabs.
  let clean = text.replace(/[^A-Za-z0-9+/=]/g, '');
  const limit = Math.ceil(maxBytes / 3) * 4;
  if (clean.length > limit) {
    // Cut at a whole group of four so the prefix still decodes.
    clean = clean.slice(0, limit);
  }
  const raw = atob(clean);
  const out = new Uint8Array(Math.min(raw.length, maxBytes));
  for (let i = 0; i < out.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

/** "Mac_OS_X (Apple_HFS : 2)" is a volume name, a partition type and an index. */
function splitName(name: string): { volume?: string } {
  const m = /^(.*) \([^()]* : \d+\)$/.exec(name);
  const volume = m?.[1].trim();
  return volume && !GENERIC_NAMES.has(volume) ? { volume } : {};
}

function readMish(data: Uint8Array, name: string, warnings: string[]): Partition | undefined {
  if (data.length < MISH_HEADER || ascii(data.subarray(0, 4)) !== 'mish') {
    return undefined;
  }
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sectors = Number(v.getBigUint64(16, false));
  const declared = v.getUint32(200, false);
  // Count only the chunks the table really holds; the declared count is the file's claim.
  const available = Math.floor((data.length - MISH_HEADER) / CHUNK_SIZE);
  if (declared > available) {
    warnings.push(`The chunk list of "${name}" is cut short.`);
  }
  const kinds = new Set<number>();
  for (let i = 0; i < Math.min(declared, available); i++) {
    const type = v.getUint32(MISH_HEADER + i * CHUNK_SIZE, false);
    if (!IGNORED_CHUNKS.has(type)) {
      kinds.add(type);
    }
  }
  return {
    name,
    ...splitName(name),
    sectors,
    kinds: [...kinds]
      .sort((a, b) => a - b)
      .map((t) => CHUNK_KINDS[t] ?? `type 0x${t.toString(16)}`),
  };
}

async function readPartitions(
  reader: RangeReader,
  xmlOffset: number,
  xmlLength: number,
  warnings: string[],
): Promise<{ partitions: Partition[]; licence: boolean }> {
  if (xmlLength > MAX_PLIST_BYTES) {
    warnings.push('The partition list is larger than MarkCopy will read.');
    return { partitions: [], licence: false };
  }
  const plist = parseXml(new TextDecoder().decode(await reader.bytes(xmlOffset, xmlLength)));
  const root = child(plist, 'plist');
  const fork = dictGet(root ? child(root, 'dict') : undefined, 'resource-fork');
  const blkx = dictGet(fork, 'blkx');
  const licence = dictGet(fork, 'LPic') !== undefined;
  const partitions: Partition[] = [];
  const entries = blkx?.children ?? [];
  if (entries.length > MAX_PARTITIONS) {
    warnings.push(`Only the first ${MAX_PARTITIONS} of ${entries.length} partitions were read.`);
  }
  for (const entry of entries.slice(0, MAX_PARTITIONS)) {
    const label = printable(
      (dictGet(entry, 'Name')?.text ?? dictGet(entry, 'CFName')?.text ?? '').trim(),
    );
    const data = dictGet(entry, 'Data')?.text;
    if (data === undefined) {
      continue;
    }
    try {
      const partition = readMish(
        decodeBase64(data, MAX_MISH_BYTES),
        label || '(unnamed)',
        warnings,
      );
      if (partition) {
        partitions.push(partition);
      }
    } catch {
      warnings.push(`The partition "${label || '(unnamed)'}" could not be read.`);
    }
  }
  return { partitions, licence };
}

/** The signer of the code signature's CMS blob, from its SuperBlob wrapper. */
function readCodeSignature(blob: Uint8Array): { cms?: Uint8Array } {
  if (blob.length < 12) {
    return {};
  }
  const v = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (v.getUint32(0, false) !== 0xfade0cc0) {
    return {};
  }
  const count = Math.min(v.getUint32(8, false), MAX_SIGNATURE_BLOBS);
  for (let i = 0; i < count && 12 + i * 8 + 8 <= blob.length; i++) {
    const at = v.getUint32(12 + i * 8 + 4, false);
    if (at + 8 <= blob.length && v.getUint32(at, false) === 0xfade0b01) {
      const length = v.getUint32(at + 4, false);
      if (length >= 8 && at + length <= blob.length) {
        return { cms: blob.subarray(at + 8, at + length) };
      }
    }
  }
  return {};
}

export async function readDmg(reader: RangeReader): Promise<PackageInfo> {
  const warnings: string[] = [];
  if (reader.size >= 8) {
    const encrypted =
      ascii(await reader.bytes(0, 8)) === 'encrcdsa' ||
      ascii(await reader.bytes(reader.size - 8, 8)) === 'cdsaencr';
    if (encrypted) {
      return {
        format: 'Apple disk image (encrypted)',
        summary: 'An encrypted Apple disk image.',
        sections: [
          ...propertySection('Disk image', [
            ['Format', 'Apple disk image (UDIF)'],
            ['Encrypted', 'Yes'],
            ['Stored size', formatBytes(reader.size)],
          ]),
          {
            kind: 'text',
            heading: 'Contents',
            paragraphs: [
              'The image is encrypted, so nothing inside it can be shown without the password.',
            ],
          },
        ],
        warnings,
      };
    }
  }
  if (reader.size < KOLY_SIZE) {
    throw new PackageError('it is too short to be an Apple disk image.');
  }
  const v = await reader.view(reader.size - KOLY_SIZE, KOLY_SIZE);
  if (ascii(new Uint8Array(v.buffer, v.byteOffset, 4)) !== 'koly') {
    throw new PackageError('it does not end with an Apple disk image trailer.');
  }
  const u64 = (at: number): number => Number(v.getBigUint64(at, false));
  const flags = v.getUint32(12, false);
  const dataForkLength = u64(32);
  const segmentNumber = v.getUint32(56, false);
  const segmentCount = v.getUint32(60, false);
  const checksumType = v.getUint32(80, false);
  const xmlOffset = u64(216);
  const xmlLength = u64(224);
  const signatureOffset = u64(296);
  const signatureLength = u64(304);
  const sectorCount = u64(492);

  let partitions: Partition[] = [];
  let licence = false;
  if (xmlLength > 0) {
    try {
      ({ partitions, licence } = await readPartitions(reader, xmlOffset, xmlLength, warnings));
    } catch {
      warnings.push('The partition list could not be read.');
    }
  } else {
    warnings.push('The image has no partition list.');
  }

  const kinds = [...new Set(partitions.flatMap((p) => p.kinds))];
  const uncompressed = sectorCount * SECTOR;
  const largest = [...partitions].sort((a, b) => b.sectors - a.sectors).find((p) => p.volume);

  let signature: InfoSection[] = [];
  if (signatureLength > 0) {
    try {
      if (signatureLength > MAX_SIGNATURE_BYTES) {
        throw new PackageError('too large.');
      }
      const { cms } = readCodeSignature(await reader.bytes(signatureOffset, signatureLength));
      signature = [signatureSection('Apple code signing', cms ? readSigner(cms) : undefined)];
    } catch {
      warnings.push('The code signature could not be read.');
    }
  }

  return {
    format: 'Apple disk image',
    title: largest?.volume,
    summary: 'An Apple disk image (UDIF).',
    sections: [
      ...propertySection('Disk image', [
        ['Format', 'Apple disk image (UDIF)'],
        [
          'Uncompressed size',
          Number.isSafeInteger(uncompressed) && sectorCount > 0
            ? formatBytes(uncompressed)
            : undefined,
        ],
        [
          'Stored size',
          dataForkLength > 0 && dataForkLength <= reader.size
            ? formatBytes(dataForkLength)
            : undefined,
        ],
        ['Compression', kinds.join(', ')],
        [
          'Checksum',
          CHECKSUMS[checksumType] ?? (checksumType ? `type ${checksumType}` : undefined),
        ],
        ['Segment', segmentCount > 1 ? `${segmentNumber} of ${segmentCount}` : undefined],
        ['Encrypted', 'No'],
        ['License agreement', licence ? 'Yes (shown before the image mounts)' : undefined],
        ['Internet-enabled', flags & 4 ? 'Yes' : undefined],
      ]),
      ...tableSection(
        'Partitions',
        ['Name', 'Size', 'Compression'],
        partitions.map((p) => [p.name, formatBytes(p.sectors * SECTOR), p.kinds.join(', ')]),
        { noun: 'partitions' },
      ),
      {
        kind: 'text',
        heading: 'Inside the image',
        paragraphs: [
          'MarkCopy does not read the file system inside the image, so the application name and version are not shown.',
        ],
      },
      ...signature,
    ],
    warnings,
  };
}
