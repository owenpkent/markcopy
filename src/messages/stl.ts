import {
  asMessage,
  saveFrame,
  settingMessage,
  type SaveFrameMessage,
  type UpdateSettingMessage,
} from './common';
import { isStlSetting } from './settings';

// Webview to host messages of the STL and 3MF viewer (src/stlEditor.ts): the
// request for the file, the context menu's save, reveal, open and settings
// actions, and the request for a second model to compare against. `compare`
// carries a name, never a path: the host only opens one it offered itself.
export type StlMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | SaveFrameMessage
  | { type: 'openExternal' }
  | { type: 'openAsText' }
  | { type: 'compare'; name: string }
  | { type: 'compareBrowse' }
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
    case 'openAsText':
    case 'compareBrowse':
      return { type: msg.type };
    case 'compare':
      return typeof msg.name === 'string' && msg.name.length > 0 && msg.name.length <= 1024
        ? { type: 'compare', name: msg.name }
        : undefined;
    case 'saveFrame':
      return saveFrame(msg);
    case 'updateSetting':
      return settingMessage(msg, isStlSetting);
    default:
      return undefined;
  }
}
