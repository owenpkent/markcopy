// Number formatting shared by text.ts (font sizes) and render.ts (positions).
//
// Every value that reaches the DOM here came out of arithmetic on numbers a
// crafted file controls (a slide size of 1 EMU, a run size of 0), so every
// caller clamps through this rather than trusting the division to land
// somewhere sane.

/** Round to `decimals` places and drop trailing zeros: 12.10 -> "12.1". */
export function fmtNum(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) {
    return '0';
  }
  return String(Number(n.toFixed(decimals)));
}

export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) {
    return lo;
  }
  return Math.min(hi, Math.max(lo, n));
}
