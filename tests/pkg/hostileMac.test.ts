// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import { readDmg } from '../../src/pkg/dmg';
import { PackageError } from '../../src/pkg/model';
import type { PackageInfo } from '../../src/pkg/model';
import { readXar } from '../../src/pkg/xar';
import { buildDmg } from './dmgFixture';
import { buildXar } from './xarFixture';

// Regression tests for amplification: a few kilobytes of file that used to cost
// gigabytes. The sizes are chosen so the unfixed code spends a few hundred MB.
const reader = (bytes: Uint8Array): RangeReader => new RangeReader(bytesSource(bytes));
const heap = (): number => {
  globalThis.gc?.();
  return process.memoryUsage().heapUsed;
};
const LIMIT = 64 * 1024 * 1024;

const contents = (info: PackageInfo): string[][] => {
  const s = info.sections.find((x) => x.heading === 'Contents');
  return s?.kind === 'table' ? s.rows : [];
};

describe('xar: path and tree bombs', () => {
  it('cuts a huge directory name instead of copying it into every child path', async () => {
    const name = 'D'.repeat(1024 * 1024);
    const kids = '<file><name>a</name><type>file</type></file>'.repeat(1000);
    const toc = `<xar><toc><file><name>${name}</name><type>directory</type>${kids}</file></toc></xar>`;
    const before = heap();
    const info = await readXar(reader(buildXar({ rawToc: toc })));
    expect(heap() - before).toBeLessThan(LIMIT);
    const rows = contents(info);
    expect(rows).toHaveLength(200);
    for (const [path] of rows) {
      expect(path.length).toBeLessThanOrEqual(1024);
    }
  });

  it('rejects a table of contents with more elements than any real one', async () => {
    const toc = `<xar><toc>${'<a/>'.repeat(300_000)}</toc></xar>`;
    const before = heap();
    await expect(readXar(reader(buildXar({ rawToc: toc })))).rejects.toThrow(PackageError);
    expect(heap() - before).toBeLessThan(LIMIT);
  });

  it('keeps a normal archive exactly as before', async () => {
    const info = await readXar(
      reader(buildXar({ files: [{ name: 'dir', children: [{ name: 'a.txt', data: 'hello' }] }] })),
    );
    expect(contents(info)).toEqual([['dir/a.txt', '5 bytes']]);
  });
});

describe('dmg: property list bomb', () => {
  it('warns instead of building a tree of millions of elements', async () => {
    const plist = `<plist>${'<a/>'.repeat(750_000)}</plist>`;
    const before = heap();
    const info = await readDmg(reader(buildDmg({ rawPlist: plist })));
    expect(heap() - before).toBeLessThan(LIMIT);
    expect(info.warnings.join(' ')).toContain('partition list');
    expect(info.format).toBe('Apple disk image');
  });
});
