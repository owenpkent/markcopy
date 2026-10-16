// Turning a package's image part into a data URI the preview can show.
//
// Shared by the deck and document readers: both deliver images the same way
// (inlined as `data:` URIs, charged against one budget per file, encoded once
// per distinct part), because the webview CSP allows `data:` images and
// nothing else a package could name is safe to load.
import { type Parts } from './zip';

/** Image formats a browser can show as an <img>, by file extension. */
export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

/** A running byte total for the images inlined so far, against a ceiling. */
export interface MediaBudget {
  used: number;
  max: number;
}

/**
 * The `data:` URI for the image part at `target`, or undefined when it is
 * missing, in a format a browser cannot show (EMF/WMF), or past the budget.
 *
 * Encodes and charges each distinct part once, no matter how many places embed
 * it. A failed lookup is deliberately not cached: it costs nothing to re-check
 * on the next reference, and caching it would mean a part that only narrowly
 * missed the budget on first sight can never be retried.
 */
export function imageDataUri(
  parts: Parts,
  target: string,
  media: MediaBudget,
  cache: Map<string, string>,
): string | undefined {
  const cached = cache.get(target);
  if (cached !== undefined) {
    return cached;
  }
  const ext = target.slice(target.lastIndexOf('.') + 1).toLowerCase();
  const mime = IMAGE_MIME[ext];
  // EMF/WMF vector metafiles and anything else without a web-safe MIME type
  // are common in pasted-from-Office content but nothing a browser can show
  // as an <img>. A placeholder box is honest; a broken <img> is not.
  if (mime === undefined) {
    return undefined;
  }
  const bytes = parts.get(target);
  if (bytes === undefined) {
    return undefined;
  }
  if (media.used + bytes.length > media.max) {
    return undefined;
  }
  media.used += bytes.length;
  const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  cache.set(target, dataUri);
  return dataUri;
}
