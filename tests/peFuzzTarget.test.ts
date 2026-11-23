import { describe, expect, it } from 'vitest';
import { bytesSource, readPe } from '../src/pe';
import { fuzz, withHeader } from '../fuzz/targets/pe.fuzz';
import { buildPe } from './pe/fixture';

describe('pe fuzz target', () => {
  it('accepts a real image, junk, and an empty input without throwing', async () => {
    await fuzz(Buffer.from(buildPe({ version: { fileVersion: [1, 0, 0, 0] } })));
    await fuzz(Buffer.alloc(0));
    await fuzz(Buffer.alloc(4096, 0x41));
    await fuzz(Buffer.alloc(4096, 0xff));
  });

  it('turns junk into an image whose sections and directories the reader reaches', async () => {
    const info = await readPe(bytesSource(withHeader(Buffer.alloc(4096, 0))));
    expect(info.sections.map((s) => s.name)).toEqual(['.text', '.rsrc']);
    expect(info.format).toBe('PE32');
  });

  it('leaves an input that already has a PE header alone', () => {
    const real = Buffer.from(buildPe());
    expect(withHeader(real).equals(real)).toBe(true);
  });

  it('leaves an input too short to hold the header alone', () => {
    const short = Buffer.alloc(100, 7);
    expect(withHeader(short)).toBe(short);
  });
});
