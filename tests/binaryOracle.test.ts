// @vitest-environment node
// The checks the pe, pkg and file-source fuzz targets apply to every page
// (fuzz/targets/binaryOracle.ts). Each must pass the pages real fixtures make
// and fail the kinds of page a broken reader would.
import { describe, expect, it } from 'vitest';
import { bytesSource } from '../src/binary/reader';
import { readPe, renderPeHtml } from '../src/pe';
import { readPackage, renderPackageHtml } from '../src/pkg';
import {
  checkPage,
  CostError,
  memoryInUse,
  PageError,
  startCost,
} from '../fuzz/targets/binaryOracle';
import { iconBitmap, buildPe } from './pe/fixture';
import { buildDeb } from './pkg/debFixture';
import { buildElf } from './pkg/elfFixture';
import { buildMsi } from './pkg/msiFixture';
import { buildRpm } from './pkg/rpmFixture';

const none = new Uint8Array(0);

describe('checkPage', () => {
  it('passes the pages real executables and packages make', async () => {
    const pe = buildPe({
      version: { fileVersion: [1, 2, 3, 4] },
      icons: [
        {
          id: 1,
          width: 16,
          height: 16,
          bitCount: 32,
          data: iconBitmap({ width: 16, height: 16, bitCount: 32 }),
        },
      ],
    });
    checkPage(
      'x.exe',
      renderPeHtml(await readPe(bytesSource(pe)), { fileName: 'x.exe', sha256: 'f'.repeat(64) }),
      pe,
    );
    for (const [bytes, name] of [
      [buildElf(), 'x.so'],
      [buildRpm(), 'x.rpm'],
      [buildDeb(), 'x.deb'],
      [buildMsi(), 'x.msi'],
    ] as const) {
      const info = await readPackage(bytesSource(bytes), name);
      checkPage(
        name,
        renderPackageHtml(info, { fileName: name, fileSize: bytes.length, sha256: 'f'.repeat(64) }),
        bytes,
      );
    }
  });

  it('fails a tag, an attribute or a stray < the renderers never write', () => {
    expect(() => checkPage('x', '<p>a</p><script>1</script>', none)).toThrow(PageError);
    expect(() => checkPage('x', '<p onclick="x">a</p>', none)).toThrow(PageError);
    expect(() => checkPage('x', '<img src="javascript:1">', none)).toThrow(PageError);
    expect(() => checkPage('x', '<td>a < b</td>', none)).toThrow(PageError);
    expect(() => checkPage('x', '<div class="a&quot;b">', none)).toThrow(PageError);
    expect(() =>
      checkPage('x', '<table class="mc-info-props"><tr><td>a &lt; b</td></tr></table>', none),
    ).not.toThrow();
  });

  it('fails engine text the file does not hold, and passes it when the file does', () => {
    for (const text of [
      'function Object() { [native code] }',
      '[object Object]',
      'undefined',
      'NaN bytes',
      'Infinity',
    ]) {
      expect(() => checkPage('x', `<td>${text}</td>`, none), text).toThrow(PageError);
      expect(() =>
        checkPage('x', `<td>${text}</td>`, Buffer.from(`..${text}..`, 'latin1')),
      ).not.toThrow();
      expect(() =>
        checkPage('x', `<td>${text}</td>`, Buffer.from(`..${text}..`, 'utf16le')),
      ).not.toThrow();
    }
    // A word that merely contains one is not one.
    expect(() => checkPage('x', '<td>NaNo, Infinityx</td>', none)).not.toThrow();
  });
});

describe('startCost', () => {
  it('counts typed arrays, not only the JavaScript heap', () => {
    const before = memoryInUse();
    const held = new Uint8Array(64 * 1024 * 1024).fill(1);
    expect(memoryInUse() - before).toBeGreaterThan(60 * 1024 * 1024);
    expect(held[0]).toBe(1);
  });

  it('fails a page over the size limit and passes an ordinary one', () => {
    startCost('x', 1)('<p>ok</p>');
    expect(() => startCost('x', 1)('x'.repeat(4 * 1024 * 1024 + 1))).toThrow(CostError);
  });
});
