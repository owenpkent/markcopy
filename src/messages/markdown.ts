import { isGridOp, type GridOp } from '../csv';
import {
  asMessage,
  exportMessage,
  settingMessage,
  toastMessage,
  type ExportMessage,
  type ToastMessage,
  type UpdateSettingMessage,
  numberField,
} from './common';
import { isPreviewSetting } from './settings';

// Webview to host messages of the Markdown and CSV preview (src/extension.ts).
export type MarkdownMessage =
  | { type: 'ready' }
  | { type: 'revealInOS' }
  | { type: 'openExternal' }
  // docKey: the document the report was measured in, so the host can drop one
  // that was still in flight when the preview switched to another document.
  | { type: 'revealLine'; line: number; docKey: string }
  // Whether this document's preview is auto-scrolling right now.
  | { type: 'autoScroll'; playing: boolean; docKey: string }
  // From the hidden-character notice: put the cursor on a flagged run (1-based).
  | { type: 'revealHidden'; line: number; column: number; docKey: string }
  // Copy the document's text without the characters the notice flags.
  | { type: 'copyCleanSource'; docKey: string }
  | ToastMessage
  | UpdateSettingMessage
  | { type: 'openSettings' }
  | { type: 'openLink'; href: string }
  | ExportMessage
  | {
      type: 'editCell';
      line: number;
      column: number;
      value: string;
      docVersion?: number;
      docKey: string;
    }
  | {
      type: 'gridOp';
      op: GridOp;
      line: number;
      column: number;
      docVersion?: number;
      docKey: string;
    }
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
    case 'ready':
    case 'revealInOS':
    case 'openExternal':
    case 'openSettings':
      return { type: msg.type };
    case 'copyCleanSource':
      return typeof msg.docKey === 'string'
        ? { type: 'copyCleanSource', docKey: msg.docKey }
        : undefined;
    case 'revealLine':
      // revealEditorLine ignores anything that is not a finite number.
      return typeof msg.line === 'number' &&
        Number.isFinite(msg.line) &&
        typeof msg.docKey === 'string'
        ? { type: 'revealLine', line: msg.line, docKey: msg.docKey }
        : undefined;
    case 'autoScroll':
      return typeof msg.playing === 'boolean' && typeof msg.docKey === 'string'
        ? { type: 'autoScroll', playing: msg.playing, docKey: msg.docKey }
        : undefined;
    case 'revealHidden': {
      const line = numberField(msg.line);
      const column = numberField(msg.column);
      return Number.isSafeInteger(line) &&
        Number.isSafeInteger(column) &&
        line >= 1 &&
        column >= 1 &&
        typeof msg.docKey === 'string'
        ? { type: 'revealHidden', line, column, docKey: msg.docKey }
        : undefined;
    }
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
      const line = numberField(msg.line);
      const column = numberField(msg.column);
      if (
        !Number.isInteger(line) ||
        !Number.isInteger(column) ||
        typeof msg.value !== 'string' ||
        typeof msg.docKey !== 'string'
      ) {
        return undefined;
      }
      return {
        type: 'editCell',
        line,
        column,
        value: msg.value,
        docKey: msg.docKey,
        ...(typeof msg.docVersion === 'number' ? { docVersion: msg.docVersion } : {}),
      };
    }
    case 'gridOp': {
      const line = numberField(msg.line);
      const column = numberField(msg.column);
      if (
        !isGridOp(msg.op) ||
        !Number.isInteger(line) ||
        !Number.isInteger(column) ||
        typeof msg.docKey !== 'string'
      ) {
        return undefined;
      }
      return {
        type: 'gridOp',
        op: msg.op,
        line,
        column,
        docKey: msg.docKey,
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
