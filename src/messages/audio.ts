import { asMessage, settingMessage, type Dict, type UpdateSettingMessage } from './common';
import { isAudioSetting } from './settings';

// Webview to host messages of the audio viewer (src/audioEditor.ts). The review
// edits carry `raw`, the page's object, as the video and image viewers' do: the
// session checks it with the validators in src/review/validate.ts and answers a
// refused edit with a `reviewError`.
export type AudioMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | { type: 'openExternal' }
  | { type: 'navigate'; step: 1 | -1 }
  | { type: 'reviewEnable' }
  | { type: 'reviewCopy' }
  | { type: 'reviewAdd'; raw: Dict }
  | { type: 'reviewDelete'; raw: Dict }
  | { type: 'reviewRestore'; raw: Dict }
  | UpdateSettingMessage;

export type { AudioDetails, AudioDetailsMessage, AudioTagKey } from './audioDetails';

export function parseAudioMessage(raw: unknown): AudioMessage | undefined {
  const msg = asMessage(raw);
  if (!msg) {
    return undefined;
  }
  switch (msg.type) {
    case 'ready':
    case 'revealInOS':
    case 'openExternal':
    case 'reviewEnable':
    case 'reviewCopy':
      return { type: msg.type };
    case 'reviewAdd':
    case 'reviewDelete':
    case 'reviewRestore':
      return { type: msg.type, raw: msg };
    case 'updateSetting':
      return settingMessage(msg, isAudioSetting);
    case 'navigate':
      return msg.step === 1 || msg.step === -1 ? { type: 'navigate', step: msg.step } : undefined;
    default:
      return undefined;
  }
}
