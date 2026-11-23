// Zip-based packages: Java archives, VS Code extensions, Python wheels, NuGet
// packages and Android apps, plus any other zip as a plain archive.
//
// The flavour is decided by what is inside, not by the file's extension: a
// .zip can be a wheel, a .jar can be an Android library, and an extension only
// chooses which editor VS Code opened. The archive is read through ranges
// (src/pkg/zipRange.ts), so a 300 MB .jar costs its directory and a manifest.
import { formatBytes, formatBytesShort, formatNumber } from '../binary/html';
import { readApk } from './androidApk';
import { readJar } from './jar';
import { tableSection, type PackageInfo } from './model';
import { readNupkg } from './nupkg';
import { readVsix } from './vsix';
import { readWheel } from './wheel';
import { openZip, type ZipArchive, type ZipFlavour } from './zipRange';
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
  const distInfo = zip.entries.find((e) => /^[^/]+\.dist-info\/METADATA$/.test(e.name));
  if (distInfo) {
    return readWheel(zip, distInfo);
  }
  const nuspec = zip.entries.find((e) => /^[^/]+\.nuspec$/.test(e.name));
  if (nuspec) {
    return readNupkg(zip, nuspec, fileName);
  }
  if (zip.entries.some((e) => e.name.toUpperCase() === 'META-INF/MANIFEST.MF')) {
    return readJar(zip);
  }
  return {
    format: 'Zip archive',
    summary: 'A zip archive that is not a recognised package type.',
    before: [],
    after: [],
    warnings: [],
  };
}

export async function readZipPackage(reader: RangeReader, fileName: string): Promise<PackageInfo> {
  const zip = await openZip(reader);
  const kind = await flavour(zip, fileName);
  const warnings = [...kind.warnings];
  if (!zip.complete) {
    warnings.push('The archive directory is damaged or very large, so the file list is partial.');
  }
  return {
    format: kind.format,
    title: kind.title,
    summary: kind.summary,
    sections: [...kind.before, ...contents(zip), ...kind.after],
    warnings,
  };
}
