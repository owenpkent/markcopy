// The parts and assembly tree of a 3D model, and the pure logic around it. No DOM
// and no Three.js, so tests/parts.test.ts runs it directly.
//
// Every reader (STL, 3MF, GLB, STEP) still hands the viewer ONE merged triangle
// soup, which is what keeps the section, Compare with and the print bed working
// unchanged. Beside it each returns a tree whose leaves say which triangles of
// that soup are which part: `ranges` are `[start, count]` in triangles. Hiding,
// isolating and highlighting a part then only re-draws ranges of the one geometry
// (see applyParts in stl.ts); nothing is rebuilt.
//
// A file's names are hostile input. They are cleaned here (control and bidi
// characters out, length capped), the tree is capped in nodes and depth, and
// past a cap the rest is gathered under one "More parts" node rather than
// refused: a model that opens as a mesh should still open.

/** One node: an assembly has children, a part has ranges. */
export interface PartNode {
  name: string;
  children: PartNode[];
  /** `[start, count]` in triangles of the merged geometry. Parts only. */
  ranges: Array<[number, number]>;
}

export const MAX_PART_NODES = 20_000;
export const MAX_PART_DEPTH = 64;
export const MAX_PART_NAME = 200;
export const MORE_PARTS = 'More parts';

// C0 and C1 controls, line and paragraph separators, and the bidirectional
// overrides and isolates, which can make one name read as another.
// eslint-disable-next-line no-control-regex
const UNWANTED = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

/** A name safe to show: controls and bidi marks out, whitespace folded, capped. '' when nothing is left. */
export function cleanPartName(raw: unknown, max = MAX_PART_NAME): string {
  if (typeof raw !== 'string') {
    return '';
  }
  // Bound the work first: a name megabytes long is cut before any regex runs.
  let text = raw.length > max * 4 ? raw.slice(0, max * 4) : raw;
  text = text.replace(UNWANTED, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > max) {
    text = text.slice(0, max - 1);
    // Never end on half of a surrogate pair.
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      text = text.slice(0, -1);
    }
    text = `${text.trimEnd()}…`;
  }
  return text;
}

export interface PartLimits {
  maxNodes?: number;
  maxDepth?: number;
  maxName?: number;
}

interface Frame {
  /** The node this frame opened, or null when a cap turned it into a pass-through. */
  node: PartNode | null;
}

/**
 * Builds a PartNode tree while a reader walks its own structure. `begin` opens
 * an assembly, `leaf` adds a part, `end` closes the assembly. The caps are
 * enforced as nodes arrive, so a hostile file cannot make the reader hold
 * millions of nodes: past the node cap every further part's ranges are merged
 * into one "More parts" node, and past the depth cap an assembly adds no level.
 */
export class PartTreeBuilder {
  private readonly root: PartNode = { name: '', children: [], ranges: [] };
  private readonly stack: Frame[] = [];
  private readonly maxNodes: number;
  private readonly maxDepth: number;
  private readonly maxName: number;
  private nodes = 0;
  private overflow: PartNode | null = null;

  /** `total`: the triangles in the merged geometry; ranges are clipped to it. */
  constructor(
    private readonly total: number,
    limits: PartLimits = {},
  ) {
    this.maxNodes = limits.maxNodes ?? MAX_PART_NODES;
    this.maxDepth = limits.maxDepth ?? MAX_PART_DEPTH;
    this.maxName = limits.maxName ?? MAX_PART_NAME;
  }

  private container(): PartNode {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const node = this.stack[i].node;
      if (node) {
        return node;
      }
    }
    return this.root;
  }

  begin(name?: unknown): void {
    if (this.nodes >= this.maxNodes || this.stack.length >= this.maxDepth) {
      this.stack.push({ node: null });
      return;
    }
    const node: PartNode = { name: cleanPartName(name, this.maxName), children: [], ranges: [] };
    this.container().children.push(node);
    this.nodes++;
    this.stack.push({ node });
  }

  end(): void {
    const frame = this.stack.pop();
    const node = frame?.node;
    if (!node || node.children.length > 0 || node.ranges.length > 0) {
      return;
    }
    // An assembly that held nothing drawable is not a row.
    const parent = this.container();
    const at = parent.children.lastIndexOf(node);
    if (at >= 0) {
      parent.children.splice(at, 1);
      this.nodes--;
    }
  }

  leaf(name: unknown, ranges: ReadonlyArray<readonly [number, number]>): void {
    const kept: Array<[number, number]> = [];
    for (const [start, count] of ranges) {
      const from = Math.max(0, Math.floor(start));
      const to = Math.min(this.total, Math.floor(start) + Math.floor(count));
      if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
        kept.push([from, to - from]);
      }
    }
    if (kept.length === 0) {
      return;
    }
    if (this.nodes >= this.maxNodes) {
      const more = (this.overflow ??= this.addOverflow());
      for (const range of kept) {
        const last = more.ranges[more.ranges.length - 1];
        if (last && last[0] + last[1] === range[0]) {
          last[1] += range[1];
        } else {
          more.ranges.push(range);
        }
      }
      return;
    }
    this.container().children.push({
      name: cleanPartName(name, this.maxName),
      children: [],
      ranges: kept,
    });
    this.nodes++;
  }

  private addOverflow(): PartNode {
    const node: PartNode = { name: MORE_PARTS, children: [], ranges: [] };
    this.root.children.push(node);
    return node;
  }

  /** The finished tree, its unnamed nodes called "Assembly N" and "Part N". */
  finish(): PartNode {
    while (this.stack.length > 0) {
      this.end();
    }
    let assemblies = 0;
    let parts = 0;
    // Depth is bounded by maxDepth; an explicit stack keeps it that way even
    // for a caller that raised the limit.
    const todo: PartNode[] = [...this.root.children].reverse();
    while (todo.length > 0) {
      const node = todo.pop() as PartNode;
      if (node.name === '') {
        node.name = node.children.length > 0 ? `Assembly ${++assemblies}` : `Part ${++parts}`;
      }
      for (let i = node.children.length - 1; i >= 0; i--) {
        todo.push(node.children[i]);
      }
    }
    return this.root;
  }
}

/** The triangles a part holds. */
export function rangeTriangles(ranges: ReadonlyArray<readonly [number, number]>): number {
  let n = 0;
  for (const range of ranges) {
    n += range[1];
  }
  return n;
}

// ---------------------------------------------------------------------------
// The panel's model: rows with quantities, and the parts in row order
// ---------------------------------------------------------------------------
export interface PartLeaf {
  name: string;
  /** The assemblies above it, outermost first. */
  path: string[];
  triangles: number;
  ranges: Array<[number, number]>;
}

export interface PartItem {
  id: number;
  name: string;
  /** A group is a quantity row: identical siblings folded into one, `children` the instances. */
  kind: 'part' | 'assembly' | 'group';
  qty: number;
  /** One part's triangles; a group shows one instance's. An assembly sums its parts. */
  triangles: number;
  depth: number;
  parent: PartItem | null;
  children: PartItem[];
  /** The leaves under this row are `leaves[leafFrom]` up to, not including, `leafTo`. */
  leafFrom: number;
  leafTo: number;
  /** For a part, its index in `leaves`; else -1. */
  leaf: number;
}

export interface PartModel {
  items: PartItem[];
  byId: PartItem[];
  /** In row order, so every row's leaves are one contiguous run. */
  leaves: PartLeaf[];
  segments: Segments;
}

/**
 * Rows for `root`: siblings with the same name and the same triangle count are
 * folded into one row with a quantity (the instances stay under it), and the
 * leaves are numbered in the order the rows show them.
 */
export function buildPartModel(root: PartNode): PartModel {
  const byId: PartItem[] = [];
  const leaves: PartLeaf[] = [];

  const triangles = (node: PartNode): number =>
    node.children.length > 0
      ? node.children.reduce((sum, child) => sum + triangles(child), 0)
      : rangeTriangles(node.ranges);

  const make = (
    node: PartNode,
    depth: number,
    parent: PartItem | null,
    path: string[],
  ): PartItem => {
    const isAssembly = node.children.length > 0;
    const item: PartItem = {
      id: byId.length,
      name: node.name,
      kind: isAssembly ? 'assembly' : 'part',
      qty: 1,
      triangles: 0,
      depth,
      parent,
      children: [],
      leafFrom: leaves.length,
      leafTo: leaves.length,
      leaf: -1,
    };
    byId.push(item);
    if (isAssembly) {
      item.children = foldChildren(node.children, depth + 1, item, [...path, node.name]);
      item.triangles = item.children.reduce(
        (sum, child) => sum + child.triangles * (child.kind === 'group' ? child.qty : 1),
        0,
      );
    } else {
      item.leaf = leaves.length;
      leaves.push({
        name: node.name,
        path,
        triangles: rangeTriangles(node.ranges),
        ranges: node.ranges,
      });
      item.triangles = leaves[item.leaf].triangles;
    }
    item.leafTo = leaves.length;
    return item;
  };

  const foldChildren = (
    nodes: PartNode[],
    depth: number,
    parent: PartItem | null,
    path: string[],
  ): PartItem[] => {
    const keyOf = (node: PartNode) =>
      `${node.children.length > 0 ? 'a' : 'p'}\u0000${node.name}\u0000${triangles(node)}`;
    const buckets = new Map<string, PartNode[]>();
    for (const node of nodes) {
      const key = keyOf(node);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.push(node);
      } else {
        buckets.set(key, [node]);
      }
    }
    const out: PartItem[] = [];
    const done = new Set<string>();
    for (const node of nodes) {
      const key = keyOf(node);
      if (done.has(key)) {
        continue;
      }
      done.add(key);
      const bucket = buckets.get(key) as PartNode[];
      if (bucket.length === 1) {
        out.push(make(node, depth, parent, path));
        continue;
      }
      const group: PartItem = {
        id: byId.length,
        name: node.name,
        kind: 'group',
        qty: bucket.length,
        triangles: triangles(node),
        depth,
        parent,
        children: [],
        leafFrom: leaves.length,
        leafTo: leaves.length,
        leaf: -1,
      };
      byId.push(group);
      group.children = bucket.map((member) => make(member, depth + 1, group, path));
      group.leafTo = leaves.length;
      out.push(group);
    }
    return out;
  };

  const items = foldChildren(root.children, 0, null, []);
  return { items, byId, leaves, segments: buildSegments(leaves) };
}

// ---------------------------------------------------------------------------
// Which part a triangle belongs to
// ---------------------------------------------------------------------------
/** Every leaf range, sorted by start, for a binary search. */
export interface Segments {
  starts: Float64Array;
  ends: Float64Array;
  leaf: Int32Array;
}

export function buildSegments(
  leaves: ReadonlyArray<{ ranges: ReadonlyArray<readonly [number, number]> }>,
): Segments {
  const list: Array<[number, number, number]> = [];
  leaves.forEach((leaf, index) => {
    for (const [start, count] of leaf.ranges) {
      list.push([start, start + count, index]);
    }
  });
  list.sort((a, b) => a[0] - b[0]);
  const starts = new Float64Array(list.length);
  const ends = new Float64Array(list.length);
  const leaf = new Int32Array(list.length);
  list.forEach(([start, end, index], i) => {
    starts[i] = start;
    ends[i] = end;
    leaf[i] = index;
  });
  return { starts, ends, leaf };
}

/** The leaf that holds `triangle`, or -1. Binary search over the sorted ranges. */
export function findLeaf(segments: Segments, triangle: number): number {
  let lo = 0;
  let hi = segments.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (triangle < segments.starts[mid]) {
      hi = mid - 1;
    } else if (triangle >= segments.ends[mid]) {
      lo = mid + 1;
    } else {
      return segments.leaf[mid];
    }
  }
  return -1;
}

/** How a part is drawn: the index into the material array. */
export const NORMAL = 0;
export const HIDDEN = 1;
export const HIGHLIGHT = 2;
export type DrawState = 0 | 1 | 2;

export interface DrawGroup {
  start: number;
  count: number;
  state: DrawState;
}

/**
 * The geometry groups that draw `total` triangles with each part in the state
 * `stateOf` gives it. Adjacent ranges in the same state are one group, so a
 * model of thousands of parts with most of them shown is a handful of draw
 * calls. Triangles no part claims are drawn normally.
 */
export function drawGroups(
  segments: Segments,
  stateOf: (leaf: number) => DrawState,
  total: number,
): DrawGroup[] {
  const groups: DrawGroup[] = [];
  const add = (start: number, end: number, state: DrawState) => {
    if (end <= start) {
      return;
    }
    const last = groups[groups.length - 1];
    if (last && last.state === state && last.start + last.count === start) {
      last.count += end - start;
    } else {
      groups.push({ start, count: end - start, state });
    }
  };
  let cursor = 0;
  for (let i = 0; i < segments.starts.length; i++) {
    const start = Math.max(segments.starts[i], cursor);
    const end = Math.min(segments.ends[i], total);
    if (end <= start) {
      continue;
    }
    add(cursor, start, NORMAL);
    add(start, end, stateOf(segments.leaf[i]));
    cursor = end;
  }
  add(cursor, total, NORMAL);
  return groups;
}

/** The min and max corner of the triangles in leaves `[from, to)`, or null when they have none. */
export function leafBounds(
  positions: Float32Array,
  leaves: ReadonlyArray<{ ranges: ReadonlyArray<readonly [number, number]> }>,
  from: number,
  to: number,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let l = from; l < to; l++) {
    for (const [start, count] of leaves[l].ranges) {
      const end = Math.min(positions.length, (start + count) * 9);
      for (let i = start * 9; i + 2 < end; i += 3) {
        for (let a = 0; a < 3; a++) {
          const v = positions[i + a];
          if (v < min[a]) {
            min[a] = v;
          }
          if (v > max[a]) {
            max[a] = v;
          }
        }
      }
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

// ---------------------------------------------------------------------------
// Copy parts list
// ---------------------------------------------------------------------------
function cell(text: string): string {
  // Literal text: markdown-it lets any ASCII punctuation be backslash-escaped,
  // and the preview renders HTML, so the angle brackets and ampersand become
  // entities, which decode to the character rather than starting markup.
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[!"#$'()*+\-.:[\\\]^_`{|}~]/g, '\\$&')
    .replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/**
 * A Markdown table of the parts: `| Part | Assembly | Qty | Triangles |`. The
 * assembly is the path of assemblies above the part, joined by " / ". Parts with
 * the same name, path and triangle count are one row with their quantity.
 * Triangles is one part's.
 */
export function partsMarkdown(root: PartNode): string {
  const rows = new Map<string, { name: string; path: string[]; qty: number; triangles: number }>();
  const walk = (node: PartNode, path: string[]) => {
    if (node.children.length > 0) {
      for (const child of node.children) {
        walk(child, [...path, node.name]);
      }
      return;
    }
    const triangles = rangeTriangles(node.ranges);
    // A structured key: a name that itself holds " / " cannot collide with a path.
    const key = JSON.stringify([path, node.name, triangles]);
    const row = rows.get(key);
    if (row) {
      row.qty++;
    } else {
      rows.set(key, { name: node.name, path, qty: 1, triangles });
    }
  };
  for (const child of root.children) {
    walk(child, []);
  }
  const lines = ['| Part | Assembly | Qty | Triangles |', '| --- | --- | ---: | ---: |'];
  for (const row of rows.values()) {
    lines.push(
      `| ${cell(row.name)} | ${cell(row.path.join(' / '))} | ${row.qty} | ${row.triangles} |`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// STL: one part per `solid`
// ---------------------------------------------------------------------------
/**
 * The part tree of an STL: one part per solid, in file order. The ranges and
 * names are STLLoader's own (`geometry.groups`, in vertices, and
 * `geometry.userData.groupNames`), so they agree with what is drawn whatever the
 * loader accepts (a byte order mark, a closing name made of syntax words). An
 * empty solid (a zero-count group) is skipped, keeping its index into the names.
 * A file with no more than one drawable solid, or whose drawable groups do not
 * tile `total` triangles, is one part.
 */
export function stlPartTree(
  groups: ReadonlyArray<{ start: number; count: number }>,
  groupNames: unknown,
  total: number,
): PartNode {
  const builder = new PartTreeBuilder(total);
  const drawable = groups.filter((group) => group.count !== 0);
  let tiled = drawable.length > 1;
  let cursor = 0;
  for (const group of drawable) {
    if (group.start !== cursor || group.count % 3 !== 0) {
      tiled = false;
      break;
    }
    cursor += group.count;
  }
  if (tiled && cursor / 3 === total) {
    const given = Array.isArray(groupNames) ? groupNames : [];
    groups.forEach((group, i) => {
      if (group.count === 0) {
        return;
      }
      // The loader reads `solid\s(.+)`: an unnamed solid takes the next line as its name.
      const raw = typeof given[i] === 'string' ? given[i].trim() : '';
      const name = /^(facet\s+normal|endsolid)(\s|$)/.test(raw) ? '' : raw;
      builder.leaf(name, [[group.start / 3, group.count / 3]]);
    });
  } else {
    builder.leaf('', [[0, total]]);
  }
  return builder.finish();
}
