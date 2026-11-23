// Building ar, tar and Debian package bytes.
//
// Written from the specifications (the ar(5) and ustar/GNU tar header layouts,
// and deb(5) for the package layout), not from src/pkg/: a parser that agrees
// with this agrees with the formats and not merely with itself. Compressed
// vectors that cannot be produced in the test (xz and Zstandard encoders are not
// dependencies) are embedded as base64 with the command that made them.
import { gzipSync } from 'fflate';

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// --- tar ---------------------------------------------------------------

export interface TarSpec {
  name: string;
  data?: string | Uint8Array;
  /** The typeflag. "0" is a file, "5" a directory, "L" a GNU long name, "x" a pax header. */
  type?: string;
  /** Overrides the size field, to describe a lie. */
  declaredSize?: number;
}

function field(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(ascii(text).subarray(0, length));
  return out;
}

const octal = (value: number, length: number): string =>
  value.toString(8).padStart(length - 1, '0');

/** One 512-byte ustar header. */
export function tarHeader(name: string, size: number, type = '0', prefix = ''): Uint8Array {
  const header = new Uint8Array(512);
  header.set(field(name, 100), 0);
  header.set(field('0000644', 8), 100);
  header.set(field('0000000', 8), 108);
  header.set(field('0000000', 8), 116);
  header.set(field(octal(size, 12), 12), 124);
  header.set(field('00000000000', 12), 136);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(field('ustar', 6), 257);
  header.set(field('00', 2), 263);
  header.set(field(prefix, 155), 345);
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  header.set(field(`${octal(sum, 7)}`, 7), 148);
  header[155] = 0x20;
  return header;
}

function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
}

/** A tar stream. `end` appends the two zero blocks; Alpine's segments leave them out. */
export function tar(entries: TarSpec[], end = true): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const data =
      typeof entry.data === 'string' ? ascii(entry.data) : (entry.data ?? new Uint8Array(0));
    parts.push(tarHeader(entry.name, entry.declaredSize ?? data.length, entry.type ?? '0'));
    parts.push(padded(data));
  }
  if (end) {
    parts.push(new Uint8Array(1024));
  }
  return concat(...parts);
}

/** A pax extended header record "<length> path=<value>\n", length counting itself. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) {
    length = String(length).length + body.length;
  }
  return `${length}${body}`;
}

// --- ar ----------------------------------------------------------------

export interface ArSpec {
  name: string;
  data: Uint8Array | string;
  /** Overrides the size field, to describe a lie. */
  declaredSize?: number;
}

export function ar(members: ArSpec[]): Uint8Array {
  const parts: Uint8Array[] = [ascii('!<arch>\n')];
  for (const member of members) {
    const data = typeof member.data === 'string' ? ascii(member.data) : member.data;
    const header =
      member.name.padEnd(16) +
      '0'.padEnd(12) +
      '0'.padEnd(6) +
      '0'.padEnd(6) +
      '100644'.padEnd(8) +
      String(member.declaredSize ?? data.length).padEnd(10) +
      '`\n';
    parts.push(ascii(header), data);
    if (data.length % 2 === 1) {
      parts.push(ascii('\n'));
    }
  }
  return concat(...parts);
}

// --- embedded compressed vectors --------------------------------------------

/** The tar both vectors decompress to: one `./control` file, made by Python's tarfile. */
export const VECTOR_CONTROL = [
  'Package: vectorpkg',
  'Version: 1.2-3',
  'Architecture: all',
  'Maintainer: Test <t@example.com>',
  'Installed-Size: 12',
  'Depends: libc6 (>= 2.34), a | b',
  'Description: compressed control',
  ' Made with python tarfile and lzma.',
  '',
].join('\n');

// python -I gen.py: tarfile.open(mode="w", format=USTAR_FORMAT) holding ./control,
// then lzma.compress(tar, format=lzma.FORMAT_XZ).
export const VECTOR_XZ =
  '/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AQddABcLyOfZ5dHD1ZV9QtvcDlxs1FkS8hVsYa/S+GcYdTkJ+QmywR6S5nvwMVv0EOn42WR4InGJV1vVLmDLDDb1wVimk5BeaaJmCIDLylPW16pwMKdtrazc1khK9+8jxfHzBRNGRAAubDzBTVE5eViYPzvgr5vBy41T4+jH4Xo8mHZZH0gAJAH3VBiN6s3deANH9oX/sjBzQ+nWBoWpb7PfmosZH+8ntLVbk6n16XupC2QMfGIWzS6ecDf6DV+drcHHrCLpLm0qON3UoA4EdnxT+u9OFVacLqKqv2EMux7YURhu73ePd2NwlPe/qj5n9Fgw9fYG0UZMlT2g311rEBEOZXcwrYUE4CMAAADY9CILN2LkvwABowKAUAAAdnz4p7HEZ/sCAAAAAARZWg==';

// lzma.compress(bytes(4 * 1024 * 1024), format=lzma.FORMAT_XZ): 4 MiB of zeros.
export const VECTOR_XZ_ZEROS =
  '/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj//8RAWxdAABv/f//o7f/Rz5IFXI5YVG4kijmo4YH+e7kHoLTL8U6PAFLsX7JiopNL6MN2X+m44wjEVPgWRjFdYrid/i2lH8MasDedElk4ulcU7IE2PdEDKtfDW1G6eXDdoi3llestk3haR1v+0uIEGxCy4g/XACP0E6vJiiUcR89jyThcJ6nI1/sKMuF0ZWYin4qkfIndfcZwAaYTZj92K/VkA/EJVP49ZE2MQWlsO5vwXBNRwzRkRGqrWAdus6xJxhcWYbpZlJYvul2rFnk5VsFCPnH2q38+1IrdM0eWyBC+d1TPfgpZAk7gMsqbN+1O/DEvS5fqg8+S2ZCkBMO/xCT+HF4WfgLzf+VKEYPqfx83vuaMC5WwI+F84OBwGXEJVP49ZE2MQWlsO5vwXBNRwzRkRGqrWAdus6xJxhcWYbpZlJYvul2rFnk5VsFCPnH2q38+1IrdM0eWyBC+d1TPfgpZAk7gMsqbN+1O/DEvEgn5lif/xABKwDsc1On/b6ufDEan7eNMW5wnqcjX+woy4XRlZiKfiqR8id19xnABphNmP3Yr9WQD8QlU/j1kTYxBaWw7m/BcE1HDNGREaqtYB26zrEnGFxZhulmUli+6XasWeTlWwUI+cfarfz7Uit0zR5bIEL53VM9+ClkCTuAyyps37U78MS9Ll+qDz5LZkKQEw7/EJP4cXhZ+AvN/5UoRg+p/Hze+5owLlbAj4Xzg4HAZcQlU/j1kTYxBaWw7m/BcE1HDNGREaqtYB26zrEnGFxZhulmUli+6XasWeTlWwUI+cfarfz7Uit0zR5bIEL53VM9+ClkCTuAyyps37U78MS9Ll+qDz5LZkKQEw7/EJP4cXhZ+AvN/5UoRg+p/Hze+5owLlbAj4Xzg4HAZcQlUQ8/soAB3AAFAEHqpi0AAGtsRXzSCWHbAAHEBYCAgALTUy1YscRn+wIAAAAABFla';

export const b64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));

// --- Debian package -----------------------------------------------------

export const CONTROL = [
  'Package: curl',
  'Version: 8.5.0-2',
  'Architecture: amd64',
  'Maintainer: Ana Example <ana@example.org>',
  'Installed-Size: 1536',
  'Section: web',
  'Priority: optional',
  'Homepage: https://curl.example/',
  'Source: curl-src (8.5.0)',
  'Essential: no',
  'Multi-Arch: foreign',
  'Built-Using: glibc (= 2.38-1)',
  'Pre-Depends: dpkg (>= 1.17)',
  'Depends: libc6 (>= 2.34), libssl3 | libssl1.1 (>= 1.1.1),',
  ' zlib1g',
  'Recommends: ca-certificates',
  'Suggests: curl-doc',
  'Enhances: wget',
  'Breaks: curl-old (<< 8.0)',
  'Conflicts: curl-ssl',
  'Replaces: curl-old',
  'Provides: http-client',
  'X-Custom: kept as written',
  'Description: command line tool for transferring data',
  ' curl is a tool for transferring data from or to a server.',
  ' It supports many protocols.',
  ' .',
  ' Second paragraph with a <img src=x onerror=1> tag.',
  '',
].join('\n');

// node -e "zlib.zstdCompressSync(tar)": the same tar as VECTOR_XZ, Zstandard compressed (Node 24).
export const VECTOR_ZST =
  'KLUv/WAAJxUHAJIOLyQwbasDLFUNQbTXBJARi5EcoDpZg9YU52Ys+3+pLw93sLBhACRK2YjC/Xl7du1Bbv9BqCfioW4R52cfV394TpYxgqxjk2yyQ0Fe8b1AgNMozA8aAGcwSHNf83kc2aGY5YspGsPiYee251NQjQgyhV2MVoIR2uA9ueFL8mvbr+1DObdfLCfNuBvEZIJqFoyyfD3YpmQHFZFECZsxxBdHVsJ2QZPcnpOkT40SFKimpVFVdRyGqmpyUPaDbEAJDAD7JMeDDpwXSpyH8EEQCFBBvCE1AKTjVvipDYBj5TI3ASQ=';

// node -e "zlib.zstdCompressSync(Buffer.alloc(4 * 1024 * 1024))": 4 MiB of zeros.
export const VECTOR_ZST_ZEROS =
  'KLUv/YBYAABAAFQAABAAAAEA+/85wAICABAAAgAQAAIAEAACABAAAgAQAAIAEAACABAAAgAQAAIAEAACABAAAgAQAAIAEAACABAAAgAQAAIAEAACABAAAgAQAAIAEAACABAAAgAQAAIAEAACABAAAgAQAAIAEAACABAAAgAQAAIAEAACABAAAgAQAAIAEAADABAA';

export interface DebSpec {
  control?: string;
  /** Extra control-archive files. */
  files?: Record<string, string>;
  /** Names of the maintainer scripts to include. */
  scripts?: string[];
  md5sums?: string[];
  /** How control.tar is compressed. 'bz2' and 'lzma' produce a member MarkCopy cannot read. */
  compression?: 'none' | 'gz' | 'xz' | 'zst' | 'bz2' | 'lzma';
  /** The control member's bytes, replacing the built ones (for the xz and zst vectors). */
  controlBytes?: Uint8Array;
  dataSuffix?: string;
  dataSize?: number;
  firstMember?: string;
  omitControl?: boolean;
  omitData?: boolean;
}

export function buildDeb(spec: DebSpec = {}): Uint8Array {
  const files: TarSpec[] = [{ name: './control', data: spec.control ?? CONTROL }];
  for (const [name, data] of Object.entries(spec.files ?? {})) {
    files.push({ name: `./${name}`, data });
  }
  for (const script of spec.scripts ?? []) {
    files.push({ name: `./${script}`, data: '#!/bin/sh\nexit 0\n' });
  }
  if (spec.md5sums) {
    files.push({
      name: './md5sums',
      data: spec.md5sums.map((p) => `d41d8cd98f00b204e9800998ecf8427e  ${p}\n`).join(''),
    });
  }
  const compression = spec.compression ?? 'gz';
  const archive = tar(files);
  const control =
    spec.controlBytes ??
    (compression === 'gz'
      ? gzipSync(archive)
      : compression === 'none'
        ? archive
        : ascii('compressed with something MarkCopy cannot read'));
  const suffix = compression === 'none' ? '' : `.${compression}`;
  const members: ArSpec[] = [{ name: spec.firstMember ?? 'debian-binary', data: '2.0\n' }];
  if (!spec.omitControl) {
    members.push({ name: `control.tar${suffix}`, data: control });
  }
  if (!spec.omitData) {
    members.push({
      name: `data.tar${spec.dataSuffix ?? '.xz'}`,
      data: new Uint8Array(spec.dataSize ?? 2048).fill(7),
    });
  }
  return ar(members);
}
