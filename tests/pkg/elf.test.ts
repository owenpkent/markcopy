import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import { readElf } from '../../src/pkg/elf';
import { PackageError } from '../../src/pkg/model';
import { renderPackageHtml } from '../../src/pkg/render';
import type { InfoSection, PackageInfo } from '../../src/pkg/model';
import { buildElf, FIELDS, type ElfSpec } from './elfFixture';

const read = (input: ElfSpec | Uint8Array = {}): Promise<PackageInfo> =>
  // isView rather than instanceof: under jsdom a TextEncoder's bytes come from
  // Node's realm, whose Uint8Array is not the test file's own.
  readElf(new RangeReader(bytesSource(ArrayBuffer.isView(input) ? input : buildElf(input))));
const RLO = String.fromCharCode(0x202e);

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

const COMMENT = 'GCC: (Debian 12.2.0) 12.2.0\0GCC: (Debian 12.2.0) 12.2.0\0clang version 15.0.0\0';
const LD = '/lib64/ld-linux-x86-64.so.2';

const library: ElfSpec = {
  soname: 'libdemo.so.1',
  needed: ['libc.so.6', 'libm.so.6'],
  runpath: '$ORIGIN/lib',
  buildId: [0xde, 0xad, 0xbe, 0xef],
  abiTag: [0, 3, 2, 0],
  relro: true,
  flags: 0x8,
  sections: [
    { name: '.symtab', type: 2, data: 'abcd' },
    { name: '.debug_info', data: 'xyz' },
    { name: '.comment', data: COMMENT },
    { name: '.gnu_debuglink', data: 'libdemo.debug\0\0\0\0\u0001\u0002\u0003\u0004' },
  ],
};

describe('readElf: identity', () => {
  it('reads a shared library, every field', async () => {
    const info = await read(library);
    expect(info.format).toBe('ELF shared library');
    expect(info.title).toBe('libdemo.so.1');
    expect(info.summary).toBe('Shared library for x86-64');
    expect(info.warnings).toEqual([]);
    const binary = rowsOf(info, 'Binary');
    expect(binary['Type']).toBe('Shared library');
    expect(binary['Architecture']).toBe('x86-64, 64-bit, little-endian');
    expect(binary['OS ABI']).toBe('UNIX System V');
    expect(binary['SONAME']).toBe('libdemo.so.1');
    expect(binary['Interpreter']).toBeUndefined();
    expect(binary['Entry point']).toBe('0x1040');
    expect(binary['Build ID']).toBe('deadbeef');
    expect(binary['Minimum kernel']).toBe('Linux 3.2.0');
    expect(binary['Stripped']).toBe('No');
    expect(binary['Debug information']).toBe('Yes');
    expect(binary['Separate debug file']).toBe('libdemo.debug');
    expect(binary['Compiler']).toBe('GCC: (Debian 12.2.0) 12.2.0; clang version 15.0.0');
    expect(tableOf(info, 'Dependencies')).toEqual([['libc.so.6'], ['libm.so.6']]);
    const sections = tableOf(info, 'Sections');
    expect(sections.map((r) => r[0])).toEqual([
      '.dynstr',
      '.note.gnu.build-id',
      '.symtab',
      '.debug_info',
      '.comment',
      '.gnu_debuglink',
      '.shstrtab',
    ]);
    expect(sections[2]).toEqual(['.symtab', '4 bytes', 'Symbol table']);
  });

  it('shows the order Binary, Protections, Dependencies, Sections', async () => {
    const info = await read(library);
    expect(info.sections.map((s) => s.heading)).toEqual([
      'Binary',
      'Protections',
      'Dependencies',
      'Sections',
    ]);
  });

  it('tells a position-independent executable from a library', async () => {
    const pie = await read({ interp: LD, needed: ['libc.so.6'], flags1: 0x08000001 });
    expect(rowsOf(pie, 'Binary')['Type']).toBe('Executable (position-independent)');
    expect(rowsOf(pie, 'Binary')['Interpreter']).toBe(LD);
    expect(rowsOf(pie, 'Protections')['Position-independent (PIE)']).toBe('Yes');
    expect(pie.format).toBe('ELF executable');
    expect(pie.title).toBeUndefined();

    // An older linker leaves no PIE flag: an interpreter and no SONAME still says executable.
    const old = await read({ interp: LD, needed: ['libc.so.6'] });
    expect(rowsOf(old, 'Binary')['Type']).toBe('Executable (position-independent)');

    // libc.so.6 is a library that carries an interpreter too.
    const libc = await read({ interp: LD, soname: 'libc.so.6', needed: ['ld-linux.so.2'] });
    expect(rowsOf(libc, 'Binary')['Type']).toBe('Shared library');
  });

  it('reads a fixed-address executable, a core dump and an object file', async () => {
    const exec = await read({ type: 2, interp: LD, needed: ['libc.so.6'] });
    expect(rowsOf(exec, 'Binary')['Type']).toBe('Executable');
    expect(rowsOf(exec, 'Protections')['Position-independent (PIE)']).toBe(
      'No (fixed load address)',
    );
    expect((await read({ type: 4 })).format).toBe('ELF core dump');
    const object = await read({ type: 1, noProgramHeaders: true, sections: [{ name: '.text' }] });
    expect(object.format).toBe('ELF relocatable object');
    expect(rowsOf(object, 'Binary')['Type']).toBe('Relocatable object');
    expect(rowsOf(object, 'Binary')['Entry point']).toBeUndefined();
    expect(section(object, 'Protections')).toBeUndefined();
  });

  it('honours byte order and word size, and names the architecture', async () => {
    const mips = await read({
      wide: false,
      big: true,
      machine: 8,
      soname: 'libbig.so',
      needed: ['libc.so.0'],
      buildId: [1, 2, 3, 4],
      abiTag: [0, 2, 6, 32],
      entry: 0x10a0,
      osAbi: 3,
      sections: [{ name: '.comment', data: 'GCC 4.9\0' }],
    });
    const binary = rowsOf(mips, 'Binary');
    expect(binary['Architecture']).toBe('MIPS, 32-bit, big-endian');
    expect(binary['OS ABI']).toBe('Linux (GNU)');
    expect(binary['SONAME']).toBe('libbig.so');
    expect(binary['Entry point']).toBe('0x10a0');
    expect(binary['Build ID']).toBe('01020304');
    expect(binary['Minimum kernel']).toBe('Linux 2.6.32');
    expect(binary['Compiler']).toBe('GCC 4.9');
    expect(tableOf(mips, 'Dependencies')).toEqual([['libc.so.0']]);

    const names: [number, boolean, string][] = [
      [3, false, 'x86, 32-bit'],
      [40, false, 'ARM, 32-bit'],
      [183, true, 'AArch64, 64-bit'],
      [243, true, 'RISC-V, 64-bit'],
      [21, true, 'PowerPC64, 64-bit'],
      [22, true, 'S390, 64-bit'],
      [258, true, 'LoongArch, 64-bit'],
      [247, true, 'BPF, 64-bit'],
      [2, false, 'SPARC, 32-bit'],
      [43, true, 'SPARC v9, 64-bit'],
      [20, false, 'PowerPC, 32-bit'],
      [0x1234, true, 'Machine 0x1234, 64-bit'],
    ];
    for (const [machine, wide, expected] of names) {
      const info = await read({ machine, wide });
      expect(rowsOf(info, 'Binary')['Architecture']).toContain(expected);
    }
  });

  it('reads a Go build ID note', async () => {
    const info = await read({ type: 2, goBuildId: 'abc/def_ghi' });
    expect(rowsOf(info, 'Binary')['Go build ID']).toBe('abc/def_ghi');
  });

  it('says whether the file is stripped', async () => {
    const stripped = await read({ sections: [{ name: '.text' }] });
    expect(rowsOf(stripped, 'Binary')['Stripped']).toBe('Yes');
    expect(rowsOf(stripped, 'Binary')['Debug information']).toBe('No');
    const noSections = await read({ noSections: true, soname: 'libx.so' });
    expect(rowsOf(noSections, 'Binary')['Stripped']).toContain('Unknown');
    expect(rowsOf(noSections, 'Binary')['Debug information']).toBeUndefined();
    expect(section(noSections, 'Sections')).toBeUndefined();
    expect(tableOf(noSections, 'Dependencies')).toEqual([]);
  });
});

describe('readElf: protections', () => {
  const prot = async (spec: ElfSpec) =>
    rowsOf(await read({ needed: ['libc.so.6'], ...spec }), 'Protections');

  it('reports RELRO as none, partial or full', async () => {
    expect((await prot({})).RELRO).toBe('None');
    expect((await prot({ relro: true })).RELRO).toBe('Partial');
    expect((await prot({ relro: true, flags: 0x8 })).RELRO).toBe('Full');
    expect((await prot({ relro: true, flags1: 0x1 })).RELRO).toBe('Full');
    expect((await prot({ relro: true, bindNow: true })).RELRO).toBe('Full');
    expect((await prot({ flags: 0x8 })).RELRO).toBe('None');
  });

  it('reports the stack', async () => {
    expect((await prot({ stack: 'nx' }))['Non-executable stack']).toBe('Yes');
    expect((await prot({ stack: 'exec' }))['Non-executable stack']).toBe(
      'No (stack is executable)',
    );
    expect((await prot({ stack: 'none' }))['Non-executable stack']).toContain('Unknown');
  });

  it('shows RPATH and RUNPATH, which are a hijack risk', async () => {
    const p = await prot({ rpath: '/opt/app/lib', runpath: '$ORIGIN' });
    expect(p['RPATH']).toBe('/opt/app/lib');
    expect(p['RUNPATH']).toBe('$ORIGIN');
  });
});

describe('readElf: kernel modules', () => {
  it('reads modinfo, grouping repeated keys', async () => {
    const info = await read({
      type: 1,
      noProgramHeaders: true,
      buildId: [0xaa, 0xbb],
      sections: [
        {
          name: '.modinfo',
          data:
            'license=GPL\0description=A demo\0author=A One\0author=B Two\0' +
            'alias=a1\0alias=a2\0alias=a3\0alias=a4\0depends=\0vermagic=6.1.0 SMP mod_unload\0',
        },
        { name: '.gnu.linkonce.this_module', data: 'x' },
        { name: '.symtab', type: 2 },
      ],
    });
    expect(info.format).toBe('Linux kernel module');
    expect(rowsOf(info, 'Binary')['Type']).toBe('Kernel module');
    expect(rowsOf(info, 'Binary')['Build ID']).toBe('aabb');
    const mod = rowsOf(info, 'Kernel module');
    expect(mod['license']).toBe('GPL');
    expect(mod['description']).toBe('A demo');
    expect(mod['author']).toBe('A One; B Two');
    expect(mod['alias']).toBe('a1; a2; a3 (and 1 more)');
    expect(mod['vermagic']).toBe('6.1.0 SMP mod_unload');
    expect(mod['depends']).toBeUndefined();
  });

  it('caps the number of module keys', async () => {
    const data = Array.from({ length: 80 }, (_, i) => `key${i}=v`).join('\0');
    const info = await read({
      type: 1,
      noProgramHeaders: true,
      sections: [{ name: '.modinfo', data }],
    });
    expect(Object.keys(rowsOf(info, 'Kernel module'))).toHaveLength(40);
  });
});

describe('readElf: AppImage', () => {
  it('finds a squashfs payload after the ELF runtime', async () => {
    const payload = new Uint8Array(1000);
    payload.set(new TextEncoder().encode('hsqs'), 0);
    const bytes = buildElf({ appImage: 2, interp: LD, needed: ['libc.so.6'], payload });
    const info = await read(bytes);
    expect(info.format).toBe('AppImage (type 2)');
    const app = rowsOf(info, 'AppImage');
    expect(app['Payload size']).toBe('1,000 bytes');
    expect(app['Payload format']).toBe('SquashFS');
    expect(app['Payload offset']).toBe((bytes.length - 1000).toLocaleString('en-US'));
    expect(rowsOf(info, 'Binary')['Type']).toBe('Executable (position-independent)');
  });

  it('reports a type 1 image and a payload that is not squashfs', async () => {
    const info = await read({ appImage: 1, payload: 'ISO9660 data here' });
    expect(info.format).toBe('AppImage (type 1)');
    expect(rowsOf(info, 'AppImage')['Payload format']).toBe('Not recognised');
  });

  it('does not take an unknown type byte for an AppImage', async () => {
    const info = await read({ appImage: 3 });
    expect(info.format).not.toContain('AppImage');
    expect(section(info, 'AppImage')).toBeUndefined();
  });
});

describe('readElf: caps', () => {
  it('shows 200 dependencies and says how many were left out', async () => {
    const needed = Array.from({ length: 600 }, (_, i) => `lib${i}.so`);
    const info = await read({ needed });
    expect(tableOf(info, 'Dependencies')).toHaveLength(200);
    expect(noteOf(info, 'Dependencies')).toBe('Showing the first 200 of 600 libraries.');
  });

  it('shows 200 sections and says how many were left out', async () => {
    const sections = Array.from({ length: 250 }, (_, i) => ({ name: `.s${i}`, data: 'x' }));
    const info = await read({ type: 1, noProgramHeaders: true, sections });
    expect(tableOf(info, 'Sections')).toHaveLength(200);
    expect(noteOf(info, 'Sections')).toMatch(/^Showing the first 200 of 251 sections\.$/);
  });

  it('keeps at most 8 distinct compiler strings', async () => {
    const data = Array.from({ length: 20 }, (_, i) => `cc ${i}`).join('\0');
    const info = await read({ sections: [{ name: '.comment', data }] });
    expect(rowsOf(info, 'Binary')['Compiler'].split('; ')).toHaveLength(8);
  });
});

describe('readElf: rejection and damage', () => {
  it('rejects files that are not ELF', async () => {
    await expect(read(new Uint8Array(0))).rejects.toThrow(PackageError);
    await expect(read(new Uint8Array(30))).rejects.toThrow(PackageError);
    await expect(read(new TextEncoder().encode('MZ'.padEnd(200, 'x')))).rejects.toThrow(
      /not an ELF file/,
    );
  });

  it('rejects an unknown word size or byte order', async () => {
    const a = buildElf();
    a[4] = 3;
    await expect(read(a)).rejects.toThrow(PackageError);
    const b = buildElf();
    b[5] = 0;
    await expect(read(b)).rejects.toThrow(PackageError);
  });

  it('rejects a 64-bit header cut short', async () => {
    await expect(read(buildElf().subarray(0, 60))).rejects.toThrow(PackageError);
  });

  const poke = (bytes: Uint8Array, at: number, size: 2 | 4 | 8, value: bigint | number): void => {
    const v = new DataView(bytes.buffer);
    if (size === 2) {
      v.setUint16(at, Number(value), true);
    } else if (size === 4) {
      v.setUint32(at, Number(value), true);
    } else {
      v.setBigUint64(at, BigInt(value), true);
    }
  };
  /** Offset of the program header with this p_type in a 64-bit little-endian file. */
  const segmentAt = (bytes: Uint8Array, kind: number): number => {
    const v = new DataView(bytes.buffer);
    const count = v.getUint16(56, true);
    for (let i = 0; i < count; i++) {
      if (v.getUint32(64 + i * 56, true) === kind) {
        return 64 + i * 56;
      }
    }
    throw new Error('segment missing from fixture');
  };
  const rich = (): Uint8Array => buildElf({ ...library, interp: LD, soname: 'libdemo.so.1' });

  it('turns offsets and counts pointing outside the file into warnings', async () => {
    const f = FIELDS.wide;
    const cases: [number, 2 | 4 | 8, bigint | number][] = [
      [f.phoff, 8, 2n ** 40n],
      [f.phoff, 8, 2n ** 63n],
      [f.shoff, 8, 2n ** 40n],
      [f.shoff, 8, 0xffffffffffffffffn],
      [f.phnum, 2, 1000],
      [f.shnum, 2, 65535],
      [f.shstrndx, 2, 9999],
      [f.shstrndx, 2, 0xffff],
      [f.phentsize, 2, 1],
      [f.phentsize, 2, 0xffff],
      [f.shentsize, 2, 1],
      [f.shentsize, 2, 0xffff],
    ];
    for (const [at, size, value] of cases) {
      const bytes = rich();
      poke(bytes, at, size, value);
      const info = await read(bytes);
      expect(info.format).toContain('ELF');
    }
    const bytes = rich();
    poke(bytes, f.phoff, 8, 2n ** 40n);
    expect((await read(bytes)).warnings.join(' ')).toContain('program headers');
  });

  it('survives damage to the dynamic section', async () => {
    const dyn = (bytes: Uint8Array): number => segmentAt(bytes, 2);
    const huge = rich();
    poke(huge, dyn(huge) + 32, 8, 2n ** 40n); // p_filesz
    expect((await read(huge)).warnings.join(' ')).toContain('dynamic section');
    const away = rich();
    poke(away, dyn(away) + 8, 8, 2n ** 40n); // p_offset
    expect((await read(away)).warnings.join(' ')).toContain('dynamic section');
  });

  it('falls back to .dynstr when the string table address maps nowhere', async () => {
    const bytes = rich();
    const load = segmentAt(bytes, 1);
    poke(bytes, load + 32, 8, 0); // PT_LOAD p_filesz: nothing maps
    const info = await read(bytes);
    expect(tableOf(info, 'Dependencies')).toEqual([['libc.so.6'], ['libm.so.6']]);
  });

  it('ignores a note that claims more than its segment holds', async () => {
    const bytes = rich();
    const note = segmentAt(bytes, 4);
    const offset = Number(new DataView(bytes.buffer).getBigUint64(note + 8, true));
    poke(bytes, offset, 4, 0xffffffff); // namesz
    const info = await read(bytes);
    expect(rowsOf(info, 'Binary')['Build ID']).toBeUndefined();
    expect(info.warnings).toEqual([]);
  });

  // The first section header of a 64-bit little-endian file, where the
  // extended counts live: sh_type +4, sh_size +32, sh_link +40, sh_info +44.
  const sectionZero = (bytes: Uint8Array): number =>
    Number(new DataView(bytes.buffer).getBigUint64(FIELDS.wide.shoff, true));
  const u16 = (bytes: Uint8Array, at: number): number =>
    new DataView(bytes.buffer).getUint16(at, true);

  it('takes the program header count from the first section header under PN_XNUM', async () => {
    const bytes = rich();
    const real = u16(bytes, FIELDS.wide.phnum);
    poke(bytes, FIELDS.wide.phnum, 2, 0xffff);
    poke(bytes, sectionZero(bytes) + 44, 4, real);
    const info = await read(bytes);
    expect(rowsOf(info, 'Binary')['Interpreter']).toBe(LD);
    expect(info.warnings).toEqual([]);
  });

  it('reads no program headers under PN_XNUM when the first section header holds no count', async () => {
    const bytes = rich();
    poke(bytes, FIELDS.wide.phnum, 2, 0xffff);
    const info = await read(bytes);
    expect(rowsOf(info, 'Binary')['Interpreter']).toBeUndefined();
    expect(info.warnings.join(' ')).toContain('The program header count is too large');
  });

  it('takes the section count and name table index from a reserved first entry', async () => {
    const bytes = rich();
    const zero = sectionZero(bytes);
    const total = u16(bytes, FIELDS.wide.shnum);
    const names = u16(bytes, FIELDS.wide.shstrndx);
    poke(bytes, FIELDS.wide.shnum, 2, 0);
    poke(bytes, FIELDS.wide.shstrndx, 2, 0xffff);
    poke(bytes, zero + 32, 8, total);
    poke(bytes, zero + 40, 4, names);
    const info = await read(bytes);
    expect(tableOf(info, 'Sections').map((row) => row[0])).toEqual(
      tableOf(await read(rich()), 'Sections').map((row) => row[0]),
    );
    expect(info.warnings).toEqual([]);
  });

  it('does not take extended counts from a first section header that is not SHT_NULL', async () => {
    const counted = rich();
    poke(counted, FIELDS.wide.shnum, 2, 0);
    poke(counted, sectionZero(counted) + 4, 4, 1); // SHT_PROGBITS
    poke(counted, sectionZero(counted) + 32, 8, u16(rich(), FIELDS.wide.shnum));
    const a = await read(counted);
    expect(section(a, 'Sections')).toBeUndefined();
    expect(a.warnings.join(' ')).toContain('it is not the reserved empty entry');

    const named = rich();
    poke(named, FIELDS.wide.shstrndx, 2, 0xffff);
    poke(named, sectionZero(named) + 4, 4, 1);
    poke(named, sectionZero(named) + 40, 4, u16(rich(), FIELDS.wide.shstrndx));
    const b = await read(named);
    expect(tableOf(b, 'Sections').some((row) => row[0] === '.comment')).toBe(false);
    expect(b.warnings.join(' ')).toContain('it is not the reserved empty entry');
  });

  // A file whose section table is rebuilt at its end with 0xff10 entries and
  // the name table's header at 0xff05, where SHN_XINDEX is required: past the
  // 4,096 entries the reader enumerates.
  const farNames = () => {
    const base = rich();
    const oldOff = sectionZero(base);
    const oldCount = u16(base, FIELDS.wide.shnum);
    const oldNames = u16(base, FIELDS.wide.shstrndx);
    const total = 0xff10;
    const nameIndex = 0xff05;
    const tableAt = Math.ceil(base.length / 8) * 8;
    const bytes = new Uint8Array(tableAt + total * 64);
    bytes.set(base);
    bytes.set(base.subarray(oldOff, oldOff + oldCount * 64), tableAt);
    const namesHeader = oldOff + oldNames * 64;
    bytes.set(base.subarray(namesHeader, namesHeader + 64), tableAt + nameIndex * 64);
    poke(bytes, FIELDS.wide.shoff, 8, tableAt);
    poke(bytes, FIELDS.wide.shnum, 2, 0);
    poke(bytes, FIELDS.wide.shstrndx, 2, 0xffff);
    poke(bytes, tableAt + 32, 8, total); // section 0 sh_size
    poke(bytes, tableAt + 40, 4, nameIndex); // section 0 sh_link
    return { bytes, tableAt, namesAt: tableAt + nameIndex * 64 };
  };

  it('names sections from an extended name-table index past the enumerated entries', async () => {
    const info = await read(farNames().bytes);
    expect(tableOf(info, 'Sections').map((row) => row[0])).toContain('.comment');
    expect(rowsOf(info, 'Binary')['Compiler']).toContain('GCC');
  });

  it('takes no names from a distant name-table header that is not a string table', async () => {
    const { bytes, namesAt } = farNames();
    poke(bytes, namesAt + 4, 4, 1); // sh_type SHT_PROGBITS
    const info = await read(bytes);
    const rows = tableOf(info, 'Sections');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row[0])).not.toContain('.comment');
    expect(info.warnings.join(' ')).toContain('is not a string table');
  });

  it('keeps the sections when the distant name table’s bytes cannot be read', async () => {
    const { bytes, tableAt, namesAt } = farNames();
    // Point the name table at a page nothing else reads, and fail that read.
    const away = tableAt + 0x200000;
    poke(bytes, namesAt + 24, 8, away); // sh_offset
    const source = {
      size: bytes.length,
      read: async (offset: number, length: number): Promise<Uint8Array> => {
        if (offset <= away && away < offset + length) {
          throw new Error('the disk could not be read');
        }
        return bytes.subarray(offset, offset + length);
      },
    };
    const info = await readElf(new RangeReader(source));
    expect(tableOf(info, 'Sections').length).toBeGreaterThan(0);
    expect(info.warnings).toContain('The section names could not be read.');
    expect(info.warnings.join(' ')).not.toContain('section headers could not be read');
  });

  it('cannot locate an AppImage payload when an extended section count is zero', async () => {
    const plain = buildElf({ appImage: 2, interp: LD, payload: 'hsqs-image' });
    poke(plain, segmentAt(plain, 1) + 32, 8, sectionZero(plain)); // PT_LOAD stops at the table
    poke(plain, FIELDS.wide.shnum, 2, 0); // section 0's sh_size is 0
    const info = await read(plain);
    expect(section(info, 'AppImage')).toBeUndefined();
    expect(info.warnings).toContain('The AppImage payload could not be located.');
  });

  it('counts an extended section table when finding where an AppImage payload starts', async () => {
    const payload = new Uint8Array(500);
    payload.set(new TextEncoder().encode('hsqs'), 0);
    const plain = buildElf({ appImage: 2, interp: LD, payload });
    // The loadable segment stops short of the section table, so only the
    // table's own length says where the ELF ends.
    const shoff = sectionZero(plain);
    poke(plain, segmentAt(plain, 1) + 32, 8, shoff); // PT_LOAD p_filesz
    const expected = rowsOf(await read(plain), 'AppImage')['Payload offset'];
    expect(expected).toBe((plain.length - 500).toLocaleString('en-US'));

    const extended = plain.slice();
    poke(extended, sectionZero(extended) + 32, 8, u16(extended, FIELDS.wide.shnum));
    poke(extended, FIELDS.wide.shnum, 2, 0);
    expect(rowsOf(await read(extended), 'AppImage')['Payload offset']).toBe(expected);
  });

  it('does not take the headers of an AppImage cut off in its section table for a payload', async () => {
    const plain = buildElf({ appImage: 2, interp: LD, payload: 'hsqs-image' });
    const shoff = sectionZero(plain);
    poke(plain, segmentAt(plain, 1) + 32, 8, shoff); // PT_LOAD p_filesz stops at the table
    const cut = plain.slice(0, shoff + 64 + 10); // one entry and part of the next
    const info = await read(cut);
    expect(section(info, 'AppImage')).toBeUndefined();
    expect(info.warnings).toContain('The AppImage payload could not be located.');
  });

  it('never throws anything but PackageError when truncated', async () => {
    const variants = [
      buildElf({ ...library, interp: LD }),
      buildElf({ wide: false, big: true, machine: 8, soname: 'x', needed: ['a'], buildId: [1] }),
      buildElf({
        type: 1,
        noProgramHeaders: true,
        sections: [{ name: '.modinfo', data: 'license=GPL\0' }],
      }),
      buildElf({ appImage: 2, payload: 'hsqs' }),
    ];
    for (const bytes of variants) {
      const cuts: number[] = [];
      for (let n = 0; n < Math.min(1024, bytes.length); n++) {
        cuts.push(n);
      }
      for (let n = 1024; n < bytes.length; n += 29) {
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
    const good = rich();
    for (let at = 16; at < 64; at++) {
      for (const fill of [0x00, 0xff, 0x7f]) {
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

describe('readElf: rendering', () => {
  it('escapes strings from the file and strips direction overrides', async () => {
    const info = await read({
      soname: '<img src=x onerror=1>',
      needed: [`a${RLO}b.so`],
      rpath: '<script>alert(1)</script>',
      sections: [{ name: '.comment', data: `cc ${RLO}evil` }],
    });
    const html = renderPackageHtml(info, { fileName: 'a.so', fileSize: 10 });
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(RLO);
    expect(html).toContain('ab.so');
  });
});

describe('readElf: control-flow hardening notes', () => {
  const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24];
  const feature = (type: number, bits: number) => ({ type, data: u32(bits) });
  const X86 = 0xc0000002;
  const ARM = 0xc0000000;
  const prot = async (spec: ElfSpec) =>
    rowsOf(await read({ needed: ['libc.so.6'], ...spec }), 'Protections');
  const IBT = 'Indirect branch tracking (CET IBT)';
  const SHSTK = 'Shadow stack (CET SHSTK)';
  const BTI = 'Branch target identification (BTI)';
  const PAC = 'Pointer authentication (PAC)';
  const NOTE_MISSING = 'Unknown (no GNU property note)';

  it('reads IBT and shadow stack on x86-64', async () => {
    const both = await prot({ properties: [feature(X86, 3)] });
    expect([both[IBT], both[SHSTK]]).toEqual(['Yes', 'Yes']);
    const ibt = await prot({ properties: [feature(X86, 1)] });
    expect([ibt[IBT], ibt[SHSTK]]).toEqual(['Yes', 'No']);
    const none = await prot({});
    expect([none[IBT], none[SHSTK]]).toEqual([NOTE_MISSING, NOTE_MISSING]);
    const zero = await prot({ properties: [feature(X86, 0)] });
    expect([zero[IBT], zero[SHSTK]]).toEqual(['No', 'No']);
  });

  it('puts the new rows after the existing ones', async () => {
    const info = await read({ needed: ['libc.so.6'], properties: [feature(X86, 3)] });
    const s = section(info, 'Protections');
    expect(s?.kind === 'properties' ? s.rows.map((r) => r[0]) : []).toEqual([
      'Non-executable stack',
      'RELRO',
      IBT,
      SHSTK,
    ]);
  });

  it('reads a 32-bit x86 note with 4-byte padding, and keeps other notes', async () => {
    const info = await read({
      wide: false,
      machine: 3,
      needed: ['libc.so.6'],
      buildId: [1, 2, 3],
      properties: [feature(X86, 3)],
    });
    const p = rowsOf(info, 'Protections');
    expect([p[IBT], p[SHSTK]]).toEqual(['Yes', 'Yes']);
    expect(rowsOf(info, 'Binary')['Build ID']).toBe('010203');
  });

  it('reads BTI and pointer authentication on AArch64', async () => {
    const both = await prot({ machine: 183, properties: [feature(ARM, 3)] });
    expect([both[BTI], both[PAC]]).toEqual(['Yes', 'Yes']);
    expect(both[IBT]).toBeUndefined();
    const bti = await prot({ machine: 183, properties: [feature(ARM, 1)] });
    expect([bti[BTI], bti[PAC]]).toEqual(['Yes', 'No']);
    const none = await prot({ machine: 183 });
    expect([none[BTI], none[PAC]]).toEqual([NOTE_MISSING, NOTE_MISSING]);
  });

  it('reads the property note from PT_GNU_PROPERTY as well as PT_NOTE', async () => {
    const spec = { machine: 183, noSections: true, properties: [feature(ARM, 3)] };
    const note = await prot(spec);
    expect([note[BTI], note[PAC]]).toEqual(['Yes', 'Yes']);
    const dedicated = await prot({ ...spec, propertySegment: true });
    expect([dedicated[BTI], dedicated[PAC]]).toEqual(['Yes', 'Yes']);
  });

  it('falls back to the section when an unrelated PT_NOTE carries no property', async () => {
    // namesz 4, descsz 16, type 5, "GNU ", then one 4-byte property padded to 8.
    const prop = [4, 0, 0, 0, 16, 0, 0, 0, 5, 0, 0, 0, 0x47, 0x4e, 0x55, 0];
    prop.push(...u32(ARM), 4, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0);
    const p = await prot({
      machine: 183,
      buildId: [1, 2, 3],
      sections: [{ name: '.note.gnu.property', type: 7, data: new Uint8Array(prop) }],
    });
    expect([p[BTI], p[PAC]]).toEqual(['Yes', 'Yes']);
  });

  it('keeps the notes it read when a later note range is damaged', async () => {
    const info = await read({
      buildId: [1, 2, 3],
      sections: [{ name: '.note.bad', type: 7, size: 65536 }],
    });
    expect(rowsOf(info, 'Binary')['Build ID']).toBe('010203');
    expect(info.warnings).toHaveLength(1);
    expect(info.warnings[0]).toContain('.note.bad');
  });

  it('ignores a feature word that belongs to another architecture', async () => {
    const p = await prot({ machine: 183, properties: [feature(X86, 3)] });
    expect([p[BTI], p[PAC]]).toEqual(['No', 'No']);
  });

  it('skips an unrelated property that comes first', async () => {
    const p = await prot({
      properties: [{ type: 0xc0008002, data: u32(1) }, feature(X86, 2)],
    });
    expect([p[IBT], p[SHSTK]]).toEqual(['No', 'Yes']);
  });

  it('stops at a property whose size runs past the note, without failing', async () => {
    const info = await read({
      needed: ['libc.so.6'],
      properties: [
        { type: 0xc0008002, data: u32(1) },
        { type: X86, data: u32(3), size: 4000 },
      ],
    });
    const p = rowsOf(info, 'Protections');
    expect([p[IBT], p[SHSTK]]).toEqual(['No', 'No']);
    expect(info.warnings).toEqual([]);
  });

  it('shows no hardening rows for other machines', async () => {
    const p = await prot({ machine: 243, properties: [feature(X86, 3)] });
    expect(Object.keys(p).filter((k) => /CET|BTI|PAC/.test(k))).toEqual([]);
  });

  it('shows no hardening rows where protections are not shown', async () => {
    const object = await read({ type: 1, noProgramHeaders: true, properties: [feature(X86, 3)] });
    expect(section(object, 'Protections')).toBeUndefined();
  });
});
