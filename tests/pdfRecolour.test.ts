// @vitest-environment node
import { fileURLToPath } from 'node:url';
import type * as NapiCanvas from '@napi-rs/canvas';
import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import {
  hasImageOps,
  imageCoverageOps,
  recolourKeepingImages,
  type Tint,
} from '../src/webview/pdfRecolour';

// The helper imports the browser build for its operator codes; Node wants the
// legacy build, whose codes are identical.
vi.mock('pdfjs-dist', () => import('pdfjs-dist/legacy/build/pdf.mjs'));

// @napi-rs/canvas is pdfjs-dist's optional Node canvas. The raster regressions
// need it and skip where it is not installed.
let napi: typeof NapiCanvas | null = null;
try {
  napi = await import('@napi-rs/canvas');
} catch {
  napi = null;
}

const STANDARD_FONTS = fileURLToPath(
  new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url),
).replace(/\\/g, '/');

// RGBA pixels, alpha 255 unless given.
function px(...pixels: number[][]): Uint8ClampedArray {
  return new Uint8ClampedArray(pixels.flatMap(([r, g, b, a = 255]) => [r, g, b, a]));
}
const CLEAR = [0, 0, 0, 0];
const COVERED = [0, 0, 0, 255];

// A one-page 100 x 100 pt PDF built by hand: `content` is the page stream,
// `resources` the page resource dictionary, `extra` further objects numbered
// from 5.
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

const RED = [200, 30, 40] as const;

// A 1x1 inline RGB image, drawn into the unit square.
function inlineImage([r, g, b]: readonly number[]): string {
  return `BI /W 1 /H 1 /CS /RGB /BPC 8 ID ${String.fromCharCode(r, g, b)} EI`;
}

// A 100 x 100 greyscale inline image of white paper with a black 60 x 10 bar
// whose lower-left corner is at (20, 45) in image units, y up.
function scanImage(): string {
  let data = '';
  for (let row = 0; row < 100; row++) {
    const y = 99 - row;
    for (let x = 0; x < 100; x++) {
      data += String.fromCharCode(x >= 20 && x < 80 && y >= 45 && y < 55 ? 0 : 255);
    }
  }
  return `BI /W 100 /H 100 /CS /G /BPC 8 ID ${data} EI`;
}

const HELVETICA = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>';

function luminosityMask(): [string, string] {
  const form = `q 100 0 0 100 0 0 cm ${inlineImage([255, 255, 255])} Q`;
  return [
    '<< /ExtGState << /GS1 << /SMask << /S /Luminosity /G 5 0 R >> >> >> >>',
    `<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /CS /DeviceRGB >> /Length ${form.length} >>\nstream\n${form}\nendstream`,
  ];
}

interface DarkPage {
  width: number;
  orig: Uint8ClampedArray; // the page in true colours
  out: Uint8ClampedArray; // the page as the dark or green viewer shows it
  keptImages: boolean; // false when the page fell back to whole-page inversion
}

// Render page 1 at 2x the way the PDF viewer does for a dark or green theme:
// a full render, then the coverage (and, if planned, paints) renders, then the
// recolour, falling back to inverting the whole page.
async function darkRender(pdf: Uint8Array, tint: Tint): Promise<DarkPage> {
  const canvasLib = napi!;
  const task = getDocument({
    data: pdf,
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONTS,
  });
  try {
    const page = await (await task.promise).getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);
    // A browser canvas returns the context it already has, whatever options a
    // later getContext call passes; pdf.js relies on that and the viewer
    // creates its scratch contexts with alpha. The native canvas needs telling.
    const surface = () => {
      const canvas = canvasLib.createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      (canvas as unknown as { getContext: () => unknown }).getContext = () => ctx;
      return { canvas, ctx };
    };
    const render = async (keep: boolean[] | null, record?: (list: unknown) => void) => {
      const { canvas, ctx } = surface();
      await page.render({
        canvas: canvas as never,
        canvasContext: ctx as never,
        viewport,
        ...(keep ? { background: 'rgba(0,0,0,0)' } : {}),
        operationsFilter: (i, list) => {
          record?.(list);
          return keep ? (keep[i] ?? true) : true;
        },
      }).promise;
      return ctx.getImageData(0, 0, width, height).data;
    };

    let list = { fnArray: [] as number[], argsArray: [] as unknown[] };
    const orig = await render(null, (l) => (list = l as typeof list));
    const out = orig.slice();
    let keptImages = false;
    if (hasImageOps(list.fnArray)) {
      const plan = imageCoverageOps(list.fnArray, list.argsArray);
      const coverage = await render(plan.coverage);
      const paints = plan.paints ? await render(plan.paints) : undefined;
      keptImages = recolourKeepingImages(out, coverage, tint, [0, 255, 0], paints);
    }
    if (!keptImages) {
      const green = tint === 'green' ? [0, 255, 0] : [255, 255, 255];
      for (let i = 0; i < out.length; i += 4) {
        for (let c = 0; c < 3; c++) out[i + c] = ((255 - out[i + c]) * green[c]) / 255;
      }
    }
    return { width, orig, out, keptImages };
  } finally {
    await task.destroy();
  }
}

type Kind = 'image' | 'page' | 'skip';

// Classify a true-colour pixel: the red test image, neutral page content
// (paper, black or grey vector and text), or an antialiased mix of the two.
function byColour(r: number, g: number, b: number): Kind {
  if (Math.abs(r - RED[0]) < 4 && Math.abs(g - RED[1]) < 4 && Math.abs(b - RED[2]) < 4) {
    return 'image';
  }
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) return 'page';
  return 'skip';
}

// Every page pixel must show inverted (or green-tinted) and every image pixel in
// its true colour. Returns how many pixels of each kind were checked.
function expectRecoloured(result: DarkPage, tint: Tint, classify = byColour) {
  const { orig, out } = result;
  const green = tint === 'green' ? [0, 255, 0] : [255, 255, 255];
  const counts = { image: 0, page: 0 };
  const wrong: string[] = [];
  for (let i = 0; i < orig.length; i += 4) {
    const kind = classify(orig[i], orig[i + 1], orig[i + 2]);
    if (kind === 'skip') continue;
    counts[kind]++;
    for (let c = 0; c < 3; c++) {
      const want = kind === 'image' ? orig[i + c] : ((255 - orig[i + c]) * green[c]) / 255;
      if (Math.abs(out[i + c] - want) > 1 && wrong.length < 5) {
        const p = i / 4;
        wrong.push(
          `${kind} pixel (${p % result.width}, ${Math.floor(p / result.width)}): ` +
            `${Array.from(out.slice(i, i + 3))} instead of about ${want} in channel ${c}`,
        );
      }
    }
  }
  expect(wrong).toEqual([]);
  return counts;
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
    const plan = imageCoverageOps(fnArray, argsArray);
    expect(plan.coverage).toEqual([true, true, false, true, false, true, true, true, true, true]);
    expect(plan.paints).toBeNull();
  });

  it('runs a painting path that carries a clip, and replays it without images', () => {
    const fnArray = [OPS.clip, OPS.constructPath, OPS.constructPath, OPS.paintImageXObject];
    const argsArray = [[], [OPS.fill, [], null], [OPS.fill, [], null], []];
    const plan = imageCoverageOps(fnArray, argsArray);
    expect(plan.coverage).toEqual([true, true, false, true]);
    expect(plan.paints).toEqual([true, true, false, false]);
  });

  it('runs text in clipping render modes, tracking the mode through save and restore', () => {
    const fnArray = [
      OPS.save,
      OPS.setTextRenderingMode,
      OPS.showText, // mode 7: clip only
      OPS.restore,
      OPS.showText, // mode 0 again
      OPS.setTextRenderingMode,
      OPS.showText, // mode 5: stroke and clip
    ];
    const argsArray: unknown[] = [[], [7], [], [], [], [5], []];
    const plan = imageCoverageOps(fnArray, argsArray);
    expect(plan.coverage).toEqual([true, true, true, true, false, true, true]);
    expect(plan.paints).not.toBeNull();

    const clipOnly = imageCoverageOps([OPS.setTextRenderingMode, OPS.showText], [[7], []]);
    expect(clipOnly.coverage).toEqual([true, true]);
    expect(clipOnly.paints).toBeNull();
  });

  it('keeps everything inside a soft-mask group, nested groups included', () => {
    const fnArray = [
      OPS.beginGroup,
      OPS.beginGroup,
      OPS.constructPath,
      OPS.paintImageXObject,
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
      [],
    ];
    expect(imageCoverageOps(fnArray, argsArray).coverage).toEqual([
      true,
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

describe('recolourKeepingImages', () => {
  it('inverts uncovered pixels and keeps covered ones, white included', () => {
    const page = px([255, 255, 255], [0, 0, 0], [255, 255, 255], [200, 30, 40]);
    const coverage = px(CLEAR, CLEAR, COVERED, COVERED);
    expect(recolourKeepingImages(page, coverage, 'inverted')).toBe(true);
    expect(Array.from(page)).toEqual(
      Array.from(px([0, 0, 0], [255, 255, 255], [255, 255, 255], [200, 30, 40])),
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

  it('discounts coverage the image-free paints render painted the same', () => {
    // A clip-carrying black fill (in both renders) and an image over part of it.
    const page = px([0, 0, 0], [200, 30, 40], [255, 255, 255], [255, 255, 255]);
    const coverage = px([0, 0, 0, 255], [200, 30, 40, 255], CLEAR, CLEAR);
    const paints = px([0, 0, 0, 255], [0, 0, 0, 255], CLEAR, CLEAR);
    expect(recolourKeepingImages(page, coverage, 'inverted', undefined, paints)).toBe(true);
    expect(Array.from(page)).toEqual(
      Array.from(px([255, 255, 255], [200, 30, 40], [0, 0, 0], [0, 0, 0])),
    );
  });

  it('declines a white-paper scan with black ink, however few pixels differ in colour', () => {
    const page = px([255, 255, 255], [0, 0, 0], [255, 255, 255], [255, 255, 255]);
    const coverage = px(COVERED, COVERED, COVERED, COVERED);
    const before = Array.from(page);
    expect(recolourKeepingImages(page, coverage, 'inverted')).toBe(false);
    expect(recolourKeepingImages(page, coverage, 'green')).toBe(false);
    expect(Array.from(page)).toEqual(before);
  });
});

// End to end through pdf.js and a real canvas, for each case a review found.
describe.skipIf(!napi)('dark and green PDF pages, rasterised', () => {
  const tints: Tint[] = ['inverted', 'green'];

  it.each(tints)(
    '%s: a full-page white scan inverts whole, so its ink stays visible',
    async (tint) => {
      const result = await darkRender(makePdf(`q 100 0 0 100 0 0 cm ${scanImage()} Q`), tint);
      expect(result.keptImages).toBe(false);
      const counts = expectRecoloured(result, tint);
      expect(counts.page).toBe(200 * 200);
    },
  );

  it.each(tints)('%s: an inset monochrome figure keeps its paper and ink', async (tint) => {
    // The scan image drawn into the middle quarter of the page, beside a vector bar.
    const result = await darkRender(
      makePdf(`q 50 0 0 50 25 25 cm ${scanImage()} Q 0 g 5 5 15 3 re f`),
      tint,
    );
    expect(result.keptImages).toBe(true);
    const inFigure = (p: number) => {
      const x = p % result.width;
      const y = Math.floor(p / result.width);
      return x >= 50 && x < 150 && y >= 50 && y < 150;
    };
    let p = -1;
    const counts = expectRecoloured(result, tint, (r, g, b) => {
      p++;
      if (byColour(r, g, b) === 'skip') return 'skip';
      return inFigure(p) ? 'image' : 'page';
    });
    expect(counts.image).toBe(100 * 100);
  });

  it.each(tints)(
    '%s: vector content under a soft mask built from an image still inverts',
    async (tint) => {
      const [resources, form] = luminosityMask();
      const result = await darkRender(
        makePdf(
          `q /GS1 gs 0 g 20 45 60 10 re f Q q 10 0 0 10 5 5 cm ${inlineImage(RED)} Q`,
          resources,
          [form],
        ),
        tint,
      );
      expect(result.keptImages).toBe(true);
      const counts = expectRecoloured(result, tint);
      expect(counts.image).toBe(20 * 20);
    },
  );

  it.each([
    ['W f', '0 g 20 45 60 10 re W f'],
    ['W S', '0 G 4 w 20 45 60 10 re W S'],
    ['W B', '0 g 0 G 4 w 20 45 60 10 re W B'],
  ])('a filled or stroked clipping path (%s) inverts in both appearances', async (_name, path) => {
    for (const tint of tints) {
      const result = await darkRender(
        makePdf(`q ${path} Q q 10 0 0 10 5 5 cm ${inlineImage(RED)} Q`),
        tint,
      );
      expect(result.keptImages).toBe(true);
      const counts = expectRecoloured(result, tint);
      expect(counts.image).toBe(20 * 20);
    }
  });

  it.each([
    ['7 (clip only)', 7],
    ['4 (fill and clip)', 4],
  ])(
    'an image clipped to text in render mode %s keeps only the glyph area',
    async (_name, mode) => {
      for (const tint of tints) {
        const result = await darkRender(
          makePdf(
            `BT /F1 50 Tf 10 30 Td ${mode} Tr (I) Tj ET q 50 0 0 50 0 25 cm ${inlineImage(RED)} Q`,
            HELVETICA,
          ),
          tint,
        );
        expect(result.keptImages).toBe(true);
        const counts = expectRecoloured(result, tint);
        // The glyph is a thin bar: the image shows through it and nowhere else.
        expect(counts.image).toBeGreaterThan(100);
        expect(counts.image).toBeLessThan(2000);
      }
    },
  );
});
