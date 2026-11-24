// @vitest-environment node
// The file-source fuzz target reads one input four ways (memory, a real file
// through the worker's task, a handle that answers in pieces, memory again)
// and fails when they disagree.
import { describe, expect, it } from 'vitest';
import { choppyHandle, fuzz } from '../fuzz/targets/file-source.fuzz';
import { buildPe } from './pe/fixture';
import { buildElf } from './pkg/elfFixture';
import { buildMsi } from './pkg/msiFixture';
import { SHAPES } from '../fuzz/targets/pkg.fuzz';

const shape = (name: string) => SHAPES.findIndex((s) => s.name === name);

describe('file-source fuzz target', () => {
  it('agrees with itself on real files, junk and empty input', async () => {
    await fuzz(
      Buffer.concat([
        Buffer.of(0xff),
        Buffer.from(buildPe({ version: { fileVersion: [1, 0, 0, 0] } })),
      ]),
    );
    await fuzz(Buffer.concat([Buffer.of(shape('fuzz.msi')), Buffer.from(buildMsi())]));
    await fuzz(Buffer.concat([Buffer.of(shape('fuzz.so')), Buffer.from(buildElf())]));
    for (let i = 0; i < SHAPES.length; i++) {
      await fuzz(Buffer.concat([Buffer.of(i), Buffer.alloc(3000, i * 7)]));
    }
    await fuzz(Buffer.alloc(0));
    await fuzz(Buffer.of(0xf5));
  });

  it('answers reads in short pieces, never empty before the end', async () => {
    const bytes = new Uint8Array(10_000).map((_, i) => i & 0xff);
    const handle = choppyHandle(bytes, 12345);
    const sizes: number[] = [];
    const buffer = new Uint8Array(10_000);
    for (let at = 0; at < bytes.length;) {
      const { bytesRead } = await handle.read(buffer, at, bytes.length - at, at);
      expect(bytesRead).toBeGreaterThan(0);
      sizes.push(bytesRead);
      at += bytesRead;
    }
    expect(buffer).toEqual(bytes);
    expect(sizes.length).toBeGreaterThan(2);
    expect((await handle.read(buffer, 0, 10, bytes.length)).bytesRead).toBe(0);
  });
});
