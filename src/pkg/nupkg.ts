// NuGet packages (.nupkg, .snupkg).
//
// The .nuspec at the root describes the package. What the folder layout shows
// matters as much: files under build/ run inside the consumer's build, and
// tools/ can hold scripts an older NuGet client ran on install, so those are
// called out rather than left in a file list.
import { printable } from '../binary/text';
import { formatNumber } from '../binary/html';
import { parseXmlBounded } from '../binary/xml';
import { child, children, findAll, type XNode } from '../ooxml/xnode';
import { propertySection, tableSection, type InfoSection } from './model';
import { readSigner, signatureSection } from './signature';
import {
  readBytesEntry,
  readTextEntry,
  isSignature,
  signatureNotEstablished,
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
  const value = node ? printable(node.text.slice(0, max).trim()) : '';
  return value || undefined;
};

// NuGet's package folders (lib, build, tools...) are matched without regard to
// case, so "Build/" is the build folder. No `u` flag: a non-ASCII letter never
// folds to an ASCII one.
const folderPattern = (folder: string): RegExp => new RegExp(`^${folder}/`, 'i');

/** The first segment under a folder: "lib/net6.0/a.dll" under "lib" gives "net6.0". */
function subfolders(zip: ZipArchive, folder: string): string[] {
  const found = new Set<string>();
  const inside = folderPattern(folder);
  for (const entry of zip.entries) {
    const rest = inside.test(entry.name) ? entry.name.slice(folder.length + 1) : '';
    const slash = rest.indexOf('/');
    if (slash > 0 && found.size < MAX_FOLDER_NAMES) {
      found.add(rest.slice(0, slash));
    }
  }
  return [...found];
}

function underFolder(zip: ZipArchive, folder: string): ZipEntry[] {
  const inside = folderPattern(folder);
  return zip.entries.filter((e) => !e.isDirectory && inside.test(e.name));
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
      const root = child(parseXmlBounded(xml), 'package');
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
      ['License', license],
      ['License URL', licenseNode ? field('licenseUrl') : undefined],
      ['Requires license acceptance', field('requireLicenseAcceptance')],
      ['Homepage', field('projectUrl')],
      [
        'Repository',
        repository ? printable((repository.attrs.url ?? '').slice(0, 500)) : undefined,
      ],
      [
        'Repository type',
        repository ? printable((repository.attrs.type ?? '').slice(0, 40)) : undefined,
      ],
      ['Commit', repository ? printable((repository.attrs.commit ?? '').slice(0, 80)) : undefined],
      ['Branch', repository ? printable((repository.attrs.branch ?? '').slice(0, 80)) : undefined],
      ['Tags', field('tags')],
      ['Development dependency', field('developmentDependency')],
      // minClientVersion is an attribute of <metadata>, not a child element.
      [
        'Minimum NuGet client',
        metadata ? printable((metadata.attrs.minClientVersion ?? '').slice(0, 40)) : undefined,
      ],
      [
        'Package types',
        typeNodes
          .slice(0, 10)
          .map((n) =>
            printable(
              `${(n.attrs.name ?? '').slice(0, 100)}${n.attrs.version ? ` ${n.attrs.version.slice(0, 40)}` : ''}`,
            ),
          )
          .filter(Boolean)
          .join(', '),
      ],
    ]),
  ];
  // Descriptions keep their line breaks so paragraphs survive.
  const descriptionNode = metadata ? child(metadata, 'description') : undefined;
  const description = descriptionNode
    ? printable(descriptionNode.text.slice(0, MAX_TEXT_CHARS).trim(), true) || undefined
    : undefined;
  const notes = metadata ? child(metadata, 'releaseNotes') : undefined;
  const firstNote = notes
    ? printable(notes.text.slice(0, MAX_TEXT_CHARS).trim(), true)
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
  let droppedDependencies = 0;
  const depsNode = metadata ? child(metadata, 'dependencies') : undefined;
  const addDependencies = (parent: XNode, framework: string): void => {
    const list = children(parent, 'dependency');
    if (list.length === 0 && framework !== '(any)') {
      dependencies.push([framework, '(none)', '']);
    }
    for (const dep of list) {
      if (dependencies.length >= MAX_DEPENDENCY_ROWS) {
        droppedDependencies++;
      } else {
        dependencies.push([
          framework,
          printable((dep.attrs.id ?? '').slice(0, 200)),
          printable((dep.attrs.version ?? '').slice(0, 100)),
        ]);
      }
    }
  };
  if (depsNode) {
    addDependencies(depsNode, '(any)');
    for (const group of children(depsNode, 'group')) {
      if (dependencies.length >= MAX_DEPENDENCY_ROWS) {
        droppedDependencies++;
        break;
      }
      addDependencies(
        group,
        printable((group.attrs.targetFramework ?? '').slice(0, 100)) || '(any)',
      );
    }
  }
  if (droppedDependencies > 0) {
    warnings.push(
      'The nuspec lists more dependencies than MarkCopy reads, so the table is incomplete.',
    );
  }
  before.push(
    ...tableSection('Dependencies', ['Framework', 'Package', 'Version'], dependencies, {
      noun: 'dependencies',
    }),
  );

  const list = (items: string[]): string | undefined =>
    items.length > 0 ? items.map((s) => printable(s)).join(', ') : undefined;
  const runtimes = subfolders(zip, 'runtimes');
  // Every folder NuGet imports build logic from: build for every framework,
  // buildTransitive for assets that flow to consumers, buildMultiTargeting for the
  // outer build of multi-targeting projects. Only .props and .targets are imported.
  const buildFiles = [
    ...underFolder(zip, 'build'),
    ...underFolder(zip, 'buildTransitive'),
    ...underFolder(zip, 'buildMultiTargeting'),
  ].filter((e) => /\.(targets|props)$/i.test(e.name));
  const toolsFiles = underFolder(zip, 'tools');
  const scripts = toolsFiles.filter((e) => /(^|\/)(install|uninstall|init)\.ps1$/i.test(e.name));
  // Analyzers and source generators are loaded into the compiler on every build.
  const analyzerFiles = underFolder(zip, 'analyzers').filter((e) => /\.dll$/i.test(e.name));
  // contentFiles and the older content folder put files into the consuming project,
  // where source files are compiled and other build actions apply.
  const contentFiles = [...underFolder(zip, 'contentFiles'), ...underFolder(zip, 'content')];
  const toolPackage = typeNodes.some((n) => /^dotnettool$/i.test(n.attrs.name ?? ''));
  const sdkPackage = typeNodes.some((n) => /^msbuildsdk$/i.test(n.attrs.name ?? ''));
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
    ]),
    ...propertySection(
      'Code that runs',
      [
        ['Build integration', buildFiles.length > 0 ? names(buildFiles) : undefined],
        ['Install scripts', scripts.length > 0 ? names(scripts) : undefined],
        [
          'Compiler analyzers',
          analyzerFiles.length > 0 ? `${formatNumber(analyzerFiles.length)} DLLs` : undefined,
        ],
        [
          'Files added to projects',
          contentFiles.length > 0 ? `${formatNumber(contentFiles.length)} files` : undefined,
        ],
        ['.NET tool', toolPackage ? 'Yes: installed as a command' : undefined],
        ['MSBuild SDK', sdkPackage ? 'Yes: its Sdk files run on every build' : undefined],
        [
          'Tools folder',
          toolsFiles.length > 0 ? `${formatNumber(toolsFiles.length)} files` : undefined,
        ],
      ],
      'Build files run during the build of any project that uses the package, analyzers run inside the compiler, and PowerShell scripts under tools/ are run by older NuGet clients on install. Read them before trusting the package.',
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
    after.push(
      der && isSignature(der)
        ? signatureSection('NuGet package', readSigner(der))
        : signatureNotEstablished(
            'The package signature file is present but could not be read as a signature, so nothing is known about it',
          ),
    );
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
