// @vitest-environment node
import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import { hasImageOps, imageCoverageOps, recolourKeepingImages } from '../src/webview/pdfRecolour';

// The helper imports the browser build for its operator codes; Node wants the
// legacy build, whose codes are identical.
vi.mock('pdfjs-dist', () => import('pdfjs-dist/legacy/build/pdf.mjs'));

// RGBA pixels, alpha 255 unless given.
function px(...pixels: number[][]): Uint8ClampedArray {
  return new Uint8ClampedArray(pixels.flatMap(([r, g, b, a = 255]) => [r, g, b, a]));
}
const CLEAR = [0, 0, 0, 0];
const COVERED = [0, 0, 0, 255];

// A one-page PDF built by hand: `content` is the page stream, `extra` any
// further objects (numbered from 5), `resources` the page resource dictionary.
function makePdf(content: string, resources = '<< >>', extra: string[] = []): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources ${resources} /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...extra,
  ];
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

// A 1x1 inline RGB image of the given colour, drawn into the unit square.
function inlineImage(r: number, g: number, b: number): string {
  return `BI /W 1 /H 1 /CS /RGB /BPC 8 ID ${String.fromCharCode(r, g, b)} EI`;
}

async function operatorList(pdf: Uint8Array) {
  const task = getDocument({ data: pdf, isEvalSupported: false });
  try {
    const page = await (await task.promise).getPage(1);
    const { fnArray, argsArray } = await page.getOperatorList();
    return { fnArray, argsArray };
  } finally {
    await task.destroy();
  }
}

function kept(list: { fnArray: number[]; argsArray: unknown[] }): number[] {
  const keep = imageCoverageOps(list.fnArray, list.argsArray);
  return list.fnArray.filter((_, i) => keep[i]);
}

describe('hasImageOps', () => {
  it('finds raster image paints but not image masks', () => {
    expect(hasImageOps([OPS.save, OPS.paintImageXObject, OPS.restore])).toBe(true);
    expect(hasImageOps([OPS.save, OPS.paintImageMaskXObject, OPS.restore])).toBe(false);
    expect(hasImageOps([])).toBe(false);
  });
});

describe('imageCoverageOps', () => {
  it('drops text and filled paths but keeps images, clips, and state', () => {
    const fnArray = [
      OPS.save,
      OPS.transform,
      OPS.constructPath, // fill
      OPS.beginText,
      OPS.showText,
      OPS.endText,
      OPS.clip,
      OPS.constructPath, // clip path, ended with n
      OPS.paintImageXObject,
      OPS.restore,
    ];
    const argsArray: unknown[] = fnArray.map(() => []);
    argsArray[2] = [OPS.fill, [], null];
    argsArray[7] = [OPS.endPath, [], null];
    expect(imageCoverageOps(fnArray, argsArray)).toEqual([
      true,
      true,
      false,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('keeps a painting path that carries a pending clip', () => {
    const fnArray = [OPS.clip, OPS.constructPath, OPS.constructPath];
    const argsArray = [[], [OPS.fill, [], null], [OPS.fill, [], null]];
    expect(imageCoverageOps(fnArray, argsArray)).toEqual([true, true, false]);
  });

  it('keeps everything inside a soft-mask group, nested groups included', () => {
    const fnArray = [
      OPS.beginGroup,
      OPS.beginGroup,
      OPS.constructPath,
      OPS.endGroup,
      OPS.showText,
      OPS.endGroup,
      OPS.showText,
    ];
    const argsArray: unknown[] = [
      [{ smask: { subtype: 'Luminosity' } }],
      [{ isolated: true }],
      [OPS.fill, [], null],
      [],
      [],
      [],
      [],
    ];
    expect(imageCoverageOps(fnArray, argsArray)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});

// Regressions on operator lists pdf.js itself produces for small hand-built PDFs.
describe('imageCoverageOps on real pdf.js operator lists', () => {
  it('keeps a full-page white image and drops the vector ink drawn over it', async () => {
    const list = await operatorList(
      makePdf(`q 100 0 0 100 0 0 cm ${inlineImage(255, 255, 255)} Q 0 g 20 45 60 10 re f`),
    );
    expect(hasImageOps(list.fnArray)).toBe(true);
    const ops = kept(list);
    expect(ops.some((fn) => fn === OPS.paintInlineImageXObject)).toBe(true);
    expect(ops).not.toContain(OPS.constructPath);
  });

  it('keeps an image that builds a luminosity soft mask, so masked vector content is not taken for an image', async () => {
    const maskForm = `q 100 0 0 100 0 0 cm ${inlineImage(255, 255, 255)} Q`;
    const list = await operatorList(
      makePdf(
        `q /GS1 gs 0 g 20 45 60 10 re f Q q 30 0 0 30 5 5 cm ${inlineImage(200, 30, 40)} Q`,
        '<< /ExtGState << /GS1 << /SMask << /S /Luminosity /G 5 0 R >> >> >> >>',
        [
          `<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /CS /DeviceRGB >> /Length ${maskForm.length} >>\nstream\n${maskForm}\nendstream`,
        ],
      ),
    );
    const keep = imageCoverageOps(list.fnArray, list.argsArray);
    const maskStart = list.fnArray.findIndex(
      (fn, i) =>
        fn === OPS.beginGroup &&
        !!((list.argsArray[i] as unknown[])[0] as { smask?: unknown }).smask,
    );
    expect(maskStart).toBeGreaterThanOrEqual(0);
    const images = list.fnArray
      .map((fn, i) => (fn === OPS.paintInlineImageXObject ? i : -1))
      .filter((i) => i >= 0);
    expect(images).toHaveLength(2);
    // Both the mask-building image and the visible picture run.
    expect(images.every((i) => keep[i])).toBe(true);
    // The masked black rectangle, outside the mask group, does not.
    const fills = list.fnArray
      .map((fn, i) => (fn === OPS.constructPath && i > maskStart ? i : -1))
      .filter((i) => i >= 0 && (list.argsArray[i] as unknown[])[0] === OPS.fill);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((i) => !keep[i])).toBe(true);
  });
});

describe('recolourKeepingImages', () => {
  it('inverts uncovered pixels and keeps covered ones, white included', () => {
    // paper, text, white photo pixel, red photo pixel, paper, paper, paper, paper
    const page = px(
      [255, 255, 255],
      [0, 0, 0],
      [255, 255, 255],
      [200, 30, 40],
      [255, 255, 255],
      [255, 255, 255],
      [255, 255, 255],
      [255, 255, 255],
    );
    const coverage = px(CLEAR, CLEAR, COVERED, COVERED, CLEAR, CLEAR, CLEAR, CLEAR);
    expect(recolourKeepingImages(page, coverage, 'inverted')).toBe(true);
    expect(Array.from(page)).toEqual(
      Array.from(
        px(
          [0, 0, 0],
          [255, 255, 255],
          [255, 255, 255],
          [200, 30, 40],
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ),
      ),
    );
  });

  it('tints the inverted page green but leaves images alone', () => {
    const page = px([255, 255, 255], [0, 0, 0], [10, 20, 30], [255, 255, 255]);
    const coverage = px(CLEAR, CLEAR, COVERED, CLEAR);
    expect(recolourKeepingImages(page, coverage, 'green', [0, 255, 0])).toBe(true);
    expect(Array.from(page)).toEqual(
      Array.from(px([0, 0, 0], [0, 255, 0], [10, 20, 30], [0, 0, 0])),
    );
  });

  it('blends a partly covered edge between inverted and true colour', () => {
    const page = px([255, 255, 255], [0, 0, 0], [0, 0, 0], [0, 0, 0]);
    const coverage = px([0, 0, 0, 51], CLEAR, CLEAR, CLEAR);
    recolourKeepingImages(page, coverage, 'inverted');
    expect(Array.from(page.slice(0, 3))).toEqual([51, 51, 51]);
  });

  it('declines a white-paper scan with black ink, however few pixels differ in colour', () => {
    // A full-page image of white paper and a little black ink: the coverage is
    // the whole page even though most of it matches blank paper.
    const page = px([255, 255, 255], [0, 0, 0], [255, 255, 255], [255, 255, 255]);
    const coverage = px(COVERED, COVERED, COVERED, COVERED);
    const before = Array.from(page);
    expect(recolourKeepingImages(page, coverage, 'inverted')).toBe(false);
    expect(recolourKeepingImages(page, coverage, 'green')).toBe(false);
    expect(Array.from(page)).toEqual(before);
  });
});
