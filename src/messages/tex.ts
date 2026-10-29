import {
  asMessage,
  updateSetting,
  type SaveCommentsMessage,
  type UpdateSettingMessage,
} from './common';

// Webview to host messages of the LaTeX preview (src/texEditor.ts), which drives
// the same pdf.js webview as the PDF viewer.
export type TexMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | { type: 'texRecompile' }
  | SaveCommentsMessage
  | UpdateSettingMessage;

export function parseTexMessage(raw: unknown): TexMessage | undefined {
  const msg = asMessage(raw);
  if (!msg) {
    return undefined;
  }
  switch (msg.type) {
    case 'ready':
    case 'revealInOS':
    case 'texRecompile':
      return { type: msg.type };
    case 'saveComments':
      return { type: 'saveComments', comments: msg.comments };
    case 'updateSetting':
      return updateSetting(msg);
    default:
      return undefined;
  }
}
