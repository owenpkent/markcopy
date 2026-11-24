import { Zip, ZipDeflate } from 'fflate';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, openZip, OpcError, partText } from '../src/ooxml/zip';
import { buildZip } from './pkg/zipFixture';

describe('OPC zip reader', () => {
  it('reads stored and deflated ZIP64 parts within the exact size budget', () => {
    const zip = buildZip(
      [
        { name: '\\word\\media\\note.txt', data: 'stored' },
        { name: 'word/document.xml', data: '<doc/>', method: 8 },
      ],
      { zip64: true, comment: 'preview' },
    );
    const wrapped = new Uint8Array(zip.length + 2);
    wrapped.set(zip, 1);
    const parts = openZip(wrapped.subarray(1, -1), {
      limits: { ...DEFAULT_LIMITS, maxEntries: 2, maxEntryBytes: 6, maxTotalBytes: 12 },
    });
    expect(partText(parts, 'word/media/note.txt')).toBe('stored');
    expect(partText(parts, 'word/document.xml')).toBe('<doc/>');
  });

  it('inflates a streamed entry with a data descriptor across input chunks', () => {
    const chunks: Uint8Array[] = [];
    const writer = new Zip((err, chunk) => {
      if (err) {
        throw err;
      }
      chunks.push(chunk);
    });
    // Deflate level 0 emits DEFLATE stored blocks, including a block that
    // needs several input pushes before producing any output.
    const data = new Uint8Array(18 * 1024).fill(42);
    const file = new ZipDeflate('stream', { level: 0 });
    writer.add(file);
    file.push(data, true);
    writer.end();
    expect(openZip(Buffer.concat(chunks)).get('stream')).toEqual(data);
  });

  it.each([0, 8] as const)('refuses an understated size for compression method %i', (method) => {
    const zip = buildZip([{ name: 'part', data: 'decoded content', method, declaredSize: 1 }]);
    expect(() => openZip(zip)).toThrow(OpcError);
    expect(() => openZip(zip)).toThrow(/stored size|declared size/);
  });

  it('counts each part toward the declared total, including duplicate names', () => {
    const zip = buildZip([
      { name: 'part', data: 'first', method: 8 },
      { name: 'part', data: 'second', method: 8 },
    ]);
    expect(() => openZip(zip, { limits: { ...DEFAULT_LIMITS, maxTotalBytes: 10 } })).toThrow(
      /expands to more data/,
    );
  });

  it('refuses overlapping local entry ranges', () => {
    const zip = buildZip([
      { name: 'first', data: 'first', method: 8 },
      { name: 'other', data: 'other', method: 8, declaredOffset: 0 },
    ]);
    expect(() => openZip(zip)).toThrow(/overlaps another part/);
  });
});
