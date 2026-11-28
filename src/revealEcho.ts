// Marks the editor reveals the extension caused itself, so the visible-range
// change they fire is not echoed back to the preview. Kept per document and per
// requested line: a reveal in one document, or of one line (an auto-scrolling
// preview sends many), must not mute a genuine scroll of the source elsewhere.
// Free of the `vscode` module so it can be tested directly.
export interface RevealEcho {
  /** Record a reveal of this line in the document with this key (its URI string). */
  mark(key: string, line: number): void;
  /**
   * Whether a visible-range change that now starts at `line` in this document is
   * the echo of a reveal we made recently: the same document and the same line.
   */
  isEcho(key: string, line: number): boolean;
}

export function createRevealEcho(windowMs: number, now: () => number = Date.now): RevealEcho {
  const recent = new Map<string, Array<{ line: number; at: number }>>();
  const live = (key: string, t: number) => {
    const list = (recent.get(key) ?? []).filter((r) => t - r.at < windowMs);
    if (list.length > 0) {
      recent.set(key, list);
    } else {
      recent.delete(key);
    }
    return list;
  };
  return {
    mark(key, line) {
      const t = now();
      const list = live(key, t);
      list.push({ line, at: t });
      recent.set(key, list);
    },
    isEcho(key, line) {
      return live(key, now()).some((r) => r.line === line);
    },
  };
}
