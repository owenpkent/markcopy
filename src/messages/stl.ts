import { asMessage } from './common';

// Webview to host messages of the STL viewer (src/stlEditor.ts): it only ever
// asks for the file.
export type StlMessage = { type: 'ready' };

export function parseStlMessage(raw: unknown): StlMessage | undefined {
  return asMessage(raw)?.type === 'ready' ? { type: 'ready' } : undefined;
}
