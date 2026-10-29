import {
  asMessage,
  exportMessage,
  updateSetting,
  type ExportMessage,
  type UpdateSettingMessage,
} from './common';

// Webview to host messages of the spreadsheet, deck and Word previews
// (src/ooxmlEditor.ts and the sessions built on it).
export type OoxmlMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | ExportMessage
  | UpdateSettingMessage
  | { type: 'openSettings' }
  | { type: 'toast'; text: unknown }
  | { type: 'openLink'; href: string }
  | { type: 'selectSheet'; index: number };

export function parseOoxmlMessage(raw: unknown): OoxmlMessage | undefined {
  const msg = asMessage(raw);
  if (!msg) {
    return undefined;
  }
  switch (msg.type) {
    case 'ready':
    case 'revealInOS':
    case 'openSettings':
      return { type: msg.type };
    case 'pdfHtml':
    case 'docxXhtml':
    case 'pptxXhtml':
      return exportMessage(msg);
    case 'updateSetting':
      return updateSetting(msg);
    case 'toast':
      return { type: 'toast', text: msg.text };
    case 'openLink':
      return typeof msg.href === 'string' ? { type: 'openLink', href: msg.href } : undefined;
    case 'selectSheet': {
      const index = Number(msg.index);
      return Number.isInteger(index) && index >= 0 ? { type: 'selectSheet', index } : undefined;
    }
    default:
      return undefined;
  }
}
