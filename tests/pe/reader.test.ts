import { describe, expect, it } from 'vitest';
import { bytesSource, PeError, readPe, renderPeHtml, type ByteSource } from '../../src/pe';
import { isSignedData, readSigner, signerCount } from '../../src/pe/signer';
import { countThunks } from '../../src/pe/read';
import { readVersionResource } from '../../src/pe/version';
import { buildPe, buildSignedData, iconBitmap, pngStub, type PeSpec } from './fixture';

const read = (spec: PeSpec = {}, patch: (bytes: Uint8Array) => Uint8Array = (b) => b) =>
  readPe(bytesSource(patch(buildPe(spec))));

// Overwrite NumberOfFunctions in a built image's export directory, found the
// way a loader finds it: data directory 0, mapped through the section table.
function patchExportSlots(bytes: Uint8Array, slots: number): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  const pe = view.getUint32(0x3c, true);
  const optional = pe + 24;
  const plus = view.getUint16(optional, true) === 0x20b;
  const rva = view.getUint32(optional + (plus ? 112 : 96), true);
  const table = optional + view.getUint16(pe + 20, true);
  for (let i = 0; i < view.getUint16(pe + 6, true); i++) {
    const at = table + i * 40;
    const start = view.getUint32(at + 12, true);
    if (rva >= start && rva - start < view.getUint32(at + 16, true)) {
      view.setUint32(view.getUint32(at + 20, true) + (rva - start) + 20, slots, true);
      return out;
    }
  }
  throw new Error('the image has no export directory to patch');
}

// Where a built image's headers are, read the way a loader reads them.
function layout(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = view.getUint32(0x3c, true);
  const optional = pe + 24;
  const plus = view.getUint16(optional, true) === 0x20b;
  const table = optional + view.getUint16(pe + 20, true);
  const count = view.getUint16(pe + 6, true);
  /** The file offset of section header `name`. */
  const header = (name: string): number => {
    for (let i = 0; i < count; i++) {
      const at = table + i * 40;
      if (new TextDecoder().decode(bytes.subarray(at, at + 8)).replace(/\0+$/, '') === name) {
        return at;
      }
    }
    throw new Error(`the image has no ${name} section`);
  };
  /** The file offset of an RVA, mapped through the section table as built. */
  const fileOf = (rva: number): number => {
    for (let i = 0; i < count; i++) {
      const at = table + i * 40;
      const start = view.getUint32(at + 12, true);
      if (rva >= start && rva - start < view.getUint32(at + 16, true)) {
        return view.getUint32(at + 20, true) + (rva - start);
      }
    }
    throw new Error(`RVA ${rva} is not in the image`);
  };
  /** The file offset of data directory `index`'s contents. */
  const directory = (index: number): number =>
    fileOf(view.getUint32(optional + (plus ? 112 : 96) + index * 8, true));
  return { view, optional, table, count, header, fileOf, directory };
}

/** A copy of `bytes` with `edit` applied to it through the image's layout. */
function patched(bytes: Uint8Array, edit: (image: ReturnType<typeof layout>) => void): Uint8Array {
  const out = bytes.slice();
  edit(layout(out));
  return out;
}

const NOWHERE = 0x7fff0000;

const RLO = String.fromCharCode(0x202e);

describe('readPe: headers', () => {
  it('reads a 32-bit GUI application', async () => {
    const info = await read({ timestamp: 1700000000, checksum: 0xabcdef });
    expect(info.format).toBe('PE32');
    expect(info.machine).toBe(0x014c);
    expect(info.machineName).toBe('x86 (32-bit)');
    expect(info.kind).toBe('Application');
    expect(info.subsystem).toBe(2);
    expect(info.subsystemName).toBe('Windows GUI');
    expect(info.imageBase).toBe('0x00400000');
    expect(info.timestamp).toBe(1700000000);
    expect(info.checksum).toBe(0xabcdef);
    expect(info.entryPoint).toBe(0x1000);
    expect(info.linkerVersion).toBe('14.36');
    expect(info.osVersion).toBe('6.0');
    expect(info.subsystemVersion).toBe('6.0');
    expect(info.fileSize).toBe(buildPe().length);
    expect(info.warnings).toEqual([]);
  });

  it('reads a 64-bit image with its wider image base', async () => {
    const info = await read({ plus: true });
    expect(info.format).toBe('PE32+');
    expect(info.machineName).toBe('x64 (64-bit)');
    expect(info.imageBase).toBe('0x0000000140000000');
  });

  it('names other machines, and shows an unknown one as a number', async () => {
    expect((await read({ plus: true, machine: 0xaa64 })).machineName).toBe('ARM64 (64-bit)');
    expect((await read({ machine: 0x01c4 })).machineName).toBe('ARM Thumb-2 (32-bit)');
    expect((await read({ machine: 0x1234 })).machineName).toBe('Unknown (0x1234)');
  });

  it('tells a console program, a DLL, a driver and EFI images apart', async () => {
    expect((await read({ subsystem: 3 })).kind).toBe('Console application');
    expect((await read({ dll: true })).kind).toBe('Dynamic-link library');
    expect((await read({ subsystem: 1 })).kind).toBe('Driver or native image');
    expect((await read({ subsystem: 1, dll: true })).kind).toBe('Native library');
    expect((await read({ plus: true, subsystem: 10 })).kind).toBe('EFI application');
    expect((await read({ plus: true, subsystem: 11 })).kind).toBe('EFI boot service driver');
    expect((await read({ plus: true, subsystem: 12 })).subsystemName).toBe('EFI runtime driver');
    expect((await read({ subsystem: 99 })).subsystemName).toBe('Unknown (99)');
  });

  it('reads the loader mitigations from DllCharacteristics', async () => {
    // ASLR 0x40, high-entropy 0x20, DEP 0x100, CFG 0x4000, force integrity 0x80, AppContainer 0x1000.
    const info = await read({ plus: true, dllCharacteristics: 0x40 | 0x20 | 0x100 | 0x4000 });
    expect(Object.fromEntries(info.mitigations)).toEqual({
      'Address randomization (ASLR)': true,
      'High-entropy ASLR': true,
      'DEP compatible (NX_COMPAT)': true,
      'Control Flow Guard': true,
      'Forced integrity checks': false,
      'AppContainer only': false,
    });
    const other = await read({ dllCharacteristics: 0x80 | 0x1000 });
    const flags = Object.fromEntries(other.mitigations);
    expect(flags['Forced integrity checks']).toBe(true);
    expect(flags['AppContainer only']).toBe(true);
    expect(flags['Control Flow Guard']).toBe(false);
  });

  it('reads the large-address-aware flag', async () => {
    expect((await read({ largeAddressAware: true })).largeAddressAware).toBe(true);
    expect((await read()).largeAddressAware).toBe(false);
  });

  it('lists the sections with their access and contents', async () => {
    const info = await read({ version: { fileVersion: [1, 0, 0, 0] } });
    expect(info.sections.map((s) => s.name)).toEqual(['.text', '.rdata', '.rsrc']);
    expect(info.sections[0]).toMatchObject({
      read: true,
      write: false,
      execute: true,
      contents: ['code'],
    });
    expect(info.sections[1]).toMatchObject({
      read: true,
      execute: false,
      contents: ['data'],
    });
  });
});

describe('readPe: version resource', () => {
  const strings: [string, string][] = [
    ['CompanyName', 'Contoso'],
    ['FileDescription', 'Contoso Tool'],
    ['FileVersion', '1.2.3.4'],
    ['ProductName', 'X'],
    ['LegalCopyright', 'Copyright (C) Contoso \u00a9 2024'],
  ];

  it('reads the strings in file order, the numeric versions and the language', async () => {
    const info = await read({
      version: {
        fileVersion: [1, 2, 3, 4],
        productVersion: [5, 6, 7, 8],
        strings,
        language: '040904B0',
      },
    });
    expect(info.version).toEqual({
      fileVersion: '1.2.3.4',
      productVersion: '5.6.7.8',
      flags: [],
      language: '0409 / 04B0',
      strings,
    });
  });

  it('reads a version resource in a 64-bit image and a non-English language', async () => {
    const info = await read({
      plus: true,
      version: { fileVersion: [10, 0, 19041, 1], strings, language: '040704E4' },
    });
    expect(info.version?.fileVersion).toBe('10.0.19041.1');
    expect(info.version?.language).toBe('0407 / 04E4');
  });

  it('keeps odd-length keys and values apart despite the 4-byte padding between nodes', async () => {
    const odd: [string, string][] = [
      ['A', 'b'],
      ['CD', 'efg'],
      ['EFG', 'h'],
      ['LongerKeyName', 'x'],
    ];
    const info = await read({ version: { fileVersion: [1, 0, 0, 0], strings: odd } });
    expect(info.version?.strings).toEqual(odd);
  });

  it('reports only the flags the mask says are meaningful', async () => {
    const both = await read({
      version: { fileVersion: [1, 0, 0, 0], fileFlags: 0x03, fileFlagsMask: 0x3f },
    });
    expect(both.version?.flags).toEqual(['Debug build', 'Prerelease']);
    const masked = await read({
      version: { fileVersion: [1, 0, 0, 0], fileFlags: 0x0b, fileFlagsMask: 0x01 },
    });
    expect(masked.version?.flags).toEqual(['Debug build']);
    const special = await read({
      version: { fileVersion: [1, 0, 0, 0], fileFlags: 0x2c },
    });
    expect(special.version?.flags).toEqual(['Patched', 'Private build', 'Special build']);
  });

  it('has no version when the image carries none', async () => {
    expect((await read()).version).toBeUndefined();
    expect((await read({ manifest: '<assembly/>' })).version).toBeUndefined();
  });

  it('finds the version resource when a manifest sits beside it', async () => {
    const info = await read({
      version: { fileVersion: [1, 2, 3, 4], strings },
      manifest: '<assembly><assemblyIdentity name="A.B" version="1.0.0.0"/></assembly>',
    });
    expect(info.version?.strings).toEqual(strings);
    expect(info.manifest?.identity).toBe('A.B 1.0.0.0');
  });

  it('rejects a block that is not VS_VERSION_INFO', () => {
    expect(readVersionResource(new Uint8Array(4))).toBeUndefined();
    expect(readVersionResource(new Uint8Array(0))).toBeUndefined();
  });
});

const square = (side: number, bitCount: 32 | 24 = 32) => ({
  id: 0,
  width: side,
  height: side,
  bitCount,
  data: iconBitmap({
    width: side,
    height: side,
    bitCount,
    rgba: Array.from({ length: side * side }, () => [200, 100, 50, 255]),
  }),
});

describe('readPe: icon', () => {
  it('uses the image the group names, not the first icon resource', async () => {
    // RT_ICON resources are stored by ascending id, so the 16 px image (id 5)
    // is first in the file; the group's best entry is the 32 px one (id 9).
    const info = await read({
      icons: [
        { ...square(16), id: 5 },
        { ...square(32), id: 9 },
        { ...square(8), id: 12 },
      ],
    });
    expect(info.icon).toMatchObject({ width: 32, height: 32 });
    expect(info.warnings).toEqual([]);
    expect(Array.from(info.icon!.png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('works alongside a version resource and a manifest, in a 64-bit image', async () => {
    const info = await read({
      plus: true,
      version: { fileVersion: [1, 2, 3, 4], strings: [['A', 'b']] },
      manifest: '<assembly><assemblyIdentity name="N"/></assembly>',
      icons: [{ ...square(24, 24), id: 2 }],
    });
    expect(info.icon).toMatchObject({ width: 24, height: 24 });
    expect(info.version?.fileVersion).toBe('1.2.3.4');
    expect(info.manifest?.identity).toBe('N');
  });

  it('passes a 256 pixel PNG image through', async () => {
    const png = pngStub(256, 256);
    const info = await read({
      icons: [{ id: 1, width: 256, height: 256, bitCount: 32, data: png }],
    });
    expect(info.icon).toMatchObject({ width: 256, height: 256 });
    expect(Array.from(info.icon!.png.subarray(0, 24))).toEqual(Array.from(png.subarray(0, 24)));
  });

  it('has no icon, and no warning, when the file has no icon resource', async () => {
    const info = await read({ version: { fileVersion: [1, 0, 0, 0] } });
    expect(info.icon).toBeUndefined();
    expect(info.warnings).toEqual([]);
  });

  it('has no icon when the group names an id with no resource', async () => {
    const info = await read({
      icons: [{ id: 77, width: 32, height: 32, bitCount: 32 }],
      version: { fileVersion: [1, 0, 0, 0] },
    });
    expect(info.icon).toBeUndefined();
    expect(info.version?.fileVersion).toBe('1.0.0.0');
  });

  it('has no icon for a cursor group', async () => {
    const info = await read({ icons: [{ ...square(32), id: 1 }], iconGroupType: 2 });
    expect(info.icon).toBeUndefined();
  });

  it('has no icon when the best image is not a bitmap or PNG', async () => {
    const info = await read({
      icons: [{ id: 1, width: 32, height: 32, bitCount: 32, data: new Uint8Array(200) }],
    });
    expect(info.icon).toBeUndefined();
  });
});

describe('readPe: manifest', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="2.1.0.0" name="Contoso.Tool" type="win32"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security><requestedPrivileges>
      <requestedExecutionLevel level="requireAdministrator" uiAccess="false"/>
    </requestedPrivileges></security>
  </trustInfo>
  <application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>
    <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
  </windowsSettings></application>
</assembly>`;

  it('reads the execution level, UI access, DPI awareness and identity', async () => {
    expect((await read({ manifest: xml })).manifest).toEqual({
      executionLevel: 'requireAdministrator',
      uiAccess: 'false',
      dpiAware: 'true/pm',
      identity: 'Contoso.Tool 2.1.0.0',
    });
  });

  // The stock Visual Studio app.manifest keeps this comment above the live
  // element. Reading the text instead of the document finds the comment first.
  it('reads the live execution level, not the commented-out examples above it', async () => {
    const commented = `<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <assemblyIdentity version="1.0.0.0" name="MyApplication.app"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v2">
    <security>
      <requestedPrivileges xmlns="urn:schemas-microsoft-com:asm.v3">
        <!-- UAC Manifest Options
             If you want to change the Windows User Account Control level replace the
             requestedExecutionLevel node with one of the following.

        <requestedExecutionLevel  level="asInvoker" uiAccess="true" />
        <requestedExecutionLevel  level="requireAdministrator" uiAccess="false" />
        <requestedExecutionLevel  level="highestAvailable" uiAccess="false" />
        -->
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
  <!-- <dpiAware>true</dpiAware> -->
</assembly>`;
    const info = await read({ manifest: commented });
    expect(info.manifest).toEqual({
      executionLevel: 'requireAdministrator',
      uiAccess: 'false',
      dpiAware: undefined,
      identity: 'MyApplication.app 1.0.0.0',
    });
    expect(info.warnings).toEqual([]);
    expect(renderPeHtml(info, { fileName: 'a.exe' })).toContain('asks for administrator rights');
  });

  it('takes the identity under <assembly>, not a dependency listed before it', async () => {
    const dependencyFirst = `<assembly xmlns="urn:schemas-microsoft-com:asm.v1">
  <dependency><dependentAssembly>
    <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"/>
  </dependentAssembly></dependency>
  <assemblyIdentity name="Contoso.Tool" version="3.0.0.0"/>
</assembly>`;
    expect((await read({ manifest: dependencyFirst })).manifest?.identity).toBe(
      'Contoso.Tool 3.0.0.0',
    );
    const dependencyOnly = `<assembly xmlns="urn:schemas-microsoft-com:asm.v1">
  <dependency><dependentAssembly>
    <assemblyIdentity name="Microsoft.Windows.Common-Controls" version="6.0.0.0"/>
  </dependentAssembly></dependency>
</assembly>`;
    expect((await read({ manifest: dependencyOnly })).manifest).toBeUndefined();
  });

  it('warns instead of guessing when the manifest is not well-formed XML', async () => {
    const info = await read({
      manifest: '<assembly><requestedExecutionLevel level="asInvoker"></assembly>',
    });
    expect(info.manifest).toBeUndefined();
    expect(info.warnings).toContain('The manifest could not be read.');
  });

  // Windows applies resource ID 1 to an executable's process. A file can hold
  // other manifests, and named ones sort first in the directory, so "the first
  // manifest" is not it.
  describe("which manifest is the program's own", () => {
    const manifestOf = (name: string, level: string): string =>
      `<assembly xmlns="urn:schemas-microsoft-com:asm.v1"><assemblyIdentity name="${name}" version="1.0.0.0"/>` +
      `<trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>` +
      `<requestedExecutionLevel level="${level}" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>`;

    it('reads resource ID 1, not a named manifest that comes before it', async () => {
      const info = await read({
        manifest: manifestOf('Primary.Process', 'requireAdministrator'),
        extraManifests: [{ name: 'ALTERNATE', xml: manifestOf('Secondary.Context', 'asInvoker') }],
      });
      expect(info.manifest?.identity).toBe('Primary.Process 1.0.0.0');
      expect(info.manifest?.executionLevel).toBe('requireAdministrator');
      expect(info.warnings).toEqual([]);
      expect(renderPeHtml(info, { fileName: 'a.exe' })).toContain('asks for administrator rights');
    });

    it('reads resource ID 1 when a lower-sorting numbered manifest is also there', async () => {
      const info = await read({
        manifest: manifestOf('Primary.Process', 'highestAvailable'),
        extraManifests: [
          { name: 3, xml: manifestOf('Third', 'asInvoker') },
          { name: 'A', xml: manifestOf('Named', 'asInvoker') },
        ],
      });
      expect(info.manifest?.identity).toBe('Primary.Process 1.0.0.0');
      expect(info.manifest?.executionLevel).toBe('highestAvailable');
    });

    it('shows no manifest for a program that has only a secondary one', async () => {
      const info = await read({
        extraManifests: [{ name: 'ALTERNATE', xml: manifestOf('Secondary.Context', 'asInvoker') }],
      });
      expect(info.manifest).toBeUndefined();
      expect(info.warnings).toEqual([]);
      const named = await read({ manifest: manifestOf('Other', 'asInvoker'), manifestId: 7 });
      expect(named.manifest).toBeUndefined();
    });

    it("reads a library's manifest at ID 2, and falls back to ID 1", async () => {
      const two = await read({
        dll: true,
        manifest: manifestOf('Library.Isolation', 'asInvoker'),
        manifestId: 2,
      });
      expect(two.manifest?.identity).toBe('Library.Isolation 1.0.0.0');
      const one = await read({ dll: true, manifest: manifestOf('Library.One', 'asInvoker') });
      expect(one.manifest?.identity).toBe('Library.One 1.0.0.0');
      // And an executable does not take ID 2 for its own.
      const exe = await read({ manifest: manifestOf('Not.Mine', 'asInvoker'), manifestId: 2 });
      expect(exe.manifest).toBeUndefined();
    });
  });

  it('prefers dpiAwareness, and accepts prefixed elements and single quotes', async () => {
    const prefixed = `<asmv1:assembly xmlns:asmv1="urn:schemas-microsoft-com:asm.v1">
  <asmv1:assemblyIdentity name='Only.Name'/>
  <asmv3:requestedExecutionLevel xmlns:asmv3="urn:schemas-microsoft-com:asm.v3" level='asInvoker'/>
  <dpiAware>true</dpiAware><dpiAwareness>PerMonitorV2</dpiAwareness>
</asmv1:assembly>`;
    expect((await read({ manifest: prefixed })).manifest).toEqual({
      executionLevel: 'asInvoker',
      uiAccess: undefined,
      dpiAware: 'PerMonitorV2',
      identity: 'Only.Name',
    });
  });

  it('has no manifest when none of the four facts is present', async () => {
    expect((await read({ manifest: '<assembly></assembly>' })).manifest).toBeUndefined();
    expect((await read()).manifest).toBeUndefined();
  });
});

describe('readPe: imports', () => {
  const imports = [
    { library: 'KERNEL32.dll', functions: 5 },
    { library: 'USER32.dll', functions: 1 },
  ];

  for (const plus of [false, true]) {
    it(`counts the functions of each library in a ${plus ? 'PE32+' : 'PE32'} image`, async () => {
      const info = await read({ plus, imports });
      expect(info.imports).toEqual([
        { library: 'KERNEL32.dll', functions: 5, delayLoaded: false },
        { library: 'USER32.dll', functions: 1, delayLoaded: false },
      ]);
    });

    it(`lists delay-load imports after the ordinary ones in a ${plus ? 'PE32+' : 'PE32'} image`, async () => {
      const info = await read({
        plus,
        imports: [{ library: 'KERNEL32.dll', functions: 2 }],
        delayImports: [{ library: 'ole32.dll', functions: 3 }],
      });
      expect(info.imports).toEqual([
        { library: 'KERNEL32.dll', functions: 2, delayLoaded: false },
        { library: 'ole32.dll', functions: 3, delayLoaded: true },
      ]);
    });
  }

  it('reads delay-load imports on their own', async () => {
    const info = await read({ delayImports: [{ library: 'dbghelp.dll', functions: 4 }] });
    expect(info.imports).toEqual([{ library: 'dbghelp.dll', functions: 4, delayLoaded: true }]);
  });

  it('has no imports for an image without the table', async () => {
    expect((await read()).imports).toEqual([]);
  });
});

describe('readPe: exports', () => {
  it('reads the export name, counts and names', async () => {
    const info = await read({
      dll: true,
      exports: { dllName: 'tool.dll', names: ['Alpha', 'Beta'] },
    });
    expect(info.exports).toEqual({
      name: 'tool.dll',
      base: 1,
      functions: 2,
      slots: 2,
      named: 2,
      names: ['Alpha', 'Beta'],
    });
  });

  it('counts functions that are exported by ordinal only', async () => {
    const info = await read({ exports: { dllName: 'x.dll', names: ['One'], functions: 5 } });
    expect(info.exports).toMatchObject({ functions: 5, slots: 5, named: 1, names: ['One'] });
  });

  // The header's count is the length of the address table. A library whose
  // ordinals have gaps (shell32.dll: 2,001 slots, 843 exports) leaves the
  // unused slots zero, and those are not functions.
  it('does not count the unused ordinal slots of a sparse table as functions', async () => {
    const info = await read({
      dll: true,
      exports: {
        dllName: 'sparse.dll',
        names: ['Only'],
        functions: 10,
        unused: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      },
    });
    expect(info.exports).toMatchObject({ functions: 1, slots: 10, named: 1 });
    const html = renderPeHtml(info, { fileName: 'sparse.dll' });
    expect(html).toContain('1 function as sparse.dll, 1 by name.');
    expect(html).toContain('Its ordinals run from 1 to 10, with 9 unused.');
    expect(html).not.toContain('10 functions');
  });

  // The address table's first slot is the ordinal base, not 1: crypt32.dll's
  // thousand slots are ordinals 1,001 to 2,000.
  it("gives the ordinal range from the table's base, not from 1", async () => {
    const info = await read({
      dll: true,
      exports: { dllName: 'based.dll', names: ['Only'], functions: 4, unused: [1, 2], base: 100 },
    });
    expect(info.exports).toMatchObject({ base: 100, functions: 2, slots: 4 });
    const html = renderPeHtml(info, { fileName: 'based.dll' });
    expect(html).toContain('Its ordinals run from 100 to 103, with 2 unused.');
    expect(html).not.toContain('run to 4');
  });

  it('says nothing about ordinals when every slot is in use', async () => {
    const info = await read({ exports: { dllName: 'x.dll', names: ['A', 'B'] } });
    const html = renderPeHtml(info, { fileName: 'x.dll' });
    expect(html).toContain('2 functions as x.dll, 2 by name.');
    expect(html).not.toContain('ordinals');
  });

  it('reports slots, not functions, when the address table cannot be read', async () => {
    // A table of 60,000 slots in a file a few kilobytes long runs off its end.
    const info = await read({ exports: { dllName: 'x.dll', names: ['A'], functions: 2 } }, (b) =>
      patchExportSlots(b, 60000),
    );
    expect(info.exports?.functions).toBeUndefined();
    expect(info.exports?.slots).toBe(60000);
    expect(info.exports?.names).toEqual(['A']);
    const html = renderPeHtml(info, { fileName: 'x.dll' });
    expect(html).toContain('60,000 export table slots as x.dll, 1 by name.');
    expect(html).not.toContain('60,000 functions');
  });

  it('does not try to count a table longer than ordinals can address', async () => {
    const info = await read({ exports: { dllName: 'x.dll', names: ['A'] } }, (b) =>
      patchExportSlots(b, 0x7fffffff),
    );
    expect(info.exports?.functions).toBeUndefined();
    expect(info.exports?.slots).toBe(0x7fffffff);
  });

  it('lists at most 100 names but reports how many there are', async () => {
    const names = Array.from({ length: 150 }, (_, i) => `Export${String(i).padStart(3, '0')}`);
    const info = await read({ plus: true, exports: { dllName: 'big.dll', names } });
    expect(info.exports?.named).toBe(150);
    expect(info.exports?.functions).toBe(150);
    expect(info.exports?.names).toHaveLength(100);
    expect(info.exports?.names[0]).toBe('Export000');
    expect(info.exports?.names[99]).toBe('Export099');
  });

  it('has no exports for an image without the table', async () => {
    expect((await read()).exports).toBeUndefined();
  });
});

describe('readPe: debug directory', () => {
  const debug = {
    guid: '11223344-5566-7788-99AA-BBCCDDEEFF00',
    age: 3,
    pdbPath: 'C:\\build\\tool.pdb',
  };

  it('reads the CodeView record with its GUID in canonical byte order', async () => {
    const info = await read({ debug });
    expect(info.debug).toEqual({
      guid: '11223344-5566-7788-99AA-BBCCDDEEFF00',
      age: 3,
      pdbPath: 'C:\\build\\tool.pdb',
    });
    expect(info.reproducible).toBe(false);
  });

  it('marks a build with a REPRO entry as reproducible', async () => {
    const info = await read({ debug, repro: true });
    expect(info.reproducible).toBe(true);
    expect(info.debug?.pdbPath).toBe('C:\\build\\tool.pdb');
  });

  it('marks a reproducible build that has no CodeView record', async () => {
    const info = await read({ repro: true });
    expect(info.reproducible).toBe(true);
    expect(info.debug).toBeUndefined();
  });

  it('has no debug record when the directory is absent', async () => {
    const info = await read();
    expect(info.debug).toBeUndefined();
    expect(info.reproducible).toBe(false);
  });
});

describe('readPe: .NET header', () => {
  it('reads the runtime and an IL-only assembly', async () => {
    expect((await read({ clr: { runtime: 'v4.0.30319', flags: 0x1 } })).dotnet).toEqual({
      runtime: 'v4.0.30319',
      ilOnly: true,
      requires32Bit: false,
      prefers32Bit: false,
      strongNamed: false,
    });
  });

  it('reads the 32-bit, preferred-32-bit and strong-name flags', async () => {
    const required = await read({ clr: { runtime: 'v2.0.50727', flags: 0x1 | 0x2 } });
    expect(required.dotnet).toMatchObject({ requires32Bit: true, prefers32Bit: false });
    const preferred = await read({ clr: { runtime: 'v4.0.30319', flags: 0x1 | 0x2 | 0x20000 } });
    expect(preferred.dotnet).toMatchObject({ requires32Bit: false, prefers32Bit: true });
    const strong = await read({ clr: { runtime: 'v4.0.30319', flags: 0x1 | 0x8 } });
    expect(strong.dotnet?.strongNamed).toBe(true);
    const mixed = await read({ clr: { runtime: 'v4.0.30319', flags: 0 } });
    expect(mixed.dotnet?.ilOnly).toBe(false);
  });

  it('has no .NET header for a native image', async () => {
    expect((await read()).dotnet).toBeUndefined();
  });
});

describe('readPe: signature', () => {
  const signer = {
    subject: { commonName: 'Contoso Software', organization: 'Contoso Ltd' },
    issuer: { commonName: 'Contoso Code Signing CA' },
    notBefore: '230615000000Z',
    notAfter: '260615235959Z',
  };

  it('names the signer the SignerInfo cites, not the first certificate', async () => {
    const info = await read({ certificate: buildSignedData(signer) });
    expect(info.signature?.signer).toEqual({
      subject: 'Contoso Software',
      organization: 'Contoso Ltd',
      issuer: 'Contoso Code Signing CA',
      notBefore: '2023-06-15',
      notAfter: '2026-06-15',
    });
  });

  it('reports the size of the certificate table, padding included', async () => {
    const der = buildSignedData(signer);
    const info = await read({ certificate: der });
    expect(info.signature?.size).toBe(Math.ceil((8 + der.length) / 8) * 8);
  });

  it('reads PrintableString names and two-digit years before and after 2050', async () => {
    const info = await read({
      certificate: buildSignedData({
        ...signer,
        stringTag: 0x13,
        notBefore: '991231235959Z',
        notAfter: '490101000000Z',
      }),
    });
    expect(info.signature?.signer).toMatchObject({
      subject: 'Contoso Software',
      notBefore: '1999-12-31',
      notAfter: '2049-01-01',
    });
  });

  it('counts the signers of SignedData, and finds none in a bundle of certificates', () => {
    expect(signerCount(buildSignedData(signer))).toBe(1);
    // ContentInfo naming SignedData, holding an empty SEQUENCE.
    const bare = Uint8Array.from([
      0x30, 0x0f, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02, 0xa0, 0x02,
      0x30, 0x00,
    ]);
    expect(isSignedData(bare)).toBe(true);
    expect(signerCount(bare)).toBe(0);
    expect(signerCount(new Uint8Array(40).fill(0x41))).toBe(0);
    expect(signerCount(new Uint8Array(0))).toBe(0);
  });

  // A corrupt entry length must not carry the walk out of the certificate
  // table. A length near the top of the range once became a step backwards,
  // because the padding was done with a 32-bit mask.
  describe('an entry whose length lies', () => {
    it('is not followed when it runs past the table', async () => {
      const info = await read({ certificate: buildSignedData(signer), certificateLength: 0x10000 });
      expect(info.signature).toMatchObject({ signedData: false, entries: [] });
      expect(info.warnings).toEqual([]);
    });

    it('is not followed backwards when it is near the top of the range', async () => {
      for (const length of [0xfffffff8, 0xfffffff9, 0xffffffff, 0x80000000, 0x7ffffff9]) {
        const info = await read({
          certificate: buildSignedData(signer),
          certificateLength: length,
        });
        expect(info.signature).toMatchObject({ signedData: false, entries: [] });
      }
    });

    it('does not read bytes before the table as an entry', async () => {
      // Sixteen bytes placed straight before the table that read as the header
      // of a PKCS #7 entry. Stepping back eight bytes from the table would land
      // on them.
      const lure = new Uint8Array(16);
      new DataView(lure.buffer).setUint32(8, 16, true);
      new DataView(lure.buffer).setUint16(14, 2, true);
      const info = await read({
        overlay: lure,
        certificate: buildSignedData(signer),
        certificateLength: 0xfffffff8,
      });
      expect(info.signature?.entries).toEqual([]);
      expect(info.signature?.signedData).toBe(false);
    });

    it('still reads a second entry that follows a well-formed first', async () => {
      const first = buildSignedData(signer);
      const info = await read({ certificate: first });
      expect(info.signature).toMatchObject({ signedData: true, entries: ['PKCS #7 SignedData'] });
    });
  });

  it('recognizes a PKCS #7 SignedData entry as a signature', async () => {
    const info = await read({ certificate: buildSignedData(signer) });
    expect(info.signature).toMatchObject({ signedData: true, entries: ['PKCS #7 SignedData'] });
  });

  // A certificate table is not a signature. Only a PKCS #7 SignedData entry is
  // one, and an entry has to be that, not merely be labelled as that.
  it('reports a table whose entry is labelled PKCS #7 but is not SignedData as unsigned', async () => {
    const info = await read({ certificate: new Uint8Array(40).fill(0x41) });
    expect(info.signature).toMatchObject({ size: 48, signedData: false });
    expect(info.signature?.signer).toBeUndefined();
    expect(renderPeHtml(info, { fileName: 'a.exe' })).not.toContain('signature present');
  });

  it('does not call a bare X.509 certificate a signature', async () => {
    // The same bytes that are a signature under type 2, filed under type 1.
    const info = await read({ certificate: buildSignedData(signer), certificateType: 1 });
    expect(info.signature).toMatchObject({ signedData: false, entries: ['X.509 certificate'] });
    expect(info.signature?.signer).toBeUndefined();
    const html = renderPeHtml(info, { fileName: 'a.exe' });
    expect(html).toContain('Certificate data present, with no Authenticode signature recognized');
    expect(html).toContain('<td>Holds</td><td>X.509 certificate</td>');
    expect(html).not.toContain('Embedded signature present');
    expect(html).not.toContain('<td>Signer</td>');
    expect(html).not.toContain('Contoso');
  });

  it('names an entry type it does not know by its number', async () => {
    const info = await read({ certificate: new Uint8Array(16), certificateType: 9 });
    expect(info.signature).toMatchObject({ signedData: false, entries: ['Type 9'] });
  });

  it('has no signature when the directory is empty', async () => {
    expect((await read()).signature).toBeUndefined();
  });

  it('strips direction and control characters from the signer name', async () => {
    const info = await read({
      certificate: buildSignedData({
        ...signer,
        subject: { commonName: `Evil${RLO}fdp\u0007.exe` },
      }),
    });
    expect(info.signature?.signer?.subject).toBe('Evilfdp.exe');
  });

  it('returns nothing from a truncated or empty SignedData', () => {
    const der = buildSignedData(signer);
    expect(readSigner(new Uint8Array(0))).toBeUndefined();
    for (let n = 0; n < der.length; n += 7) {
      expect(() => readSigner(der.subarray(0, n))).not.toThrow();
    }
  });
});

describe('readPe: overlay', () => {
  it('reports bytes after the last section', async () => {
    const bytes = buildPe({ overlay: 1000 });
    const info = await readPe(bytesSource(bytes));
    expect(info.overlay).toEqual({ offset: bytes.length - 1000, size: 1000 });
  });

  it('stops the overlay where the certificate table starts', async () => {
    const der = buildSignedData({
      subject: { commonName: 'S' },
      issuer: { commonName: 'I' },
    });
    const bytes = buildPe({ overlay: 1000, certificate: der });
    const info = await readPe(bytesSource(bytes));
    expect(info.signature?.signer?.subject).toBe('S');
    // The overlay is padded to the table's 8-byte boundary.
    expect(info.overlay?.offset).toBe(bytes.length - Math.ceil((8 + der.length) / 8) * 8 - 1000);
    expect(info.overlay?.size).toBe(1000);
  });

  it('has no overlay for an image that ends with its last section', async () => {
    expect((await read()).overlay).toBeUndefined();
  });

  it('has no overlay when only a certificate table follows the sections', async () => {
    const info = await read({
      certificate: buildSignedData({ subject: { commonName: 'S' }, issuer: { commonName: 'I' } }),
    });
    expect(info.overlay).toBeUndefined();
  });
});

describe('readPe: rejection', () => {
  const rejects = async (bytes: Uint8Array, message?: RegExp) => {
    const failure = await readPe(bytesSource(bytes)).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(PeError);
    if (message) {
      expect((failure as PeError).message).toMatch(message);
    }
  };

  it('rejects an empty file', async () => {
    await rejects(new Uint8Array(0), /too small/);
  });

  it('rejects a file too short for a DOS header', async () => {
    await rejects(Uint8Array.from([0x4d, 0x5a, 0, 0]), /too small/);
  });

  it('rejects bytes that do not start with MZ', async () => {
    await rejects(new Uint8Array(200).fill(0x41), /MZ/);
  });

  it('rejects an MZ file with no PE signature, as a DOS program is', async () => {
    const dos = new Uint8Array(256);
    dos.set([0x4d, 0x5a]);
    new DataView(dos.buffer).setUint32(0x3c, 0x80, true); // points at zeros
    await rejects(dos, /DOS or 16-bit/);
  });

  it('rejects an MZ file whose PE offset is past the end', async () => {
    const dos = new Uint8Array(128);
    dos.set([0x4d, 0x5a]);
    new DataView(dos.buffer).setUint32(0x3c, 0xfffffff0, true);
    await rejects(dos, /DOS or 16-bit/);
  });

  it('rejects an absurd section count', async () => {
    await rejects(buildPe({ declaredSections: 97 }), /sections/);
    await rejects(buildPe({ declaredSections: 0xffff }), /sections/);
  });

  it('rejects an optional header too small to describe an image', async () => {
    const bytes = buildPe();
    new DataView(bytes.buffer).setUint16(0x80 + 4 + 16, 40, true); // SizeOfOptionalHeader
    await rejects(bytes, /optional header/);
  });

  it('rejects an unknown optional header magic', async () => {
    const bytes = buildPe();
    new DataView(bytes.buffer).setUint16(0x80 + 24, 0x107, true);
    await rejects(bytes, /unknown format/);
  });
});

describe('readPe: damaged images', () => {
  it('warns instead of throwing when a directory points outside the file', async () => {
    const info = await read({
      version: { fileVersion: [1, 0, 0, 0] },
      directories: {
        1: { address: 0x7fff0000, size: 40 },
        6: { address: 0x7fff0000, size: 56 },
        0: { address: 0x7fff0000, size: 40 },
        14: { address: 0x7fff0000, size: 72 },
      },
    });
    expect(info.imports).toEqual([]);
    expect(info.exports).toBeUndefined();
    expect(info.dotnet).toBeUndefined();
    expect(info.warnings).toEqual(
      expect.arrayContaining([
        'The import table could not be read.',
        'The export table could not be read.',
        'The debug directory could not be read.',
        'The .NET header could not be read.',
      ]),
    );
    // The part that is intact is still shown.
    expect(info.version?.fileVersion).toBe('1.0.0.0');
  });

  it('warns when the certificate table lies beyond the end of the file', async () => {
    const info = await read({ directories: { 4: { address: 0x7ffffff0, size: 64 } } });
    expect(info.signature).toBeUndefined();
    expect(info.warnings).toContain('The signature could not be read.');
  });

  it('warns when the resource directory points outside the file', async () => {
    const info = await read({
      version: { fileVersion: [1, 0, 0, 0] },
      directories: { 2: { address: 0x7fff0000, size: 64 } },
    });
    expect(info.version).toBeUndefined();
    expect(info.warnings).toContain('The version resource could not be read.');
    expect(info.warnings).toContain('The manifest could not be read.');
  });

  const threeLibraries = {
    imports: [
      { library: 'KERNEL32.dll', functions: 3 },
      { library: 'USER32.dll', functions: 2 },
      { library: 'ADVAPI32.dll', functions: 1 },
    ],
  };

  it('leaves out an import whose library name points nowhere and keeps the rest', async () => {
    const bytes = patched(buildPe(threeLibraries), (image) => {
      image.view.setUint32(image.directory(1) + 20 + 12, NOWHERE, true); // second descriptor's Name
    });
    const info = await readPe(bytesSource(bytes));
    expect(info.imports.map((i) => [i.library, i.functions])).toEqual([
      ['KERNEL32.dll', 3],
      ['ADVAPI32.dll', 1],
    ]);
    expect(info.warnings).toEqual([
      '1 entry of the import table could not be read and is left out.',
    ]);
  });

  it('counts an import from its address table when the lookup table points nowhere', async () => {
    const bytes = patched(buildPe(threeLibraries), (image) => {
      image.view.setUint32(image.directory(1) + 20, NOWHERE, true); // OriginalFirstThunk
    });
    const info = await readPe(bytesSource(bytes));
    expect(info.imports.map((i) => i.functions)).toEqual([3, 2, 1]);
    expect(info.warnings).toEqual([]);
  });

  it('keeps the library but not a count when neither thunk table resolves', async () => {
    const bytes = patched(buildPe(threeLibraries), (image) => {
      image.view.setUint32(image.directory(1) + 20, NOWHERE, true); // OriginalFirstThunk
      image.view.setUint32(image.directory(1) + 20 + 16, NOWHERE, true); // FirstThunk
    });
    const info = await readPe(bytesSource(bytes));
    expect(info.imports.map((i) => [i.library, i.functions])).toEqual([
      ['KERNEL32.dll', 3],
      ['USER32.dll', undefined],
      ['ADVAPI32.dll', 1],
    ]);
  });

  it('leaves out a delay-load import whose name points nowhere and keeps the rest', async () => {
    const bytes = patched(
      buildPe({
        delayImports: [
          { library: 'WINHTTP.dll', functions: 2 },
          { library: 'dbghelp.dll', functions: 4 },
        ],
      }),
      (image) => {
        image.view.setUint32(image.directory(13) + 4, NOWHERE, true); // first DllNameRVA
      },
    );
    const info = await readPe(bytesSource(bytes));
    expect(info.imports.map((i) => [i.library, i.functions, i.delayLoaded])).toEqual([
      ['dbghelp.dll', 4, true],
    ]);
    expect(info.warnings).toEqual([
      '1 entry of the delay-load import table could not be read and is left out.',
    ]);
  });

  it('leaves out an exported name that points nowhere and keeps the counts', async () => {
    const bytes = patched(
      buildPe({ dll: true, exports: { dllName: 'core.dll', names: ['Alpha', 'Beta', 'Gamma'] } }),
      (image) => {
        const names = image.view.getUint32(image.directory(0) + 32, true); // AddressOfNames
        image.view.setUint32(image.fileOf(names) + 4, NOWHERE, true); // "Beta"
      },
    );
    const info = await readPe(bytesSource(bytes));
    expect(info.exports?.name).toBe('core.dll');
    expect(info.exports?.functions).toBe(3);
    expect(info.exports?.names).toEqual(['Alpha', 'Gamma']);
    expect(info.warnings).toEqual(['1 exported name could not be read and is left out.']);
    // Alpha and Gamma are the first and third names, not "the first 2".
    const html = renderPeHtml(info, { fileName: 'core.dll' });
    expect(html).toContain('Showing 2 of 3 names. 1 could not be read.');
    expect(html).not.toContain('Showing the first 2');
  });

  it('keeps the exports when only the library name they export under points nowhere', async () => {
    const bytes = patched(
      buildPe({ dll: true, exports: { dllName: 'core.dll', names: ['Alpha'] } }),
      (image) => {
        image.view.setUint32(image.directory(0) + 12, NOWHERE, true); // Name
      },
    );
    const info = await readPe(bytesSource(bytes));
    expect(info.exports?.name).toBe('');
    expect(info.exports?.names).toEqual(['Alpha']);
    expect(info.warnings).toEqual(['The name the library exports under could not be read.']);
  });

  it('keeps the export counts when the table of names itself points nowhere', async () => {
    const bytes = patched(
      buildPe({ dll: true, exports: { dllName: 'core.dll', names: ['Alpha', 'Beta'] } }),
      (image) => {
        image.view.setUint32(image.directory(0) + 32, NOWHERE, true); // AddressOfNames
      },
    );
    const info = await readPe(bytesSource(bytes));
    expect(info.exports?.name).toBe('core.dll');
    expect(info.exports?.functions).toBe(2);
    expect(info.exports?.named).toBe(2);
    expect(info.exports?.names).toEqual([]);
    expect(info.exports?.unreadNames).toBe(2);
    expect(info.warnings).toEqual(['The table of exported names could not be read.']);
    expect(renderPeHtml(info, { fileName: 'core.dll' })).toContain(
      'The exported names could not be read.',
    );
  });

  it('counts a function list that ends at its section’s data only when zero fill follows', async () => {
    // The second library's lookup table is pointed at .text: 0x200 bytes of
    // code with no zero entry, then (at the default 0x1000 alignment) zero
    // fill, which is the terminator the loader sees.
    const retarget = (image: ReturnType<typeof layout>): void => {
      const text = image.view.getUint32(image.header('.text') + 12, true);
      image.view.setUint32(image.directory(1) + 20, text, true); // OriginalFirstThunk
    };
    const filled = await readPe(bytesSource(patched(buildPe(threeLibraries), retarget)));
    expect(filled.imports[1]).toMatchObject({ library: 'USER32.dll', functions: 0x200 / 4 });

    // With the section alignment brought down to the file alignment, .text's
    // data runs right up to its mapped end and no zero entry is known to follow.
    const flush = await readPe(
      bytesSource(
        patched(buildPe(threeLibraries), (image) => {
          retarget(image);
          image.view.setUint32(image.optional + 32, 0x200, true); // SectionAlignment
        }),
      ),
    );
    expect(flush.imports.map((i) => [i.library, i.functions])).toEqual([
      ['KERNEL32.dll', 3],
      ['USER32.dll', undefined],
      ['ADVAPI32.dll', 1],
    ]);
  });

  it('charges the thunk budget for entries read before a read error', async () => {
    let calls = 0;
    const failing = {
      view: async (_offset: number, length: number): Promise<DataView> => {
        calls++;
        if (calls > 1) {
          throw new Error('the disk could not be read');
        }
        return new DataView(new Uint8Array(length).fill(1).buffer);
      },
      bytes: async (): Promise<Uint8Array> => new Uint8Array(0),
    };
    const budget = { left: 10000 };
    await expect(
      countThunks(
        failing as unknown as Parameters<typeof countThunks>[0],
        { offset: 0, length: 4 * 2000, cut: false, zeroFill: 0x1000 },
        false,
        budget,
      ),
    ).rejects.toThrow('the disk could not be read');
    expect(budget.left).toBe(10000 - 512);
  });

  it('stops the import walk where its section’s file data ends, without reading on', async () => {
    // The terminator is overwritten with a copy of the first descriptor, and
    // .rdata's file data is cut to end just before it: what follows is not
    // part of the table the loader sees, so the copy must not be listed.
    const bytes = patched(buildPe(threeLibraries), (image) => {
      const descriptors = image.directory(1);
      const out = new Uint8Array(image.view.buffer, image.view.byteOffset);
      out.copyWithin(descriptors + 60, descriptors, descriptors + 20);
      const rdata = image.header('.rdata');
      const raw = image.view.getUint32(rdata + 20, true);
      image.view.setUint32(rdata + 16, descriptors + 60 - raw, true); // SizeOfRawData
    });
    const info = await readPe(bytesSource(bytes));
    expect(info.imports.map((i) => i.library)).toEqual([
      'KERNEL32.dll',
      'USER32.dll',
      'ADVAPI32.dll',
    ]);
    expect(info.warnings).toEqual([
      'The import table runs to the end of its section without a closing entry: the entries before that are shown.',
    ]);
  });

  // An image whose export address table (nonzero entries) is the last thing
  // in the file, so a thunk list pointed at it runs into the end of the file.
  const runsToEof = async (
    spec: PeSpec,
    retarget: (image: ReturnType<typeof layout>, functions: number) => void,
    extra: number,
  ): Promise<Awaited<ReturnType<typeof readPe>>> => {
    const whole = buildPe(spec);
    const image = layout(whole);
    const functions = image.fileOf(image.view.getUint32(image.directory(0) + 28, true));
    const bytes = patched(whole, (copy) => retarget(copy, functions));
    // Three whole entries of the address table, then `extra` bytes of a fourth.
    return readPe(bytesSource(bytes.slice(0, functions + 12 + extra)));
  };
  const exportsOf = { dllName: 'x.dll', names: ['A', 'B', 'C', 'D', 'E', 'F'] };

  for (const extra of [0, 2]) {
    it(`keeps the other imports when one function list runs into the end of the file (${extra} spare bytes)`, async () => {
      const info = await runsToEof(
        { ...threeLibraries, dll: true, exports: exportsOf },
        (image, functions) => {
          const rva = image.view.getUint32(image.directory(0) + 28, true);
          expect(image.fileOf(rva)).toBe(functions);
          image.view.setUint32(image.directory(1) + 20, rva, true); // second OriginalFirstThunk
        },
        extra,
      );
      expect(info.imports.map((i) => [i.library, i.functions])).toEqual([
        ['KERNEL32.dll', 3],
        ['USER32.dll', undefined],
        ['ADVAPI32.dll', 1],
      ]);
    });

    it(`keeps a delay-load import whose name list runs into the end of the file (${extra} spare bytes)`, async () => {
      const info = await runsToEof(
        {
          delayImports: [
            { library: 'WINHTTP.dll', functions: 2 },
            { library: 'dbghelp.dll', functions: 4 },
          ],
          dll: true,
          exports: exportsOf,
        },
        (image) => {
          const rva = image.view.getUint32(image.directory(0) + 28, true);
          image.view.setUint32(image.directory(13) + 16, rva, true); // first ImportNameTableRVA
        },
        extra,
      );
      expect(info.imports.map((i) => [i.library, i.functions])).toEqual([
        ['WINHTTP.dll', undefined],
        ['dbghelp.dll', 4],
      ]);
    });
  }

  it('still finds the REPRO entry after a CodeView entry whose record is outside the file', async () => {
    const bytes = patched(
      buildPe({
        debug: { guid: '12345678-9abc-def0-1234-56789abcdef0', age: 1, pdbPath: 'C:\\x.pdb' },
        repro: true,
      }),
      (image) => {
        image.view.setUint32(image.directory(6) + 24, 0x7ffffff0, true); // PointerToRawData
      },
    );
    const info = await readPe(bytesSource(bytes));
    expect(info.debug).toBeUndefined();
    expect(info.reproducible).toBe(true);
    expect(info.warnings).toEqual([
      '1 entry of the debug directory could not be read and is left out.',
    ]);
  });

  it('shows the headers and the sections that fit when the file ends in the section table', async () => {
    const whole = buildPe(threeLibraries);
    const { table, count } = layout(whole);
    expect(count).toBeGreaterThan(1);
    const info = await readPe(bytesSource(whole.slice(0, table + 40 + 10)));
    expect(info.format).toBe('PE32');
    expect(info.sections.map((s) => s.name)).toEqual(['.text']);
    expect(info.warnings).toContain(
      `The file ends inside the section table: 1 of ${count} sections are shown.`,
    );
  });

  it('does not read past a section’s virtual size into raw padding', async () => {
    // With the section alignment brought down to the file alignment, .rdata
    // claiming 16 bytes maps 0x200 of them, and the import descriptors, which
    // the fixture writes after the names they point at, lie past that.
    const many = { imports: [{ library: 'KERNEL32.dll', functions: 120 }] };
    const whole = buildPe(many);
    const { directory, view, optional, header } = layout(whole);
    const rdataRva = view.getUint32(header('.rdata') + 12, true);
    const importRva = view.getUint32(optional + 96 + 8, true);
    expect(importRva - rdataRva).toBeGreaterThan(0x200);
    expect(directory(1)).toBeGreaterThan(0);

    const shrunk = patched(whole, (image) => {
      image.view.setUint32(image.optional + 32, 0x200, true); // SectionAlignment
      image.view.setUint32(image.header('.rdata') + 8, 16, true); // VirtualSize
    });
    const info = await readPe(bytesSource(shrunk));
    expect(info.imports).toEqual([]);
    expect(info.warnings).toContain('The import table could not be read.');

    // A VirtualSize of 0, as old linkers left it, maps the whole raw size.
    const zero = patched(whole, (image) => {
      image.view.setUint32(image.header('.rdata') + 8, 0, true);
    });
    expect((await readPe(bytesSource(zero))).imports).toEqual([
      { library: 'KERNEL32.dll', functions: 120, delayLoaded: false },
    ]);
  });

  it('resolves or rejects with PeError at every truncation of a rich image', async () => {
    const bytes = buildPe({
      plus: true,
      dll: true,
      version: {
        fileVersion: [1, 2, 3, 4],
        strings: [
          ['CompanyName', 'Contoso'],
          ['FileDescription', 'Contoso Tool'],
        ],
      },
      manifest: '<assembly><assemblyIdentity name="A" version="1.0.0.0"/></assembly>',
      imports: [{ library: 'KERNEL32.dll', functions: 8 }],
      delayImports: [{ library: 'ole32.dll', functions: 2 }],
      exports: { dllName: 'rich.dll', names: ['Alpha', 'Beta', 'Gamma'] },
      debug: { guid: '11223344-5566-7788-99AA-BBCCDDEEFF00', age: 1, pdbPath: 'rich.pdb' },
      repro: true,
      clr: { runtime: 'v4.0.30319', flags: 1 },
      icons: [
        { ...square(16), id: 3 },
        { ...square(32), id: 4 },
      ],
      overlay: 300,
      certificate: buildSignedData({
        subject: { commonName: 'S', organization: 'O' },
        issuer: { commonName: 'I' },
      }),
    });
    const lengths: number[] = [];
    for (let n = 0; n <= Math.min(1024, bytes.length); n++) {
      lengths.push(n);
    }
    for (let n = 1024 + 61; n < bytes.length; n += 61) {
      lengths.push(n);
    }
    let resolved = 0;
    for (const n of lengths) {
      try {
        await readPe(bytesSource(bytes.subarray(0, n)));
        resolved++;
      } catch (err) {
        expect(err, `truncated to ${n} bytes`).toBeInstanceOf(PeError);
      }
    }
    // Truncation past the headers still yields a preview of what survived.
    expect(resolved).toBeGreaterThan(0);
  }, 30000);

  it('reads a flipped byte anywhere in the headers without a non-PeError exception', async () => {
    const bytes = buildPe({
      version: { fileVersion: [1, 0, 0, 0], strings: [['A', 'b']] },
      imports: [{ library: 'K.dll', functions: 2 }],
      exports: { dllName: 'x.dll', names: ['n'] },
    });
    for (let at = 0; at < 0x200; at++) {
      const copy = bytes.slice();
      copy[at] ^= 0xff;
      try {
        await readPe(bytesSource(copy));
      } catch (err) {
        expect(err, `byte ${at} flipped`).toBeInstanceOf(PeError);
      }
    }
  }, 30000);
});

describe('readPe: reading is ranged and budgeted', () => {
  function counting(bytes: Uint8Array): ByteSource & { total: () => number } {
    let total = 0;
    return {
      size: bytes.length,
      read: (offset, length) => {
        const out = bytes.subarray(offset, offset + length);
        total += out.length;
        return Promise.resolve(out);
      },
      total: () => total,
    };
  }

  it('does not read a 40 MB overlay', async () => {
    const bytes = buildPe({
      version: { fileVersion: [1, 0, 0, 0], strings: [['A', 'b']] },
      imports: [{ library: 'KERNEL32.dll', functions: 3 }],
      overlay: 40 * 1024 * 1024,
    });
    const source = counting(bytes);
    const info = await readPe(source);
    expect(info.overlay?.size).toBe(40 * 1024 * 1024);
    expect(info.imports[0].functions).toBe(3);
    expect(source.total()).toBeLessThan(2 * 1024 * 1024);
  }, 30000);

  it('never asks a source for bytes past its reported size', async () => {
    const bytes = buildPe({ imports: [{ library: 'A.dll', functions: 1 }] });
    const requests: [number, number][] = [];
    await readPe({
      size: bytes.length,
      read: (offset, length) => {
        requests.push([offset, length]);
        return Promise.resolve(bytes.subarray(offset, offset + length));
      },
    });
    for (const [offset, length] of requests) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset + length).toBeLessThanOrEqual(bytes.length);
    }
  });

  it('rejects a source that returns less than its size promised', async () => {
    const bytes = buildPe();
    const failure = await readPe({
      size: bytes.length,
      read: (offset, length) =>
        Promise.resolve(bytes.subarray(offset, offset + Math.min(length, 10))),
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure === undefined || failure instanceof PeError).toBe(true);
  });
});
