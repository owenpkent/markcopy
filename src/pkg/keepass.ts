// What a KeePass database (.kdbx) declares about its encryption, from its
// outer header, which KeePass stores unencrypted so that it knows how to open
// the rest. Layout from the KeePass file format notes (KDBX 3.1 and 4.x, as
// implemented in KeePass and KeePassXC): two signatures, a version, then
// type-length-value fields. The master seed, transform seed, IV, stream key and
// the KDF's salt and seed are skipped without being kept, so they cannot be
// shown; no master key is asked for and nothing is decrypted.
import { formatBytesShort } from '../binary/html';
import type { RangeReader } from '../binary/reader';
import { ENCRYPTION_NOTE, NOT_DETERMINED, Cursor, Undetermined, count, hexId } from './labels';
import { propertySection, type PackageInfo } from './model';

export const KDBX_SIGNATURE_1 = [0x03, 0xd9, 0xa2, 0x9a];
export const KDBX_SIGNATURE_2 = [0x67, 0xfb, 0x4b, 0xb5];

const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_FIELDS = 32;
/** The largest header field kept or skipped (the variant dictionary is the largest real one). */
const MAX_FIELD_BYTES = 64 * 1024;
const MAX_DICTIONARY_ENTRIES = 32;
const MAX_DICTIONARY_KEY = 64;
const MAX_DICTIONARY_VALUE = 4096;

const CIPHERS: Record<string, string> = {
  '31c1f2e6bf714350be5805216afc5aff': 'AES-256',
  d6038a2b8b6f4cb5a524339a31dbb59a: 'ChaCha20',
  ad68f29f576f4bb9a36ad47af965346c: 'Twofish',
};
const KDFS: Record<string, string> = {
  c9d9f39a628a4460bf740d08c18a4fea: 'AES-KDF',
  '7c02bb8279a74ac0927d114a00648238': 'AES-KDF',
  ef636ddf8c29444b91f7a9a403e30a0c: 'Argon2d',
  '9e298b1956db4773b23dfc3ec6f0a1e6': 'Argon2id',
};

/** The variant dictionary's public parameters: name to number, and the KDF UUID as hex. */
export interface KdfParameters {
  uuid?: string;
  numbers: Map<string, number>;
}

function readDictionary(bytes: Uint8Array): KdfParameters {
  const c = new Cursor(bytes);
  if ((c.u16le() & 0xff00) !== 0x0100) {
    throw new Undetermined('unknown variant dictionary version');
  }
  const out: KdfParameters = { numbers: new Map() };
  for (let i = 0; i < MAX_DICTIONARY_ENTRIES; i++) {
    const type = c.u8();
    if (type === 0) {
      break;
    }
    const nameLength = c.u32le();
    if (nameLength > MAX_DICTIONARY_KEY) {
      throw new Undetermined('a name is too long');
    }
    const name = new TextDecoder().decode(c.take(nameLength));
    const valueLength = c.u32le();
    if (valueLength > MAX_DICTIONARY_VALUE) {
      throw new Undetermined('a value is too long');
    }
    const value = c.take(valueLength);
    if (name === '$UUID' && type === 0x42) {
      out.uuid = hexId(value);
    } else if ((type === 0x04 || type === 0x05) && value.length === (type === 0x04 ? 4 : 8)) {
      const v = new Cursor(value);
      out.numbers.set(name, type === 0x04 ? v.u32le() : v.u64le());
    }
  }
  return out;
}

function kdfRows(parameters: KdfParameters): [string, string][] {
  const name =
    parameters.uuid && Object.hasOwn(KDFS, parameters.uuid) ? KDFS[parameters.uuid] : undefined;
  if (!name) {
    return [
      ['Key derivation', parameters.uuid ? `unknown (id ${parameters.uuid})` : NOT_DETERMINED],
    ];
  }
  const n = parameters.numbers;
  if (name === 'AES-KDF') {
    const rounds = n.get('R');
    return [
      ['Key derivation', name],
      ['Transform rounds', rounds === undefined ? NOT_DETERMINED : count(rounds)],
    ];
  }
  const memory = n.get('M');
  const iterations = n.get('I');
  const lanes = n.get('P');
  const version = n.get('V');
  return [
    ['Key derivation', name],
    ['Iterations', iterations === undefined ? NOT_DETERMINED : count(iterations)],
    ['Memory', memory === undefined ? NOT_DETERMINED : formatBytesShort(memory)],
    ['Parallelism', lanes === undefined ? NOT_DETERMINED : count(lanes)],
    ...(version === undefined
      ? []
      : [['Argon2 version', `0x${version.toString(16)}`] as [string, string]]),
  ];
}

/** What the database declares. Never throws. */
export async function readKeePass(reader: RangeReader): Promise<PackageInfo> {
  const warnings: string[] = [];
  const rows: [string, string][] = [];
  try {
    const bytes = await reader.upTo(0, Math.min(reader.size, MAX_HEADER_BYTES));
    const c = new Cursor(bytes);
    c.skip(8);
    const minor = c.u16le();
    const major = c.u16le();
    const v4 = major >= 4;
    rows.push(['Format version', `${major}.${minor}`]);
    if (major < 3 || major > 4) {
      rows.push(['Encryption', `${NOT_DETERMINED} (KDBX ${major}.${minor} is not read)`]);
    } else {
      let cipher = NOT_DETERMINED;
      let compression = NOT_DETERMINED;
      let rounds: number | undefined;
      let parameters: KdfParameters | undefined;
      let ended = false;
      for (let i = 0; i < MAX_FIELDS && !ended; i++) {
        const id = c.u8();
        const size = v4 ? c.u32le() : c.u16le();
        if (size > MAX_FIELD_BYTES) {
          throw new Undetermined('a header field is too large');
        }
        const data = c.take(size);
        if (id === 0) {
          ended = true;
        } else if (id === 2 && size === 16) {
          const uuid = hexId(data);
          cipher = Object.hasOwn(CIPHERS, uuid) ? CIPHERS[uuid] : `unknown (id ${uuid})`;
        } else if (id === 3 && size === 4) {
          const flag = new Cursor(data).u32le();
          compression = flag === 0 ? 'none' : flag === 1 ? 'gzip' : `${NOT_DETERMINED} (${flag})`;
        } else if (id === 6 && size === 8) {
          rounds = new Cursor(data).u64le();
        } else if (id === 11 && v4) {
          parameters = readDictionary(data);
        }
      }
      rows.push(['Cipher', cipher]);
      rows.push(['Compression', compression]);
      if (v4) {
        rows.push(
          ...(parameters
            ? kdfRows(parameters)
            : [['Key derivation', NOT_DETERMINED] as [string, string]]),
        );
      } else {
        rows.push(['Key derivation', 'AES-KDF']);
        rows.push(['Transform rounds', rounds === undefined ? NOT_DETERMINED : count(rounds)]);
      }
      rows.push(['Database contents', 'encrypted']);
      if (!ended) {
        rows.push(['Header', `${NOT_DETERMINED} beyond the first ${MAX_FIELDS} fields`]);
      }
    }
  } catch {
    rows.push(['Encryption', `${NOT_DETERMINED} (the header could not be read to the end)`]);
    warnings.push(
      'The KeePass header could not be read to the end, so some labels are not determined.',
    );
  }
  return {
    format: 'KeePass database',
    summary: 'A KeePass password database. Its contents are encrypted; only the header is read.',
    sections: propertySection('Encryption', rows, ENCRYPTION_NOTE),
    warnings,
  };
}
