// @vitest-environment node
//
// Which reader readPackage hands a file to, decided by its leading bytes alone.
// Every reader is replaced by a stub that answers with its own name, so a
// magic-byte stub is enough and a reader that is still being written cannot
// change the result. The readers themselves are tested in their own files, and
// readPackage on real fixtures in tests/pkg/dispatch.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const looksLikeDmg = vi.hoisted(() => vi.fn());
const readZipPackage = vi.hoisted(() => vi.fn());

const marker = (format: string) => ({ format, sections: [], warnings: [] });

vi.mock('../../src/pkg/deb', () => ({ readDeb: vi.fn(async () => marker('deb')) }));
vi.mock('../../src/pkg/rpm', () => ({ readRpm: vi.fn(async () => marker('rpm')) }));
vi.mock('../../src/pkg/alpine', () => ({ readAlpineApk: vi.fn(async () => marker('alpine')) }));
vi.mock('../../src/pkg/elf', () => ({ readElf: vi.fn(async () => marker('elf')) }));
vi.mock('../../src/pkg/msi', () => ({ readMsi: vi.fn(async () => marker('msi')) }));
vi.mock('../../src/pkg/xar', () => ({ readXar: vi.fn(async () => marker('xar')) }));
vi.mock('../../src/pkg/dmg', () => ({
  looksLikeDmg,
  readDmg: vi.fn(async () => marker('dmg')),
}));
vi.mock('../../src/pkg/zipFormats', () => ({ readZipPackage }));

import { bytesSource } from '../../src/binary/reader';
import { PackageError, readPackage } from '../../src/pkg';

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

// `lead` followed by zero padding, so the reader sees a file longer than its magic.
function file(lead: number[], length = 64): Uint8Array {
  const out = new Uint8Array(length);
  out.set(lead);
  return out;
}

const route = async (lead: number[], name = 'file.bin', length?: number): Promise<string> =>
  (await readPackage(bytesSource(file(lead, length)), name)).format;

beforeEach(() => {
  looksLikeDmg.mockReset().mockResolvedValue(false);
  readZipPackage.mockReset().mockImplementation(async () => marker('zip'));
});

describe('readPackage routing by magic bytes', () => {
  it('sends an ELF file to the ELF reader whatever it is named', async () => {
    expect(await route([0x7f, 0x45, 0x4c, 0x46], 'libdemo.so.1')).toBe('elf');
    expect(await route([0x7f, 0x45, 0x4c, 0x46], 'notes.txt')).toBe('elf');
  });

  it('sends an RPM lead to the RPM reader', async () => {
    expect(await route([0xed, 0xab, 0xee, 0xdb], 'x.rpm')).toBe('rpm');
  });

  it('sends an ar archive to the Debian reader', async () => {
    expect(await route(ascii('!<arch>\n'), 'x.deb')).toBe('deb');
  });

  it('does not take a near miss of the ar magic for one', async () => {
    await expect(route(ascii('!<arch>X'), 'x.deb')).rejects.toBeInstanceOf(PackageError);
  });

  it('sends the compound file magic to the Windows Installer reader', async () => {
    expect(await route([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 'x.msi')).toBe('msi');
  });

  it('sends xar! to the xar reader', async () => {
    expect(await route(ascii('xar!'), 'x.pkg')).toBe('xar');
  });

  it('sends both zip signatures to the zip reader', async () => {
    expect(await route([0x50, 0x4b, 0x03, 0x04], 'x.jar')).toBe('zip');
    expect(await route([0x50, 0x4b, 0x05, 0x06], 'x.whl')).toBe('zip');
  });

  it('does not take a zip spanning marker (PK\\x07\\x08) for a zip', async () => {
    await expect(route([0x50, 0x4b, 0x07, 0x08], 'x.jar')).rejects.toBeInstanceOf(PackageError);
  });

  it('passes the file name to the zip reader, which decides the flavour from it', async () => {
    await route([0x50, 0x4b, 0x03, 0x04], 'Tool-1.0.vsix');
    expect(readZipPackage).toHaveBeenCalledTimes(1);
    expect(readZipPackage.mock.calls[0][1]).toBe('Tool-1.0.vsix');
  });

  it('sends gzip named .apk, in either case, to the Alpine reader', async () => {
    expect(await route([0x1f, 0x8b, 8], 'busybox-1.36.apk')).toBe('alpine');
    expect(await route([0x1f, 0x8b, 8], 'BUSYBOX.APK')).toBe('alpine');
  });

  it('rejects gzip with any other name', async () => {
    for (const name of ['archive.tar.gz', 'x.apk.gz', 'apk', 'x.apkx']) {
      await expect(route([0x1f, 0x8b, 8], name)).rejects.toBeInstanceOf(PackageError);
    }
  });

  it('prefers a magic number to the name: a zip named .apk goes to the zip reader', async () => {
    expect(await route([0x50, 0x4b, 0x03, 0x04], 'app.apk')).toBe('zip');
  });
});

describe('readPackage and the disk image trailer', () => {
  it('asks the DMG reader last and uses it when it says yes', async () => {
    looksLikeDmg.mockResolvedValue(true);
    expect(await route([1, 2, 3, 4], 'x.dmg')).toBe('dmg');
    expect(looksLikeDmg).toHaveBeenCalledTimes(1);
  });

  it('rejects the file when the trailer check says no', async () => {
    looksLikeDmg.mockResolvedValue(false);
    await expect(route([1, 2, 3, 4], 'x.dmg')).rejects.toThrow(
      'it is not a package format this preview reads.',
    );
    expect(looksLikeDmg).toHaveBeenCalledTimes(1);
  });

  it('does not ask about a trailer for a file that has a leading magic', async () => {
    await route([0x7f, 0x45, 0x4c, 0x46]);
    await route(ascii('xar!'));
    expect(looksLikeDmg).not.toHaveBeenCalled();
  });
});

describe('readPackage on files too short to hold a magic number', () => {
  it('rejects an empty file before any reader runs', async () => {
    looksLikeDmg.mockResolvedValue(true);
    const err = await readPackage(bytesSource(new Uint8Array(0)), 'a.deb').catch((e) => e);
    expect(err).toBeInstanceOf(PackageError);
    expect(err.message).toBe('it is empty.');
    expect(looksLikeDmg).not.toHaveBeenCalled();
  });

  it('treats a one-byte file as unrecognised, not as a crash', async () => {
    await expect(route([0x7f], 'a.so', 1)).rejects.toBeInstanceOf(PackageError);
    await expect(route([0x1f], 'a.apk', 1)).rejects.toBeInstanceOf(PackageError);
    expect(looksLikeDmg).toHaveBeenCalled();
  });

  it('does not route a file that holds only the first bytes of a longer magic', async () => {
    await expect(route([0x50, 0x4b], 'a.jar', 2)).rejects.toBeInstanceOf(PackageError);
    await expect(route(ascii('!<arch>'), 'a.deb', 7)).rejects.toBeInstanceOf(PackageError);
  });
});
