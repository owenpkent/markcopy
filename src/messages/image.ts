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
    default:
      return undefined;
  }
}
