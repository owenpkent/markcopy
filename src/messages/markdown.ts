import { isGridOp, type GridOp } from '../csv';
import {
  asMessage,
  exportMessage,
  settingMessage,
  toastMessage,
  type ExportMessage,
  type ToastMessage,
  type UpdateSettingMessage,
} from './common';
import { isPreviewSetting } from './settings';

// Webview to host messages of the Markdown and CSV preview (src/extension.ts).
export type MarkdownMessage =
  | { type: 'revealInOS' }
  | { type: 'revealLine'; line: number }
  | ToastMessage
  | UpdateSettingMessage
  | { type: 'openSettings' }
  | { type: 'openLink'; href: string }
  | ExportMessage
  | { type: 'editCell'; line: number; column: number; value: string; docVersion?: number }
  | { type: 'gridOp'; op: GridOp; line: number; column: number; docVersion?: number }
  | {
      type: 'editBlock';
      editId?: number;
      // Checked by editTargetsDocument and planBlockEdit, which also decide how
      // the webview is told an edit was refused: an invalid one is still answered.
      docKey: unknown;
      startLine: unknown;
      endLine: unknown;
      original: unknown;
      text: unknown;
    };

export function parseMarkdownMessage(raw: unknown): MarkdownMessage | undefined {
  const msg = asMessage(raw);
  if (!msg) {
    return undefined;
  }
  switch (msg.type) {
    case 'revealInOS':
    case 'openSettings':
      return { type: msg.type };
    case 'revealLine':
      // revealEditorLine ignores anything that is not a finite number.
      return typeof msg.line === 'number' && Number.isFinite(msg.line)
        ? { type: 'revealLine', line: msg.line }
        : undefined;
    case 'toast':
      return toastMessage(msg);
    case 'updateSetting':
      return settingMessage(msg, isPreviewSetting);
    case 'openLink':
      return typeof msg.href === 'string' ? { type: 'openLink', href: msg.href } : undefined;
    case 'pdfHtml':
    case 'docxXhtml':
    case 'pptxXhtml':
      return exportMessage(msg);
    case 'editCell': {
      const line = Number(msg.line);
      const column = Number(msg.column);
      if (!Number.isInteger(line) || !Number.isInteger(column) || typeof msg.value !== 'string') {
        return undefined;
      }
      return {
        type: 'editCell',
        line,
        column,
        value: msg.value,
        ...(typeof msg.docVersion === 'number' ? { docVersion: msg.docVersion } : {}),
      };
    }
    case 'gridOp': {
      const line = Number(msg.line);
      const column = Number(msg.column);
      if (!isGridOp(msg.op) || !Number.isInteger(line) || !Number.isInteger(column)) {
        return undefined;
      }
      return {
        type: 'gridOp',
        op: msg.op,
        line,
        column,
        ...(typeof msg.docVersion === 'number' ? { docVersion: msg.docVersion } : {}),
      };
    }
    case 'editBlock':
      return {
        type: 'editBlock',
        ...(Number.isSafeInteger(msg.editId) ? { editId: msg.editId as number } : {}),
        docKey: msg.docKey,
        startLine: msg.startLine,
        endLine: msg.endLine,
        original: msg.original,
        text: msg.text,
      };
    default:
      return undefined;
  }
}
