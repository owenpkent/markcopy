import {
  asMessage,
  saveFrame,
  settingMessage,
  type SaveFrameMessage,
  type UpdateSettingMessage,
} from './common';
import { isImageSetting } from './settings';

// Webview to host messages of the image viewer (src/imageEditor.ts).
export type ImageMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | SaveFrameMessage
  | { type: 'openExternal' }
  | { type: 'navigate'; step: 1 | -1 }
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
      return { type: msg.type };
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
