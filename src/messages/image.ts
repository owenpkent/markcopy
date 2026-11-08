import {
  asMessage,
  type Dict,
  saveFrame,
  settingMessage,
  type SaveFrameMessage,
  type UpdateSettingMessage,
} from './common';
import { isImageSetting } from './settings';

// Webview to host messages of the image viewer (src/imageEditor.ts).
//
// The note edits carry `raw`, the page's object, as the video messages do: the
// session checks it with the validators in src/review/validate.ts and answers a
// refused edit with a message the page is waiting for.
export type ImageMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | SaveFrameMessage
  | { type: 'openExternal' }
  | { type: 'navigate'; step: 1 | -1 }
  | { type: 'reviewEnable' }
  | { type: 'reviewCopy' }
  | { type: 'reviewAdd'; raw: Dict }
  | { type: 'reviewDelete'; raw: Dict }
  | { type: 'reviewRestore'; raw: Dict }
  | UpdateSettingMessage;

export function parseImageMessage(raw: unknown): ImageMessage | undefined {
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
    case 'saveFrame':
      return saveFrame(msg);
    case 'updateSetting':
      return settingMessage(msg, isImageSetting);
    case 'navigate':
      return msg.step === 1 || msg.step === -1 ? { type: 'navigate', step: msg.step } : undefined;
    default:
      return undefined;
  }
}
