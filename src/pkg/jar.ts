// Java archives: .jar, .war and .ear.
//
// The manifest names the entry point and the version; the Maven descriptor, if
// the build left one, names the coordinates; one class file's header says
// which Java release compiled it. Nothing is loaded or run.
import { printable } from '../binary/text';
import { formatNumber } from '../binary/html';
import { propertySection, tableSection, type InfoSection } from './model';
import {
  readTextEntry,
  readV1Signatures,
  signatureNotEstablished,
  v1Section,
  type ZipArchive,
  type ZipEntry,
  type ZipFlavour,
} from './zipRange';

const MANIFEST = 'META-INF/MANIFEST.MF';
// A manifest is a few hundred bytes to a few hundred kilobytes (an OSGi
// bundle lists every package).
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROPERTIES_BYTES = 64 * 1024;
const MAX_MANIFEST_LINES = 20_000;
const MAX_ATTRIBUTES = 500;
const MAX_VALUE_CHARS = 4096;
const MAX_NAME_CHARS = 200;
// A value in the "other attributes" table is shown in a cell.
const MAX_CELL_CHARS = 300;
const MAX_OTHER_ROWS = 60;

/** The main section of a manifest: attributes in order, first occurrence of a name winning. */
export function parseJarManifest(text: string): [string, string][] {
  const lines = text.split(/\r\n|\n|\r/, MAX_MANIFEST_LINES);
  const out: [string, string][] = [];
  const seen = new Set<string>();
  let current: [string, string] | undefined;
  const flush = (): void => {
    if (current && !seen.has(current[0].toLowerCase()) && out.length < MAX_ATTRIBUTES) {
      seen.add(current[0].toLowerCase());
      out.push(current);
    }
    current = undefined;
  };
  for (const line of lines) {
    if (line === '') {
      // A blank line ends the main section; per-entry sections follow.
      break;
    }
    if (line[0] === ' ') {
      // Lines are wrapped at 72 bytes; a continuation starts with one space.
      if (current && current[1].length < MAX_VALUE_CHARS) {
        current[1] += line.slice(1);
      }
      continue;
    }
    flush();
    const colon = line.indexOf(':');
    if (colon > 0) {
      current = [
        printable(line.slice(0, Math.min(colon, MAX_NAME_CHARS))),
        line.slice(colon + 1, colon + 1 + MAX_VALUE_CHARS + 1).replace(/^ /, ''),
      ];
    }
  }
  flush();
  return out.map(([name, value]) => [name, printable(value).slice(0, MAX_VALUE_CHARS)]);
}

function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r\n|\n|\r/, 500)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] === '#' || trimmed[0] === '!') {
      continue;
    }
    const split = /[=:]/.exec(trimmed);
    if (split) {
      out.set(
        trimmed.slice(0, split.index).trim(),
        printable(trimmed.slice(split.index + 1).trim()),
      );
    }
  }
  return out;
}

/** "Java 17" for a class file major version; the first releases were 1.1 to 1.4. */
function javaRelease(major: number): string | undefined {
  if (major < 45 || major > 120) {
    return undefined;
  }
  const release = major - 44;
  return release < 5 ? `Java 1.${release}` : `Java ${release}`;
}

async function classVersion(
  zip: ZipArchive,
  classes: ZipEntry[],
  warnings: string[],
): Promise<string | undefined> {
  // module-info.class is compiled separately and often to a different level,
  // and versioned copies under META-INF/versions are for newer runtimes only.
  const chosen =
    classes.find(
      (e) => !e.name.startsWith('META-INF/') && !/(^|\/)module-info\.class$/.test(e.name),
    ) ?? classes[0];
  if (!chosen) {
    return undefined;
  }
  try {
    const head = await zip.readEntryHead(chosen, 8);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 8 || view.getUint32(0, false) !== 0xcafebabe) {
      return undefined;
    }
    const minor = view.getUint16(4, false);
    const major = view.getUint16(6, false);
    const release = javaRelease(major);
    return (
      `${major}.${minor}` +
      (release ? ` (${release})` : '') +
      (minor === 0xffff ? ', compiled with preview features' : '')
    );
  } catch {
    warnings.push('The class file version could not be read.');
    return undefined;
  }
}

export async function readJar(zip: ZipArchive): Promise<ZipFlavour> {
  const warnings: string[] = [];
  const manifestEntry =
    zip.find(MANIFEST) ?? zip.exactEntries.find((e) => /^META-INF\/MANIFEST\.MF$/i.test(e.name));
  const text = manifestEntry
    ? await readTextEntry(zip, manifestEntry, MAX_MANIFEST_BYTES, warnings, 'The manifest')
    : undefined;
  const manifest = text ? parseJarManifest(text) : [];
  const used = new Set<string>();
  const get = (name: string): string | undefined => {
    used.add(name.toLowerCase());
    return manifest.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
  };

  const mavenEntry = zip.exactEntries.find((e) =>
    /^META-INF\/maven\/[^/]+\/[^/]+\/pom\.properties$/.test(e.name),
  );
  let maven: Map<string, string> | undefined;
  if (mavenEntry) {
    const props = await readTextEntry(
      zip,
      mavenEntry,
      MAX_PROPERTIES_BYTES,
      warnings,
      'The Maven descriptor',
    );
    maven = props ? parseProperties(props) : undefined;
  }
  const coordinates =
    maven?.get('groupId') && maven.get('artifactId')
      ? `${maven.get('groupId')}:${maven.get('artifactId')}${maven.get('version') ? `:${maven.get('version')}` : ''}`
      : undefined;

  const classes = zip.entries.filter((e) => !e.isDirectory && e.name.endsWith('.class'));
  const moduleInfo = zip.entries.some((e) => /(^|\/)module-info\.class$/.test(e.name));
  const isWar = zip.find('WEB-INF/web.xml') !== undefined;
  const isEar = zip.find('META-INF/application.xml') !== undefined;
  const bytecode = await classVersion(zip, classes, warnings);

  const name = get('Implementation-Title') ?? get('Bundle-Name') ?? maven?.get('artifactId');
  const version = get('Implementation-Version') ?? get('Bundle-Version') ?? maven?.get('version');
  const title = name ? `${name}${version ? ` ${version}` : ''}` : undefined;

  const before: InfoSection[] = [
    ...propertySection('Package', [
      ['Title', get('Implementation-Title')],
      ['Version', get('Implementation-Version')],
      ['Vendor', get('Implementation-Vendor')],
      ['Specification', get('Specification-Title')],
      ['Specification version', get('Specification-Version')],
      ['Specification vendor', get('Specification-Vendor')],
      ['Maven coordinates', coordinates],
      ['OSGi symbolic name', get('Bundle-SymbolicName')],
      ['OSGi bundle version', get('Bundle-Version')],
      ['OSGi bundle name', get('Bundle-Name')],
      ['Module name', get('Automatic-Module-Name')],
      ['Created by', get('Created-By')],
      ['Built with JDK', get('Build-Jdk') ?? get('Build-Jdk-Spec')],
    ]),
    ...propertySection('Java', [
      ['Main class', get('Main-Class')],
      ['Class path', get('Class-Path')],
      ['Launcher agent', get('Launcher-Agent-Class')],
      ['Premain agent', get('Premain-Class')],
      // The value lists packages opened to reflection; that it is there is the fact.
      [
        'Opens packages to reflection',
        get('Add-Opens') === undefined ? undefined : 'Yes (Add-Opens)',
      ],
      ['Multi-release', get('Multi-Release')],
      [
        'Classes',
        classes.length > 0
          ? `${formatNumber(classes.length)}${zip.complete ? '' : ' or more'}`
          : undefined,
      ],
      ['Java module', moduleInfo ? 'Yes (module-info.class)' : undefined],
      ['Web application', isWar ? 'Yes (WEB-INF/web.xml)' : undefined],
      ['Enterprise application', isEar ? 'Yes (META-INF/application.xml)' : undefined],
      ['Class file version', bytecode],
    ]),
  ];
  const handled = new Set(['manifest-version', 'name', 'sealed']);
  const other = manifest
    .filter(([n]) => !used.has(n.toLowerCase()) && !handled.has(n.toLowerCase()))
    .map(([n, v]) => [n, v.length > MAX_CELL_CHARS ? `${v.slice(0, MAX_CELL_CHARS)}...` : v]);
  before.push(
    ...tableSection('Other manifest attributes', ['Attribute', 'Value'], other, {
      limit: MAX_OTHER_ROWS,
      noun: 'attributes',
    }),
  );

  const after: InfoSection[] = [];
  // OpenJDK pairs direct META-INF children without regard to case; see v1Name.
  const v1 = await readV1Signatures(zip, 'jdk', warnings);
  if (v1.signed.length > 0) {
    after.push(v1Section('JAR signing', v1));
  } else if (v1.notEstablished) {
    after.push(signatureNotEstablished(v1.notEstablished));
  }

  return {
    format: isWar
      ? 'Java web archive (WAR)'
      : isEar
        ? 'Java enterprise archive (EAR)'
        : 'Java archive (JAR)',
    title,
    summary:
      classes.length > 0
        ? `Java archive with ${formatNumber(classes.length)} classes${bytecode ? `, class file version ${bytecode}` : ''}.`
        : 'Java archive.',
    before,
    after,
    warnings,
  };
}
