// @vitest-environment node
//
// A comments sidecar that only partly loads must not be overwritten by the next
// save, or every note in it is lost. These pin that, and the warnings.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  read: vi.fn(),
  replace: vi.fn(async () => undefined),
  warn: vi.fn(async () => undefined),
}));

vi.mock('vscode', () => ({
  Uri: { joinPath: vi.fn(), file: vi.fn() },
  workspace: { getConfiguration: () => ({ get: () => undefined }), fs: {} },
  window: { showWarningMessage: host.warn },
  commands: {},
}));
vi.mock('../src/documentFile', () => ({
  MAX_PDF_BYTES: 1,
  readDocument: host.read,
}));
vi.mock('../src/sidecarFile', () => ({
  missing: (err: unknown) => (err as { code?: string })?.code === 'ENOENT',
  replaceSidecar: host.replace,
}));

import { readComments, writeComments } from '../src/pdfEditor';

const comment = { id: 'c1', page: 1, xPct: 0.5, yPct: 0.5, text: 'A note' };
let n = 0;
const fresh = () => {
  const key = `file:///doc${++n}.pdf.mccomments.json`;
  return { toString: () => key } as never;
};
const file = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('comments sidecar protection', () => {
  beforeEach(() => {
    host.read.mockReset();
    host.replace.mockClear();
    host.warn.mockClear();
  });

  it('treats a missing file as empty and still saves', async () => {
    const uri = fresh();
    host.read.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect(await readComments(uri)).toEqual([]);
    await writeComments(uri, [comment]);
    expect(host.warn).not.toHaveBeenCalled();
    expect(host.replace).toHaveBeenCalledTimes(1);
  });

  it('loads the valid entries of a partly invalid file, warns once, and refuses to save', async () => {
    const uri = fresh();
    host.read.mockResolvedValue(file([comment, { ...comment, id: 'c2', page: 0 }]));
    expect(await readComments(uri)).toEqual([comment]);
    expect(await readComments(uri)).toEqual([comment]);
    expect(host.warn).toHaveBeenCalledTimes(1);
    expect(host.warn.mock.calls[0][0]).toContain('Comment saving is off');

    await writeComments(uri, [comment]);
    await writeComments(uri, []);
    expect(host.replace).not.toHaveBeenCalled();
  });

  it('protects a file that is not valid JSON', async () => {
    const uri = fresh();
    host.read.mockResolvedValue(Buffer.from('{ not json'));
    expect(await readComments(uri)).toEqual([]);
    await writeComments(uri, [comment]);
    expect(host.warn).toHaveBeenCalledTimes(1);
    expect(host.replace).not.toHaveBeenCalled();
  });

  it('saves again once the file loads cleanly', async () => {
    const uri = fresh();
    host.read.mockResolvedValueOnce(file([{ nope: true }]));
    await readComments(uri);
    host.read.mockResolvedValueOnce(file([comment]));
    expect(await readComments(uri)).toEqual([comment]);
    await writeComments(uri, [comment]);
    expect(host.replace).toHaveBeenCalledTimes(1);
  });

  it('warns instead of silently dropping an invalid save', async () => {
    await writeComments(fresh(), [{ ...comment, text: 'x'.repeat(16_385) }]);
    expect(host.warn).toHaveBeenCalledTimes(1);
    expect(host.replace).not.toHaveBeenCalled();
  });
});
