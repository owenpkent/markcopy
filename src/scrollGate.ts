// Decisions about which scroll reports the host honours, kept free of the
// `vscode` module so they can be tested directly (see also revealEcho.ts).

/**
 * Whether a report from the webview belongs to the document the preview shows
 * now. A report still in flight when the preview switched documents carries the
 * old document's key and must be dropped, not applied to the new one.
 */
export function reportIsCurrent(reportKey: string, currentKey: string): boolean {
  return reportKey === currentKey;
}

/**
 * The playing flag after an `autoScroll` report: the report counts only when it
 * is for the document shown now, otherwise the flag is unchanged.
 */
export function playingAfterReport(
  previous: boolean,
  report: { playing: boolean; docKey: string },
  currentKey: string,
): boolean {
  return reportIsCurrent(report.docKey, currentKey) ? report.playing : previous;
}

/**
 * Whether an editor scroll is pushed to a preview. A playing preview leads: the
 * editor must not pull it back, however long ago its last reveal was.
 */
export function pushesEditorScroll(previewPlaying: boolean | undefined): boolean {
  return !previewPlaying;
}
