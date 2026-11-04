import {
  asMessage,
  saveFrame,
  settingMessage,
  type SaveFrameMessage,
  type UpdateSettingMessage,
} from './common';
import { isGifSetting } from './settings';

// Webview to host messages of the GIF viewer (src/gifEditor.ts).
export type GifMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | SaveFrameMessage
  | { type: 'openExternal' }
  | UpdateSettingMessage;

export function parseGifMessage(raw: unknown): GifMessage | undefined {
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
      return settingMessage(msg, isGifSetting);
    default:
      return undefined;
  }
}
