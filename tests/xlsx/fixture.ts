// Building .xlsx fixtures as exact zip bytes.
//
// Deliberately hand-authored rather than produced by a writer library. The bugs
// this reader has to survive are precisely the things a writer normalizes away:
// `t="str"` versus `t="s"`, a formula with no cached `<v>`, phonetic `<rPh>` runs,
// a cell with no `r` attribute, the 1904 date system, a hidden sheet. A library
// would emit its own house style and none of those cases would ever be exercised.
import { zipSync, strToU8 } from 'fflate';

export interface SheetSpec {
  name: string;
  /** Raw <sheetData> children and any sibling elements, verbatim. */
  xml: string;
  hidden?: boolean;
}

export interface WorkbookSpec {
  sheets: SheetSpec[];
  sharedStrings?: string[];
  /** Raw <numFmts> and <cellXfs> content, for the styles part. */
  numFmts?: { id: number; code: string }[];
  /** One entry per cellXfs record: the numFmtId it points at. */
  cellXfs?: number[];
  date1904?: boolean;
  /** Extra parts, or overrides, keyed by zip path. */
  extra?: Record<string, string>;
}

export function buildXlsx(spec: WorkbookSpec): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, text: string): void => {
    files[path] = strToU8(text);
  };

  put(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
</Types>`,
  );

  put(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  );

  const sheetEntries = spec.sheets
    .map(
      (s, i) =>
        `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.hidden ? ' state="hidden"' : ''}/>`,
    )
    .join('');

  put(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${spec.date1904 ? '<workbookPr date1904="1"/>' : ''}
<sheets>${sheetEntries}</sheets>
</workbook>`,
  );

  const sheetRels = spec.sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('');
  const extraRels: string[] = [];
  if (spec.sharedStrings) {
    extraRels.push(
      `<Relationship Id="rIdSst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`,
    );
  }
  if (spec.cellXfs) {
    extraRels.push(
      `<Relationship Id="rIdSty" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    );
  }
  put(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}${extraRels.join('')}</Relationships>`,
  );

  spec.sheets.forEach((s, i) => {
    put(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${s.xml}</worksheet>`,
    );
  });

  if (spec.sharedStrings) {
    const items = spec.sharedStrings.map((t) => `<si>${t}</si>`).join('');
    put(
      'xl/sharedStrings.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${spec.sharedStrings.length}">${items}</sst>`,
    );
  }

  if (spec.cellXfs) {
    const numFmts = (spec.numFmts ?? [])
      .map((f) => `<numFmt numFmtId="${f.id}" formatCode="${f.code}"/>`)
      .join('');
    const xfs = spec.cellXfs.map((id) => `<xf numFmtId="${id}" xfId="0"/>`).join('');
    put(
      'xl/styles.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${numFmts ? `<numFmts count="${spec.numFmts!.length}">${numFmts}</numFmts>` : ''}
<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>
<cellXfs count="${spec.cellXfs.length}">${xfs}</cellXfs>
</styleSheet>`,
    );
  }

  for (const [path, text] of Object.entries(spec.extra ?? {})) {
    put(path, text);
  }

  return zipSync(files);
}

/** `<sheetData>` wrapping numbered rows, for the common case. */
export function sheetData(rows: string[]): string {
  return `<sheetData>${rows.join('')}</sheetData>`;
}

/** One `<row>` at 1-based `index`, holding raw `<c>` elements. */
export function row(index: number, cells: string, attrs = ''): string {
  return `<row r="${index}"${attrs}>${cells}</row>`;
}
