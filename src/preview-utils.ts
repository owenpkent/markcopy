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

export interface LocalLink {
  kind: 'local';
  /** File path, percent-decoded, with any ?query / #fragment stripped off. */
  path: string;
  /** True when the path is filesystem-absolute (POSIX `/…` or Windows `C:\…`). */
  absolute: boolean;
  /** The `#fragment` without its leading '#', percent-decoded, or '' if none. */
  fragment: string;
  /** True when the path looks like a Markdown document (.md / .markdown / .mdx). */
  markdown: boolean;
}

export type LinkTarget =
  { kind: 'fragment'; fragment: string } | { kind: 'external'; href: string } | LocalLink;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Classify a rendered link's `href` so the webview and host know how to follow
// it: a pure in-page `#fragment`, an external URL (opened in the browser), or a
// local file resolved relative to the document. Reuses localImageRef's scheme /
// drive-letter logic so image and link handling agree on what "local" means.
// Returns null for an empty href.
export function classifyLink(href: string): LinkTarget | null {
  const trimmed = (href ?? '').trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('#')) {
    return { kind: 'fragment', fragment: safeDecode(trimmed.slice(1)) };
  }
  const ref = localImageRef(trimmed);
  if (!ref) {
    // Remote URL, mailto:, an already-resolved scheme, or a protocol-relative
    // //host (which we normalize to https so Uri.parse accepts it).
    return { kind: 'external', href: trimmed.startsWith('//') ? `https:${trimmed}` : trimmed };
  }
  const hashIdx = ref.suffix.indexOf('#');
  const fragment = hashIdx >= 0 ? safeDecode(ref.suffix.slice(hashIdx + 1)) : '';
  const path = safeDecode(ref.path);
  return {
    kind: 'local',
    path,
    absolute: ref.absolute,
    fragment,
    markdown: /\.(md|markdown|mdx)$/i.test(path),
  };
}

/** How a previewable document is turned into HTML for the webview. */
export type PreviewKind = 'markdown' | 'csv';

const PREVIEW_LANGUAGES: Record<string, PreviewKind> = {
  markdown: 'markdown',
  mdx: 'markdown',
  csv: 'csv',
  tsv: 'csv',
};

// What MarkCopy would render this document as, or undefined if it can't preview
// it. Normally the language id decides. The extension contributes the `csv` and
// `tsv` ids itself, but another extension (or the user's `files.associations`)
// can map those files elsewhere, so a recognized extension is accepted too,
// rather than leaving "Open Rich Preview" inert on an obvious .csv.
export function previewKind(languageId: string, path = ''): PreviewKind | undefined {
  const byLanguage = PREVIEW_LANGUAGES[languageId];
  if (byLanguage) {
    return byLanguage;
  }
  if (/\.(csv|tsv|tab)$/i.test(path)) {
    return 'csv';
  }
  if (/\.(md|markdown|mdown|mkd|mdx)$/i.test(path)) {
    return 'markdown';
  }
  return undefined;
}

/**
 * Whether MarkCopy previews this document as LaTeX.
 *
 * Kept apart from `previewKind` on purpose: that answers "which way does the
 * shared Markdown/CSV webview render this", and LaTeX does not go through that
 * webview at all. It compiles to a PDF and opens in its own custom editor, so
 * the only thing callers need from here is yes or no.
 *
 * `latex` is VS Code's own built-in language id, but the extension is accepted
 * too, for the same reason `previewKind` accepts one: a `files.associations`
 * entry or another extension can map .tex somewhere else, and the preview should
 * not go inert just because something renamed the language.
 */
export function isTexDocument(languageId: string, path = ''): boolean {
  return languageId === 'latex' || /\.(tex|ltx|latex)$/i.test(path);
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
  /** Path of the document, used when the language id is not conclusive. */
  path?: string;
  /** Documents whose preview the user explicitly closed this session. */
  dismissed: ReadonlySet<string>;
}

// Whether focusing a document should auto-open (or retarget) the preview.
// Gated by the setting, restricted to on-disk documents MarkCopy can render,
// and suppressed for any document the user has deliberately closed so we never
// fight them.
export function shouldAutoPreview(input: AutoPreviewInput): boolean {
  return (
    input.enabled &&
    previewKind(input.languageId, input.path ?? '') !== undefined &&
    input.scheme === 'file' &&
    !input.dismissed.has(input.docKey)
  );
}
