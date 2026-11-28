// Validation of the address behind an external link in a PDF. Shared by the
// webview (which only draws a link it could open) and the host (which checks
// again, because a webview message is untrusted input and this is the check
// that counts). Free of `vscode` so both bundles and the tests can use it.

/** Longest link address accepted. Longer is not a link a person follows. */
export const MAX_LINK_URL_LENGTH = 2048;

const OPENABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * The address unchanged when it is an http, https or mailto URL of sane length
 * with no whitespace or control characters, else undefined. Returned as given
 * (not re-serialised), because `openExternalLink` hands the exact string to the
 * OS; see src/externalLink.ts.
 */
export function parseLinkUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LINK_URL_LENGTH) {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(raw)) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  return OPENABLE_PROTOCOLS.has(parsed.protocol) ? raw : undefined;
}
