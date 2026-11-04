// Building blocks for the per-surface webview message parsers in this folder.
//
// Every message a webview posts is untrusted input to the extension host. Each
// surface has a `parse<Surface>Message(raw: unknown)` that returns a typed message
// for exactly the shapes its handler acts on, and `undefined` for everything else,
// so a handler is a `switch` over a narrowed union. These modules never import
// `vscode`, which is what lets tests and the `messages` fuzz target drive them.

export type Dict = Record<string, unknown>;

/** A message object with a string `type`, or undefined for anything else. */
export function asMessage(raw: unknown): (Dict & { type: string }) | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const type = (raw as Dict).type;
  return typeof type === 'string' ? (raw as Dict & { type: string }) : undefined;
}

/** `{type: 'updateSetting', key, value}`, for a key and value the surface allows. */
export interface UpdateSettingMessage {
  type: 'updateSetting';
  key: string;
  value: unknown;
}

/** An `updateSetting` whose key and value pass the surface's allow-list (settings.ts). */
export function settingMessage(
  msg: Dict,
  allowed: (key: string, value: unknown) => boolean,
): UpdateSettingMessage | undefined {
  return typeof msg.key === 'string' && allowed(msg.key, msg.value)
    ? { type: 'updateSetting', key: msg.key, value: msg.value }
    : undefined;
}

/** A status-bar toast: the text is shown as is, so it has to be a string. */
export interface ToastMessage {
  type: 'toast';
  text: string;
}

export function toastMessage(msg: Dict): ToastMessage | undefined {
  return typeof msg.text === 'string' ? { type: 'toast', text: msg.text } : undefined;
}

export interface ExportMessage {
  type: 'pdfHtml' | 'docxXhtml' | 'pptxXhtml';
  /** The serialized preview body: `bodyHtml` for a PDF, `bodyXhtml` for DOCX and PPTX. */
  body: string;
}

export function exportMessage(msg: Dict): ExportMessage | undefined {
  if (msg.type === 'pdfHtml' && typeof msg.bodyHtml === 'string') {
    return { type: 'pdfHtml', body: msg.bodyHtml };
  }
  if ((msg.type === 'docxXhtml' || msg.type === 'pptxXhtml') && typeof msg.bodyXhtml === 'string') {
    return { type: msg.type, body: msg.bodyXhtml };
  }
  return undefined;
}

export interface SaveFrameMessage {
  type: 'saveFrame';
  /** Base64 PNG data, never empty. */
  data: string;
  /** The suggested file name, or undefined when the page sent none usable. */
  name: string | undefined;
}

export function saveFrame(msg: Dict): SaveFrameMessage | undefined {
  if (typeof msg.data !== 'string' || !msg.data) {
    return undefined;
  }
  return {
    type: 'saveFrame',
    data: msg.data,
    name: typeof msg.name === 'string' && msg.name ? msg.name : undefined,
  };
}

export interface SaveCommentsMessage {
  type: 'saveComments';
  /** Anything but a non-empty array deletes the sidecar (see writeComments). */
  comments: unknown;
}

// Number() on an object with no prototype (or a throwing toString) throws
// rather than returning NaN, so a hostile message could take the host down
// in the validator. Only a real number passes; everything else is NaN, which
// the callers' Number.isInteger checks reject.
export function numberField(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}
