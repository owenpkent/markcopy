// Reading a package or installer's metadata: what it is, what version, who
// made it, what it needs and what is inside, without installing or running it.
//
// The format is decided by what the file holds, not by its name. An extension
// only chooses which editor VS Code opens; a .pkg that is not a macOS installer
// or a .apk that is an Alpine package rather than an Android one is read as
// what it is, and a file that is none of these gets a message saying so.
//
// Free of the `vscode` module, like src/pe, so every reader unit-tests and
// fuzzes directly.
import { RangeReader, ReadError, type ByteSource } from '../binary/reader';
import { readAlpineApk } from './alpine';
import { readDeb } from './deb';
import { looksLikeDmg, readDmg } from './dmg';
import { readElf } from './elf';
import type { PackageInfo } from './model';
import { readMsi } from './msi';
import { readRpm } from './rpm';
import { readXar } from './xar';
import { readZipPackage } from './zipFormats';

export { PackageError, type PackageInfo, type InfoSection } from './model';
export { renderPackageHtml, type RenderOptions } from './render';

// Twice the executable reader's budget: an RPM header or a zip's central
// directory lists every file in the package, and for a large one that runs to
// megabytes that all have to be read to count them.
const LIMITS = { maxPages: 512, maxRead: 16 * 1024 * 1024 };

export async function readPackage(source: ByteSource, fileName: string): Promise<PackageInfo> {
  const reader = new RangeReader(source, LIMITS);
  if (reader.size === 0) {
    throw new ReadError('it is empty.');
  }
  const head = await reader.upTo(0, 16);
  const bytes = (...expected: number[]): boolean => expected.every((b, i) => head[i] === b);
  const text = (expected: string): boolean =>
    [...expected].every((c, i) => head[i] === c.charCodeAt(0));

  if (bytes(0x7f, 0x45, 0x4c, 0x46)) {
    return readElf(reader);
  }
  if (bytes(0xed, 0xab, 0xee, 0xdb)) {
    return readRpm(reader);
  }
  if (text('!<arch>\n')) {
    return readDeb(reader);
  }
  if (bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    return readMsi(reader);
  }
  if (text('xar!')) {
    return readXar(reader);
  }
  if (text('PK\x03\x04') || text('PK\x05\x06')) {
    return readZipPackage(reader, fileName);
  }
  // An Alpine package is gzip, which says nothing about what is inside, so the
  // name has to vouch for it before it is unpacked.
  if (bytes(0x1f, 0x8b) && /\.apk$/i.test(fileName)) {
    return readAlpineApk(reader);
  }
  // A disk image is recognised by its trailer, not its first bytes.
  if (await looksLikeDmg(reader)) {
    return readDmg(reader);
  }
  throw new ReadError('it is not a package format this preview reads.');
}
