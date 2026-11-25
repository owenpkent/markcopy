import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import { readElf } from '../../src/pkg/elf';
import { PackageError } from '../../src/pkg/model';
import { renderPackageHtml } from '../../src/pkg/render';
import type { InfoSection, PackageInfo } from '../../src/pkg/model';
import { buildElf, FIELDS, type ElfSpec, type SectionSpec } from './elfFixture';
import { inlineBlock, pointerBlock, SAMPLE_LINES } from '../binary/goFixture';

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

describe('readElf: Go build information', () => {
  const goSection = (data: SectionSpec['data']) => ({
    name: '.go.buildinfo',
    align: 16,
    data,
  });

  it('reads inline strings from the .go.buildinfo section', async () => {
    const info = await read({
      type: 2,
      sections: [goSection(inlineBlock({ info: SAMPLE_LINES }))],
    });
    expect(info.warnings).toEqual([]);
    expect(info.sections.map((s) => s.heading).slice(0, 3)).toEqual([
      'Binary',
      'Go',
      'Go build settings',
    ]);
    expect(rowsOf(info, 'Go')).toEqual({
      'Go version': 'go1.22.1',
      Package: 'example.com/app/cmd/app',
      Module: 'example.com/app',
      'Module version': 'v1.4.0',
    });
    expect(tableOf(info, 'Go build settings')).toContainEqual(['-trimpath', 'true']);
    expect(tableOf(info, 'Go modules')).toEqual([
      ['github.com/spf13/cobra', 'v1.8.0'],
      ['golang.org/x/sys', 'v0.15.0, replaced by example.com/fork-sys v0.15.1'],
    ]);
    expect(noteOf(info, 'Go modules')).toBeUndefined();
  });

  it('keeps the Go build ID in the Binary section', async () => {
    const info = await read({
      goBuildId: 'abc/def',
      sections: [goSection(inlineBlock())],
    });
    expect(rowsOf(info, 'Binary')['Go build ID']).toBe('abc/def');
    expect(rowsOf(info, 'Go')['Go version']).toBe('go1.22.1');
  });

  it('falls back to the first writable loadable segment when there is no section', async () => {
    const spec = { loadFlags: 6, noSections: true, sections: [goSection(inlineBlock())] };
    const info = await read(spec);
    expect(rowsOf(info, 'Go')['Go version']).toBe('go1.22.1');
    // The segment is not writable: the block is not looked for there.
    const readOnly = await read({ ...spec, loadFlags: 5 });
    expect(section(readOnly, 'Go')).toBeUndefined();
  });

  it('does not look in a .go.buildinfo section that holds no file data', async () => {
    const info = await read({ sections: [{ name: '.go.buildinfo', type: 8, size: 64 }] });
    expect(section(info, 'Go')).toBeUndefined();
    expect(info.warnings).toEqual([]);
  });

  it('follows pointers through the loadable segment in the older layout', async () => {
    for (const spec of [{}, { pointerSize: 4 }, { big: true }]) {
      const wide = spec.pointerSize !== 4;
      const info = await read({
        wide,
        big: spec.big,
        sections: [goSection((vaddr) => pointerBlock({ ...spec, info: SAMPLE_LINES })(vaddr))],
      });
      expect(info.warnings).toEqual([]);
      expect(rowsOf(info, 'Go')['Go version']).toBe('go1.16.5');
      expect(tableOf(info, 'Go modules')).toHaveLength(2);
    }
  });

  it('shows only the version when the module text is declared too long', async () => {
    const info = await read({
      sections: [goSection(inlineBlock({ info: SAMPLE_LINES, declaredInfoLength: 300 * 1024 }))],
    });
    expect(rowsOf(info, 'Go')['Go version']).toBe('go1.22.1');
    expect(section(info, 'Go modules')).toBeUndefined();
    expect(info.warnings).toEqual([
      'The Go module list is too long to read, so only the Go version is shown.',
    ]);
  });

  it('warns about a damaged header instead of failing the page', async () => {
    for (const block of [
      inlineBlock({ pointerSize: 3 }),
      inlineBlock({ info: SAMPLE_LINES, declaredInfoLength: 99999 }),
      inlineBlock({ version: 'x'.repeat(100) }),
    ]) {
      const info = await read({ sections: [goSection(block)] });
      expect(info.warnings).toEqual(['The Go build information could not be read.']);
      expect(section(info, 'Go')).toBeUndefined();
      expect(rowsOf(info, 'Binary')['Type']).toBe('Shared library');
    }
    // A pointer that maps nowhere.
    const lost = await read({
      sections: [goSection(() => pointerBlock({ info: SAMPLE_LINES })(0x900000))],
    });
    expect(lost.warnings).toEqual(['The Go build information could not be read.']);
  });

  it('lists 200 modules and says how many there are', async () => {
    const lines = Array.from({ length: 700 }, (_, i) => `dep\tx.org/m${i}\tv1.0.${i}`);
    const info = await read({ sections: [goSection(inlineBlock({ info: lines }))] });
    expect(tableOf(info, 'Go modules')).toHaveLength(200);
    expect(noteOf(info, 'Go modules')).toBe('Showing the first 200 of 700 modules.');
  });

  it('is absent from an ELF file that is not a Go program', async () => {
    const info = await read(library);
    expect(info.sections.map((s) => s.heading)).not.toContain('Go');
  });

  it('renders escaped and cleaned', async () => {
    const info = await read({
      sections: [
        goSection(
          inlineBlock({
            info: [
              `path\t<script>alert(1)</script>${RLO}x`,
              `dep\t<img src=x onerror=1>\tv1`,
              `build\tk${RLO}=<b>`,
            ],
          }),
        ),
      ],
    });
    const html = renderPackageHtml(info, { fileName: 'a.out', fileSize: 10 });
    expect(html).toContain('Go build settings');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;x');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain(RLO);
  });
});
