// NuGet packages (.nupkg, .snupkg).
//
// The .nuspec at the root describes the package. What the folder layout shows
// matters as much: files under build/ run inside the consumer's build, and
// tools/ can hold scripts an older NuGet client ran on install, so those are
// called out rather than left in a file list.
import { printable } from '../binary/text';
import { formatNumber } from '../binary/html';
import { child, children, findAll, parseXml, type XNode } from '../ooxml/xnode';
import { propertySection, tableSection, type InfoSection } from './model';
import { readSigner, signatureSection } from './signature';
import {
  readBytesEntry,
  readTextEntry,
  type ZipArchive,
  type ZipEntry,
  type ZipFlavour,
} from './zipRange';

const MAX_NUSPEC_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 4000;
// A package depends on a handful of packages per framework; this bounds a
// hostile nuspec that lists thousands.
const MAX_DEPENDENCY_ROWS = 2000;
const MAX_FOLDER_NAMES = 64;
const MAX_LISTED_FILES = 12;

const text = (node: XNode | undefined, max = 500): string | undefined => {
  const value = node ? printable(node.text.trim()).slice(0, max) : '';
  return value || undefined;
};

/** The first segment under a folder: "lib/net6.0/a.dll" under "lib" gives "net6.0". */
function subfolders(zip: ZipArchive, folder: string): string[] {
  const found = new Set<string>();
  for (const entry of zip.entries) {
    const rest = entry.name.startsWith(`${folder}/`) ? entry.name.slice(folder.length + 1) : '';
    const slash = rest.indexOf('/');
    if (slash > 0 && found.size < MAX_FOLDER_NAMES) {
      found.add(rest.slice(0, slash));
    }
  }
  return [...found];
}

function underFolder(zip: ZipArchive, folder: string): ZipEntry[] {
  return zip.entries.filter((e) => !e.isDirectory && e.name.startsWith(`${folder}/`));
}

export async function readNupkg(
  zip: ZipArchive,
  nuspec: ZipEntry,
  fileName: string,
): Promise<ZipFlavour> {
  const warnings: string[] = [];
  let metadata: XNode | undefined;
  const xml = await readTextEntry(zip, nuspec, MAX_NUSPEC_BYTES, warnings, 'The nuspec');
  if (xml !== undefined) {
    try {
      const root = child(parseXml(xml), 'package');
      metadata = root ? child(root, 'metadata') : undefined;
      if (!metadata) {
        warnings.push('The nuspec has no package metadata.');
      }
    } catch {
      warnings.push('The nuspec is not valid XML.');
    }
  }
  const field = (name: string): string | undefined =>
    text(metadata ? child(metadata, name) : undefined);
  const id = field('id');
  const version = field('version');
  const licenseNode = metadata ? child(metadata, 'license') : undefined;
  const license = licenseNode
    ? `${text(licenseNode) ?? ''}${licenseNode.attrs.type === 'file' ? ' (file)' : ''}`
    : field('licenseUrl');
  const repository = metadata ? child(metadata, 'repository') : undefined;
  const typeNodes = metadata ? findAll(metadata, 'packageType') : [];

  const before: InfoSection[] = [
    ...propertySection('Package', [
      ['Id', id],
      ['Title', field('title')],
      ['Version', version],
      ['Authors', field('authors')],
      ['Owners', field('owners')],
      ['Licence', license],
      ['Licence URL', licenseNode ? field('licenseUrl') : undefined],
      ['Requires licence acceptance', field('requireLicenseAcceptance')],
      ['Homepage', field('projectUrl')],
      ['Repository', repository ? printable(repository.attrs.url ?? '').slice(0, 500) : undefined],
      [
        'Repository type',
        repository ? printable(repository.attrs.type ?? '').slice(0, 40) : undefined,
      ],
      ['Commit', repository ? printable(repository.attrs.commit ?? '').slice(0, 80) : undefined],
      ['Tags', field('tags')],
      ['Development dependency', field('developmentDependency')],
      ['Minimum NuGet client', field('minClientVersion')],
      [
        'Package types',
        typeNodes
          .map((n) => printable(n.attrs.name ?? ''))
          .filter(Boolean)
          .slice(0, 10)
          .join(', '),
      ],
    ]),
  ];
  // Descriptions keep their line breaks so paragraphs survive.
  const descriptionNode = metadata ? child(metadata, 'description') : undefined;
  const description = descriptionNode
    ? printable(descriptionNode.text.trim(), true).slice(0, MAX_TEXT_CHARS) || undefined
    : undefined;
  const notes = metadata ? child(metadata, 'releaseNotes') : undefined;
  const firstNote = notes
    ? printable(notes.text.trim(), true)
        .split(/\n\s*\n/)[0]
        ?.trim()
    : undefined;
  const paragraphs = [
    ...(description ? description.split(/\r?\n\s*\r?\n/).map((p) => p.trim()) : []),
  ].filter(Boolean);
  if (paragraphs.length > 0) {
    before.push({ kind: 'text', heading: 'Description', paragraphs });
  }
  if (firstNote) {
    before.push({
      kind: 'text',
      heading: 'Release notes',
      paragraphs: [firstNote.slice(0, MAX_TEXT_CHARS)],
    });
  }

  const dependencies: string[][] = [];
  const depsNode = metadata ? child(metadata, 'dependencies') : undefined;
  const addDependencies = (parent: XNode, framework: string): void => {
    const list = children(parent, 'dependency');
    if (list.length === 0 && framework !== '(any)') {
      dependencies.push([framework, '(none)', '']);
    }
    for (const dep of list) {
      if (dependencies.length < MAX_DEPENDENCY_ROWS) {
        dependencies.push([
          framework,
          printable(dep.attrs.id ?? '').slice(0, 200),
          printable(dep.attrs.version ?? '').slice(0, 100),
        ]);
      }
    }
  };
  if (depsNode) {
    addDependencies(depsNode, '(any)');
    for (const group of children(depsNode, 'group')) {
      addDependencies(group, printable(group.attrs.targetFramework ?? '').slice(0, 100) || '(any)');
    }
  }
  before.push(
    ...tableSection('Dependencies', ['Framework', 'Package', 'Version'], dependencies, {
      noun: 'dependencies',
    }),
  );

  const list = (items: string[]): string | undefined =>
    items.length > 0 ? items.map((s) => printable(s)).join(', ') : undefined;
  const runtimes = subfolders(zip, 'runtimes');
  const buildFiles = [...underFolder(zip, 'build'), ...underFolder(zip, 'buildTransitive')].filter(
    (e) => /\.(targets|props)$/i.test(e.name),
  );
  const toolsFiles = underFolder(zip, 'tools');
  const scripts = toolsFiles.filter((e) => /(^|\/)(install|uninstall|init)\.ps1$/i.test(e.name));
  const names = (entries: ZipEntry[]): string =>
    entries
      .slice(0, MAX_LISTED_FILES)
      .map((e) => e.name)
      .join(', ') +
    (entries.length > MAX_LISTED_FILES
      ? `, and ${formatNumber(entries.length - MAX_LISTED_FILES)} more`
      : '');
  before.push(
    ...propertySection('Targets', [
      ['Libraries for', list(subfolders(zip, 'lib'))],
      ['Reference assemblies for', list(subfolders(zip, 'ref'))],
      ['Runtimes', list(runtimes)],
      ['Analyzers', underFolder(zip, 'analyzers').length > 0 ? 'Yes' : undefined],
    ]),
    ...propertySection(
      'Code that runs',
      [
        ['Build integration', buildFiles.length > 0 ? names(buildFiles) : undefined],
        ['Install scripts', scripts.length > 0 ? names(scripts) : undefined],
        [
          'Tools folder',
          toolsFiles.length > 0 ? `${formatNumber(toolsFiles.length)} files` : undefined,
        ],
      ],
      'Build files run during the build of any project that uses the package, and PowerShell scripts under tools/ are run by older NuGet clients on install. Read them before trusting the package.',
    ),
  );

  const after: InfoSection[] = [];
  const signature = zip.find('.signature.p7s');
  if (signature) {
    const der = await readBytesEntry(
      zip,
      signature,
      MAX_SIGNATURE_BYTES,
      warnings,
      'The signature',
    );
    after.push(signatureSection('NuGet package', der ? readSigner(der) : undefined));
  }

  const symbols =
    /\.snupkg$/i.test(fileName) || typeNodes.some((n) => n.attrs.name === 'SymbolsPackage');
  return {
    format: symbols ? 'NuGet symbol package' : 'NuGet package',
    title: id ? `${id}${version ? ` ${version}` : ''}` : undefined,
    summary: field('summary') ?? description?.split(/\r?\n/)[0].slice(0, 300),
    before,
    after,
    warnings,
  };
}
