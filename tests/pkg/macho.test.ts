import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import { PackageError, readPackage } from '../../src/pkg';
import { looksLikeMachO, readMachO } from '../../src/pkg/macho';
import { renderPackageHtml } from '../../src/pkg/render';
import type { InfoSection, PackageInfo } from '../../src/pkg/model';
import {
  buildClassFileLike,
  buildFat,
  buildMacho,
  buildVersion,
  CPU,
  dylib,
  dylinker,
  encryption,
  LC,
  linkedit,
  main,
  MH_ALLOW_STACK_EXECUTION,
  MH_NO_HEAP_EXECUTION,
  MH_PIE,
  rawCommand,
  rpath,
  segment,
  sourceVersion,
  uuid,
  ver,
  versionMin,
  type Cmd,
  type MachoSpec,
} from './machoFixture';

const toBytes = (input: MachoSpec | Uint8Array): Uint8Array =>
  // isView rather than instanceof: under jsdom a TextEncoder's bytes come from
  // Node's realm, whose Uint8Array is not the test file's own.
  ArrayBuffer.isView(input) ? input : buildMacho(input);
const reader = (input: MachoSpec | Uint8Array): RangeReader =>
  new RangeReader(bytesSource(toBytes(input)));
const read = (input: MachoSpec | Uint8Array = {}): Promise<PackageInfo> => readMachO(reader(input));
const RLO = String.fromCharCode(0x202e);
const BEL = String.fromCharCode(7);

const section = (info: PackageInfo, heading: string): InfoSection | undefined =>
  info.sections.find((s) => s.heading === heading);
const rowsOf = (info: PackageInfo, heading: string): Record<string, string> => {
  const s = section(info, heading);
  return s?.kind === 'properties' ? Object.fromEntries(s.rows) : {};
};
const tableOf = (info: PackageInfo, heading: string): string[][] => {
  const s = section(info, heading);
  return s?.kind === 'table' ? s.rows : [];
};
const noteOf = (info: PackageInfo, heading: string): string | undefined => {
  const s = section(info, heading);
  return s?.kind === 'table' || s?.kind === 'properties' ? s.note : undefined;
};

const UUID_BYTES = [
  0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10,
];
const UUID_TEXT = '01234567-89AB-CDEF-FEDC-BA9876543210';
const DAMAGED = 'The load commands stop at a damaged command; the ones before it are shown.';
const ENDS = 'The file ends inside the load commands; the ones before that are shown.';

const library: MachoSpec = {
  filetype: 6,
  cputype: CPU.ARM64,
  cpusubtype: 0,
  flags: 0,
  commands: [
    segment('__TEXT', { vmsize: 0x8000, filesize: 0x4000 }),
    segment('__DATA', { initprot: 3, maxprot: 3, nsects: 2 }),
    dylib(LC.ID_DYLIB, '@rpath/libdemo.dylib', ver(2, 3, 4), ver(1, 0, 0)),
    dylib(LC.LOAD_DYLIB, '/usr/lib/libSystem.B.dylib', ver(1319, 0, 0), ver(1, 0, 0)),
    dylib(LC.LOAD_WEAK_DYLIB, '/usr/lib/libweak.dylib'),
    dylib(LC.REEXPORT_DYLIB, '/usr/lib/libreexport.dylib'),
    dylib(LC.LAZY_LOAD_DYLIB, '/usr/lib/liblazy.dylib'),
    dylib(LC.LOAD_UPWARD_DYLIB, '/usr/lib/libupward.dylib'),
    rpath('@loader_path/../Frameworks'),
    uuid(UUID_BYTES),
    buildVersion(1, ver(11, 0, 0), ver(14, 2, 0), [
      [3, ver(1022, 1, 0)],
      [1, ver(1500, 0, 0)],
      [2, ver(5, 9, 2)],
    ]),
    sourceVersion(1, 2, 3, 4, 5),
    linkedit(LC.CODE_SIGNATURE, 0x8000, 4096),
  ],
};

describe('readMachO: identity', () => {
  it('reads a dynamic library, every field', async () => {
    const info = await read(library);
    expect(info.format).toBe('Mach-O dynamic library (arm64)');
    expect(info.title).toBe('@rpath/libdemo.dylib');
    expect(info.summary).toBe('Dynamic library for arm64');
    expect(info.warnings).toEqual([]);
    const binary = rowsOf(info, 'Binary');
    expect(binary['Type']).toBe('Dynamic library');
    expect(binary['Architecture']).toBe('arm64');
    expect(binary['Platform']).toBe('macOS');
    expect(binary['Minimum OS']).toBe('11.0.0');
    expect(binary['SDK']).toBe('14.2.0');
    expect(binary['Build tools']).toBe('ld 1022.1.0, clang 1500.0.0, swift 5.9.2');
    expect(binary['UUID']).toBe(UUID_TEXT);
    expect(binary['Source version']).toBe('1.2.3.4.5');
    expect(binary['Install name']).toBe('@rpath/libdemo.dylib');
    expect(binary['Current version']).toBe('2.3.4');
    expect(binary['Compatibility version']).toBe('1.0.0');
    expect(binary['Code signature']).toBe(
      'Present, not verified by MarkCopy (4.00 KB (4,096 bytes))',
    );
    expect(binary['Encrypted']).toBeUndefined();
    expect(binary['Entry point']).toBeUndefined();
  });

  it('reads every byte order and word size', async () => {
    for (const wide of [true, false]) {
      for (const big of [true, false]) {
        const info = await read({
          wide,
          big,
          cputype: wide ? CPU.X86_64 : CPU.X86,
          commands: [
            uuid(UUID_BYTES),
            dylib(LC.LOAD_DYLIB, '/usr/lib/libz.1.dylib', ver(1, 2, 11)),
            segment('__TEXT'),
          ],
        });
        const label = `${wide ? '64' : '32'}-bit ${big ? 'big' : 'little'}-endian`;
        expect(info.warnings, label).toEqual([]);
        expect(rowsOf(info, 'Binary')['Architecture'], label).toBe(wide ? 'x86_64' : 'x86');
        expect(rowsOf(info, 'Binary')['UUID'], label).toBe(UUID_TEXT);
        expect(tableOf(info, 'Dependencies'), label).toEqual([
          ['/usr/lib/libz.1.dylib', 'Required', '1.2.11 (compatible 1.0.0)'],
        ]);
        expect(tableOf(info, 'Segments')[0].slice(0, 1), label).toEqual(['__TEXT']);
      }
    }
  });

  it('names the file types', async () => {
    const names: Record<number, string> = {
      1: 'Object file',
      2: 'Executable',
      3: 'Fixed VM library',
      4: 'Core dump',
      5: 'Preloaded executable',
      6: 'Dynamic library',
      7: 'Dynamic linker',
      8: 'Bundle',
      9: 'Dynamic library stub',
      10: 'dSYM companion file',
      11: 'Kernel extension bundle',
      12: 'Fileset',
    };
    for (const [type, name] of Object.entries(names)) {
      expect(rowsOf(await read({ filetype: Number(type) }), 'Binary')['Type']).toBe(name);
    }
    expect(rowsOf(await read({ filetype: 99 }), 'Binary')['Type']).toBe('Unknown type (99)');
  });

  it('names the architectures, and shows an unknown one in hex', async () => {
    const cases: [number, number, string][] = [
      [CPU.X86, 3, 'x86'],
      [CPU.X86_64, 3, 'x86_64'],
      [CPU.X86_64, 8, 'x86_64h'],
      [CPU.ARM, 0, 'arm'],
      [CPU.ARM, 9, 'armv7'],
      [CPU.ARM, 11, 'armv7s'],
      [CPU.ARM, 12, 'armv7k'],
      [CPU.ARM64, 0, 'arm64'],
      [CPU.ARM64, 2, 'arm64e'],
      // The top byte of the subtype is capability bits.
      [CPU.ARM64, 0x80000002, 'arm64e'],
      [CPU.ARM64_32, 1, 'arm64_32'],
      [CPU.PPC, 0, 'ppc'],
      [CPU.PPC64, 0, 'ppc64'],
      [0x1234, 0, '0x1234'],
    ];
    for (const [cputype, cpusubtype, name] of cases) {
      const info = await read({ cputype, cpusubtype });
      expect(rowsOf(info, 'Binary')['Architecture']).toBe(name);
    }
  });
});

describe('readMachO: load commands', () => {
  it('reads LC_BUILD_VERSION platforms and caps the tool list at 8', async () => {
    const tools: [number, number][] = Array.from({ length: 12 }, (_, i) => [1, ver(i)]);
    const info = await read({ commands: [buildVersion(2, ver(15, 4), ver(17, 5, 1), tools)] });
    const binary = rowsOf(info, 'Binary');
    expect(binary['Platform']).toBe('iOS');
    expect(binary['Minimum OS']).toBe('15.4.0');
    expect(binary['SDK']).toBe('17.5.1');
    expect(binary['Build tools']?.split(', ')).toHaveLength(8);
    const unknown = await read({ commands: [buildVersion(77, ver(1), ver(1), [[9, ver(1)]])] });
    expect(rowsOf(unknown, 'Binary')['Platform']).toBe('Platform 77');
    expect(rowsOf(unknown, 'Binary')['Build tools']).toBe('tool 9 1.0.0');
  });

  it('reads the older minimum-version commands', async () => {
    const cases: [number, string][] = [
      [LC.VERSION_MIN_MACOSX, 'macOS'],
      [LC.VERSION_MIN_IPHONEOS, 'iOS'],
      [LC.VERSION_MIN_TVOS, 'tvOS'],
      [LC.VERSION_MIN_WATCHOS, 'watchOS'],
    ];
    for (const [kind, platform] of cases) {
      const info = await read({ commands: [versionMin(kind, ver(10, 13), ver(10, 15, 1))] });
      const binary = rowsOf(info, 'Binary');
      expect(binary['Platform']).toBe(platform);
      expect(binary['Minimum OS']).toBe('10.13.0');
      expect(binary['SDK']).toBe('10.15.1');
    }
    // An unknown SDK is stored as zero and not shown.
    const none = await read({ commands: [versionMin(LC.VERSION_MIN_MACOSX, ver(10, 9), 0)] });
    expect(rowsOf(none, 'Binary')['SDK']).toBeUndefined();
    // LC_BUILD_VERSION wins over a minimum-version command.
    const both = await read({
      commands: [
        versionMin(LC.VERSION_MIN_MACOSX, ver(10, 9), 0),
        buildVersion(1, ver(12), ver(13)),
      ],
    });
    expect(rowsOf(both, 'Binary')['Minimum OS']).toBe('10.9.0');
  });

  it('reads the dynamic linker, entry point and encryption', async () => {
    const info = await read({
      commands: [dylinker(), main(0x4a20), encryption(LC.ENCRYPTION_INFO_64, 1)],
    });
    const binary = rowsOf(info, 'Binary');
    expect(binary['Dynamic linker']).toBe('/usr/lib/dyld');
    expect(binary['Entry point']).toBe('__TEXT + 0x4a20');
    expect(binary['Encrypted']).toBe('Yes');
    const plain = await read({ wide: false, commands: [encryption(LC.ENCRYPTION_INFO, 0)] });
    expect(rowsOf(plain, 'Binary')['Encrypted']).toBe('No');
    expect(rowsOf(await read({}), 'Binary')['Code signature']).toBe('None');
  });

  it('lists dependencies with their kind and versions', async () => {
    const info = await read(library);
    expect(tableOf(info, 'Dependencies')).toEqual([
      ['/usr/lib/libSystem.B.dylib', 'Required', '1319.0.0 (compatible 1.0.0)'],
      ['/usr/lib/libweak.dylib', 'Weak', '1.0.0'],
      ['/usr/lib/libreexport.dylib', 'Re-exported', '1.0.0'],
      ['/usr/lib/liblazy.dylib', 'Lazy', '1.0.0'],
      ['/usr/lib/libupward.dylib', 'Upward', '1.0.0'],
    ]);
    expect(tableOf(info, 'Run paths')).toEqual([['@loader_path/../Frameworks']]);
  });

  it('lists segments with sizes, protections and section counts', async () => {
    const info = await read(library);
    expect(tableOf(info, 'Segments')).toEqual([
      ['__TEXT', '16.0 KB (16,384 bytes)', '32.0 KB (32,768 bytes)', 'r-x', '0'],
      ['__DATA', '16.0 KB (16,384 bytes)', '16.0 KB (16,384 bytes)', 'rw-', '2'],
    ]);
    const mixed = await read({
      commands: [segment('__X', { initprot: 1, maxprot: 7 })],
    });
    expect(tableOf(mixed, 'Segments')[0][3]).toBe('r-- (max rwx)');
  });

  it('shows protections for an executable only', async () => {
    const hardened = await read({
      flags: MH_PIE | MH_NO_HEAP_EXECUTION,
      commands: [segment('__TEXT'), linkedit(LC.CODE_SIGNATURE, 0x8000, 100)],
    });
    expect(rowsOf(hardened, 'Protections')).toEqual({
      'Position-independent (PIE)': 'Yes',
      'Executable stack allowed': 'No',
      'No heap execution': 'Yes',
      '__RESTRICT segment': 'No',
      'Code signature': 'Present',
    });
    const loose = await read({
      flags: MH_ALLOW_STACK_EXECUTION,
      commands: [segment('__RESTRICT')],
    });
    const p = rowsOf(loose, 'Protections');
    expect(p['Position-independent (PIE)']).toBe('No (fixed load address)');
    expect(p['Executable stack allowed']).toBe('Yes (MH_ALLOW_STACK_EXECUTION)');
    expect(p['No heap execution']).toBe('No');
    expect(p['__RESTRICT segment']).toMatch(/^Present/);
    expect(p['Code signature']).toBe('None');
    // A library has no PIE or stack flags to show, but is still signed or not.
    expect(rowsOf(await read({ filetype: 6, flags: MH_PIE }), 'Protections')).toEqual({
      'Code signature': 'None',
    });
    // An object file has none of these.
    expect(section(await read({ filetype: 1 }), 'Protections')).toBeUndefined();
  });

  it('skips a command smaller than its type needs, with a warning', async () => {
    const info = await read({
      commands: [rawCommand(LC.UUID, 8), rawCommand(LC.LOAD_DYLIB, 8), dylinker()],
    });
    expect(info.warnings).toEqual([
      'A load command is smaller than its type needs and was skipped.',
    ]);
    expect(rowsOf(info, 'Binary')['Dynamic linker']).toBe('/usr/lib/dyld');
    expect(section(info, 'Dependencies')).toBeUndefined();
  });

  it('ignores unknown commands', async () => {
    const info = await read({
      commands: [rawCommand(0x7777, 16, new Array(8).fill(0)), uuid(UUID_BYTES)],
    });
    expect(info.warnings).toEqual([]);
    expect(rowsOf(info, 'Binary')['UUID']).toBe(UUID_TEXT);
  });
});

describe('readMachO: universal binaries', () => {
  const arm = buildMacho({
    cputype: CPU.ARM64,
    cpusubtype: 0,
    filetype: 6,
    commands: [
      uuid(UUID_BYTES),
      buildVersion(1, ver(11), ver(14)),
      dylib(LC.ID_DYLIB, '@rpath/libfat.dylib'),
      dylib(LC.LOAD_DYLIB, '/usr/lib/libSystem.B.dylib'),
      segment('__TEXT'),
    ],
  });
  const intel = buildMacho({
    cputype: CPU.X86_64,
    filetype: 6,
    commands: [uuid(UUID_BYTES.map((b) => b ^ 0xff)), buildVersion(1, ver(10, 13), ver(14))],
  });
  const fat = (wide = false): Uint8Array =>
    buildFat(
      [
        { bytes: arm, cputype: CPU.ARM64 },
        { bytes: intel, cputype: CPU.X86_64, cpusubtype: 3 },
      ],
      { wide },
    );

  it('reads two slices, and describes the first in full', async () => {
    for (const wide of [false, true]) {
      const bytes = fat(wide);
      expect(await looksLikeMachO(reader(bytes))).toBe(true);
      const info = await read(bytes);
      expect(info.format).toBe('Universal binary (arm64, x86_64)');
      expect(info.summary).toBe('Universal binary with 2 architectures');
      expect(info.warnings).toEqual([]);
      const table = tableOf(info, 'Architectures');
      expect(table).toEqual([
        ['arm64', 'Dynamic library', 'macOS 11.0.0', UUID_TEXT, '0x4000', `${arm.length} bytes`],
        [
          'x86_64',
          'Dynamic library',
          'macOS 10.13.0',
          UUID_TEXT.replace(/[0-9A-F]/g, (c) => (parseInt(c, 16) ^ 0xf).toString(16).toUpperCase()),
          '0x8000',
          `${intel.length} bytes`,
        ],
      ]);
      expect(rowsOf(info, 'Binary')['Install name']).toBe('@rpath/libfat.dylib');
      expect(noteOf(info, 'Binary')).toBe('Describes the first slice (arm64).');
      expect(tableOf(info, 'Dependencies')).toHaveLength(1);
      expect(info.title).toBe('@rpath/libfat.dylib');
    }
  });

  it('is found by readPackage whatever the file is called', async () => {
    const info = await readPackage(bytesSource(fat()), 'tool');
    expect(info.format).toBe('Universal binary (arm64, x86_64)');
  });

  it('shows 16 slices and says how many more there are', async () => {
    const many = buildFat(
      Array.from({ length: 20 }, () => ({ bytes: intel, cputype: CPU.X86_64 })),
      { align: 0x1000 },
    );
    const info = await read(many);
    expect(tableOf(info, 'Architectures')).toHaveLength(16);
    expect(noteOf(info, 'Architectures')).toBe('Showing the first 16 of 20 architectures.');
  });

  it('warns about a slice that is not a Mach-O file and still reads the others', async () => {
    const info = await read(
      buildFat([
        { bytes: arm, cputype: CPU.ARM64 },
        { bytes: new Uint8Array(100).fill(0x41), cputype: CPU.X86_64 },
      ]),
    );
    expect(info.warnings).toEqual(['The x86_64 slice could not be read.']);
    expect(tableOf(info, 'Architectures')[1].slice(0, 2)).toEqual(['x86_64', '']);
    expect(rowsOf(info, 'Binary')['Install name']).toBe('@rpath/libfat.dylib');
  });

  it('attributes a damaged load command in a later slice to that slice', async () => {
    const bad = buildMacho({
      cputype: CPU.X86_64,
      commands: [uuid(UUID_BYTES), rawCommand(LC.RPATH, 6)],
    });
    const info = await read(
      buildFat([
        { bytes: arm, cputype: CPU.ARM64 },
        { bytes: bad, cputype: CPU.X86_64 },
      ]),
    );
    expect(info.warnings).toEqual([`The x86_64 slice: ${DAMAGED}`]);
  });

  it('does not let a slice read past its own end', async () => {
    // The slice is cut to its header; its load commands lie in the next slice.
    const claims = buildMacho({
      cputype: CPU.X86_64,
      commands: [uuid(UUID_BYTES)],
      sizeofcmds: 24,
      ncmds: 1,
    });
    const info = await read(
      buildFat([
        { bytes: claims.subarray(0, 32), cputype: CPU.X86_64 },
        { bytes: arm, cputype: CPU.ARM64 },
      ]),
    );
    expect(rowsOf(info, 'Binary')['UUID']).toBeUndefined();
    expect(info.warnings).toEqual([ENDS]);
  });
});

describe('readMachO: files that are not Mach-O', () => {
  it('does not claim a Java class file', async () => {
    const klass = buildClassFileLike(52, 0);
    expect(await looksLikeMachO(reader(klass))).toBe(false);
    await expect(read(klass)).rejects.toThrow(PackageError);
    await expect(readPackage(bytesSource(klass), 'A.class')).rejects.toThrow(PackageError);
    // Even a class file whose table happens to fit and stay in the file.
    const small = buildClassFileLike(2, 0, 4096);
    expect(await looksLikeMachO(reader(small))).toBe(false);
  });

  it('does not claim a fat-looking file whose table points outside the file', async () => {
    const good = buildFat([{ bytes: buildMacho(), cputype: CPU.X86_64 }]);
    expect(await looksLikeMachO(reader(good))).toBe(true);
    const v = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);
    const past = good.slice();
    v(past).setUint32(8 + 8, past.length + 1, false); // offset
    expect(await looksLikeMachO(reader(past))).toBe(false);
    const longer = good.slice();
    v(longer).setUint32(8 + 12, longer.length, false); // size
    expect(await looksLikeMachO(reader(longer))).toBe(false);
    const inside = good.slice();
    v(inside).setUint32(8 + 8, 4, false); // offset inside the table
    expect(await looksLikeMachO(reader(inside))).toBe(false);
    const zero = good.slice();
    v(zero).setUint32(4, 0, false);
    expect(await looksLikeMachO(reader(zero))).toBe(false);
    const huge = good.slice();
    v(huge).setUint32(4, 0x1001, false);
    expect(await looksLikeMachO(reader(huge))).toBe(false);
    const noMagic = good.slice();
    noMagic.fill(0x41, 0x4000, 0x4004);
    expect(await looksLikeMachO(reader(noMagic))).toBe(false);
    for (const bytes of [past, longer, inside, zero, huge, noMagic]) {
      await expect(read(bytes)).rejects.toThrow(PackageError);
    }
  });

  it('rejects empty, short and unrelated files with a PackageError', async () => {
    await expect(read(new Uint8Array(0))).rejects.toThrow(PackageError);
    await expect(read(new Uint8Array(10))).rejects.toThrow(PackageError);
    await expect(read(new Uint8Array(100).fill(0x41))).rejects.toThrow(PackageError);
    expect(await looksLikeMachO(reader(new Uint8Array(3)))).toBe(false);
    expect(await looksLikeMachO(reader(new Uint8Array(100).fill(0x41)))).toBe(false);
    await expect(read(buildMacho().subarray(0, 32))).resolves.toBeDefined();
    await expect(read(buildMacho().subarray(0, 31))).rejects.toThrow(PackageError);
  });
});

describe('readMachO: caps and damaged commands', () => {
  const ok = uuid(UUID_BYTES);
  const withBad = (bad: Cmd, extra: Partial<MachoSpec> = {}): MachoSpec => ({
    commands: [ok, bad, dylinker()],
    ...extra,
  });

  it('stops at a cmdsize of 0, 4, a non-multiple of 4 and past the end', async () => {
    for (const cmdsize of [0, 4, 6, 10, 0x7ffffffc, 0xfffffffc]) {
      const info = await read(withBad(rawCommand(LC.RPATH, cmdsize, new Array(16).fill(0))));
      expect(info.warnings, String(cmdsize)).toEqual([DAMAGED]);
      expect(rowsOf(info, 'Binary')['UUID'], String(cmdsize)).toBe(UUID_TEXT);
      expect(rowsOf(info, 'Binary')['Dynamic linker'], String(cmdsize)).toBeUndefined();
    }
  });

  it('stops at a cmdsize past sizeofcmds even when the file holds the bytes', async () => {
    const info = await read(
      withBad(rawCommand(LC.RPATH, 64, new Array(56).fill(0)), {
        // Only the first two commands are counted in sizeofcmds.
        sizeofcmds: 24 + 64,
        tail: new Array(200).fill(0),
      }),
    );
    expect(info.warnings).toEqual([DAMAGED]);
    expect(rowsOf(info, 'Binary')['UUID']).toBe(UUID_TEXT);
  });

  it('stops when sizeofcmds runs past the end of the file', async () => {
    const info = await read({ commands: [ok], sizeofcmds: 0x10000, ncmds: 3 });
    expect(info.warnings).toEqual([ENDS]);
    expect(rowsOf(info, 'Binary')['UUID']).toBe(UUID_TEXT);
  });

  it('stops when ncmds is more than the commands that exist', async () => {
    const info = await read({ commands: [ok], ncmds: 5 });
    expect(info.warnings).toEqual([DAMAGED]);
  });

  it('reads at most 32,768 commands', async () => {
    const filler = rawCommand(0x7777, 8);
    const info = await read({
      commands: [ok, ...Array.from({ length: 40000 }, () => filler)],
      ncmds: 40001,
    });
    expect(info.warnings).toEqual(['Only the first 32,768 of 40,001 load commands were read.']);
    expect(rowsOf(info, 'Binary')['UUID']).toBe(UUID_TEXT);
  });

  it('reads at most 1 MiB of load commands', async () => {
    const info = await read({
      commands: [ok],
      ncmds: 3,
      sizeofcmds: 2 * 1024 * 1024,
      tail: new Array(2 * 1024 * 1024).fill(0),
    });
    expect(info.warnings).toEqual([
      'The load commands are larger than MarkCopy reads (1 MiB); the ones before that are shown.',
    ]);
    expect(rowsOf(info, 'Binary')['UUID']).toBe(UUID_TEXT);
  });

  it('shows 200 dependencies, counts all of them, and says so', async () => {
    const info = await read({
      commands: Array.from({ length: 250 }, (_, i) =>
        dylib(LC.LOAD_DYLIB, `/usr/lib/lib${i}.dylib`),
      ),
    });
    expect(tableOf(info, 'Dependencies')).toHaveLength(200);
    expect(noteOf(info, 'Dependencies')).toBe('Showing the first 200 of 250 libraries.');
  });

  it('shows 64 segments and 64 run paths, and says how many there are', async () => {
    const info = await read({
      commands: [
        ...Array.from({ length: 70 }, (_, i) => segment(`__S${i}`)),
        ...Array.from({ length: 80 }, (_, i) => rpath(`@rpath/${i}`)),
      ],
    });
    expect(tableOf(info, 'Segments')).toHaveLength(64);
    expect(noteOf(info, 'Segments')).toBe('Showing the first 64 of 70 segments.');
    expect(tableOf(info, 'Run paths')).toHaveLength(64);
    expect(noteOf(info, 'Run paths')).toBe('Showing the first 64 of 80 run paths.');
  });

  it('ignores an lc_str offset outside the command', async () => {
    for (const nameOffset of [0, 4, 7, 0x10000, 0xffffffff]) {
      const info = await read({
        commands: [
          dylib(LC.LOAD_DYLIB, '/usr/lib/libz.dylib', ver(1), ver(1), nameOffset),
          dylib(LC.ID_DYLIB, 'name', ver(1), ver(1), nameOffset),
          rpath('abc', nameOffset),
          dylinker('/usr/lib/dyld', nameOffset),
        ],
      });
      expect(info.warnings, String(nameOffset)).toEqual([]);
      expect(tableOf(info, 'Dependencies')[0][0]).toBe('(name outside the command)');
      expect(rowsOf(info, 'Binary')['Install name']).toBeUndefined();
      expect(rowsOf(info, 'Binary')['Dynamic linker']).toBeUndefined();
    }
  });

  it('reads at most 1,024 bytes of a name', async () => {
    const info = await read({ commands: [rpath('a'.repeat(3000))] });
    expect(tableOf(info, 'Run paths')[0][0]).toHaveLength(1024);
  });

  it('stops a name at the end of its command when it has no terminator', async () => {
    const info = await read({
      commands: [rawCommand(LC.RPATH, 16, [12, 0, 0, 0, 0x61, 0x62, 0x63, 0x64])],
    });
    expect(tableOf(info, 'Run paths')[0][0]).toBe('abcd');
  });
});

describe('readMachO: hostile input', () => {
  const variants = (): Uint8Array[] => [
    buildMacho({ ...library }),
    buildMacho({ ...library, wide: false, big: true, cputype: CPU.PPC }),
    buildMacho({ commands: [uuid(UUID_BYTES), dylinker(), main(1)], filetype: 2 }),
    buildFat([
      { bytes: buildMacho({ ...library }), cputype: CPU.ARM64 },
      { bytes: buildMacho({ commands: [uuid(UUID_BYTES)] }), cputype: CPU.X86_64 },
    ]),
    buildFat([{ bytes: buildMacho(), cputype: CPU.X86_64 }], { wide: true, align: 0x1000 }),
  ];

  it('never throws anything but PackageError when truncated at every byte', async () => {
    for (const bytes of variants()) {
      const cuts: number[] = [];
      for (let n = 0; n < Math.min(1200, bytes.length); n++) {
        cuts.push(n);
      }
      for (let n = 1200; n < bytes.length; n += 37) {
        cuts.push(n);
      }
      for (const n of cuts) {
        try {
          await read(bytes.subarray(0, n));
        } catch (e) {
          expect(e).toBeInstanceOf(PackageError);
        }
      }
    }
  });

  it('never throws anything but PackageError when header bytes are scrambled', async () => {
    const good = buildMacho({ ...library });
    for (let at = 0; at < 64; at++) {
      for (const fill of [0x00, 0xff, 0x7f, 0x80]) {
        const bytes = good.slice();
        bytes[at] = fill;
        try {
          await read(bytes);
        } catch (e) {
          expect(e).toBeInstanceOf(PackageError);
        }
      }
    }
  });
});

describe('readMachO: rendering', () => {
  it('escapes strings from the file and strips control and direction characters', async () => {
    const info = await read({
      commands: [
        dylib(LC.LOAD_DYLIB, `a${RLO}b${BEL}.dylib`),
        dylib(LC.ID_DYLIB, '<img src=x onerror=1>'),
        rpath('<script>alert(1)</script>'),
        dylinker(`/usr/lib/${RLO}dyld`),
        segment(`__T${RLO}${BEL}`),
      ],
    });
    expect(tableOf(info, 'Dependencies')[0][0]).toBe('ab.dylib');
    expect(tableOf(info, 'Segments')[0][0]).toBe('__T');
    expect(rowsOf(info, 'Binary')['Dynamic linker']).toBe('/usr/lib/dyld');
    const html = renderPackageHtml(info, { fileName: 'a.dylib', fileSize: 10 });
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(RLO);
    expect(html).toContain('ab.dylib');
  });

  it('renders a universal binary', async () => {
    const info = await read(
      buildFat([
        {
          bytes: buildMacho({ cputype: CPU.ARM64, commands: [uuid(UUID_BYTES)] }),
          cputype: CPU.ARM64,
        },
      ]),
    );
    const html = renderPackageHtml(info, { fileName: 'tool', fileSize: 20000 });
    expect(html).toContain('Architectures');
    expect(html).toContain(UUID_TEXT);
    expect(html).toContain('Describes the first slice (arm64).');
  });
});
