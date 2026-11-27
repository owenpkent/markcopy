import {
  GO_MODULE_ROWS,
  goModuleRows,
  goProperties,
  parseModinfo,
  readGoBuildInfo,
  uvarint,
  type GoBuildInfo,
  type ParsedModinfo,
} from '../../src/binary/goBuildInfo';
import { bytesSource, RangeReader, ReadError } from '../../src/binary/reader';
import {
  CostError,
  hasControl,
  MAX_HEAP_GROWTH,
  MAX_MILLISECONDS,
  memoryInUse,
} from './binaryOracle';

export { CostError, MAX_HEAP_GROWTH, MAX_HTML_CHARS, MAX_MILLISECONDS } from './binaryOracle';

// Go build information (src/binary/goBuildInfo.ts) is found inside an ELF or a PE
// by its 14-byte magic at a 16-byte aligned address, which the pe and pkg targets
// reach only after a header that survives mutation, a data section that holds
// the block, and a block whose pointers resolve. This target hands the reader the
// section directly: the input is the section, mapped at a fixed virtual address,
// so a pointer-form header (Go 1.17 and earlier) can name strings inside it.
//
// The first input byte picks the stage:
//   0  parseModinfo on the bytes as module text (sentinels on or off)
//   1  readGoBuildInfo over the bytes as they are
//   2  readGoBuildInfo with the magic and a pointer width written over the start,
//      so mutation works on the fields behind it
// A ReadError is the reader's documented answer to a header that makes no sense;
// anything else is a finding. A result must stay inside the caps the page relies
// on, and its text must hold no control characters.
const MODES = 3;
const BASE = 0x400000;
const MAGIC = [0xff, 0x20, 0x47, 0x6f, 0x20, 0x62, 0x75, 0x69, 0x6c, 0x64, 0x69, 0x6e, 0x66, 0x3a];
const MAX_SETTINGS = 64;

function clean(label: string, text: string | undefined): void {
  if (text === undefined) {
    return;
  }
  if (hasControl(text) || text.length > 1024) {
    throw new Error(`${label} holds a control character or runs past 1024 characters`);
  }
}

function checkParsed(parsed: ParsedModinfo): void {
  if (parsed.deps.length > GO_MODULE_ROWS || parsed.depTotal < parsed.deps.length) {
    throw new CostError(`${parsed.deps.length} dependencies of ${parsed.depTotal}`);
  }
  if (parsed.settings.length > MAX_SETTINGS) {
    throw new CostError(`${parsed.settings.length} build settings`);
  }
  clean('path', parsed.path);
  clean('module path', parsed.module?.path);
  clean('module version', parsed.module?.version);
  for (const dep of parsed.deps) {
    clean('dependency path', dep.path);
    clean('dependency version', dep.version);
    clean('replacement path', dep.replacedBy?.path);
    clean('replacement version', dep.replacedBy?.version);
  }
  for (const [key, value] of parsed.settings) {
    clean('setting key', key);
    clean('setting value', value);
  }
}

function checkInfo(info: GoBuildInfo): void {
  checkParsed(info);
  clean('Go version', info.goVersion);
  if (info.goVersion === '') {
    throw new Error('an empty Go version was accepted');
  }
  const rows = goModuleRows(info);
  if (rows.length !== info.deps.length) {
    throw new Error('goModuleRows does not give a row for each dependency');
  }
  for (const [label, value] of goProperties(info)) {
    clean(label, value);
  }
}

/** The input with the build information magic over its start, the rest left for mutation. */
export function withMagic(data: Buffer): Buffer {
  if (data.length < 32) {
    return data;
  }
  const out = Buffer.from(data);
  Buffer.from(MAGIC).copy(out);
  // Pointer width 4 or 8, as a real file has; the flags byte stays the input's.
  out[14] = out[14] & 1 ? 4 : 8;
  return out;
}

async function read(bytes: Buffer): Promise<void> {
  const reader = new RangeReader(bytesSource(bytes));
  try {
    const info = await readGoBuildInfo(
      reader,
      { offset: 0, size: bytes.length, vaddr: BASE },
      (address) => {
        const offset = address - BigInt(BASE);
        return offset >= 0n && offset < BigInt(bytes.length)
          ? { offset: Number(offset), available: bytes.length - Number(offset) }
          : undefined;
      },
    );
    if (info) {
      checkInfo(info);
    }
  } catch (err) {
    if (!(err instanceof ReadError)) {
      throw err;
    }
  }
}

// readGoBuildInfo reads through a RangeReader, so this target is async.
export async function fuzz(data: Buffer): Promise<void> {
  if (data.length === 0) {
    return;
  }
  const mode = data[0] % MODES;
  const rest = data.subarray(1);
  const started = performance.now();
  const memory = memoryInUse();
  if (mode === 0) {
    checkParsed(parseModinfo(rest));
    checkParsed(parseModinfo(rest.toString('latin1')));
    // A varint is at most 10 bytes and never reads past what it was given.
    const varint = uvarint(rest);
    if (varint !== undefined && (varint.length < 1 || varint.length > 10)) {
      throw new Error(`a varint of ${varint.length} bytes`);
    }
  } else {
    await read(mode === 1 ? rest : withMagic(rest));
  }
  if (performance.now() - started > MAX_MILLISECONDS) {
    throw new CostError(`${rest.length} bytes took too long (mode ${mode})`);
  }
  if (memoryInUse() - memory > MAX_HEAP_GROWTH) {
    throw new CostError(`${rest.length} bytes grew memory past the limit (mode ${mode})`);
  }
}
