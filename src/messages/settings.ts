// Which `markcopy.*` settings a webview may write, and with what value. Pure, so
// the editors, their message parsers and the tests share one list. A webview is
// untrusted: an unchecked key would let it set `video.ffmpegPath`,
// `pdf.browserPath` or `tex.enginePath`, which the host later executes.

export const THEMES = ['auto', 'light', 'dark', 'green'];

const isTheme = (value: unknown): boolean => typeof value === 'string' && THEMES.includes(value);

/** True for the settings the video viewer's menus write, with a value of the right type. */
export function isViewerSetting(key: string, value: unknown): boolean {
  if (key === 'theme') {
    return isTheme(value);
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

export const IMAGE_BACKGROUNDS = ['checkerboard', 'light', 'dark', 'theme'];

/** The settings the image viewer's menus write: the theme and the picture's backdrop. */
export function isImageSetting(key: string, value: unknown): boolean {
  if (key === 'image.background') {
    return typeof value === 'string' && IMAGE_BACKGROUNDS.includes(value);
  }
  return key === 'theme' && isTheme(value);
}

/**
 * The settings the Markdown, CSV, spreadsheet, deck and Word previews' Preferences
 * menu writes (src/webview/main.ts, buildSettingsEntries): the theme and four toggles.
 */
export function isPreviewSetting(key: string, value: unknown): boolean {
  if (key === 'theme') {
    return isTheme(value);
  }
  return (
    (key === 'syncScroll' || key === 'autoPreview' || key === 'math' || key === 'footnotes') &&
    typeof value === 'boolean'
  );
}

/** The one setting the PDF and LaTeX viewers' Theme menu writes (src/webview/pdf.ts). */
export function isPdfSetting(key: string, value: unknown): boolean {
  return key === 'theme' && isTheme(value);
}
