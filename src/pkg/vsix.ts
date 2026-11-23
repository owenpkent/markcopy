// VS Code extension packages (.vsix).
//
// Two descriptions are read: extension.vsixmanifest, which the marketplace
// tooling writes, and extension/package.json, which the extension author
// wrote. The second is JSON from the file, so every field is type-checked
// before it is shown.
import { printable } from '../binary/text';
import { formatNumber } from '../binary/html';
import { child, findAll, parseXml, type XNode } from '../ooxml/xnode';
import { propertySection, tableSection, type InfoSection } from './model';
import { signatureSection } from './signature';
import { readTextEntry, type ZipArchive, type ZipFlavour } from './zipRange';

const MAX_MANIFEST_BYTES = 512 * 1024;
// package.json of an extension with a large configuration schema reaches a few hundred kilobytes.
const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ITEMS = 30;
// Contribution points are a fixed vocabulary of a few dozen names.
const MAX_CONTRIBUTION_KEYS = 80;
const MAX_TEXT_CHARS = 4000;

const EMPTY: XNode = { name: '', attrs: {}, children: [], text: '' };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function str(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' ? printable(value).slice(0, max) : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .slice(0, MAX_LIST_ITEMS * 4)
        .map((v) => str(v))
        .filter((v): v is string => v !== undefined && v !== '')
    : [];
}

/** A package.json field that is still a "%key%" placeholder for a translation is not a name. */
const unresolved = (value: string | undefined): boolean =>
  value !== undefined && /^%.*%$/.test(value);

function textOf(node: XNode | undefined): string | undefined {
  const text = node ? printable(node.text.trim(), true).slice(0, MAX_TEXT_CHARS) : undefined;
  return text || undefined;
}

function countContributions(contributes: unknown): string[][] {
  if (!isObject(contributes)) {
    return [];
  }
  const rows: string[][] = [];
  for (const key of Object.keys(contributes).slice(0, MAX_CONTRIBUTION_KEYS)) {
    const value = contributes[key];
    let count = 0;
    if (key === 'configuration') {
      // One object or a list of them, each holding a "properties" map.
      for (const block of Array.isArray(value) ? value.slice(0, 50) : [value]) {
        if (isObject(block) && isObject(block.properties)) {
          count += Object.keys(block.properties).length;
        }
      }
    } else if (Array.isArray(value)) {
      count = value.length;
    } else if (isObject(value)) {
      count = Object.keys(value).length;
    }
    if (count > 0) {
      rows.push([printable(key).slice(0, 80), formatNumber(count)]);
    }
  }
  return rows;
}

export async function readVsix(zip: ZipArchive): Promise<ZipFlavour> {
  const warnings: string[] = [];
  const manifestEntry = zip.find('extension.vsixmanifest');
  let identity: XNode | undefined;
  let metadata: XNode | undefined;
  let assets: XNode[] = [];
  const text = manifestEntry
    ? await readTextEntry(
        zip,
        manifestEntry,
        MAX_MANIFEST_BYTES,
        warnings,
        'extension.vsixmanifest',
      )
    : undefined;
  if (text) {
    try {
      const root = child(parseXml(text), 'PackageManifest');
      metadata = child(root ?? EMPTY, 'Metadata');
      identity = metadata ? child(metadata, 'Identity') : undefined;
      assets = root ? findAll(root, 'Asset') : [];
    } catch {
      warnings.push('extension.vsixmanifest is not valid XML.');
    }
  }
  const property = (id: string): string | undefined => {
    const found = metadata
      ? findAll(metadata, 'Property').find((p) => p.attrs.Id === id)
      : undefined;
    const value = found ? printable(found.attrs.Value ?? '').slice(0, 500) : '';
    return value || undefined;
  };
  const asset = (type: string): string | undefined => {
    const found = assets.find((a) => a.attrs.Type === type);
    return str(found?.attrs.Path);
  };

  let pkg: Json | undefined;
  const jsonEntry = zip.find('extension/package.json');
  if (jsonEntry) {
    const json = await readTextEntry(
      zip,
      jsonEntry,
      MAX_PACKAGE_JSON_BYTES,
      warnings,
      'extension/package.json',
    );
    if (json !== undefined) {
      try {
        const parsed: unknown = JSON.parse(json);
        if (isObject(parsed)) {
          pkg = parsed;
        } else {
          warnings.push('extension/package.json is not a JSON object.');
        }
      } catch {
        warnings.push('extension/package.json is not valid JSON.');
      }
    }
  }

  const id = str(identity?.attrs.Id) ?? str(pkg?.name);
  const publisher = str(identity?.attrs.Publisher) ?? str(pkg?.publisher);
  const version = str(identity?.attrs.Version) ?? str(pkg?.version);
  const manifestName = textOf(child(metadata ?? EMPTY, 'DisplayName'));
  const packageName = str(pkg?.displayName);
  const displayName = manifestName ?? (unresolved(packageName) ? undefined : packageName);
  const description =
    textOf(metadata ? child(metadata, 'Description') : undefined) ??
    (str(pkg?.description, MAX_TEXT_CHARS) && !unresolved(str(pkg?.description))
      ? str(pkg?.description, MAX_TEXT_CHARS)
      : undefined);

  const csv = (node: XNode | undefined): string | undefined => {
    const value = textOf(node);
    return value
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .join(', ')
      : undefined;
  };
  const engines = isObject(pkg?.engines) ? str(pkg.engines.vscode) : undefined;
  const repository = isObject(pkg?.repository) ? str(pkg.repository.url) : str(pkg?.repository);

  const before: InfoSection[] = [
    ...propertySection('Package', [
      ['Name', displayName],
      ['Identifier', id && publisher ? `${publisher}.${id}` : id],
      ['Publisher', publisher],
      ['Version', version],
      ['Target platform', str(identity?.attrs.TargetPlatform)],
      ['Requires VS Code', property('Microsoft.VisualStudio.Code.Engine') ?? engines],
      [
        'Categories',
        csv(metadata ? child(metadata, 'Categories') : undefined) ??
          strings(pkg?.categories).join(', '),
      ],
      ['Tags', csv(metadata ? child(metadata, 'Tags') : undefined)],
      ['Gallery flags', csv(metadata ? child(metadata, 'GalleryFlags') : undefined)],
      [
        'License file',
        textOf(metadata ? child(metadata, 'License') : undefined) ??
          asset('Microsoft.VisualStudio.Services.Content.License'),
      ],
      [
        'Icon',
        textOf(metadata ? child(metadata, 'Icon') : undefined) ??
          asset('Microsoft.VisualStudio.Services.Icons.Default'),
      ],
      ['License', str(pkg?.license)],
      ['Homepage', str(pkg?.homepage)],
      ['Source', property('Microsoft.VisualStudio.Services.Links.Source') ?? repository],
    ]),
  ];
  if (description) {
    before.push({
      kind: 'text',
      heading: 'Description',
      paragraphs: description
        .split(/\r?\n\s*\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean),
    });
  }

  const activation = strings(pkg?.activationEvents);
  const activationCount = Array.isArray(pkg?.activationEvents) ? pkg.activationEvents.length : 0;
  const capabilities = isObject(pkg?.capabilities) ? pkg.capabilities : undefined;
  const trust = (key: string): string | undefined => {
    const value = capabilities?.[key];
    if (isObject(value)) {
      const supported = value.supported;
      return typeof supported === 'boolean'
        ? supported
          ? 'Supported'
          : 'Not supported'
        : str(supported);
    }
    return undefined;
  };
  before.push(
    ...propertySection('Extension', [
      ['Entry point (Node)', str(pkg?.main)],
      ['Entry point (web)', str(pkg?.browser)],
      ['Extension kind', property('Microsoft.VisualStudio.Code.ExtensionKind')],
      ['Activation events', activationCount > 0 ? formatNumber(activationCount) : undefined],
      ['Untrusted workspaces', trust('untrustedWorkspaces')],
      ['Virtual workspaces', trust('virtualWorkspaces')],
    ]),
    ...tableSection(
      'Activation events',
      ['Event'],
      activation.map((a) => [a]),
      {
        limit: MAX_LIST_ITEMS,
        total: activationCount,
        noun: 'activation events',
      },
    ),
    ...tableSection(
      'Contributes',
      ['Contribution point', 'Count'],
      countContributions(pkg?.contributes),
      {
        noun: 'contribution points',
      },
    ),
  );

  const dependencies: string[][] = [];
  const addAll = (list: string[], relation: string): void => {
    for (const item of list) {
      dependencies.push([item, relation]);
    }
  };
  addAll(
    (property('Microsoft.VisualStudio.Code.ExtensionDependencies') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    'Required',
  );
  if (dependencies.length === 0) {
    addAll(strings(pkg?.extensionDependencies), 'Required');
  }
  const pack = (property('Microsoft.VisualStudio.Code.ExtensionPack') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  addAll(pack.length > 0 ? pack : strings(pkg?.extensionPack), 'Bundled in the pack');
  before.push(
    ...tableSection('Dependencies', ['Extension', 'Relationship'], dependencies, {
      noun: 'extensions',
    }),
  );

  const after: InfoSection[] = [];
  if (['.signature.p7s', '.signature.sig', 'extension.sigzip'].some((n) => zip.find(n))) {
    // The signature here is the marketplace's, in its own container; only
    // its presence is reported.
    after.push(signatureSection('Marketplace'));
  }

  const label = displayName ?? id;
  return {
    format: 'VS Code extension',
    title: label ? `${label}${version ? ` ${version}` : ''}` : undefined,
    summary: description ? description.split(/\r?\n/)[0].slice(0, 300) : undefined,
    before,
    after,
    warnings,
  };
}
