// @vitest-environment node
//
// What data appended to an executable reads as, in the executable preview.
import { describe, expect, it } from 'vitest';
import { runFileInfoTask } from '../../src/fileInfoTask';
import { renderPeHtml, type PeInfo } from '../../src/pe';
import { buildZip } from '../pkg/zipFixture';
import { buildPe } from './fixture';

const join = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
const zip = buildZip([{ name: 'a.txt', data: 'hello' }]);

async function exe(bytes: Uint8Array): Promise<PeInfo> {
  const result = await runFileInfoTask({ kind: 'exe', fileName: 'setup.exe', bytes });
  if (!result.ok || result.kind !== 'exe') {
    throw new Error('not read');
  }
  return result.info;
}

describe('an executable with a zip appended', () => {
  it('says what the appended data reads as and shows the reading', async () => {
    const info = await exe(join(buildPe(), zip));
    expect(info.appended?.matches[0].format).toBe('zip archive');
    const html = renderPeHtml(info, { fileName: 'setup.exe' });
    expect(html).toContain(
      'This file has the structure of two formats: Windows executable and zip archive.',
    );
    expect(html).toContain('Also read as: zip archive');
    expect(html).toContain('It has the structure of a zip archive');
  });

  it('adds nothing when the appended data is not a zip', async () => {
    const info = await exe(join(buildPe(), new Uint8Array(500).fill(7)));
    expect(info.overlay).toBeDefined();
    expect(info.appended).toBeUndefined();
    expect(renderPeHtml(info, { fileName: 'setup.exe' })).not.toContain('Also read as');
  });

  it('adds nothing for an executable with no appended data', async () => {
    const info = await exe(buildPe());
    expect(info.appended).toBeUndefined();
  });
});
