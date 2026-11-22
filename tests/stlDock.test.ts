// @vitest-environment node
//
// The right-hand dock of the 3D viewer: Parts and Section share one column of the
// section panel's width, stacked when both are open, so the 3D view never drops
// below half of the pane. The rules live in two places (the inline style of
// src/stlEditor.ts and media/preview.css), so this reads both and works out the
// layout the way a browser cascades them. jsdom has no layout, so what it looks
// like is a manual check (docs/TESTING.md).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const css = [
  readFileSync(join(root, 'src', 'stlEditor.ts'), 'utf8'),
  readFileSync(join(root, 'media', 'preview.css'), 'utf8'),
].join('\n');

interface Rule {
  selector: string;
  decls: Record<string, string>;
  order: number;
}

// Rules written as `selector { prop: value; ... }`; comments are dropped. Only
// the flat rules this layout uses are read (no @media nesting).
const rules: Rule[] = [];
const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
for (const match of text.matchAll(/([^{}@;`]+)\{([^{}]*)\}/g)) {
  const decls: Record<string, string> = {};
  for (const part of match[2].split(';')) {
    const at = part.indexOf(':');
    if (at > 0) {
      decls[part.slice(0, at).trim()] = part.slice(at + 1).trim();
    }
  }
  for (const selector of match[1].split(',')) {
    rules.push({ selector: selector.trim(), decls, order: rules.length });
  }
}

// `body.a.b #id` or `#id`: the body classes it needs, and its weight.
function matches(selector: string, id: string, classes: string[]): number {
  const m = /^(?:body((?:\.[\w-]+)*)\s+)?#([\w-]+)$/.exec(selector);
  if (!m || m[2] !== id) {
    return -1;
  }
  const needed = (m[1] ?? '').split('.').filter(Boolean);
  return needed.every((c) => classes.includes(c)) ? 1 + needed.length : -1;
}

function style(id: string, prop: string, classes: string[]): string | undefined {
  let best: { weight: number; order: number; value: string } | undefined;
  for (const rule of rules) {
    const weight = matches(rule.selector, id, classes);
    if (weight < 0 || rule.decls[prop] === undefined) {
      continue;
    }
    if (!best || weight > best.weight || (weight === best.weight && rule.order > best.order)) {
      best = { weight, order: rule.order, value: rule.decls[prop] };
    }
  }
  return best?.value;
}

function dockWidth(): string {
  const value = /--mc-dock-w:\s*([^;]+);/.exec(text);
  expect(value).not.toBeNull();
  return (value as RegExpExecArray)[1].trim();
}

/** A length in px of `value`, given the pane width: `46%`, `var(--mc-dock-w)` or `0`. */
function px(value: string | undefined, pane: number): number {
  if (value === undefined || value === 'auto') {
    return 0;
  }
  const v = value.replace(/var\(--mc-dock-w(?:,\s*[^)]+)?\)/, dockWidth());
  return v.endsWith('%') ? (parseFloat(v) / 100) * pane : parseFloat(v);
}

const viewportWidth = (pane: number, classes: string[]): number =>
  pane -
  px(style('viewport', 'left', classes), pane) -
  px(style('viewport', 'right', classes), pane);

describe('the right-hand dock', () => {
  const cases: Array<[string, string[]]> = [
    ['Parts only', ['mc-parts']],
    ['Section only', ['mc-section']],
    ['Parts and Section', ['mc-parts', 'mc-section']],
  ];

  for (const pane of [800, 1200]) {
    for (const [label, classes] of cases) {
      it(`leaves the 3D view at least half of a ${pane}px pane: ${label}`, () => {
        expect(viewportWidth(pane, classes)).toBeGreaterThanOrEqual(pane / 2);
      });
    }
  }

  it('is as wide with Parts and Section together as with Section alone', () => {
    expect(viewportWidth(800, ['mc-parts', 'mc-section'])).toBe(viewportWidth(800, ['mc-section']));
    expect(viewportWidth(800, ['mc-parts'])).toBe(viewportWidth(800, ['mc-section']));
  });

  it('puts the panels in the dock on the right, at its width', () => {
    for (const id of ['parts', 'section']) {
      expect(style(id, 'right', [])).toBe('0');
      expect(style(id, 'width', [])).toMatch(/--mc-dock-w/);
    }
    expect(style('parts', 'left', ['mc-parts'])).toBeUndefined();
  });

  it('stacks them when both are open, Parts above Section, without overlap', () => {
    const both = ['mc-parts', 'mc-section'];
    expect(style('parts', 'top', both)).toBe('0');
    expect(style('parts', 'bottom', both)).toBe('50%');
    expect(style('section', 'top', both)).toBe('50%');
    expect(style('section', 'bottom', both)).toBe('0');
    // Alone, each takes the full height.
    expect(style('section', 'top', ['mc-section'])).toBe('0');
    expect(style('parts', 'bottom', ['mc-parts'])).toBe('0');
  });
});
