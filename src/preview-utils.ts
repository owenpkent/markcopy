// Pure, VS Code-independent helpers for the Markdown preview. Kept free of the
// `vscode` module so they can be unit-tested directly (see test/preview-utils.test.ts).

export interface LocalImageRef {
  /** The path portion, with any ?query / #fragment stripped off. */
  path: string;
  /** The stripped ?query / #fragment, to re-append after the path is resolved. */
  suffix: string;
  /** True when the path is filesystem-absolute (POSIX `/…` or Windows `C:\…`). */
  absolute: boolean;
}

// Decide whether a markdown image `src` points at a local file we must rewrite
// through `asWebviewUri`. Returns null for anything that should be left as-is:
// remote URLs (http/https), data:/blob: payloads, protocol-relative `//host`,
// pure `#fragment` links, and already-resolved URIs (they carry a scheme).
//
// A single-letter "scheme" is treated as a Windows drive (C:\…), not a URL, so
// absolute Windows paths resolve as local files rather than being skipped.
export function localImageRef(src: string): LocalImageRef | null {
  if (!src) {
    return null;
  }
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return null;
  }
  // A real URL scheme is 2+ chars (http:, data:, vscode-webview:). This
  // deliberately does NOT match a `C:` Windows drive letter.
  if (/^[a-z][a-z0-9+.-]+:/i.test(trimmed)) {
    return null;
  }

  const match = /^([^?#]*)([?#].*)?$/.exec(trimmed);
  const path = match?.[1] ?? trimmed;
  const suffix = match?.[2] ?? '';
  if (!path) {
    return null;
  }

  const absolute = path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path);
  return { path, suffix, absolute };
}

export interface AutoPreviewInput {
  /** Value of the `markcopy.autoPreview` setting. */
  enabled: boolean;
  /** languageId of the newly-focused document. */
  languageId: string;
  /** URI scheme of the document (only real files on disk qualify). */
  scheme: string;
  /** Stable key (uri.toString()) of the document. */
  docKey: string;
  /** Documents whose preview the user explicitly closed this session. */
  dismissed: ReadonlySet<string>;
}

// Whether focusing a document should auto-open (or retarget) the preview.
// Gated by the setting, restricted to on-disk Markdown, and suppressed for any
// document the user has deliberately closed so we never fight them.
export function shouldAutoPreview(input: AutoPreviewInput): boolean {
  return (
    input.enabled &&
    input.languageId === 'markdown' &&
    input.scheme === 'file' &&
    !input.dismissed.has(input.docKey)
  );
}
