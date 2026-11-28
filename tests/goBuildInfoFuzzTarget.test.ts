import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../src/binary/reader';
import { goProperties, readGoBuildInfo } from '../src/binary/goBuildInfo';
import { fuzz } from '../fuzz/targets/go-buildinfo.fuzz';

const SEED = join(__dirname, '../fuzz/corpus/go-buildinfo/replacement-at-limit');

describe('go-buildinfo fuzz target', () => {
  it('accepts the longest replacement row the reader assembles', async () => {
    const seed = readFileSync(SEED);
    expect(seed[0] % 3).toBe(1);
    const section = seed.subarray(1);
    const info = await readGoBuildInfo(
      new RangeReader(bytesSource(section)),
      { offset: 0, size: section.length, vaddr: 0x400000 },
      () => undefined,
    );
    const row = goProperties(info!).find(([label]) => label === 'Module replaced by');
    expect(row?.[1]).toHaveLength(1025);
    await fuzz(seed);
  });

  it('accepts an empty input and junk', async () => {
    await fuzz(Buffer.alloc(0));
    await fuzz(Buffer.alloc(4096, 0x41));
  });
});
