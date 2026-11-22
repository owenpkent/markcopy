// Coverage for src/webview/parts.ts: the part tree builder and its caps, name
// cleaning, the rows with quantities, the range lookup used for picking, the
// geometry groups, the Markdown parts list and the STL solid reader.
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { createMarkdownIt } from '../src/render';
import { describe, expect, it } from 'vitest';
import {
  HIDDEN,
  HIGHLIGHT,
  MAX_PART_NAME,
  MORE_PARTS,
  NORMAL,
  PartTreeBuilder,
  buildPartModel,
  buildSegments,
  cleanPartName,
  drawGroups,
  findLeaf,
  leafBounds,
  partsMarkdown,
  stlPartTree,
  type PartNode,
} from '../src/webview/parts';

const names = (node: PartNode): string[] => node.children.map((c) => c.name);

describe('cleanPartName', () => {
  it('strips controls and bidi overrides and folds whitespace', () => {
    expect(cleanPartName('  Bolt\u0000\n  M3\t‮evil‬ ')).toBe('Bolt M3 evil');
  });

  it('caps the length and never ends on half a surrogate pair', () => {
    const long = cleanPartName('a'.repeat(5000));
    expect(long.length).toBe(MAX_PART_NAME);
    expect(long.endsWith('…')).toBe(true);
    const emoji = cleanPartName('😀'.repeat(300));
    expect(emoji.length).toBeLessThanOrEqual(MAX_PART_NAME);
    expect(emoji).not.toMatch(/[\ud800-\udbff]…$/);
  });

  it('gives an empty string for anything that is not a usable name', () => {
    expect(cleanPartName(undefined)).toBe('');
    expect(cleanPartName(42)).toBe('');
    expect(cleanPartName('\u0000\u0001  ')).toBe('');
  });

  it('keeps markup as plain text for textContent to show', () => {
    expect(cleanPartName('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('PartTreeBuilder', () => {
  it('names unnamed nodes Assembly N and Part N in tree order', () => {
    const b = new PartTreeBuilder(10);
    b.begin();
    b.leaf('', [[0, 3]]);
    b.leaf(undefined, [[3, 3]]);
    b.end();
    b.leaf('', [[6, 4]]);
    const tree = b.finish();
    expect(names(tree)).toEqual(['Assembly 1', 'Part 3']);
    expect(names(tree.children[0])).toEqual(['Part 1', 'Part 2']);
  });

  it('drops an assembly with nothing in it, and a part with no triangles', () => {
    const b = new PartTreeBuilder(10);
    b.begin('empty');
    b.end();
    b.leaf('none', [[0, 0]]);
    b.leaf('outside', [[50, 3]]);
    b.leaf('kept', [[8, 9]]);
    const tree = b.finish();
    expect(names(tree)).toEqual(['kept']);
    // Clipped to the 10 triangles of the geometry.
    expect(tree.children[0].ranges).toEqual([[8, 2]]);
  });

  it('gathers parts past the node cap under one More parts node, never throwing', () => {
    const b = new PartTreeBuilder(100, { maxNodes: 5 });
    b.begin('group');
    for (let i = 0; i < 50; i++) {
      b.leaf(`p${i}`, [[i, 1]]);
    }
    b.end();
    const tree = b.finish();
    const more = tree.children.find((c) => c.name === MORE_PARTS);
    expect(more).toBeDefined();
    // Adjacent ranges merge, so thousands of parts stay a short list.
    expect(more?.ranges).toEqual([[4, 46]]);
    expect(tree.children[0].children).toHaveLength(4);
  });

  it('caps depth: assemblies past it add no level, their parts land in the last one', () => {
    const b = new PartTreeBuilder(10, { maxDepth: 3 });
    for (let i = 0; i < 100; i++) {
      b.begin(`a${i}`);
    }
    b.leaf('deep', [[0, 1]]);
    for (let i = 0; i < 100; i++) {
      b.end();
    }
    let node = b.finish();
    let depth = 0;
    while (node.children.length > 0) {
      node = node.children[0];
      depth++;
    }
    expect(depth).toBe(4);
    expect(node.name).toBe('deep');
  });

  it('handles a tree of 25,000 parts without throwing', () => {
    const b = new PartTreeBuilder(25_000);
    for (let i = 0; i < 25_000; i++) {
      b.leaf(`p${i}`, [[i, 1]]);
    }
    const tree = b.finish();
    expect(tree.children.length).toBeLessThanOrEqual(20_001);
  });
});

function sample(): PartNode {
  // Assembly "Kit": a Plate, and a Peg twice. A lone Plate sits beside it.
  const b = new PartTreeBuilder(60);
  b.begin('Kit');
  b.leaf('Plate', [[0, 12]]);
  b.leaf('Peg', [[12, 12]]);
  b.leaf('Peg', [[24, 12]]);
  b.end();
  b.leaf('Plate', [[36, 20]]);
  return b.finish();
}

describe('buildPartModel', () => {
  it('folds identical siblings into one row with a quantity and keeps the instances', () => {
    const model = buildPartModel(sample());
    expect(model.leaves).toHaveLength(4);
    const kit = model.items[0];
    expect(kit.kind).toBe('assembly');
    expect(kit.triangles).toBe(36);
    expect(kit.children.map((c) => [c.name, c.kind, c.qty])).toEqual([
      ['Plate', 'part', 1],
      ['Peg', 'group', 2],
    ]);
    const pegs = kit.children[1];
    expect(pegs.triangles).toBe(12);
    expect(pegs.children.map((c) => c.leaf)).toEqual([1, 2]);
    expect(pegs.leafFrom).toBe(1);
    expect(pegs.leafTo).toBe(3);
  });

  it('does not fold siblings with the same name but another triangle count', () => {
    const model = buildPartModel(sample());
    // The two Plates are in different parents, and 12 is not 20 anyway.
    expect(model.items.map((i) => i.name)).toEqual(['Kit', 'Plate']);
    const b = new PartTreeBuilder(40);
    b.leaf('Plate', [[0, 12]]);
    b.leaf('Plate', [[12, 20]]);
    const flat = buildPartModel(b.finish());
    expect(flat.items.map((i) => [i.kind, i.qty])).toEqual([
      ['part', 1],
      ['part', 1],
    ]);
  });

  it('numbers leaves in row order, so a row owns a contiguous run', () => {
    const b = new PartTreeBuilder(40);
    b.leaf('A', [[0, 10]]);
    b.leaf('B', [[10, 10]]);
    b.leaf('A', [[20, 10]]);
    const model = buildPartModel(b.finish());
    // A, A folded and listed first; B after.
    expect(model.leaves.map((l) => l.name)).toEqual(['A', 'A', 'B']);
    expect(model.items[0].leafFrom).toBe(0);
    expect(model.items[0].leafTo).toBe(2);
  });

  it('records each leaf with its assembly path', () => {
    const model = buildPartModel(sample());
    expect(model.leaves.map((l) => l.path)).toEqual([['Kit'], ['Kit'], ['Kit'], []]);
  });
});

describe('findLeaf', () => {
  it('finds the part of a triangle by binary search over the sorted ranges', () => {
    // Out of order on purpose: a part may hold several ranges.
    const segments = buildSegments([
      { ranges: [[20, 5]] },
      {
        ranges: [
          [0, 10],
          [30, 10],
        ],
      },
      { ranges: [[10, 10]] },
    ]);
    expect(findLeaf(segments, 0)).toBe(1);
    expect(findLeaf(segments, 9)).toBe(1);
    expect(findLeaf(segments, 10)).toBe(2);
    expect(findLeaf(segments, 19)).toBe(2);
    expect(findLeaf(segments, 20)).toBe(0);
    expect(findLeaf(segments, 24)).toBe(0);
    expect(findLeaf(segments, 25)).toBe(-1);
    expect(findLeaf(segments, 35)).toBe(1);
    expect(findLeaf(segments, 40)).toBe(-1);
    expect(findLeaf(segments, -1)).toBe(-1);
  });

  it('agrees with a linear scan over many ranges', () => {
    const leaves = Array.from({ length: 500 }, (_, i) => ({
      ranges: [[i * 4, 3] as [number, number]],
    }));
    const segments = buildSegments(leaves);
    for (let t = 0; t < 2000; t++) {
      const expected = t % 4 === 3 ? -1 : Math.floor(t / 4);
      expect(findLeaf(segments, t)).toBe(expected);
    }
  });
});

describe('drawGroups', () => {
  it('coalesces adjacent ranges in one state, so thousands of parts are a few groups', () => {
    const leaves = Array.from({ length: 5000 }, (_, i) => ({
      ranges: [[i * 2, 2] as [number, number]],
    }));
    const segments = buildSegments(leaves);
    const groups = drawGroups(
      segments,
      (leaf) => (leaf === 2500 ? HIDDEN : leaf === 10 ? HIGHLIGHT : NORMAL),
      10_000,
    );
    expect(groups).toEqual([
      { start: 0, count: 20, state: NORMAL },
      { start: 20, count: 2, state: HIGHLIGHT },
      { start: 22, count: 4978, state: NORMAL },
      { start: 5000, count: 2, state: HIDDEN },
      { start: 5002, count: 4998, state: NORMAL },
    ]);
    expect(groups.reduce((sum, g) => sum + g.count, 0)).toBe(10_000);
  });

  it('draws triangles no part claims normally', () => {
    const segments = buildSegments([{ ranges: [[5, 5]] }]);
    expect(drawGroups(segments, () => HIDDEN, 12)).toEqual([
      { start: 0, count: 5, state: NORMAL },
      { start: 5, count: 5, state: HIDDEN },
      { start: 10, count: 2, state: NORMAL },
    ]);
  });
});

describe('leafBounds', () => {
  it('takes the box of the triangles in the leaves', () => {
    // Two triangles: the first at x 0..1, the second at x 5..6.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 2, 3, 6, 2, 3, 5, 4, 3]);
    const leaves = [
      { ranges: [[0, 1]] as Array<[number, number]> },
      { ranges: [[1, 1]] as Array<[number, number]> },
    ];
    expect(leafBounds(positions, leaves, 1, 2)).toEqual({ min: [5, 2, 3], max: [6, 4, 3] });
    expect(leafBounds(positions, leaves, 0, 2)).toEqual({ min: [0, 0, 0], max: [6, 4, 3] });
    expect(leafBounds(positions, leaves, 2, 2)).toBeNull();
  });
});

describe('partsMarkdown', () => {
  it('writes the table with the assembly path and a quantity', () => {
    expect(partsMarkdown(sample())).toBe(
      [
        '| Part | Assembly | Qty | Triangles |',
        '| --- | --- | ---: | ---: |',
        '| Plate | Kit | 1 | 12 |',
        '| Peg | Kit | 2 | 12 |',
        '| Plate |  | 1 | 20 |',
      ].join('\n'),
    );
  });

  it('joins nested assemblies with " / "', () => {
    const b = new PartTreeBuilder(10);
    b.begin('Machine');
    b.begin('Arm');
    b.leaf('Bolt', [[0, 2]]);
    b.end();
    b.end();
    expect(partsMarkdown(b.finish()).split('\n')[2]).toBe('| Bolt | Machine / Arm | 1 | 2 |');
  });

  it('keeps a flat assembly named "Machine / Arm" apart from a nested Machine > Arm', () => {
    const b = new PartTreeBuilder(10);
    b.begin('Machine / Arm');
    b.leaf('Bolt', [[0, 2]]);
    b.end();
    b.begin('Machine');
    b.begin('Arm');
    b.leaf('Bolt', [[2, 2]]);
    b.end();
    b.end();
    // One row each, not '| Bolt | Machine / Arm | 2 | 2 |'.
    expect(partsMarkdown(b.finish()).split('\n').slice(2)).toEqual([
      '| Bolt | Machine / Arm | 1 | 2 |',
      '| Bolt | Machine / Arm | 1 | 2 |',
    ]);
  });

  it('renders names as literal text', () => {
    const raw: PartNode = {
      name: '',
      children: [
        { name: '<M6>', children: [], ranges: [[0, 1]] },
        { name: '**Retainer**', children: [], ranges: [[1, 1]] },
        { name: 'a|b\\c & d_e', children: [], ranges: [[2, 1]] },
      ],
      ranges: [],
    };
    const html = createMarkdownIt().render(partsMarkdown(raw));
    const dom = new DOMParser().parseFromString(html, 'text/html');
    const cells = [...dom.querySelectorAll('tbody tr')].map(
      (tr) => tr.querySelector('td')?.textContent,
    );
    expect(cells).toEqual(['<M6>', '**Retainer**', 'a|b\\c & d_e']);
    expect(dom.querySelectorAll('strong, m6')).toHaveLength(0);
  });

  it('escapes pipes, backslashes and newlines so a name cannot break the table', () => {
    const b = new PartTreeBuilder(10);
    b.begin('A | B');
    b.leaf('x\\|y', [[0, 2]]);
    b.end();
    const row = partsMarkdown(b.finish()).split('\n')[2];
    expect(row).toBe('| x\\\\\\|y | A \\| B | 1 | 2 |');
    // Newlines never reach a cell: names are cleaned when the tree is built.
    const raw: PartNode = {
      name: '',
      children: [{ name: 'a\nb|c', children: [], ranges: [[0, 1]] }],
      ranges: [],
    };
    expect(partsMarkdown(raw).split('\n')).toHaveLength(3);
    expect(partsMarkdown(raw).split('\n')[2]).toBe('| a b\\|c |  | 1 | 1 |');
  });
});

function asciiStl(solids: Array<[string, number]>): Uint8Array {
  const out: string[] = [];
  for (const [name, facets] of solids) {
    out.push(`solid ${name}`);
    for (let i = 0; i < facets; i++) {
      out.push(
        'facet normal 0 0 1',
        ' outer loop',
        '  vertex 0 0 0',
        '  vertex 1 0 0',
        '  vertex 0 1 0',
        ' endloop',
        'endfacet',
      );
    }
    out.push(`endsolid ${name}`);
  }
  return new TextEncoder().encode(out.join('\n') + '\n');
}

describe('STL solids', () => {
  const parse = (bytes: Uint8Array): PartNode => {
    const geometry = new STLLoader().parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    const total = geometry.getAttribute('position').count / 3;
    return stlPartTree(geometry.groups, geometry.userData.groupNames, total);
  };

  it('reads one part per solid, in order, with its facet count', () => {
    const tree = parse(
      asciiStl([
        ['left', 2],
        ['right', 3],
      ]),
    );
    expect(names(tree)).toEqual(['left', 'right']);
    expect(tree.children.map((c) => c.ranges)).toEqual([[[0, 2]], [[2, 3]]]);
  });

  it('is one part for a single solid or a binary file', () => {
    expect(names(parse(asciiStl([['only', 2]])))).toEqual(['Part 1']);
    expect(names(stlPartTree([], undefined, 4))).toEqual(['Part 1']);
    expect(
      names(
        stlPartTree(
          [
            { start: 0, count: 6 },
            { start: 6, count: 6 },
          ],
          ['a', 'b'],
          9,
        ),
      ),
    ).toEqual(['Part 1']);
  });

  it('keeps both solids of a file that starts with a UTF-8 byte order mark', () => {
    const plain = asciiStl([
      ['left', 2],
      ['right', 3],
    ]);
    const bom = new Uint8Array(plain.length + 3);
    bom.set([0xef, 0xbb, 0xbf]);
    bom.set(plain, 3);
    const tree = parse(bom);
    expect(names(tree)).toEqual(['left', 'right']);
    expect(tree.children.map((c) => c.ranges)).toEqual([[[0, 2]], [[2, 3]]]);
  });

  it('keeps a solid whose name holds syntax words, with its closing name', () => {
    const tree = parse(
      asciiStl([
        ['Brace facet guard', 1],
        ['Other', 1],
      ]),
    );
    expect(names(tree)).toEqual(['Brace facet guard', 'Other']);
  });

  it('leaves an unnamed solid unnamed', () => {
    const facet = [
      'facet normal 0 0 1',
      'outer loop',
      'vertex 0 0 0',
      'vertex 1 0 0',
      'vertex 0 1 0',
      'endloop',
      'endfacet',
      '',
    ].join('\n');
    const text = `solid\n${facet}endsolid\nsolid b\n${facet}endsolid b\n`;
    const tree = parse(new TextEncoder().encode(text));
    expect(names(tree)).toEqual(['Part 1', 'b']);
  });
});
