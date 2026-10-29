import {
  asMessage,
  saveFrame,
  type Dict,
  type SaveFrameMessage,
  type UpdateSettingMessage,
} from './common';
import { isViewerSetting } from './settings';

// Webview to host messages of the video viewer (src/videoEditor.ts).
//
// The review edits carry `raw`, the page's object, rather than a narrowed shape:
// whether a note is acceptable depends on the video's duration and frame rate and
// on the notes file, which only the review session knows, and it answers every
// refused edit with a message the page is waiting for. It checks `raw` with the
// validators in src/review/validate.ts.
export type VideoMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | SaveFrameMessage
  | { type: 'openExternal' }
  | { type: 'proxyRequest' }
  | { type: 'playable' }
  | { type: 'proxyStart'; kind: 'sound' | 'picture' }
  | { type: 'proxyCancel' }
  | { type: 'reviewEnable' }
  | { type: 'reviewCopy' }
  | { type: 'reviewAdd'; raw: Dict }
  | { type: 'reviewDelete'; raw: Dict }
  | { type: 'reviewRestore'; raw: Dict }
  | UpdateSettingMessage;

export function parseVideoMessage(raw: unknown): VideoMessage | undefined {
  const msg = asMessage(raw);
  if (!msg) {
    return undefined;
  }
  switch (msg.type) {
    case 'ready':
    case 'revealInOS':
    case 'openExternal':
    case 'proxyRequest':
    case 'playable':
    case 'proxyCancel':
    case 'reviewEnable':
    case 'reviewCopy':
      return { type: msg.type };
    case 'saveFrame':
      return saveFrame(msg);
    case 'proxyStart':
      // Anything other than the explicit sound request is the picture path, so a
      // malformed message cannot select a mode the host did not expect.
      return { type: 'proxyStart', kind: msg.kind === 'sound' ? 'sound' : 'picture' };
    case 'reviewAdd':
    case 'reviewDelete':
    case 'reviewRestore':
      return { type: msg.type, raw: msg };
    case 'updateSetting':
      return typeof msg.key === 'string' && isViewerSetting(msg.key, msg.value)
        ? { type: 'updateSetting', key: msg.key, value: msg.value }
        : undefined;
    default:
      return undefined;
  }
}
