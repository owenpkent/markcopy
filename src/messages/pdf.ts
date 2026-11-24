import {
  asMessage,
  commentsMessage,
  settingMessage,
  type RejectedCommentsMessage,
  type SaveCommentsMessage,
  type UpdateSettingMessage,
} from './common';
import { isPdfSetting } from './settings';

// Webview to host messages of the PDF viewer (src/pdfEditor.ts).
export type PdfMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | { type: 'openExternal' }
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
    case 'saveComments':
      return commentsMessage(msg);
    case 'updateSetting':
      return settingMessage(msg, isPdfSetting);
    default:
      return undefined;
  }
}
