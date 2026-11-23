// The Unix `ar` archive that wraps a Debian package: an 8-byte magic, then
// members, each a 60-byte ASCII header followed by its data padded to an even
// offset. Only the headers are read here; a member's bytes are fetched by the
// caller when it wants them, since the data member of a package can be gigabytes.
import type { RangeReader } from '../binary/reader';

export const AR_MAGIC = '!<arch>\n';
const HEADER_LENGTH = 60;

// A .deb has three members. Anything past a few dozen is not a package, and
// every header costs a read, so this bounds the walk.
const MAX_MEMBERS = 64;

export interface ArMember {
  /** The member's name with the GNU `/` terminator and padding removed. */
  name: string;
  size: number;
  /** Where the member's data starts in the file. */
  offset: number;
  /** True when the file ends before the member's data does. */
  truncated: boolean;
}

export interface ArListing {
  members: ArMember[];
  /** True when the walk stopped at the member cap rather than the end of the file. */
  capped: boolean;
}

const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

/** The members of the archive, or null when the file does not start with the ar magic. */
export async function listAr(reader: RangeReader): Promise<ArListing | null> {
  if (reader.size < AR_MAGIC.length || ascii(await reader.bytes(0, 8)) !== AR_MAGIC) {
    return null;
  }
  const members: ArMember[] = [];
  let at = AR_MAGIC.length;
  while (members.length < MAX_MEMBERS) {
    if (at + HEADER_LENGTH > reader.size) {
      return { members, capped: false };
    }
    const header = ascii(await reader.bytes(at, HEADER_LENGTH));
    if (header.slice(58, 60) !== '`\n') {
      // Not a member header: the archive is damaged from here, so stop with what was read.
      return { members, capped: false };
    }
    const sizeText = header.slice(48, 58).trim();
    if (!/^\d{1,10}$/.test(sizeText)) {
      return { members, capped: false };
    }
    const size = Number(sizeText);
    const offset = at + HEADER_LENGTH;
    const name = header.slice(0, 16).trim().replace(/\/$/, '');
    members.push({ name, size, offset, truncated: offset + size > reader.size });
    at = offset + size + (size % 2);
  }
  return { members, capped: at + HEADER_LENGTH <= reader.size };
}
