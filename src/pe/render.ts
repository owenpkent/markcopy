// Turns what readPe found into the preview's markup: ordinary headings and
// tables inside the shared shell, so the context menu's copies and the three
// exports work on an executable's metadata as they do on a Word document.
//
// Every string here came out of a file that may be hostile. All of it goes
// through escapeHtml, and the webview sanitizes the result again on arrival.
import { escapeHtml } from '../escape';
import { MEDIA_ATTR } from '../ooxml/media';
import type { PeInfo, PeSection } from './read';
import { formatBytes, formatNumber as number, properties, table, type Row } from '../binary/html';
import { printable } from '../binary/text';

/** The id the icon travels under: the shared shell's media channel wants "m" and digits. */
export const ICON_MEDIA_ID = 'm1';

// Drawn at the size Explorer's large icons are, and never larger than the
// image is: a 16 pixel icon blown up to 48 is a blur.
const ICON_SIDE = 48;

export interface RenderOptions {
  fileName: string;
  /** Lowercase hex. Absent when the host did not hash the file. */
  sha256?: string;
  /** Why there is no hash, to show in its place. */
  hashNote?: string;
}

const hex = (value: number): string => `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;

// The names Explorer's Details tab uses, in the order it shows them. A string
// the file defines under any other key is listed after these, under its own key.
const VERSION_LABELS: [key: string, label: string][] = [
  ['FileDescription', 'Description'],
  ['ProductName', 'Product'],
  ['CompanyName', 'Company'],
  ['FileVersion', 'File version'],
  ['ProductVersion', 'Product version'],
  ['LegalCopyright', 'Copyright'],
  ['LegalTrademarks', 'Trademarks'],
  ['OriginalFilename', 'Original file name'],
  ['InternalName', 'Internal name'],
  ['Comments', 'Comments'],
  ['PrivateBuild', 'Private build'],
  ['SpecialBuild', 'Special build'],
];

const WINDOWS_VERSIONS: Record<string, string> = {
  '5.0': 'Windows 2000',
  '5.1': 'Windows XP',
  '5.2': 'Windows XP 64-bit or Server 2003',
  '6.0': 'Windows Vista',
  '6.1': 'Windows 7',
  '6.2': 'Windows 8',
  '6.3': 'Windows 8.1',
  '10.0': 'Windows 10',
};

const EXECUTION_LEVELS: Record<string, string> = {
  asinvoker: 'runs with the rights of whoever starts it',
  highestavailable: 'asks for the highest rights the user has',
  requireadministrator: 'asks for administrator rights',
};

// A .NET assembly compiled for "Any CPU" is stamped as 32-bit x86 because the
// format has no neutral value, and then runs as whatever the process is. The
// machine field alone would have every such assembly read as 32-bit.
function architecture(info: PeInfo): string {
  const dotnet = info.dotnet;
  if (dotnet?.ilOnly && info.machine === 0x014c && !dotnet.requires32Bit) {
    return dotnet.prefers32Bit ? 'Any CPU (.NET, 32-bit preferred)' : 'Any CPU (.NET)';
  }
  return info.machineName;
}

function builtRow(info: PeInfo): string {
  if (info.reproducible) {
    return 'Not recorded (reproducible build)';
  }
  if (info.timestamp === 0) {
    return 'Not recorded';
  }
  const iso = new Date(info.timestamp * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function versionSection(info: PeInfo): string {
  const version = info.version;
  if (!version) {
    return '<p>This file carries no version information.</p>';
  }
  const rows: Row[] = [];
  const strings = new Map(version.strings);
  for (const [key, label] of VERSION_LABELS) {
    const value = strings.get(key);
    if (value !== undefined) {
      rows.push([label, value]);
      strings.delete(key);
    }
  }
  for (const [key, value] of strings) {
    rows.push([key, value]);
  }
  if (version.fileVersion) {
    rows.push(['File version number', version.fileVersion]);
  }
  if (version.productVersion) {
    rows.push(['Product version number', version.productVersion]);
  }
  if (version.flags.length > 0) {
    rows.push(['Build flags', version.flags.join(', ')]);
  }
  if (version.language) {
    rows.push(['Language / code page', version.language]);
  }
  return properties(rows);
}

function fileSection(info: PeInfo, options: RenderOptions): string {
  const rows: Row[] = [
    ['Type', info.kind],
    ['Architecture', architecture(info)],
    ['Format', info.format],
    ['Subsystem', info.subsystemName],
    ['Size', formatBytes(info.fileSize)],
  ];
  if (options.sha256) {
    rows.push(['SHA-256', options.sha256]);
  } else if (options.hashNote) {
    rows.push(['SHA-256', options.hashNote]);
  }
  rows.push(['Built', builtRow(info)]);
  if (info.subsystem === 2 || info.subsystem === 3) {
    const name = WINDOWS_VERSIONS[info.subsystemVersion];
    rows.push([
      'Minimum Windows version',
      name ? `${info.subsystemVersion} (${name})` : info.subsystemVersion,
    ]);
  }
  if (info.dotnet) {
    const parts = ['Yes'];
    if (info.dotnet.runtime) {
      parts.push(`runtime ${info.dotnet.runtime}`);
    }
    if (!info.dotnet.ilOnly) {
      parts.push('mixed with native code');
    }
    if (info.dotnet.requires32Bit) {
      parts.push('32-bit required');
    }
    if (info.dotnet.prefers32Bit) {
      parts.push('32-bit preferred');
    }
    if (info.dotnet.strongNamed) {
      parts.push('strong-named');
    }
    rows.push(['.NET assembly', parts.join(', ')]);
  }
  rows.push(['Linker version', info.linkerVersion]);
  rows.push(['Image base', info.imageBase]);
  rows.push(['Entry point', info.entryPoint === 0 ? 'None' : hex(info.entryPoint)]);
  rows.push(['Size in memory', formatBytes(info.sizeOfImage)]);
  rows.push(['Header checksum', info.checksum === 0 ? 'Not set' : hex(info.checksum)]);
  if (info.overlay) {
    rows.push([
      'Appended data',
      `${formatBytes(info.overlay.size)} after the image, as an installer's payload is`,
    ]);
  }
  return properties(rows);
}

function signatureSection(info: PeInfo): string {
  const signature = info.signature;
  if (!signature) {
    return (
      '<p>No signature is embedded in this file. Windows components are often signed ' +
      'through a separate catalog instead, which this preview cannot see.</p>'
    );
  }
  const rows: Row[] = [['Status', 'Embedded signature present, not verified by MarkCopy']];
  const signer = signature.signer;
  if (signer?.subject) {
    rows.push(['Signer', signer.subject]);
  }
  if (signer?.organization && signer.organization !== signer.subject) {
    rows.push(['Organization', signer.organization]);
  }
  if (signer?.issuer) {
    rows.push(['Issued by', signer.issuer]);
  }
  if (signer?.notBefore && signer.notAfter) {
    rows.push(['Certificate valid', `${signer.notBefore} to ${signer.notAfter}`]);
  }
  rows.push(['Signature size', formatBytes(signature.size)]);
  return (
    properties(rows) +
    '<p class="mc-exe-note">These names are what the file claims. MarkCopy does not check the ' +
    'signature, the certificate chain or revocation, so use the file&#39;s Properties dialog ' +
    'or <code>Get-AuthenticodeSignature</code> before trusting them.</p>'
  );
}

function manifestRows(info: PeInfo): Row[] {
  const manifest = info.manifest;
  const rows: Row[] = [];
  if (manifest?.executionLevel) {
    const meaning = EXECUTION_LEVELS[manifest.executionLevel.toLowerCase()];
    rows.push([
      'Requested execution level',
      meaning ? `${manifest.executionLevel} (${meaning})` : manifest.executionLevel,
    ]);
  }
  if (manifest?.uiAccess) {
    rows.push(['UI access', manifest.uiAccess]);
  }
  if (manifest?.dpiAware) {
    rows.push(['DPI awareness', manifest.dpiAware]);
  }
  if (manifest?.identity) {
    rows.push(['Manifest identity', manifest.identity]);
  }
  return rows;
}

function protectionSection(info: PeInfo): string {
  const rows: Row[] = manifestRows(info);
  const narrow = info.format === 'PE32';
  for (const [label, on] of info.mitigations) {
    // High-entropy ASLR needs a 64-bit address space, so it says nothing about a 32-bit image.
    if (narrow && label === 'High-entropy ASLR') {
      continue;
    }
    rows.push([label, on ? 'Yes' : 'No']);
  }
  if (narrow) {
    rows.push(['Large address aware', info.largeAddressAware ? 'Yes' : 'No']);
  }
  return properties(rows);
}

function access(section: PeSection): string {
  const parts = [];
  if (section.read) {
    parts.push('read');
  }
  if (section.write) {
    parts.push('write');
  }
  if (section.execute) {
    parts.push('execute');
  }
  return parts.join(', ');
}

function sectionsSection(info: PeInfo): string {
  return table(
    ['Name', 'Size on disk', 'Size in memory', 'Access', 'Contents'],
    info.sections.map((s) => [
      s.name,
      number(s.rawSize),
      number(s.virtualSize),
      access(s),
      s.contents.join(', '),
    ]),
  );
}

function importsSection(info: PeInfo): string {
  return table(
    ['Library', 'Functions', 'Loaded'],
    info.imports.map((entry) => [
      entry.library,
      number(entry.functions),
      entry.delayLoaded ? 'On first use' : 'At start',
    ]),
  );
}

function exportsSection(info: PeInfo): string {
  const exported = info.exports;
  if (!exported) {
    return '';
  }
  const as = exported.name ? ` as ${escapeHtml(exported.name)}` : '';
  let html = `<p>${number(exported.functions)} ${exported.functions === 1 ? 'function' : 'functions'}${as}, ${number(exported.named)} by name.</p>`;
  if (exported.names.length > 0) {
    html += table(
      ['Exported name'],
      exported.names.map((name) => [name]),
    );
    if (exported.named > exported.names.length) {
      html += `<p class="mc-exe-note">Showing the first ${number(exported.names.length)} of ${number(exported.named)} names.</p>`;
    }
  }
  return html;
}

export function renderPeHtml(info: PeInfo, options: RenderOptions): string {
  const description = info.version?.strings.find(([key]) => key === 'FileDescription')?.[1];
  const summary = `${info.kind}, ${architecture(info)}`;
  const parts: string[] = [];
  if (info.icon) {
    const width = Math.min(ICON_SIDE, info.icon.width);
    const height = Math.max(1, Math.round((info.icon.height * width) / info.icon.width));
    // No src: the bytes follow in a media message and the webview fills it in.
    parts.push(
      `<p class="mc-exe-icon"><img ${MEDIA_ATTR}="${ICON_MEDIA_ID}" alt="File icon" width="${width}" height="${height}"></p>`,
    );
  }
  parts.push(
    `<h1>${escapeHtml(printable(options.fileName))}</h1>`,
    description
      ? `<p><strong>${escapeHtml(description)}</strong><br>${escapeHtml(summary)}</p>`
      : `<p>${escapeHtml(summary)}</p>`,
  );
  for (const warning of info.warnings) {
    parts.push(`<p class="mc-exe-note">${escapeHtml(warning)}</p>`);
  }
  parts.push('<h2>Version</h2>', versionSection(info));
  parts.push('<h2>File</h2>', fileSection(info, options));
  parts.push('<h2>Signature</h2>', signatureSection(info));
  parts.push('<h2>Permissions and protections</h2>', protectionSection(info));
  if (info.debug?.pdbPath || info.debug?.guid) {
    const rows: Row[] = [];
    if (info.debug.pdbPath) {
      rows.push(['Symbol file', info.debug.pdbPath]);
    }
    if (info.debug.guid) {
      rows.push(['Symbol ID', `${info.debug.guid}, age ${info.debug.age ?? 0}`]);
    }
    parts.push('<h2>Debug information</h2>', properties(rows));
  }
  if (info.sections.length > 0) {
    parts.push('<h2>Sections</h2>', sectionsSection(info));
  }
  if (info.imports.length > 0) {
    parts.push(
      `<h2>Imports</h2>`,
      `<p>${number(info.imports.length)} ${info.imports.length === 1 ? 'library' : 'libraries'}.</p>`,
      importsSection(info),
    );
  }
  if (info.exports) {
    parts.push('<h2>Exports</h2>', exportsSection(info));
  }
  return `<div class="mc-exe">${parts.join('')}</div>`;
}
