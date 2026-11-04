import { classifyLink } from '../../src/preview-utils';
import { hostFollowsLink, markdownLink, refFromHref, refFromText } from '../../src/webview/links';

// A base with a scheme of its own, so a relative href resolves to a protocol no
// real scheme shares and can be told apart from `https:`.
const BASE = 'mc-base://doc.invalid/dir/';
// A relative href lands on the base's own protocol. A query-only one is classified
// external, and openExternalLink drops it for having no scheme, so it is no finding.
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', new URL(BASE).protocol]);

/** The protocol a browser resolves `href` to, or undefined when it cannot parse it. */
function browserProtocol(href: string): string | undefined {
  try {
    return new URL(href, BASE).protocol;
  } catch {
    return undefined;
  }
}

// Oracle. A click in the preview is followed by the host when hostFollowsLink
// says so, and the host then hands an `external` classification to the OS. So
// whatever a browser would read as javascript:, data:, vbscript:, file:,
// command: or vscode: must never come out of that pair as an external link.
// (A `local` classification is a file path the host opens in the editor, and a
// path is not a scheme; the shell keeps every link hostFollowsLink declines.)
function checkFollowed(href: string): void {
  if (!hostFollowsLink(href)) {
    return;
  }
  const target = classifyLink(href);
  if (target?.kind !== 'external') {
    return;
  }
  const protocol = browserProtocol(target.href);
  if (protocol !== undefined && !SAFE_PROTOCOLS.has(protocol)) {
    throw new Error(
      `followed as external but a browser reads ${protocol}: ${JSON.stringify(href)} -> ${JSON.stringify(target.href)}`,
    );
  }
}

export function fuzz(data: Buffer): void {
  const text = data.toString('utf8');
  checkFollowed(text);

  classifyLink(text);
  refFromHref(text);
  refFromText(text);

  const mid = text.length >> 1;
  const label = text.slice(0, mid);
  const href = text.slice(mid);
  checkFollowed(href);
  const link = markdownLink(label, href);
  // The escaped target must not carry a character that ends it early.
  const target = link.slice(link.lastIndexOf('](') + 2, -1);
  if (/[()\s]/.test(target)) {
    throw new Error(`markdownLink left a delimiter in the target: ${JSON.stringify(link)}`);
  }
}
