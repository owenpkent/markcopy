// An RPM's payload: a compressed cpio archive whose member names are compared
// with the file list in the header. Only the names are read; each member's data
// is skipped as it streams past, and decoding stops at the archive's trailer.
import { formatBytes, formatNumber } from '../binary/html';
import { printable } from '../binary/text';
import type { RangeReader } from '../binary/reader';
import {
  DAMAGED,
  gunzipUntil,
  readCompressed,
  TOO_BIG,
  unxzUntil,
  unzstdUntil,
  type ChunkHandler,
} from './decompress';
import { PackageError, propertySection, tableSection, type InfoSection } from './model';

/** Compressed payload bytes read. The reader's budget is 32 MiB for the whole file, headers included. */
export const MAX_PAYLOAD_INPUT = 16 * 1024 * 1024;
/** Decompressed payload bytes walked before giving up. */
export const MAX_PAYLOAD_OUTPUT = 256 * 1024 * 1024;
/** Cpio members read. Matches the header file list's own cap. */
export const MAX_PAYLOAD_MEMBERS = 200_000;
/** The longest member name read, in bytes. */
export const MAX_MEMBER_NAME = 4096;
/** Names of each kind of difference shown. */
export const MAX_NAMES_SHOWN = 10;

const NEWC_HEADER = 110;
const TRAILER = 'TRAILER!!!';

/** A reason the payload could not be compared. */
export class NotChecked extends Error {}

const MIB = 1024 * 1024;

/** A path as both sides are compared: without a leading "./" or "/". */
export function normalizePath(path: string): string {
  return path.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

const hexField = (bytes: Uint8Array, at: number): number => {
  let value = 0;
  for (let i = at; i < at + 8; i++) {
    const c = bytes[i];
    const digit =
      c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (digit < 0) {
      throw new NotChecked('a cpio header holds a field that is not hexadecimal');
    }
    value = value * 16 + digit;
  }
  return value;
};

/** Reads member names from a "newc" or "crc" cpio stream, in pieces of any size, skipping each member's data. */
export class CpioWalker {
  readonly names: string[] = [];
  /** True once the trailer was reached. */
  finished = false;
  private phase: 'header' | 'name' | 'skip' = 'header';
  private buffer = new Uint8Array(NEWC_HEADER);
  private have = 0;
  private need = NEWC_HEADER;
  private skipped = 0;
  private fileSize = 0;
  private nameSize = 0;

  /** Feed the next piece. Returns true once the trailer has been read. */
  feed(chunk: Uint8Array): boolean {
    let at = 0;
    while (at < chunk.length && !this.finished) {
      if (this.phase === 'skip') {
        const take = Math.min(this.skipped, chunk.length - at);
        this.skipped -= take;
        at += take;
        if (this.skipped === 0) {
          this.phase = 'header';
          this.need = NEWC_HEADER;
          this.have = 0;
        }
        continue;
      }
      const take = Math.min(this.need - this.have, chunk.length - at);
      this.buffer.set(chunk.subarray(at, at + take), this.have);
      this.have += take;
      at += take;
      if (this.have < this.need) {
        continue;
      }
      if (this.phase === 'header') {
        this.readHeader();
      } else {
        this.readName();
      }
    }
    return this.finished;
  }

  private readHeader(): void {
    const magic = String.fromCharCode(...this.buffer.subarray(0, 6));
    if (magic !== '070701' && magic !== '070702') {
      throw new NotChecked(
        /^[0-9A-Za-z]{6}$/.test(magic)
          ? `the payload's cpio format is "${magic}", not newc or crc`
          : 'the payload does not begin like a cpio archive',
      );
    }
    this.fileSize = hexField(this.buffer, 54);
    this.nameSize = hexField(this.buffer, 94);
    if (this.nameSize < 1 || this.nameSize > MAX_MEMBER_NAME) {
      throw new NotChecked(
        `a cpio member name is ${formatNumber(this.nameSize)} bytes, outside what MarkCopy reads (1 to ${formatNumber(MAX_MEMBER_NAME)})`,
      );
    }
    if (this.names.length >= MAX_PAYLOAD_MEMBERS) {
      throw new NotChecked(
        `the payload holds more than ${formatNumber(MAX_PAYLOAD_MEMBERS)} members`,
      );
    }
    this.phase = 'name';
    this.need = this.nameSize;
    this.have = 0;
    if (this.buffer.length < this.nameSize) {
      this.buffer = new Uint8Array(MAX_MEMBER_NAME);
    }
  }

  private readName(): void {
    const raw = this.buffer.subarray(0, this.nameSize);
    const nul = raw.indexOf(0);
    const name = new TextDecoder().decode(nul < 0 ? raw : raw.subarray(0, nul));
    if (name === TRAILER) {
      this.finished = true;
      return;
    }
    this.names.push(name);
    // The header and name are padded to 4 bytes together, and the data to 4 on its own.
    const namePad = (4 - ((NEWC_HEADER + this.nameSize) % 4)) % 4;
    const dataPad = (4 - (this.fileSize % 4)) % 4;
    this.skipped = namePad + this.fileSize + dataPad;
    this.phase = 'skip';
  }
}

const bytesLabel = (n: number): string => `${formatNumber(n / MIB)} MiB`;

/** The member names of an RPM payload, or the reason it could not be read. */
export async function readPayloadNames(
  reader: RangeReader,
  offset: number,
  compressor: string | undefined,
  format: string | undefined,
): Promise<string[]> {
  if (format !== undefined && format !== 'cpio') {
    throw new NotChecked(`the payload format is "${format}", and MarkCopy reads only cpio`);
  }
  const kind = (compressor ?? '').toLowerCase();
  if (!['gzip', 'zstd', 'xz'].includes(kind)) {
    throw new NotChecked(
      compressor
        ? `MarkCopy does not read a ${compressor} payload`
        : 'the package names no payload compressor',
    );
  }
  const size = reader.size - offset;
  if (size <= 0) {
    throw new NotChecked('the file holds no payload after the header');
  }
  if (size > MAX_PAYLOAD_INPUT) {
    throw new NotChecked(
      `the compressed payload is ${formatBytes(size)}, larger than the ${bytesLabel(MAX_PAYLOAD_INPUT)} MarkCopy reads`,
    );
  }
  const walker = new CpioWalker();
  // The decompressors turn any exception from a handler into "damaged", so a
  // reason found while walking is kept here and the stream is stopped.
  let found: NotChecked | undefined;
  const onChunk: ChunkHandler = (chunk) => {
    try {
      return walker.feed(chunk);
    } catch (error) {
      if (!(error instanceof NotChecked)) {
        throw error;
      }
      found = error;
      return true;
    }
  };
  try {
    const data = await readCompressed(reader, offset, size, MAX_PAYLOAD_INPUT);
    if (kind === 'gzip') {
      gunzipUntil(data, MAX_PAYLOAD_OUTPUT, onChunk);
    } else if (kind === 'zstd') {
      unzstdUntil(data, MAX_PAYLOAD_OUTPUT, onChunk);
    } else {
      await unxzUntil(data, MAX_PAYLOAD_OUTPUT, onChunk);
    }
  } catch (error) {
    if (error instanceof NotChecked) {
      throw error;
    }
    if (error instanceof PackageError) {
      throw new NotChecked(
        error.message === TOO_BIG
          ? `the payload expands to more than the ${bytesLabel(MAX_PAYLOAD_OUTPUT)} MarkCopy reads`
          : error.message === DAMAGED
            ? `the ${kind} data could not be decompressed`
            : 'the payload could not be read',
      );
    }
    throw error;
  }
  if (found) {
    throw found;
  }
  if (!walker.finished) {
    throw new NotChecked('the payload ended before the cpio trailer');
  }
  return walker.names;
}

/** What the header lists, ready to compare with the payload. */
export interface Listed {
  /** Every listed path except %ghost entries, normalised. */
  expected: Set<string>;
  /** Listed paths marked %ghost, which rpm leaves out of the payload. */
  ghosts: Set<string>;
}

function ghostSentence(count: number): string {
  return count > 0
    ? ` ${formatNumber(count)} ${count === 1 ? 'entry' : 'entries'} marked %ghost (which rpm leaves out of a payload) ${count === 1 ? 'was' : 'were'} not compared.`
    : '';
}

/** The rows and tables for a comparison of the header's list with the payload's names. */
export function payloadSections(listed: Listed, payload: string[] | NotChecked): InfoSection[] {
  if (payload instanceof NotChecked) {
    return propertySection('Payload contents', [
      ['Payload contents', `Not checked: ${payload.message}.`],
    ]);
  }
  const present = new Set<string>();
  for (const raw of payload) {
    const name = normalizePath(raw);
    if (name !== '' && name !== '.') {
      present.add(name);
    }
  }
  const missing = [...listed.expected].filter((p) => !present.has(p)).sort();
  const extra = [...present].filter((p) => !listed.expected.has(p) && !listed.ghosts.has(p)).sort();
  const ghost = ghostSentence(listed.ghosts.size);
  if (missing.length === 0 && extra.length === 0) {
    return propertySection('Payload contents', [
      [
        'Payload contents',
        `The payload holds the same ${formatNumber(listed.expected.size)} entries the header lists.${ghost}`,
      ],
    ]);
  }
  return [
    ...propertySection('Payload contents', [
      [
        'Payload contents',
        `The payload differs from the header's file list: ${formatNumber(missing.length)} listed are not in the payload, ${formatNumber(extra.length)} in the payload are not listed.${ghost}`,
      ],
    ]),
    ...tableSection(
      'Listed but not in the payload',
      ['Path'],
      missing.map((p) => [printable(p)]),
      { limit: MAX_NAMES_SHOWN, noun: 'paths' },
    ),
    ...tableSection(
      'In the payload but not listed',
      ['Path'],
      extra.map((p) => [printable(p)]),
      { limit: MAX_NAMES_SHOWN, noun: 'paths' },
    ),
  ];
}
