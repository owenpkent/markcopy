// The address of a media file the host wants a page to play.
//
// The host hands a webview its file as `asWebviewUri(...)`, an https URL on the
// webview resource origin. Nothing else is ever meant to arrive, so nothing else
// is accepted: a string that is not an absolute https URL comes back empty, and
// an empty source fails to load like a missing file rather than being handed to
// the media element as a `javascript:` or `data:` address.
export function hostMediaUrl(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  try {
    return new URL(value).protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}
