// The images a Word document or PowerPoint deck preview shows.
//
// The host sends the markup with `<img data-mc-media="m3">` where a picture
// goes and the pictures themselves in `media` messages that follow, base64 a
// few MB at a time (the webview transport JSON-encodes, so bytes travel as
// text; see src/pdfEditor.ts). Each arrives here once, becomes a Blob and a
// `blob:` URL, and is written into every <img> that references it. Nothing in
// the HTML string is then larger than a short attribute, which is what keeps
// a photo-heavy deck from stalling on DOMPurify and innerHTML before a word
// of text is on screen.
//
// A render and its media share a `mediaSet` id. A new render begins a new set
// and revokes the old URLs; media for any other set is dropped, so a slow
// batch for a file that has since been replaced cannot land on the wrong
// document.
//
// The copy and export paths serialize the DOM to leave the webview, where a
// `blob:` URL means nothing, so materializeMedia() turns each reference in a
// detached clone back into a `data:` URI, downscaled to what a page or slide
// can show. That is where a 6000 px photograph stops costing 20 MB.
import { base64ToBytes } from './gifInfo';

/** Mirrors MEDIA_ATTR in src/ooxml/media.ts, which this bundle does not import (it is host-side code). */
export const MEDIA_ATTR = 'data-mc-media';

/** The MIME types the host's IMAGE_MIME table can send; anything else is dropped unread. */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/svg+xml',
  'image/webp',
  'image/tiff',
]);
const ID_RE = /^m\d{1,7}$/;

/** The longest side an exported image keeps; a page or slide shows nothing finer. */
export const EXPORT_MAX_SIDE = 2048;

let currentSet: string | undefined;
const urls = new Map<string, string>();
const blobs = new Map<string, Blob>();

/**
 * Start collecting media for a new render, discarding the previous render's.
 * Called when a render message arrives, not when it is applied: an editor
 * may hold the render back, and the media for it still has to be kept.
 */
export function beginMediaSet(set: unknown): void {
  const next = typeof set === 'string' ? set : undefined;
  if (next === currentSet) {
    return;
  }
  for (const url of urls.values()) {
    URL.revokeObjectURL(url);
  }
  urls.clear();
  blobs.clear();
  currentSet = next;
}

/**
 * Take in one `media` message for the current set and show its images in
 * `root`. Returns how many new images were accepted, for tests.
 */
export function addMedia(set: unknown, items: unknown, root: ParentNode): number {
  if (typeof set !== 'string' || set !== currentSet || !Array.isArray(items)) {
    return 0;
  }
  let added = 0;
  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const { id, mime, base64 } = item as Record<string, unknown>;
    if (
      typeof id !== 'string' ||
      !ID_RE.test(id) ||
      typeof mime !== 'string' ||
      !ALLOWED_MIME.has(mime) ||
      urls.has(id)
    ) {
      continue;
    }
    const bytes = base64ToBytes(base64);
    if (bytes.length === 0) {
      continue;
    }
    const blob = new Blob([bytes as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    urls.set(id, url);
    blobs.set(id, blob);
    added++;
    root.querySelectorAll<HTMLImageElement>(`img[${MEDIA_ATTR}="${id}"]`).forEach((img) => {
      img.src = url;
    });
  }
  return added;
}

/** Point every media reference in `root` at the image already received for it. */
export function applyMedia(root: ParentNode): void {
  root.querySelectorAll<HTMLImageElement>(`img[${MEDIA_ATTR}]`).forEach((img) => {
    const url = urls.get(img.getAttribute(MEDIA_ATTR) ?? '');
    if (url !== undefined) {
      img.src = url;
    }
  });
}

/** The ids of the images received so far, for tests. */
export function mediaIds(): string[] {
  return Array.from(urls.keys());
}

/**
 * Replace each media reference in a detached clone with a `data:` URI that
 * survives outside the webview, downscaled so no side exceeds `maxSide`.
 *
 * An image that never arrived loses its `src` and keeps its alt text: the
 * export then shows what the preview showed, a gap, rather than failing.
 */
export async function materializeMedia(root: ParentNode, maxSide = EXPORT_MAX_SIDE): Promise<void> {
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>(`img[${MEDIA_ATTR}]`));
  await Promise.all(
    imgs.map(async (img) => {
      const blob = blobs.get(img.getAttribute(MEDIA_ATTR) ?? '');
      img.removeAttribute(MEDIA_ATTR);
      if (blob === undefined) {
        img.removeAttribute('src');
        return;
      }
      try {
        img.setAttribute('src', await toDataUri(blob, maxSide));
      } catch {
        img.removeAttribute('src');
      }
    }),
  );
}

async function toDataUri(blob: Blob, maxSide: number): Promise<string> {
  // An SVG is already small and scales itself, and a canvas redraw of one
  // without an intrinsic size is unreliable (the Word and PowerPoint exports
  // redraw it to PNG on their own terms). A GIF keeps its frames.
  if (blob.type === 'image/svg+xml' || blob.type === 'image/gif') {
    return blobToDataUrl(blob);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    // A format the browser will not decode (TIFF, usually): send it as it is
    // and let the destination decide.
    return blobToDataUrl(blob);
  }
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height, 1));
    if (scale >= 1) {
      return await blobToDataUrl(blob);
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return await blobToDataUrl(blob);
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // A photograph stays a JPEG; anything else may have transparency or hard
    // edges that JPEG would smear, so it stays lossless.
    return blob.type === 'image/jpeg'
      ? canvas.toDataURL('image/jpeg', 0.9)
      : canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}
