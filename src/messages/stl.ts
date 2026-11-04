import {
  asMessage,
  saveFrame,
  settingMessage,
  type SaveFrameMessage,
  type UpdateSettingMessage,
} from './common';
import { isStlSetting } from './settings';

// Webview to host messages of the STL viewer (src/stlEditor.ts): the request for
// the file, plus the context menu's save, reveal, open and theme actions.
export type StlMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | SaveFrameMessage
  | { type: 'openExternal' }
  | UpdateSettingMessage;

export function parseStlMessage(raw: unknown): StlMessage | undefined {
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
      return settingMessage(msg, isStlSetting);
    default:
      return undefined;
  }
}
