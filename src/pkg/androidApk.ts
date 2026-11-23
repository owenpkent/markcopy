// Android packages (.apk) that are zip archives.
//
// The manifest is binary XML; src/pkg/axml.ts turns it into a tree. Names that
// the app's resources would supply (its label, its icon) are not resolved,
// since that needs resources.arsc, so they are reported as references.
import { printable } from '../binary/text';
import { formatBytesShort, formatNumber } from '../binary/html';
import { parseManifest, type ManifestNode } from './axml';
import { PackageError, propertySection, tableSection, type InfoSection } from './model';
import {
  readBytesEntry,
  readV1Signatures,
  signatureNotEstablished,
  v1Section,
  type ZipArchive,
  type ZipFlavour,
} from './zipRange';

// A large app's manifest, with thousands of components, is still well under this.
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_PERMISSIONS = 2000;
const MAX_FEATURES = 500;
const MAX_ABIS = 32;

// Block IDs from apksig (ApkSigningBlockUtils, V2/V3SchemeConstants,
// SourceStampConstants). The container holds ID/value pairs and Android ignores
// IDs it does not know, so only these count as a signature scheme.
const SIGNING_SCHEMES: Record<number, string> = {
  0x7109871a: 'v2',
  0xf05368c0: 'v3',
  0x1b93ad61: 'v3.1',
};
// Padding that keeps the directory aligned, and the source stamp (who built the
// app, not a signature over it). Neither is a signature scheme.
const VERITY_PADDING_ID = 0x42726577;
const SOURCE_STAMP_IDS = new Set([0x2b09189e, 0x6dff800d]);

/** versionCodeMajor and versionCode as Android combines them: major in the high word, both unsigned. */
function versionCode(code: string | undefined, major: string | undefined): string | undefined {
  const parse = (text: string | undefined): bigint | undefined => {
    if (text === undefined || !/^(-?[0-9]{1,12}|0x[0-9a-f]{1,8})$/i.test(text)) {
      return undefined;
    }
    return BigInt.asUintN(32, BigInt(text));
  };
  const high = parse(major);
  const low = parse(code);
  if (high === undefined || high === 0n || low === undefined) {
    return code;
  }
  return `${(high << 32n) | low} (major ${high}, code ${low})`;
}

const named = (node: ManifestNode, name: string): ManifestNode[] =>
  node.children.filter((c) => c.name === name);

const reference = (value: string | undefined): boolean =>
  value !== undefined && (value.startsWith('@') || value.startsWith('?'));

/** Show an attribute's value, or say so when it is a pointer into resources.arsc. */
const shown = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : reference(value) ? '(resource reference)' : value;

const yesNo = (value: string | undefined): string | undefined =>
  value === 'true' ? 'Yes' : value === 'false' ? 'No' : value;

function launcherActivity(application: ManifestNode | undefined): string | undefined {
  for (const activity of [
    ...(application ? named(application, 'activity') : []),
    ...(application ? named(application, 'activity-alias') : []),
  ]) {
    for (const filter of named(activity, 'intent-filter')) {
      const actions = named(filter, 'action').map((a) => a.attrs.name);
      const categories = named(filter, 'category').map((c) => c.attrs.name);
      if (
        actions.includes('android.intent.action.MAIN') &&
        categories.some(
          (c) =>
            c === 'android.intent.category.LAUNCHER' ||
            c === 'android.intent.category.LEANBACK_LAUNCHER',
        )
      ) {
        return activity.attrs.name;
      }
    }
  }
  return undefined;
}

function glVersion(value: string): string {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0
    ? `OpenGL ES ${n >>> 16}.${n & 0xffff}`
    : `OpenGL ES ${value}`;
}

export async function readApk(zip: ZipArchive): Promise<ZipFlavour> {
  const warnings: string[] = [];
  const entry = zip.find('AndroidManifest.xml');
  let manifest: ManifestNode | undefined;
  const bytes = entry
    ? await readBytesEntry(zip, entry, MAX_MANIFEST_BYTES, warnings, 'AndroidManifest.xml')
    : undefined;
  if (bytes) {
    try {
      manifest = parseManifest(bytes, warnings);
    } catch (error) {
      if (!(error instanceof PackageError)) {
        throw error;
      }
      warnings.push(`AndroidManifest.xml could not be read: ${error.message.replace(/^its /, '')}`);
    }
  }
  const attrs = manifest?.attrs ?? {};
  const application = manifest ? named(manifest, 'application')[0] : undefined;
  const sdk = manifest ? named(manifest, 'uses-sdk')[0]?.attrs : undefined;
  const packageName = attrs.package;
  const versionName = attrs.versionName;

  const dex = zip.exactEntries.filter((e) => /^classes\d*\.dex$/.test(e.name));
  const abis = new Set<string>();
  for (const e of zip.entries) {
    const match = /^lib\/([^/]+)\//.exec(e.name);
    if (match && abis.size < MAX_ABIS) {
      abis.add(match[1]);
    }
  }

  const components = (tag: string): string | undefined => {
    if (!application) {
      return undefined;
    }
    const items = named(application, tag);
    if (items.length === 0) {
      return undefined;
    }
    const exported = items.filter((i) => i.attrs.exported === 'true').length;
    return `${formatNumber(items.length)} (${formatNumber(exported)} marked exported)`;
  };
  const activities = application
    ? [...named(application, 'activity'), ...named(application, 'activity-alias')]
    : [];
  const activityCount = activities.length;
  const activityExported = activities.filter((a) => a.attrs.exported === 'true').length;

  const before: InfoSection[] = [
    ...propertySection('Package', [
      ['Package name', packageName],
      ['Version', versionName],
      ['Version code', versionCode(attrs.versionCode, attrs.versionCodeMajor)],
      ['App label', shown(application?.attrs.label)],
      ['Minimum Android API', sdk?.minSdkVersion],
      ['Target Android API', sdk?.targetSdkVersion],
      ['Compiled against API', attrs.compileSdkVersion],
      ['Compile SDK codename', attrs.compileSdkVersionCodename],
      ['Install location', attrs.installLocation],
      ['Shared user ID', attrs.sharedUserId],
      ['Debuggable', application ? (yesNo(application.attrs.debuggable) ?? 'No') : undefined],
      ['Test only', yesNo(application?.attrs.testOnly)],
      ['Allows backup', yesNo(application?.attrs.allowBackup)],
      ['Allows cleartext traffic', yesNo(application?.attrs.usesCleartextTraffic)],
      ['Launcher activity', launcherActivity(application)],
    ]),
    ...propertySection('Components', [
      [
        'Activities',
        activityCount > 0
          ? `${formatNumber(activityCount)} (${formatNumber(activityExported)} marked exported)`
          : undefined,
      ],
      ['Services', components('service')],
      ['Broadcast receivers', components('receiver')],
      ['Content providers', components('provider')],
    ]),
  ];

  const permissions: string[][] = [];
  const features: string[][] = [];
  for (const node of manifest?.children ?? []) {
    if (
      /^uses-permission(-sdk-23|-sdk-m)?$/.test(node.name) &&
      permissions.length < MAX_PERMISSIONS
    ) {
      permissions.push([
        node.attrs.name ?? '(unnamed)',
        node.attrs.maxSdkVersion ? `API ${node.attrs.maxSdkVersion}` : '',
      ]);
    } else if (node.name === 'uses-feature' && features.length < MAX_FEATURES) {
      const label =
        node.attrs.name ??
        (node.attrs.glEsVersion ? glVersion(node.attrs.glEsVersion) : '(unnamed)');
      features.push([label, node.attrs.required === 'false' ? 'No' : 'Yes']);
    }
  }
  before.push(
    ...tableSection('Permissions', ['Permission', 'Up to API'], permissions, {
      noun: 'permissions',
    }),
    ...tableSection('Features', ['Feature', 'Required'], features, { noun: 'features' }),
    ...propertySection('Code', [
      [
        'Dalvik executables',
        dex.length > 0
          ? `${formatNumber(dex.length)} (${formatBytesShort(dex.reduce((n, e) => n + e.uncompressedSize, 0))})`
          : undefined,
      ],
      ['Native libraries for', [...abis].map((a) => printable(a)).join(', ')],
    ]),
  );

  // Signature: v1 is a JAR-style PKCS #7 block with names to read. v2 and
  // later live in the APK Signing Block, whose certificate MarkCopy does not parse.
  const after: InfoSection[] = [];
  // apksig matches the block and .SF names exactly.
  const v1 = await readV1Signatures(zip, false, warnings);
  const signer = v1.signed[0]?.signer;
  let ids: number[] | undefined;
  try {
    ids = await zip.signingBlockIds();
  } catch (error) {
    if (!(error instanceof PackageError)) {
      throw error;
    }
    warnings.push('The APK Signing Block could not be read.');
  }
  // Only schemes whose IDs are present are named. A block with none of them
  // (empty, padding only, unknown IDs) is reported as a container, not as a signature.
  const schemes = [
    ...(v1.signed.length > 0 ? ['v1'] : []),
    ...new Set((ids ?? []).map((id) => SIGNING_SCHEMES[id]).filter(Boolean)),
  ];
  if (schemes.length > 0) {
    const section = v1Section(`APK Signature Scheme ${schemes.join(', ')}`, v1);
    if (!signer) {
      section.rows.push([
        'Signer',
        v1.signed.length > 0
          ? 'Not read (the certificate names could not be read)'
          : 'Not read (v2 and later signatures keep the certificate in the signing block, which MarkCopy does not parse)',
      ]);
    }
    after.push(section);
  } else if (ids !== undefined) {
    const others = ids.filter((id) => id !== VERITY_PADDING_ID && !SOURCE_STAMP_IDS.has(id));
    after.push(
      ...propertySection('Signature', [
        [
          'Status',
          'An APK Signing Block is present but holds no signature scheme MarkCopy recognises, so no signature is reported',
        ],
        [
          'Block contents',
          `${formatNumber(ids.length)} entries${others.length === 0 && ids.length > 0 ? ' (padding or source stamp only)' : ''}`,
        ],
      ]),
    );
  } else if (v1.notEstablished) {
    after.push(signatureNotEstablished(v1.notEstablished));
  } else {
    after.push(
      ...propertySection('Signature', [
        ['Status', 'Not signed: no v1 signature or APK Signing Block was found'],
      ]),
    );
  }

  const label = packageName ?? undefined;
  return {
    format: 'Android package (APK)',
    title: label ? `${label}${versionName ? ` ${versionName}` : ''}` : undefined,
    summary: manifest
      ? `Android app${sdk?.minSdkVersion ? ` for Android API ${sdk.minSdkVersion} and up` : ''}.`
      : 'Android package whose manifest could not be read.',
    before,
    after,
    warnings,
  };
}
