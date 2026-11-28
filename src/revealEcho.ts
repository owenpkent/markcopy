// Marks the editor reveals the extension caused itself, so the visible-range
// change they fire is not echoed back to the preview. Kept per document: a reveal
// in one document (an auto-scrolling preview sends many) must not mute scroll sync
// for another. Free of the `vscode` module so it can be tested directly.
export interface RevealEcho {
  /** Record a reveal in the document with this key (its URI string). */
  mark(key: string): void;
  /** Whether a visible-range change in this document is the echo of our own reveal. */
  isEcho(key: string): boolean;
}

export function createRevealEcho(windowMs: number, now: () => number = Date.now): RevealEcho {
  const revealedAt = new Map<string, number>();
  return {
    mark(key) {
      const t = now();
      revealedAt.set(key, t);
      // Keep the map small: forget documents whose window has long closed.
      if (revealedAt.size > 32) {
        for (const [k, at] of revealedAt) {
          if (t - at >= windowMs) {
            revealedAt.delete(k);
          }
        }
      }
    },
    isEcho(key) {
      const at = revealedAt.get(key);
      return at !== undefined && now() - at < windowMs;
    },
  };
}
