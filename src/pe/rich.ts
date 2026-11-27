// Reads the "Rich" header: an undocumented record Microsoft's linker writes
// between the DOS stub and the PE header. It lists the tools (compiler,
// assembler, resource compiler, linker) that produced the objects linked into
// the image, each with a build number and a count of objects.
//
// The record is XOR-encoded with a key that is also a checksum of the DOS
// header and the record itself. Anyone can write one, copy one from another
// file or strip it, so what it says is a claim about the build, never proof.
// Nothing here reads past the bytes it is given, and nothing throws.
//
// No `vscode` import: pure, so it unit-tests and fuzzes directly.

export interface PeRichEntry {
  /** The tool's product id: the high 16 bits of the entry's compId. */
  productId: number;
  /** The tool's build number: the low 16 bits. */
  build: number;
  /** How many objects or files that tool at that build contributed. */
  count: number;
  tool: string;
  /** The Visual Studio release the id and build point to, or "" when unknown. */
  toolset: string;
}

export interface PeRich {
  entries: PeRichEntry[];
  /**
   * Whether the key matches a checksum of the DOS header and the record, as the
   * linker computes it. False means something changed after linking.
   */
  checksumValid: boolean;
}

// "Rich", "DanS", little-endian.
const RICH = 0x68636952;
const DANS = 0x536e6144;
// The record can sit no earlier than the end of the DOS header and stub.
const FIRST_RICH_OFFSET = 0x80;
// How many entries are kept. A real record has a few dozen. The start marker is
// looked for all the way back to the start of the bytes given, which readPe
// caps at 4 KiB.
const MAX_ENTRIES = 256;

const rol32 = (value: number, bits: number): number =>
  ((value << bits) | (value >>> (32 - bits))) >>> 0;

// Tools of the 18-entry blocks used from Visual Studio 2010 SP1 onwards, by
// position within a block.
const BLOCK_TOOLS = [
  'Alias object',
  'Profile-guided optimisation database converter',
  'Resource converter',
  'Export file',
  'Import library',
  'Linker',
  'Assembler (MASM)',
  'C compiler',
  'C++ compiler',
  'C compiler (CIL)',
  'C++ compiler (CIL)',
  'C compiler (link-time code generation)',
  'C++ compiler (link-time code generation)',
  'MSIL (link-time code generation)',
  'C compiler (profile-guided, instrumented)',
  'C++ compiler (profile-guided, instrumented)',
  'C compiler (profile-guided, optimised)',
  'C++ compiler (profile-guided, optimised)',
];
const BLOCK_SIZE = 18;
const FIRST_BLOCK = 0x00b5;
const LAST_BLOCK_ID = 0x010e;
const BLOCK_TOOLSETS = [
  'Visual Studio 2010',
  'Visual Studio 2012',
  'Visual Studio 2013',
  'Visual Studio 2013',
];

// Ids from before the block layout, each with its tool and release. A Map, not
// an object literal: the ids come from the file.
const OLDER = new Map<number, [tool: string, toolset: string]>();
const addOlder = (toolset: string, tools: [number, string][]): void => {
  for (const [id, tool] of tools) {
    OLDER.set(id, [tool, toolset]);
  }
};
addOlder('Visual Studio 2010', [
  [0x0098, 'Alias object'],
  [0x0099, 'Profile-guided optimisation database converter'],
  [0x009a, 'Resource converter'],
  [0x009b, 'Export file'],
  [0x009c, 'Import library'],
  [0x009d, 'Linker'],
  [0x009e, 'Assembler (MASM)'],
  [0x00aa, 'C compiler'],
  [0x00ab, 'C++ compiler'],
]);
addOlder('Visual Studio 2008', [
  [0x0083, 'C compiler'],
  [0x0084, 'C++ compiler'],
  [0x0091, 'Linker'],
  [0x0092, 'Export file'],
  [0x0093, 'Import library'],
  [0x0094, 'Resource converter'],
  [0x0095, 'Assembler (MASM)'],
]);
addOlder('Visual Studio 2005', [
  [0x006d, 'C compiler'],
  [0x006e, 'C++ compiler'],
  [0x0078, 'Linker'],
  [0x007a, 'Export file'],
  [0x007b, 'Import library'],
  [0x007c, 'Resource converter'],
  [0x007d, 'Assembler (MASM)'],
]);
addOlder('Visual Studio .NET 2003', [
  [0x005a, 'Linker'],
  [0x005c, 'Export file'],
  [0x005d, 'Import library'],
  [0x005e, 'Resource converter'],
  [0x005f, 'C compiler'],
  [0x0060, 'C++ compiler'],
  [0x000f, 'Assembler (MASM)'],
]);
addOlder('', [
  [0x0001, 'Imported symbols'],
  [0x0000, 'Unmarked objects'],
]);

const inBlocks = (id: number): boolean => id >= FIRST_BLOCK && id <= LAST_BLOCK_ID;

/** What a product id is, in words. */
export function richTool(productId: number): string {
  const known = OLDER.get(productId);
  if (known) {
    return known[0];
  }
  if (inBlocks(productId)) {
    return BLOCK_TOOLS[(productId - FIRST_BLOCK) % BLOCK_SIZE];
  }
  return `Unknown tool (0x${productId.toString(16).toUpperCase().padStart(4, '0')})`;
}

/**
 * The Visual Studio release a product id (and, for the newest block, its build
 * number) belongs to. Empty when there is nothing sound to say.
 */
export function richToolset(productId: number, build: number): string {
  const known = OLDER.get(productId);
  if (known) {
    return known[1];
  }
  if (inBlocks(productId)) {
    const block = Math.floor((productId - FIRST_BLOCK) / BLOCK_SIZE);
    if (block < BLOCK_TOOLSETS.length) {
      return BLOCK_TOOLSETS[block];
    }
    // The last block served every release since 2015, so the build number
    // says which one.
    if (build < 25000) {
      return 'Visual Studio 2015';
    }
    if (build < 27500) {
      return 'Visual Studio 2017';
    }
    return build < 30700 ? 'Visual Studio 2019' : 'Visual Studio 2022 or later';
  }
  return productId < FIRST_BLOCK ? 'Older Visual Studio' : '';
}

/**
 * Decode the record from the bytes before the PE header (offset 0 up to
 * e_lfanew). Returns undefined when there is none, or what is there is not a
 * whole, well-formed record.
 */
export function readRich(bytes: Uint8Array): PeRich | undefined {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let richAt = -1;
    for (let at = FIRST_RICH_OFFSET; at + 8 <= bytes.length; at += 4) {
      if (view.getUint32(at, true) === RICH) {
        richAt = at;
        break;
      }
    }
    if (richAt < 0) {
      return undefined;
    }
    const key = view.getUint32(richAt + 4, true);

    // The record is written forwards but found backwards: "Rich" marks its end,
    // and the start marker is the first dword that decodes to "DanS".
    let dansAt = -1;
    for (let at = richAt - 4; at >= 0; at -= 4) {
      if ((view.getUint32(at, true) ^ key) >>> 0 === DANS) {
        dansAt = at;
        break;
      }
    }
    if (dansAt < 0) {
      return undefined;
    }

    // Three zero dwords of padding, then (compId, count) pairs up to "Rich".
    const first = dansAt + 16;
    const span = richAt - first;
    if (span < 0 || span % 8 !== 0) {
      return undefined;
    }
    for (let at = dansAt + 4; at < first; at += 4) {
      if ((view.getUint32(at, true) ^ key) >>> 0 !== 0) {
        return undefined;
      }
    }

    // The linker's checksum: the offset of the record, plus each byte of the
    // DOS header and stub rotated by its position (e_lfanew is left out, since
    // the linker had not set it yet), plus each entry rotated by its count.
    let checksum = dansAt >>> 0;
    for (let i = 0; i < dansAt; i++) {
      if (i < 0x3c || i > 0x3f) {
        checksum = (checksum + rol32(bytes[i], i % 32)) >>> 0;
      }
    }
    const entries: PeRichEntry[] = [];
    for (let at = first; at < richAt; at += 8) {
      const compId = (view.getUint32(at, true) ^ key) >>> 0;
      const count = (view.getUint32(at + 4, true) ^ key) >>> 0;
      checksum = (checksum + rol32(compId, count % 32)) >>> 0;
      if (entries.length < MAX_ENTRIES) {
        const productId = compId >>> 16;
        const build = compId & 0xffff;
        entries.push({
          productId,
          build,
          count,
          tool: richTool(productId),
          toolset: richToolset(productId, build),
        });
      }
    }
    return entries.length > 0 ? { entries, checksumValid: checksum === key } : undefined;
  } catch {
    return undefined;
  }
}
