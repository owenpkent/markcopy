import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bytesSource } from '../src/binary/reader';
import { readPackage } from '../src/pkg';
import { apkOf, fuzz } from '../fuzz/targets/dex.fuzz';

const CORPUS = join(__dirname, '../fuzz/corpus/dex');
const MODES = 3;

describe('dex fuzz target', () => {
  it('accepts a real seed, junk, and an empty input without throwing', async () => {
    await fuzz(readFileSync(join(CORPUS, 'valid')));
    await fuzz(Buffer.alloc(0));
    await fuzz(Buffer.alloc(4096, 0x41));
    await fuzz(Buffer.alloc(4096, 0xff));
  });

  // The zip must hold an AndroidManifest.xml, or the package reader lists a plain zip
  // and never reaches the DEX files.
  it('builds an Android package whose DEX files and digests are read, in every mode', async () => {
    for (const mode of [0, 1, 2]) {
      const seed = readFileSync(join(CORPUS, 'valid'));
      const info = await readPackage(bytesSource(apkOf(seed.subarray(1), mode)), 'fuzz.apk');
      expect(info.format).toBe('Android package (APK)');
      const dex = info.sections.find((s) => s.heading === 'DEX files');
      expect(dex).toBeDefined();
      const text = JSON.stringify(dex);
      expect(text).toContain('classes.dex Adler-32 check');
      expect(text).toContain('classes.dex SHA-1 check');
      expect(text).toContain('The computed Adler-32 matches the stored checksum.');
      expect(text.includes('(multidex)')).toBe(mode === 2);
    }
  });

  it('reads every committed seed as an Android package', async () => {
    for (const name of readdirSync(CORPUS)) {
      const seed = readFileSync(join(CORPUS, name));
      const info = await readPackage(
        bytesSource(apkOf(seed.subarray(1), seed[0] % MODES)),
        'fuzz.apk',
      );
      expect(info.format, name).toBe('Android package (APK)');
    }
  });
});
