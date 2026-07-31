// Reading a workbook's structure: which sheets it has, where their parts live,
// which date system it uses, and its shared string table.
import { attr, boolAttr, walkXml } from './xml';
import { partForRels, partText, resolveTarget, WorkbookError, type Parts } from './zip';

export interface SheetRef {
  name: string;
  /** Zip path of the worksheet part. */
  path: string;
  /** `hidden` and `veryHidden` sheets are not shown. */
  hidden: boolean;
}

export interface Workbook {
  sheets: SheetRef[];
  /** Zip path of the workbook part, which is not always xl/workbook.xml. */
  path: string;
  /** Relationships declared by the workbook part, for locating styles. */
  rels: Rels;
  /**
   * True when the workbook counts days from 1904-01-01 rather than 1899-12-30.
   * Rare (it was the old Mac default) and cheap to honour; ignoring it puts every
   * date in the file out by four years and a day.
   */
  date1904: boolean;
  sharedStrings: string[];
}

/** Relationship id -> target, resolved to a zip path. */
export type Rels = Map<string, string>;

export function readWorkbook(parts: Parts): Workbook {
  const workbookPath = findWorkbookPart(parts);
  const workbookXml = partText(parts, workbookPath);
  if (workbookXml === undefined) {
    throw new WorkbookError('this workbook has no workbook part.');
  }

  const relsPath = workbookPath.replace(/([^/]+)$/, '_rels/$1.rels');
  const rels = readRels(parts, relsPath);

  const sheets: SheetRef[] = [];
  let date1904 = false;

  walkXml(workbookXml, {
    open(name, attrs) {
      if (name === 'workbookPr') {
        // Both spellings are in the wild: `date1904` is the original, `dateCompatibility`
        // appears in the transitional schema.
        date1904 = boolAttr(attrs, 'date1904') || boolAttr(attrs, 'date1904Compatibility');
      } else if (name === 'sheet') {
        const id = attr(attrs, 'id');
        const target = id === undefined ? undefined : rels.get(id);
        if (target === undefined) {
          // A <sheet> whose relationship is missing has no part to read. Skip it
          // rather than failing the whole workbook: the other sheets are fine.
          return;
        }
        const state = attr(attrs, 'state');
        sheets.push({
          name: attr(attrs, 'name') ?? `Sheet${sheets.length + 1}`,
          path: target,
          // A preview that shows what the author deliberately hid is a bug, so
          // both hidden states are honoured. `sheetId` is deliberately unused: it
          // identifies nothing about where the part lives, only `r:id` does.
          hidden: state === 'hidden' || state === 'veryHidden',
        });
      }
    },
  });

  if (sheets.length === 0) {
    throw new WorkbookError('this workbook has no sheets.');
  }

  return {
    sheets,
    path: workbookPath,
    rels,
    date1904,
    sharedStrings: readSharedStrings(parts, rels, workbookPath),
  };
}

/**
 * Locate the workbook part through the package relationships.
 *
 * Deliberately not hardcoded to `xl/workbook.xml`. That is only a convention:
 * the officeDocument relationship in `_rels/.rels` is what actually says where
 * the workbook lives, and writers do put it elsewhere.
 */
function findWorkbookPart(parts: Parts): string {
  const rootRels = partText(parts, '_rels/.rels');
  if (rootRels !== undefined) {
    let found: string | undefined;
    walkXml(rootRels, {
      open(name, attrs) {
        if (name !== 'Relationship' || found !== undefined) {
          return;
        }
        const type = attr(attrs, 'Type') ?? '';
        const target = attr(attrs, 'Target');
        if (target && /\/officeDocument$/.test(type)) {
          found = resolveTarget(partForRels('_rels/.rels'), target);
        }
      },
    });
    if (found !== undefined && parts.has(found)) {
      return found;
    }
  }
  // Fall back to the conventional location, so a package with a damaged or
  // missing root relationship part still previews.
  if (parts.has('xl/workbook.xml')) {
    return 'xl/workbook.xml';
  }
  throw new WorkbookError('this workbook has no workbook part.');
}

function readRels(parts: Parts, relsPath: string): Rels {
  const out: Rels = new Map();
  const xml = partText(parts, relsPath);
  if (xml === undefined) {
    return out;
  }
  walkXml(xml, {
    open(name, attrs) {
      if (name !== 'Relationship') {
        return;
      }
      const id = attr(attrs, 'Id');
      const target = attr(attrs, 'Target');
      if (!id || !target) {
        return;
      }
      // An external relationship points outside the package: another workbook on
      // a share, a remote image, a DDE or OLE link. Following one would turn
      // opening a file into a network fetch, which on Windows can leak
      // credentials to whatever host it names. The preview reads the package and
      // nothing else.
      if (attr(attrs, 'TargetMode') === 'External') {
        return;
      }
      out.set(id, resolveTarget(partForRels(relsPath), target));
    },
  });
  return out;
}

/**
 * The shared string table, indexed by the `t="s"` cells that reference it.
 *
 * A string is the concatenation of its `<t>` runs, but phonetic guides (`<rPh>`,
 * the furigana above Japanese text) also contain `<t>` and are not part of the
 * value. Including them doubles every such cell.
 */
function readSharedStrings(parts: Parts, workbookRels: Rels, workbookPath: string): string[] {
  const path = findPart(
    parts,
    workbookRels,
    /\/sharedStrings$/,
    resolveTarget(workbookPath, 'sharedStrings.xml'),
  );
  const xml = path === undefined ? undefined : partText(parts, path);
  if (xml === undefined) {
    return [];
  }

  const out: string[] = [];
  let current = '';
  let depth = 0; // inside <si>
  let phonetic = 0; // inside <rPh> or <phoneticPr>
  let inText = false;

  walkXml(xml, {
    open(name) {
      if (name === 'si') {
        depth++;
        current = '';
      } else if (name === 'rPh' || name === 'phoneticPr') {
        phonetic++;
      } else if (name === 't') {
        inText = true;
      }
    },
    text(text) {
      if (inText && depth > 0 && phonetic === 0) {
        current += text;
      }
    },
    close(name) {
      if (name === 'si') {
        depth--;
        out.push(current);
        current = '';
      } else if (name === 'rPh' || name === 'phoneticPr') {
        phonetic = Math.max(0, phonetic - 1);
      } else if (name === 't') {
        inText = false;
      }
    },
  });
  return out;
}

/** A related part by relationship type, falling back to a conventional path. */
export function findPart(
  parts: Parts,
  rels: Rels,
  type: RegExp,
  fallback: string,
): string | undefined {
  for (const target of rels.values()) {
    if (type.test(relTypeOf(target))) {
      return target;
    }
  }
  return parts.has(fallback) ? fallback : undefined;
}

// Relationship targets are resolved to paths by the time they reach us, so the
// type is inferred from the filename. Good enough to pick sharedStrings/styles
// apart from worksheets, which is all this is used for.
function relTypeOf(target: string): string {
  const file = target.substring(target.lastIndexOf('/') + 1);
  return '/' + file.replace(/\.xml$/i, '');
}

export { readRels };
