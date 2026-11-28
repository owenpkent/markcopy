// Marks the editor reveals the extension caused itself, so the visible-range
// change they fire is not echoed back to the preview. A time window kept per
// document (by URI string): a reveal in one document must not mute scroll sync
// for another. A preview that auto-scrolls is muted explicitly instead (see
// scrollGate.ts). Free of the `vscode` module so it can be tested directly.
export interface RevealEcho {
  /** Record a reveal in the document with this key (its URI string). */
  mark(key: string): void;
  /** Whether a reveal in this document happened within the window. */
  isEcho(key: string): boolean;
}

// More documents than this are never revealed at once; the bound keeps the map
// from growing over a long session.
const MAX_TRACKED = 32;

export function createRevealEcho(windowMs: number, now: () => number = Date.now): RevealEcho {
  const at = new Map<string, number>();
  return {
    mark(key) {
      const t = now();
      at.delete(key);
      at.set(key, t);
      if (at.size > MAX_TRACKED) {
        for (const [k, v] of at) {
          if (t - v >= windowMs || at.size > MAX_TRACKED) {
            at.delete(k);
          }
        }
      }
    },
    isEcho(key) {
      const v = at.get(key);
      return v !== undefined && now() - v < windowMs;
    },
  };
}
