// @vitest-environment node
//
// readPackage with real fixtures for the formats that are finished. Which reader
// a magic number reaches, for every format, is in tests/pkg/dispatchRouting.test.ts
// (it mocks the readers, so it needs its own file).
import { describe, expect, it } from 'vitest';
import { bytesSource } from '../../src/binary/reader';
import { PackageError, readPackage } from '../../src/pkg';
import { buildDmg } from './dmgFixture';
import { buildElf } from './elfFixture';
import { buildMsi } from './msiFixture';
import { buildXar } from './xarFixture';

const read = (bytes: Uint8Array, name: string) => readPackage(bytesSource(bytes), name);

describe('readPackage: files it cannot identify', () => {
  it('rejects an empty file with a PackageError that says so', async () => {
    const err = await read(new Uint8Array(0), 'a.deb').catch((e) => e);
    expect(err).toBeInstanceOf(PackageError);
    expect(err.message).toBe('it is empty.');
  });

  it('rejects an unrecognised file with a PackageError that says so', async () => {
    const err = await read(new TextEncoder().encode('just some plain text\n'), 'a.deb').catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(PackageError);
    expect(err.message).toBe('it is not a package format this preview reads.');
  });

  it('rejects a one-byte file the same way, not with a RangeError', async () => {
    await expect(read(Uint8Array.of(0x7f), 'a.so')).rejects.toBeInstanceOf(PackageError);
  });

  it('does not take a gzip file for an Alpine package unless it is named .apk', async () => {
    const gzip = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3);
    const err = await read(gzip, 'archive.tar.gz').catch((e) => e);
    expect(err).toBeInstanceOf(PackageError);
    expect(err.message).toBe('it is not a package format this preview reads.');
  });
});

describe('readPackage: routing by content, with a real file', () => {
  it('reads an ELF file as ELF, whatever it is named', async () => {
    const info = await read(buildElf(), 'libdemo.so.1');
    expect(info.format).toMatch(/^ELF|Linux|AppImage/);
    const again = await read(buildElf(), 'notes.txt');
    expect(again.format).toBe(info.format);
  });

  it('reads a Windows Installer database as one, whatever it is named', async () => {
    const info = await read(buildMsi(), 'Setup.bin');
    expect(info.format).toBe('Windows Installer package');
  });

  it('reads a macOS installer package as a xar archive', async () => {
    const info = await read(buildXar(), 'thing.pkg');
    expect(info.format).toMatch(/xar archive|macOS installer package/);
  });

  it('finds a disk image by its trailer, whatever it is named', async () => {
    const info = await read(buildDmg(), 'image.bin');
    expect(info.format).toBe('Apple disk image');
  });
});
