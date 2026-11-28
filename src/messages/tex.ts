import {
  asMessage,
  commentsMessage,
  settingMessage,
  type RejectedCommentsMessage,
  type SaveCommentsMessage,
  type UpdateSettingMessage,
} from './common';
import { isPdfSetting } from './settings';
import { parseLinkUrl } from '../pdfLinkUrl';

// Webview to host messages of the LaTeX preview (src/texEditor.ts), which drives
// the same pdf.js webview as the PDF viewer.
export type TexMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | { type: 'openExternal' }
  | { type: 'texRecompile' }
  | { type: 'openLink'; url: string }
  | SaveCommentsMessage
  | RejectedCommentsMessage
  | UpdateSettingMessage;

export function parseTexMessage(raw: unknown): TexMessage | undefined {
  const msg = asMessage(raw);
  if (!msg) {
    return undefined;
  }
  switch (msg.type) {
    case 'ready':
    case 'revealInOS':
    case 'openExternal':
    case 'texRecompile':
      return { type: msg.type };
    case 'openLink': {
      const url = parseLinkUrl(msg.url);
      return url === undefined ? undefined : { type: 'openLink', url };
    }
    case 'saveComments':
      return commentsMessage(msg);
    case 'updateSetting':
      return settingMessage(msg, isPdfSetting);
    default:
      return undefined;
  }
}
