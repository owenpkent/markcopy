// Zip-based packages: Java archives, VS Code extensions, Python wheels, NuGet
// packages and Android apps, plus any other zip as a plain archive.
//
// The flavour is decided by what is inside, not by the file's extension: a
// .zip can be a wheel, a .jar can be an Android library, and an extension only
// chooses which editor VS Code opened. The archive is read through ranges
// (src/pkg/zipRange.ts), so a 300 MB .jar costs its directory and a manifest.
import { formatBytes, formatBytesShort, formatNumber } from '../binary/html';
import { readApk } from './androidApk';
import { isJarManifestName } from './ascii';
import { readJar } from './jar';
import { tableSection, type PackageInfo } from './model';
import { readOdf } from './odf';
import { readNupkg } from './nupkg';
import { readVsix } from './vsix';
import { readWheel } from './wheel';
import { openZip, summariseEncryption, type ZipArchive, type ZipFlavour } from './zipRange';
import type { RangeReader } from '../binary/reader';

const CONTENT_ROWS = 200;

function contents(zip: ZipArchive): PackageInfo['sections'] {
  const files = zip.entries.filter((e) => !e.isDirectory);
  const count = zip.complete ? files.length : zip.declaredEntries;
  const lead =
    `${formatNumber(count)} ${count === 1 ? 'entry' : 'entries'}` +
    `${zip.complete ? '' : ' (the directory could not be read to the end)'}, ` +
    `${formatBytesShort(zip.totalUncompressed)} uncompressed, ` +
    `${formatBytesShort(zip.totalCompressed)} compressed.`;
  return tableSection(
    'Contents',
    ['Path', 'Size'],
    files.slice(0, CONTENT_ROWS).map((e) => [e.name, formatBytes(e.uncompressedSize)]),
    { total: files.length, noun: 'files', lead },
  );
}

async function flavour(zip: ZipArchive, fileName: string): Promise<ZipFlavour> {
  if (zip.find('AndroidManifest.xml')) {
    return readApk(zip);
  }
  if (zip.find('extension.vsixmanifest')) {
    return readVsix(zip);
  }
  // Identity files are found among exact names only, so an entry whose name was
  // cleaned or cut for display cannot stand in for one.
  const distInfo = zip.exactEntries.find((e) => /^[^/]+\.dist-info\/METADATA$/.test(e.name));
  if (distInfo) {
    return readWheel(zip, distInfo);
  }
  // NuGet's own reader matches the extension without regard to case.
  const nuspec = zip.exactEntries.find((e) => /^[^/]+\.nuspec$/i.test(e.name));
  if (nuspec) {
    return readNupkg(zip, nuspec, fileName);
  }
  // Java looks the manifest up without regard to ASCII case, and only ASCII.
  if (zip.exactEntries.some((e) => isJarManifestName(e.name))) {
    return readJar(zip);
  }
  const odf = await readOdf(zip);
  if (odf) {
    return odf;
  }
  return {
    format: 'Zip archive',
    summary: zip.complete
      ? 'A zip archive that is not a recognised package type.'
      : 'A zip archive in which no package type was recognised in the part that could be listed.',
    before: [],
    after: [],
    warnings: [],
  };
}

export async function readZipPackage(reader: RangeReader, fileName: string): Promise<PackageInfo> {
  const zip = await openZip(reader);
  const kind = await flavour(zip, fileName);
  const warnings = [...kind.warnings];
  if (zip.duplicateNames > 0) {
    warnings.push(
      'The archive lists some names more than once. MarkCopy read the last copy of each, and other tools may read a different one.',
    );
  }
  if (!zip.complete) {
    warnings.push('The archive directory is damaged or very large, so the file list is partial.');
  }
  // Only a label: MarkCopy never asks for a password or decrypts an entry.
  const encryption = summariseEncryption(zip.entries, zip.complete);
  const fileRows: [string, string][] = [
    ...(encryption === undefined ? [] : [['Encryption', encryption] as [string, string]]),
    ...(kind.fileRows ?? []),
  ];
  return {
    format: kind.format,
    title: kind.title,
    summary: kind.summary,
    sections: [...kind.before, ...contents(zip), ...kind.after],
    fileRows: fileRows.length === 0 ? undefined : fileRows,
    warnings,
  };
}
