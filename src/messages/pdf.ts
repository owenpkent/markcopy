import {
  asMessage,
  updateSetting,
  type SaveCommentsMessage,
  type UpdateSettingMessage,
} from './common';

// Webview to host messages of the PDF viewer (src/pdfEditor.ts).
export type PdfMessage =
  { type: 'ready' } | { type: 'revealInOS' } | SaveCommentsMessage | UpdateSettingMessage;

export function parsePdfMessage(raw: unknown): PdfMessage | undefined {
  const msg = asMessage(raw);
  if (!msg) {
    return undefined;
  }
  switch (msg.type) {
    case 'ready':
    case 'revealInOS':
      return { type: msg.type };
    case 'saveComments':
      return { type: 'saveComments', comments: msg.comments };
    case 'updateSetting':
      return updateSetting(msg);
    default:
      return undefined;
  }
}
