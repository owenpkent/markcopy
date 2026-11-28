// @vitest-environment node
//
// The second reading failing must not fail the page: the notice stays and one
// line says why the other format could not be read.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/pkg/zipFormats', () => ({
  readZipPackage: vi.fn(async () => {
    throw new (await import('../../src/binary/reader')).ReadError('its directory is damaged.');
  }),
}));

import { bytesSource } from '../../src/binary/reader';
import { readPackage, renderPackageHtml } from '../../src/pkg';
import { buildMsi } from './msiFixture';
import { buildZip } from './zipFixture';

describe('a second reading that fails', () => {
  it('keeps the first reading and the notice, and says why the second is missing', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'hello' }]);
    const msi = buildMsi();
    const bytes = new Uint8Array(msi.length + zip.length);
    bytes.set(msi);
    bytes.set(zip, msi.length);
    const info = await readPackage(bytesSource(bytes), 'x.msi');
    expect(info.format).toBe('Windows Installer package');
    expect(info.also?.info).toBeUndefined();
    expect(info.also?.error).toBe('its directory is damaged.');
    const html = renderPackageHtml(info, { fileName: 'x.msi', fileSize: bytes.length });
    expect(html).toContain('structure of two formats: Windows Installer package and zip archive.');
    expect(html).not.toContain('Both readings are shown below');
    expect(html).toContain('It could not be read as zip archive: its directory is damaged.');
  });
});
