// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommand = vi.hoisted(() => vi.fn());
const setStatusBarMessage = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  commands: { executeCommand },
  window: { setStatusBarMessage },
}));

import { revealInOs } from '../src/revealInOs';

beforeEach(() => {
  executeCommand.mockClear();
  setStatusBarMessage.mockClear();
});

describe('revealInOs', () => {
  it('reveals a file on disk', () => {
    const uri = { scheme: 'file' };
    revealInOs(uri as never);
    expect(executeCommand).toHaveBeenCalledWith('revealFileInOS', uri);
    expect(setStatusBarMessage).not.toHaveBeenCalled();
  });

  it('says so instead for a document that is not on disk', () => {
    revealInOs({ scheme: 'untitled' } as never);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(setStatusBarMessage).toHaveBeenCalledOnce();
  });
});
