import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PdfSnapshot } from '../src/texSnapshot';

describe('PdfSnapshot', () => {
  let work: string;
  let snap: PdfSnapshot;
  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'mc-snap-test-'));
    snap = new PdfSnapshot();
  });
  afterEach(async () => {
    await snap.dispose();
    await rm(work, { recursive: true, force: true });
  });

  it('opens nothing before a good compile', async () => {
    expect(await snap.materialize('main.tex')).toBeUndefined();
  });

  it('keeps the last good bytes after a failed rebuild removes the compiler output', async () => {
    const working = join(work, 'main.pdf');
    const good = Buffer.from('%PDF-good');
    await writeFile(working, good);
    snap.set(await readFile(working));
    // A failed rebuild deletes the engine's PDF; set() is never called.
    await rm(working);
    const opened = await snap.materialize('main.tex');
    expect(opened).toBeDefined();
    expect(opened).not.toBe(working);
    expect(opened!.endsWith('main.pdf')).toBe(true);
    expect((await readFile(opened!)).equals(good)).toBe(true);
  });

  it('reuses the file when bytes are unchanged and updates it when they change', async () => {
    snap.set(Buffer.from('one'));
    const a = await snap.materialize('main.tex');
    expect(await snap.materialize('main.tex')).toBe(a);
    snap.set(Buffer.from('two'));
    const b = await snap.materialize('main.tex');
    expect((await readFile(b!)).toString()).toBe('two');
  });

  it('removes its directory on dispose', async () => {
    snap.set(Buffer.from('x'));
    const p = (await snap.materialize('main.tex'))!;
    await snap.dispose();
    await expect(access(p)).rejects.toThrow();
  });
});
