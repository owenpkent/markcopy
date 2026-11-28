import { bytesSource, RangeReader } from '../../src/binary/reader';
import { findZipEnd, hasPdfHeader, looksLikePdf, looksLikePe } from '../../src/binary/signatures';
import { PeError, readPe, renderPeHtml, type PeInfo } from '../../src/pe';
import {
  bound,
  PackageError,
  readAppended,
  readPackage,
  renderAlsoAlert,
  renderAlsoReading,
  renderPackageHtml,
  type PackageInfo,
} from '../../src/pkg';
import { readAlpineApk } from '../../src/pkg/alpine';
import { readDeb } from '../../src/pkg/deb';
import { readDmg } from '../../src/pkg/dmg';
import { readElf } from '../../src/pkg/elf';
import { readMachO } from '../../src/pkg/macho';
import { readMsi } from '../../src/pkg/msi';
import { readRpm } from '../../src/pkg/rpm';
import { readXar } from '../../src/pkg/xar';
import { readZipPackage } from '../../src/pkg/zipFormats';
import { readAge } from '../../src/pkg/age';
import { readKeePass } from '../../src/pkg/keepass';
import { readPem, readPkcs12 } from '../../src/pkg/keyFiles';
import { readLuks } from '../../src/pkg/luks';
import { readOpenPgp } from '../../src/pkg/openpgp';
import { readRar } from '../../src/pkg/rar';
import { readSevenZip } from '../../src/pkg/sevenZip';
import { checkPage, startCost } from './binaryOracle';
import { withHeader } from './pe.fuzz';
import { shaped } from './pkg.fuzz';

export { CostError, MAX_HEAP_GROWTH, MAX_HTML_CHARS, MAX_MILLISECONDS } from './binaryOracle';

// readPackage tries its probe table in order, reads the first format that
// selects the file, then lists the other formats whose structure the file also
// has and reads the first of those that has a reader (the "second reading"). The
// pkg target gives every input one format's magic, so it almost never produces a
// file that is two. This one builds those.
//
// The first input byte picks the mode:
//   0  a pkg shape (the first byte after it picks the format, as in the pkg
//      target), with an empty zip end record appended when the second byte's low
//      bit is set, so the zip probe also matches
//   1  the bytes as they are, under a name the second byte picks (.apk, .jar,
//      .exe, .pdf, none), for seeds that are two formats already
//   2  a PE image (the pe target's header written over the input) read as the
//      executable preview reads it, with its appended data read through
//      readAppended, and readAppended on its own with an offset from the input
//   3  the structural tests in src/binary/signatures.ts on their own
//
// Invariants beyond the pkg target's: the reading that is shown first is the one
// the same reader gives on its own (the second step never changes it); `also`
// names no format twice, never the primary, and reads the first named format that
// has a reader, once, bounded, without a second `also` inside it; a structural
// test never throws and agrees with the cheaper facts it rests on.
const MODES = 4;
const NAMES = ['fuzz.bin', 'fuzz.apk', 'fuzz.jar', 'fuzz.exe', 'fuzz.pdf', 'fuzz.pkg'];
const MAX_PROBES = 16;
// Formats the probe table only recognises: they are named but never read.
const RECOGNISED_ONLY = new Set(['Windows executable', 'PDF document']);
const MAX_SECTIONS = 40;
const MAX_ERROR_CHARS = 1024;

/** The empty zip: an end record with no entries and no comment. */
const EMPTY_ZIP = Buffer.concat([Buffer.from('PK\x05\x06', 'latin1'), Buffer.alloc(18)]);

type Reader = (reader: RangeReader, fileName: string) => Promise<PackageInfo>;
const DIRECT = new Map<string, Reader>([
  ['ELF file', readElf],
  ['Mach-O file', (reader) => readMachO(reader)],
  ['RPM package', readRpm],
  ['Debian package', readDeb],
  ['Windows Installer package', readMsi],
  ['xar archive', readXar],
  ['zip archive', readZipPackage],
  ['Alpine package', (reader) => readAlpineApk(reader)],
  ['disk image', (reader) => readDmg(reader)],
  ['7-Zip archive', (reader) => readSevenZip(reader)],
  ['RAR archive', (reader) => readRar(reader)],
  ['LUKS volume', (reader) => readLuks(reader)],
  ['KeePass database', (reader) => readKeePass(reader)],
  ['age encrypted file', (reader) => readAge(reader)],
  ['OpenPGP file', (reader) => readOpenPgp(reader)],
  ['PKCS#12 file', (reader) => readPkcs12(reader)],
  ['PEM file', (reader) => readPem(reader)],
]);
const LIMITS = { maxPages: 512, maxRead: 16 * 1024 * 1024 };

const fail = (label: string, what: string): never => {
  throw new Error(`${label}: ${what}`);
};

function checkAlso(label: string, info: PackageInfo): void {
  const also = info.also;
  if (also === undefined) {
    return;
  }
  const names = also.matches.map((m) => m.format);
  if (names.length === 0 || names.length > MAX_PROBES || new Set(names).size !== names.length) {
    fail(label, `also names ${JSON.stringify(names)}`);
  }
  if (names.includes(also.primary)) {
    fail(label, `also names its primary ${also.primary}`);
  }
  const expected = names.find((n) => !RECOGNISED_ONLY.has(n));
  if (also.read !== expected) {
    fail(label, `also read ${also.read} where the first with a reader is ${expected}`);
  }
  if (also.read === undefined) {
    if (also.info !== undefined || also.error !== undefined) {
      fail(label, 'a second reading or error without a format');
    }
    return;
  }
  if ((also.info === undefined) === (also.error === undefined)) {
    fail(label, 'the second reading has both a result and an error, or neither');
  }
  if (also.error !== undefined && also.error.length > MAX_ERROR_CHARS) {
    fail(label, `an error of ${also.error.length} characters`);
  }
  if (also.info !== undefined) {
    if (also.info.also !== undefined) {
      fail(label, 'the second reading has a second reading of its own');
    }
    if (also.info.sections.length > MAX_SECTIONS) {
      fail(label, `${also.info.sections.length} sections in the second reading`);
    }
  }
}

/** Read as a package and check the page, the `also` invariants, and the first reading against the reader alone. */
async function readAndCheck(input: Buffer, fileName: string): Promise<void> {
  const label = `${fileName} (${input.length} bytes)`;
  const done = startCost(fileName, input.length);
  let html = '';
  let info: PackageInfo | undefined;
  try {
    info = await readPackage(bytesSource(input), fileName);
    html = renderPackageHtml(info, { fileName, fileSize: input.length, sha256: 'f'.repeat(64) });
  } catch (err) {
    if (!(err instanceof PackageError)) {
      throw err;
    }
  }
  done(html);
  checkPage(fileName, html, input, info);
  if (info?.also === undefined) {
    return;
  }
  checkAlso(label, info);
  const direct = DIRECT.get(info.also.primary);
  if (direct === undefined) {
    fail(label, `no reader for the primary format ${info.also.primary}`);
    return;
  }
  const alone = bound(await direct(new RangeReader(bytesSource(input), LIMITS), fileName));
  if (JSON.stringify({ ...info, also: undefined }) !== JSON.stringify(alone)) {
    fail(label, `the first reading changed once ${info.also.read} was read too`);
  }
}

/** What readExe in src/fileInfoTask.ts does: the executable reading, then its appended data. */
async function readExeAndCheck(bytes: Buffer, overlayStart: number): Promise<void> {
  const done = startCost('fuzz.exe', bytes.length);
  let html = '';
  let info: PeInfo | undefined;
  try {
    info = await readPe(bytesSource(bytes));
    if (info.overlay) {
      info.appended = await readAppended(bytesSource(bytes), 'fuzz.exe', info.overlay.offset);
    }
    html = renderPeHtml(info, { fileName: 'fuzz.exe', sha256: 'f'.repeat(64) });
  } catch (err) {
    if (!(err instanceof PeError)) {
      throw err;
    }
  }
  done(html);
  checkPage('fuzz.exe', html, bytes, info);
  checkAppended('fuzz.exe', info?.appended);

  // readAppended on its own, with an overlay start that may sit before or after the zip.
  checkAppended('readAppended', await readAppended(bytesSource(bytes), 'fuzz.exe', overlayStart));
}
function checkAppended(label: string, also: PackageInfo['also']): void {
  if (also === undefined) {
    return;
  }
  const holder = { also, sections: [], warnings: [], format: '' } as unknown as PackageInfo;
  checkAlso(label, holder);
  if (also.primary !== 'Windows executable' || also.matches.length !== 1) {
    fail(label, `appended data named ${also.primary} and ${also.matches.length} formats`);
  }
  checkPage(label, renderAlsoAlert(also) + renderAlsoReading(also), Buffer.alloc(0), also);
}

async function checkSignatures(bytes: Buffer): Promise<void> {
  const reader = new RangeReader(bytesSource(bytes), LIMITS);
  const end = await findZipEnd(reader);
  if (end !== undefined) {
    const record = bytes.subarray(end.eocd);
    if (record.length < 22 || record.readUInt32LE(0) !== 0x06054b50) {
      fail('findZipEnd', `no end record at ${end.eocd}`);
    }
    if (22 + record.readUInt16LE(20) !== record.length) {
      fail('findZipEnd', 'the record does not end where the file does');
    }
    if (
      end.directoryStart !== undefined &&
      (end.directoryStart < 0 || end.directoryStart > end.eocd)
    ) {
      fail('findZipEnd', `a directory at ${end.directoryStart} after the record at ${end.eocd}`);
    }
  }
  const pe = await looksLikePe(reader);
  if (pe && (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a)) {
    fail('looksLikePe', 'true without an MZ header');
  }
  const head = new Uint8Array(bytes.subarray(0, 4096));
  const pdf = await looksLikePdf(reader, head);
  if (pdf && !hasPdfHeader(head)) {
    fail('looksLikePdf', 'true without a PDF header in the first 1,024 bytes');
  }
  // The same answers however the file is served: a second reader over the same bytes.
  const again = new RangeReader(bytesSource(bytes), LIMITS);
  if (
    JSON.stringify(await findZipEnd(again)) !== JSON.stringify(end) ||
    (await looksLikePe(again)) !== pe ||
    (await looksLikePdf(again, head)) !== pdf
  ) {
    fail('signatures', 'two readers over the same bytes disagree');
  }
}

// readPackage is async, so this target is too.
export async function fuzz(data: Buffer): Promise<void> {
  if (data.length < 2) {
    return;
  }
  const mode = data[0] % MODES;
  const flags = data[1];
  const rest = data.subarray(2);
  if (mode === 0) {
    const { bytes, name } = shaped(rest);
    await readAndCheck(flags & 1 ? Buffer.concat([bytes, EMPTY_ZIP]) : bytes, name);
  } else if (mode === 1) {
    await readAndCheck(rest, NAMES[flags % NAMES.length]);
  } else if (mode === 2) {
    await readExeAndCheck(withHeader(rest), (flags << 8) | (rest.length > 0 ? rest[0] : 0));
  } else {
    await checkSignatures(rest);
  }
}
