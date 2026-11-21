// Which other models the 3D preview offers under Compare with: the ones most
// likely to be another version of the file that is open.
//
// The menu is a short list picked with the pointer, so the order is the whole
// feature. Files are ranked by how much of their name they share with the open
// one (shower_chair_bar_cap_v7_current against shower_chair_bar_cap_v6 share
// everything but the number), and within a tie the higher name comes first, so
// the previous version sits at the top. No vscode dependency: the host lists
// the folders (src/stlEditor.ts) and this only orders the names.

/** The extensions the 3D preview opens, lower case. */
export const MODEL_EXTENSIONS = ['.stl', '.3mf'];

export function isModelFile(name: string): boolean {
  const lower = name.toLowerCase();
  return MODEL_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// The part of a file name that identifies the model: no folder, no extension,
// and no "_current" marker, which only says which version is the live one.
function stem(label: string): string {
  const base = label.slice(label.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).replace(/[-_. ]current$/, '');
}

// How alike two stems are: the length of what they share from the start, with
// every number read as the same token. Counting digits would put v10 nearer to
// v11 than v9 is, and part_v3 nearer to part_v30 than part_v29.
function sharedPrefix(first: string, second: string): number {
  const a = first.replace(/\d+/g, '#');
  const b = second.replace(/\d+/g, '#');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return i;
}

/**
 * `labels` (paths relative to the open file's folder, '/'-separated) ordered
 * for the Compare with menu, at most `limit` of them.
 */
export function rankSiblings(name: string, labels: readonly string[], limit = 12): string[] {
  const own = stem(name);
  const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return labels
    .map((label) => ({ label, score: sharedPrefix(own, stem(label)) }))
    .sort((a, b) => b.score - a.score || natural.compare(stem(b.label), stem(a.label)))
    .slice(0, limit)
    .map((entry) => entry.label);
}
