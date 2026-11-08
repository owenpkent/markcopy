// @vitest-environment node
//
// Host-side coverage for the audio viewer: the extension predicate, the folder
// stepping helpers it shares with the image viewer, its webview message parser,
// and the pure helpers the webview uses.
import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: vi.fn() },
  workspace: {},
  window: {},
}));

import { isAudioFile } from '../src/audioEditor';
import { sortedFiles, stepFile, hasExtension } from '../src/folderNav';
import { parseAudioMessage } from '../src/messages/audio';
import {
  describeAudioError,
  positionReadout,
  seekTarget,
  stepSpeed,
} from '../src/webview/audioInfo';

describe('audio folder navigation', () => {
  it('keeps only the extensions the viewer opens, in any case', () => {
    for (const name of ['a.mp3', 'b.WAV', 'c.ogg', 'd.oga', 'e.opus', 'f.FLAC', 'g.m4a', 'h.aac']) {
      expect(isAudioFile(name)).toBe(true);
    }
    expect(isAudioFile('clip.mp4')).toBe(false);
    expect(isAudioFile('notes.md')).toBe(false);
    expect(isAudioFile('.mp3')).toBe(false);
    expect(hasExtension('x.png', ['png'])).toBe(true);
  });

  it('sorts like the Explorer with an audio predicate', () => {
    expect(
      sortedFiles(
        ['take10.wav', 'cover.png', 'Take2.mp3', 'take1.flac'],
        'take1.flac',
        isAudioFile,
      ),
    ).toEqual(['take1.flac', 'Take2.mp3', 'take10.wav']);
  });

  it('always includes the current file, and a lone file stays put', () => {
    expect(sortedFiles([], 'solo.ogg', isAudioFile)).toEqual(['solo.ogg']);
    expect(stepFile(['solo.ogg'], 'solo.ogg', 1)).toBe('solo.ogg');
    expect(stepFile(['solo.ogg'], 'solo.ogg', -1)).toBe('solo.ogg');
  });

  it('wraps at both ends', () => {
    const files = ['a.mp3', 'b.mp3', 'c.mp3'];
    expect(stepFile(files, 'a.mp3', 1)).toBe('b.mp3');
    expect(stepFile(files, 'c.mp3', 1)).toBe('a.mp3');
    expect(stepFile(files, 'a.mp3', -1)).toBe('c.mp3');
    expect(stepFile(files, 'gone.mp3', 1)).toBe('gone.mp3');
  });
});

describe('audio message parser', () => {
  it('accepts the messages the viewer sends', () => {
    expect(parseAudioMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseAudioMessage({ type: 'openExternal' })).toEqual({ type: 'openExternal' });
    expect(parseAudioMessage({ type: 'navigate', step: 1 })).toEqual({ type: 'navigate', step: 1 });
    expect(parseAudioMessage({ type: 'navigate', step: -1 })).toEqual({
      type: 'navigate',
      step: -1,
    });
  });

  it('accepts the Audio Notes messages, the edits carrying the page object', () => {
    expect(parseAudioMessage({ type: 'reviewEnable' })).toEqual({ type: 'reviewEnable' });
    expect(parseAudioMessage({ type: 'reviewCopy' })).toEqual({ type: 'reviewCopy' });
    const add = { type: 'reviewAdd', at: 1, text: 'x' };
    expect(parseAudioMessage(add)).toEqual({ type: 'reviewAdd', raw: add });
    expect(parseAudioMessage({ type: 'reviewDelete', id: 'n1' })).toEqual({
      type: 'reviewDelete',
      raw: { type: 'reviewDelete', id: 'n1' },
    });
    expect(parseAudioMessage({ type: 'reviewRestore' })).toMatchObject({ type: 'reviewRestore' });
  });

  it('lets the page write audio.showTags, loop and autoplay as booleans', () => {
    for (const key of ['audio.showTags', 'audio.loop', 'audio.autoplay']) {
      expect(parseAudioMessage({ type: 'updateSetting', key, value: true })).toEqual({
        type: 'updateSetting',
        key,
        value: true,
      });
      expect(parseAudioMessage({ type: 'updateSetting', key, value: 'yes' })).toBeUndefined();
    }
  });

  it('lets the page write audio.review and nothing else', () => {
    expect(parseAudioMessage({ type: 'updateSetting', key: 'audio.review', value: true })).toEqual({
      type: 'updateSetting',
      key: 'audio.review',
      value: true,
    });
    expect(
      parseAudioMessage({ type: 'updateSetting', key: 'audio.review', value: 'yes' }),
    ).toBeUndefined();
    expect(
      parseAudioMessage({ type: 'updateSetting', key: 'video.ffmpegPath', value: 'x' }),
    ).toBeUndefined();
  });

  it('refuses anything else', () => {
    expect(parseAudioMessage({ type: 'navigate', step: 2 })).toBeUndefined();
    expect(
      parseAudioMessage({ type: 'updateSetting', key: 'audio.ffmpegPath', value: 'x' }),
    ).toBeUndefined();
    expect(parseAudioMessage('ready')).toBeUndefined();
    expect(parseAudioMessage(null)).toBeUndefined();
  });
});

describe('audio pure helpers', () => {
  it('formats the position readout, with hours from one hour up', () => {
    expect(positionReadout(65, 225)).toBe('1:05 / 3:45');
    expect(positionReadout(3725, 7200)).toBe('1:02:05 / 2:00:00');
    expect(positionReadout(0, NaN)).toBe('0:00 / --:--');
  });

  it('clamps a seek to the file', () => {
    expect(seekTarget(10, -20, 100)).toBe(0);
    expect(seekTarget(90, 30, 100)).toBe(100);
    expect(seekTarget(10, 30, NaN)).toBe(40);
  });

  it('steps the speed ladder and stops at the ends', () => {
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(1, -1)).toBe(0.75);
    expect(stepSpeed(2, 1)).toBe(2);
    expect(stepSpeed(0.5, -1)).toBe(0.5);
  });

  it('words the decode error with the extension', () => {
    expect(describeAudioError('a.m4a')).toMatch(/\.m4a.*AAC/);
    expect(describeAudioError('a.flac')).toMatch(/\.flac.*cannot decode/);
  });
});
