// Collecting a package's image parts for the preview to show.
//
// Shared by the deck and document readers: both deliver images the same way.
// The HTML carries only a reference (`<img data-mc-media="m3">`) and the bytes
// travel beside it, base64-encoded once per distinct part, for the webview to
// turn into `blob:` URLs. Inlining them as `data:` URIs used to make the HTML
// string itself tens of megabytes, which the webview then had to transfer,
// sanitize, and parse before showing a word of text, and the budget that kept
// that bearable (16 MB) turned every photo-heavy deck into a wall of
// placeholders.
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

/** One image part, ready to post to the webview. */
export interface MediaItem {
  /** The value of the `data-mc-media` attribute that references it. */
  id: string;
  mime: string;
  base64: string;
}

/** The HTML attribute an `<img>` carries in place of a `src`. */
export const MEDIA_ATTR = 'data-mc-media';

/**
 * The images collected for one file, each distinct part once, under a cap.
 *
 * `maxTotalBytes` bounds what one preview posts to the webview, and
 * `maxItemBytes` keeps a single part from taking most of that. Both count the
 * part's own bytes, not the base64 text.
 */
export interface MediaSink {
  items: MediaItem[];
  /** Target path -> id, so a part reused across slides or pages is sent once. */
  ids: Map<string, string>;
  used: number;
  maxItemBytes: number;
  maxTotalBytes: number;
}

/** Defaults for a preview: photographs are a few MB each, and a deck of them runs to tens. */
export const DEFAULT_MAX_MEDIA_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export function createMediaSink(
  opts: {
    maxTotalBytes?: number;
    maxItemBytes?: number;
  } = {},
): MediaSink {
  return {
    items: [],
    ids: new Map(),
    used: 0,
    maxTotalBytes: Math.max(0, opts.maxTotalBytes ?? DEFAULT_MAX_MEDIA_BYTES),
    maxItemBytes: Math.max(0, opts.maxItemBytes ?? DEFAULT_MAX_IMAGE_BYTES),
  };
}

/**
 * The media id for the image part at `target`, or undefined when it is
 * missing, in a format a browser cannot show (EMF/WMF), or past the cap.
 *
 * Encodes and charges each distinct part once, no matter how many places embed
 * it. A failed lookup is deliberately not cached: it costs nothing to re-check
 * on the next reference, and caching it would mean a part that only narrowly
 * missed the cap on first sight can never be retried.
 */
export function mediaRef(parts: Parts, target: string, sink: MediaSink): string | undefined {
  const cached = sink.ids.get(target);
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
  if (bytes.length > sink.maxItemBytes || sink.used + bytes.length > sink.maxTotalBytes) {
    return undefined;
  }
  sink.used += bytes.length;
  const id = `m${sink.items.length + 1}`;
  sink.items.push({
    id,
    mime,
    base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
  });
  sink.ids.set(target, id);
  return id;
}

/** The attribute pair an `<img>` carries to be resolved by the webview. */
export function mediaAttr(id: string): string {
  return `${MEDIA_ATTR}="${id}"`;
}
