// Which `markcopy.*` settings a webview may write, and with what value. Pure, so
// the video and GIF editors, their message parsers and the tests share one list.

export const THEMES = ['auto', 'light', 'dark', 'green'];

/** True for the settings the video viewer's menus write, with a value of the right type. */
export function isViewerSetting(key: string, value: unknown): boolean {
  if (key === 'theme') {
    return typeof value === 'string' && THEMES.includes(value);
  }
  return (
    (key === 'video.loop' || key === 'video.autoplay' || key === 'video.review') &&
    typeof value === 'boolean'
  );
}

/** True for the one setting the GIF viewer's menus write, with a valid value. */
export function isGifSetting(key: string, value: unknown): boolean {
  return key === 'theme' && isViewerSetting(key, value);
}
