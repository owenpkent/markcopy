import * as vscode from 'vscode';

/**
 * Hand a web or mail link from a preview to the OS, and nothing else.
 *
 * Only real web and mail schemes go out. markdown-it and DOMPurify already strip
 * javascript:/vbscript: hrefs upstream, so this just bounds the blast radius (and
 * drops degenerate `?query`-only hrefs that carry no scheme).
 */
export function openExternalLink(href: string): void {
  let parsed: vscode.Uri;
  try {
    parsed = vscode.Uri.parse(href, true);
  } catch {
    return;
  }
  if (!/^(https?|mailto)$/i.test(parsed.scheme)) {
    return;
  }
  // Opened as the string, not the parsed Uri. VS Code serializes a Uri for the OS
  // as encodeURI(uri.toString(true)), which decodes %26, %2B and %3D in a query
  // back into &, + and =, and encodeURI leaves those alone: a link or search for
  // "AT&T" would arrive as `q=AT&T`, and "C++" as `q=C  `. The API accepts a
  // string at runtime and opens it exactly as written; only its typings say Uri.
  void vscode.env.openExternal(href as unknown as vscode.Uri);
}
