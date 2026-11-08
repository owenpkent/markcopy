import { describe, expect, it } from 'vitest';
import { fuzz } from '../fuzz/targets/messages.fuzz';

// The harness restates, by hand, which message types each surface handles. Found
// by the nightly fuzzer (#207): the image surface's list predated Image Notes and
// folder stepping, so a valid `reviewDelete` read as a loosened parser. Every type
// the image and audio viewers really send must pass the harness.
const json = (msg: unknown) => Buffer.from(JSON.stringify(msg));

describe('messages fuzz target', () => {
  it('replays the #207 crash input without failing', () => {
    expect(() => fuzz(Buffer.from('6+s=', 'base64'))).not.toThrow();
  });

  const valid: unknown[] = [
    { type: 'navigate', step: 1 },
    { type: 'navigate', step: -1 },
    { type: 'reviewEnable' },
    { type: 'reviewCopy' },
    { type: 'reviewAdd', at: 0, text: 'note' },
    { type: 'reviewDelete', id: 'n1' },
    { type: 'reviewRestore', id: 'n1' },
    { type: 'updateSetting', key: 'image.review', value: true },
    { type: 'updateSetting', key: 'audio.review', value: true },
    { type: 'updateSetting', key: 'audio.loop', value: false },
    { type: 'updateSetting', key: 'audio.autoplay', value: true },
    { type: 'updateSetting', key: 'audio.showTags', value: true },
  ];
  for (const msg of valid) {
    it('accepts ' + JSON.stringify(msg), () => {
      expect(() => fuzz(json(msg))).not.toThrow();
    });
  }
});
