// word/numbering.xml: which list a paragraph belongs to and how it is marked.
//
// A paragraph points at a `numId`; a `w:num` points at an `abstractNum`; the
// abstract definition lists one `w:lvl` per indent level with its number
// format and start value. A `w:num` may override the start of a level (a
// restarted list). That is the whole of what the preview needs: bullet or
// ordered, which marker style, and where the count starts.
import { attr, intAttr } from '../../ooxml/xml';
import { child, children, parseXml, type XNode } from '../../ooxml/xnode';

export interface LevelDef {
  /** `bullet`, `decimal`, `lowerLetter`, `upperRoman`, `none`, and so on. */
  fmt: string;
  start: number;
  /** This instance restarts the level at `start` the first time it is used. */
  restart?: boolean;
}

interface NumDef {
  abstractId?: string;
  over: Map<number, LevelDef>;
}

export class Numbering {
  private readonly abstracts = new Map<string, Map<number, LevelDef>>();
  private readonly nums = new Map<string, NumDef>();

  constructor(xml: string | undefined) {
    if (xml === undefined) {
      return;
    }
    const root = parseXml(xml).children[0];
    if (root === undefined) {
      return;
    }
    for (const a of children(root, 'abstractNum')) {
      const id = attr(a.attrs, 'abstractNumId');
      if (id === undefined) {
        continue;
      }
      const levels = new Map<number, LevelDef>();
      for (const lvl of children(a, 'lvl')) {
        const ilvl = intAttr(lvl.attrs, 'ilvl');
        if (ilvl !== undefined) {
          levels.set(ilvl, readLevel(lvl));
        }
      }
      this.abstracts.set(id, levels);
    }
    for (const n of children(root, 'num')) {
      const id = attr(n.attrs, 'numId');
      if (id === undefined) {
        continue;
      }
      const over = new Map<number, LevelDef>();
      for (const o of children(n, 'lvlOverride')) {
        const ilvl = intAttr(o.attrs, 'ilvl');
        if (ilvl === undefined) {
          continue;
        }
        const full = child(o, 'lvl');
        const startOverride = child(o, 'startOverride');
        const base = full === undefined ? undefined : readLevel(full);
        const start = startOverride && intAttr(startOverride.attrs, 'val');
        if (base !== undefined || start !== undefined) {
          over.set(ilvl, {
            fmt: base?.fmt ?? '',
            start: start ?? base?.start ?? 1,
            restart: true,
          });
        }
      }
      this.nums.set(id, {
        abstractId: attr(child(n, 'abstractNumId')?.attrs ?? {}, 'val'),
        over,
      });
    }
  }

  /**
   * The marker definition for one level of one list.
   *
   * An unknown list falls back to a bullet: a paragraph that names a list the
   * file never defines is still a list item, and a bullet claims no count.
   */
  level(numId: string, ilvl: number): LevelDef {
    const num = this.nums.get(numId);
    const base = num?.abstractId === undefined ? undefined : this.abstracts.get(num.abstractId);
    const def = base?.get(ilvl);
    const over = num?.over.get(ilvl);
    return {
      fmt: over?.fmt || def?.fmt || 'bullet',
      start: over?.start ?? def?.start ?? 1,
      restart: over?.restart === true,
    };
  }

  /** Counting is per abstract definition; an instance of an unknown one counts alone. */
  abstractKey(numId: string): string {
    return this.nums.get(numId)?.abstractId ?? `num:${numId}`;
  }
}

function readLevel(lvl: XNode): LevelDef {
  const fmt = attr(child(lvl, 'numFmt')?.attrs ?? {}, 'val') ?? 'decimal';
  const start = child(lvl, 'start');
  return { fmt, start: (start && intAttr(start.attrs, 'val')) ?? 1 };
}
