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

// Webview to host messages of the PDF viewer (src/pdfEditor.ts).
export type PdfMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | { type: 'openExternal' }
  // An external link clicked inside the PDF. `openExternal` above opens the
  // PDF file itself; this one carries a validated http, https or mailto URL.
  | { type: 'openLink'; url: string }
  | SaveCommentsMessage
  | RejectedCommentsMessage
  | UpdateSettingMessage;

export function parsePdfMessage(raw: unknown): PdfMessage | undefined {
  const msg = asMessage(raw);
  if (!msg) {
    return undefined;
  }
  switch (msg.type) {
    case 'ready':
    case 'revealInOS':
    case 'openExternal':
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
