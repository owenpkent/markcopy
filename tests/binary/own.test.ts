// A name read from a file is looked up only among a table's own keys. Before
// src/binary/own.ts, a file that named `constructor` or `__proto__` put
// `function Object() { [native code] }` or `[object Object]` on its page
// (docs/FUZZING-STRATEGY.md). Each case here is one table that a file's text
// reaches.
import { describe, expect, it } from 'vitest';
import { own } from '../../src/binary/own';
import { bytesSource } from '../../src/binary/reader';
import { readPe, renderPeHtml } from '../../src/pe';
import { parseAxml, parseManifest } from '../../src/pkg/axml';
import { readPackage, renderPackageHtml } from '../../src/pkg';
import { buildPe } from '../pe/fixture';
import { buildAxml } from '../pkg/axmlFixture';
import { buildMsi } from '../pkg/msiFixture';

const PROTOTYPE_NAMES = ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf'];

// What an inherited member looks like once it is put in a template string.
const LEAKED = /\[native code\]|\[object Object\]/;

const packagePage = async (bytes: Uint8Array, fileName: string): Promise<string> =>
  renderPackageHtml(await readPackage(bytesSource(bytes), fileName), {
    fileName,
    fileSize: bytes.length,
    sha256: 'f'.repeat(64),
  });

describe('own', () => {
  const table: Record<string, string> = { x64: '64-bit' };

  it('answers for the table’s own keys', () => {
    expect(own(table, 'x64')).toBe('64-bit');
    expect(own(table, 'arm64')).toBeUndefined();
  });

  it('does not answer for what every object inherits', () => {
    for (const name of PROTOTYPE_NAMES) {
      expect(own(table, name)).toBeUndefined();
    }
  });
});

describe('a file that names a prototype member', () => {
  it('shows an executable’s requested execution level as the file gives it', async () => {
    for (const level of ['constructor', '__proto__']) {
      const xml = `<?xml version="1.0"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="${level}" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>`;
      const info = await readPe(bytesSource(buildPe({ manifest: xml })));
      const html = renderPeHtml(info, { fileName: 'x.exe', sha256: 'f'.repeat(64) });
      expect(html).not.toMatch(LEAKED);
      expect(html).toContain(`<td>${level}</td>`);
    }
  });

  it('still explains a known execution level', async () => {
    const xml =
      '<?xml version="1.0"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="requireAdministrator" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>';
    const info = await readPe(bytesSource(buildPe({ manifest: xml })));
    expect(renderPeHtml(info, { fileName: 'x.exe', sha256: 'f'.repeat(64) })).toMatch(
      /requireAdministrator \(/,
    );
  });

  it('shows an installer’s platform as the summary template gives it', async () => {
    for (const platform of ['constructor', '__proto__']) {
      const html = await packagePage(
        buildMsi({ summary: { template: `${platform};1033` } }),
        'x.msi',
      );
      expect(html).not.toMatch(LEAKED);
      expect(html).toContain(`<td>${platform}</td>`);
    }
  });

  // deb.ts and alpine.ts look names up the same way, but no file reaches them
  // with such a name: an ar member name is at most 16 characters (MarkCopy reads
  // no long-name table), and Alpine meanings are looked up only for dotfiles.
  // They use own() so the pattern has no exceptions.

  it('keeps a binary AXML attribute named __proto__ as an attribute', () => {
    const root = parseAxml(
      buildAxml({
        name: 'manifest',
        attrs: [
          { name: '__proto__', type: 'string', value: 'kept' },
          { name: 'constructor', type: 'string', value: 'also kept' },
          { name: 'package', type: 'string', value: 'p.q' },
        ],
      }),
    );
    expect(root.attrs['__proto__']).toBe('kept');
    expect(root.attrs['constructor']).toBe('also kept');
    expect(Object.keys(root.attrs).sort()).toEqual(['__proto__', 'constructor', 'package']);
  });

  it('keeps a text manifest attribute named __proto__ as an attribute', () => {
    const root = parseManifest(
      new TextEncoder().encode('<manifest __proto__="kept" package="p.q"/>'),
    );
    expect(root.attrs['__proto__']).toBe('kept');
    expect(root.attrs['package']).toBe('p.q');
  });
});
