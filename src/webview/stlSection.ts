// The flat half of the 3D preview's section tool: the cut drawn square-on in a
// 2D canvas, with a crosshair that measures along it.
//
// The 3D view shows where the cut is; this shows what it is. A wall thickness
// or a pocket width is read by pointing at it: the horizontal and vertical
// lines through the pointer are intersected with the outline, and every stretch
// between two crossings is labelled with its length, material and gap alike.
// That is the output of a slicing script (cross the outline with y = 0, read
// the numbers) without typing the y. Click pins the crosshair so the numbers
// can be copied.
//
// The canvas is plain 2D drawing with no Three.js, and the arithmetic is in
// meshSection.ts and the two pure helpers below, which is what is unit-tested;
// the drawing itself is checked by hand (see docs/TESTING.md).
import { fmt, gridStep, lineSpans, spanEdges, type Span } from './meshSection';

export interface SectionOutline {
  /** The model's file name, for the readout. */
  label: string;
  /** A CSS color. */
  color: string;
  /** Four floats per segment, u1 v1 u2 v2 (see sectionSegments). */
  segments: Float32Array;
}

export interface SectionData {
  outlines: SectionOutline[];
  /** The model's whole extent on the two drawn axes, so the picture holds still as the cut moves. */
  u: [number, number];
  v: [number, number];
  uName: string;
  vName: string;
}

export interface Fit {
  scale: number;
  /** Canvas x of u = 0 and canvas y of v = 0. */
  x0: number;
  y0: number;
}

/**
 * The transform that fits the extents into a `width` x `height` canvas with
 * `pad` px to spare, centred, v pointing up: x = x0 + u * scale, y = y0 - v * scale.
 */
export function fitExtent(
  u: readonly [number, number],
  v: readonly [number, number],
  width: number,
  height: number,
  pad: number,
): Fit {
  const du = Math.max(u[1] - u[0], 1e-9);
  const dv = Math.max(v[1] - v[0], 1e-9);
  const scale = Math.max(
    Math.min((width - 2 * pad) / du, (height - 2 * pad) / dv),
    Number.MIN_VALUE,
  );
  return {
    scale,
    x0: width / 2 - ((u[0] + u[1]) / 2) * scale,
    y0: height / 2 + ((v[0] + v[1]) / 2) * scale,
  };
}

export interface MeasureRow {
  label: string;
  color: string;
  /** Along the horizontal line through the point: u coordinates of its crossings, and the stretches between them. */
  across: { crossings: number[]; spans: Span[] };
  /** Along the vertical line through the point. */
  up: { crossings: number[]; spans: Span[] };
}

/** What the crosshair at (u, v) reads off each outline. */
export function measure(outlines: readonly SectionOutline[], u: number, v: number): MeasureRow[] {
  return outlines.map((outline) => {
    const across = lineSpans(outline.segments, 'v', v);
    const up = lineSpans(outline.segments, 'u', u);
    return {
      label: outline.label,
      color: outline.color,
      across: { crossings: spanEdges(across), spans: across },
      up: { crossings: spanEdges(up), spans: up },
    };
  });
}

export interface SectionView {
  setData(data: SectionData | null): void;
  /** Redraw at the canvas's current size (after a resize or a theme change). */
  redraw(): void;
  /** The crosshair, or null when the pointer is elsewhere and nothing is pinned. */
  point(): { u: number; v: number } | null;
}

const PAD = 30;
const HINT = 'Point at the section to measure. Click to pin the crosshair.';

export function createSectionView(canvas: HTMLCanvasElement, readout: HTMLElement): SectionView {
  let data: SectionData | null = null;
  let at: { u: number; v: number } | null = null;
  let pinned = false;
  let fit: Fit = { scale: 1, x0: 0, y0: 0 };

  const toModel = (e: MouseEvent) => ({
    u: (e.offsetX - fit.x0) / fit.scale,
    v: (fit.y0 - e.offsetY) / fit.scale,
  });

  canvas.addEventListener('pointermove', (e) => {
    if (data && !pinned) {
      at = toModel(e);
      draw();
    }
  });
  canvas.addEventListener('pointerleave', () => {
    if (!pinned) {
      at = null;
      draw();
    }
  });
  canvas.addEventListener('click', (e) => {
    if (!data) {
      return;
    }
    // A click pins the crosshair where it is; the next one lets it go again.
    pinned = !pinned;
    at = toModel(e);
    draw();
  });

  function draw(): void {
    // The numbers first: they do not depend on there being anything to draw on.
    const rows = data && at ? measure(data.outlines, at.u, at.v) : [];
    if (!data) {
      readout.textContent = '';
    } else if (!at) {
      readout.textContent = HINT;
    } else {
      writeReadout(readout, data, at, rows, pinned);
    }

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ctx = width > 0 && height > 0 ? canvas.getContext('2d') : null;
    if (!ctx) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!data) {
      return;
    }
    fit = fitExtent(data.u, data.v, width, height, PAD);
    const ink = getComputedStyle(canvas).color || '#888';
    const sx = (u: number) => fit.x0 + u * fit.scale;
    const sy = (v: number) => fit.y0 - v * fit.scale;

    drawGrid(ctx, data, fit, width, height, ink);

    for (const outline of data.outlines) {
      ctx.strokeStyle = outline.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const s = outline.segments;
      for (let i = 0; i + 3 < s.length; i += 4) {
        ctx.moveTo(sx(s[i]), sy(s[i + 1]));
        ctx.lineTo(sx(s[i + 2]), sy(s[i + 3]));
      }
      ctx.stroke();
    }

    if (at) {
      drawCrosshair(ctx, at, rows[0], fit, width, height, ink, pinned);
    }
  }

  return {
    setData(next) {
      data = next;
      if (!next) {
        at = null;
        pinned = false;
      }
      draw();
    },
    redraw: draw,
    point: () => at,
  };
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  data: SectionData,
  fit: Fit,
  width: number,
  height: number,
  ink: string,
): void {
  const step = gridStep(Math.max(data.u[1] - data.u[0], data.v[1] - data.v[0]), 24);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  const lines = (from: number, to: number, place: (value: number, major: boolean) => void) => {
    const first = Math.ceil(from / step);
    const last = Math.floor(to / step);
    // A degenerate extent cannot ask for more lines than there are pixels. And
    // the loop counts the lines, not the grid index: a model a long way from
    // its origin (a coordinate near 1e16 with a small extent) has an index past
    // the integers a double can step through, where `k++` leaves k unchanged
    // and a loop on it never ends. There is no grid to draw at that distance,
    // since neighbouring lines are not distinct numbers either.
    const count = last - first;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || !(count <= 2000)) {
      return;
    }
    for (let i = 0; i <= count; i++) {
      place((first + i) * step, (first + i) % 10 === 0);
    }
  };
  lines(-fit.x0 / fit.scale, (width - fit.x0) / fit.scale, (u, major) => {
    ctx.globalAlpha = major ? 0.28 : 0.1;
    ctx.beginPath();
    ctx.moveTo(Math.round(fit.x0 + u * fit.scale) + 0.5, 0);
    ctx.lineTo(Math.round(fit.x0 + u * fit.scale) + 0.5, height);
    ctx.stroke();
  });
  lines((fit.y0 - height) / fit.scale, fit.y0 / fit.scale, (v, major) => {
    ctx.globalAlpha = major ? 0.28 : 0.1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(fit.y0 - v * fit.scale) + 0.5);
    ctx.lineTo(width, Math.round(fit.y0 - v * fit.scale) + 0.5);
    ctx.stroke();
  });
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = ink;
  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(`${data.vName} ↑   grid ${step}`, 8, 16);
  ctx.textAlign = 'right';
  ctx.fillText(`${data.uName} →`, width - 8, height - 8);
  ctx.globalAlpha = 1;
}

// The crosshair and the measurements of the first outline, drawn on the cut
// itself: material as a heavy stroke, every stretch labelled where it has room.
function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  at: { u: number; v: number },
  row: MeasureRow | undefined,
  fit: Fit,
  width: number,
  height: number,
  ink: string,
  pinned: boolean,
): void {
  const x = fit.x0 + at.u * fit.scale;
  const y = fit.y0 - at.v * fit.scale;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.globalAlpha = pinned ? 0.8 : 0.45;
  ctx.setLineDash(pinned ? [] : [4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(width, y);
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  if (!row) {
    return;
  }
  ctx.font = '11px sans-serif';
  ctx.fillStyle = ink;
  for (const span of row.across.spans) {
    const from = fit.x0 + span.from * fit.scale;
    const to = fit.x0 + span.to * fit.scale;
    if (span.solid) {
      ctx.strokeStyle = row.color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(from, y);
      ctx.lineTo(to, y);
      ctx.stroke();
    }
    const text = fmt(span.length);
    if (to - from >= ctx.measureText(text).width + 6) {
      ctx.globalAlpha = span.solid ? 1 : 0.7;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, (from + to) / 2, y - 6);
      ctx.globalAlpha = 1;
    }
  }
  for (const span of row.up.spans) {
    const from = fit.y0 - span.from * fit.scale;
    const to = fit.y0 - span.to * fit.scale;
    if (span.solid) {
      ctx.strokeStyle = row.color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x, from);
      ctx.lineTo(x, to);
      ctx.stroke();
    }
    if (from - to >= 14) {
      ctx.globalAlpha = span.solid ? 1 : 0.7;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmt(span.length), x + 7, (from + to) / 2);
      ctx.globalAlpha = 1;
    }
  }
}

// The same numbers as text under the canvas, for every outline, where a span
// too narrow to label on the drawing still gets its number. Material is bold.
function writeReadout(
  readout: HTMLElement,
  data: SectionData,
  at: { u: number; v: number },
  rows: MeasureRow[],
  pinned: boolean,
): void {
  readout.textContent = '';
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'row';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = row.color;
    line.append(swatch);
    appendSpans(line, `${data.vName} = ${fmt(at.v)}: `, row.across.spans);
    appendSpans(line, `   ${data.uName} = ${fmt(at.u)}: `, row.up.spans);
    if (rows.length > 1) {
      line.title = row.label;
    }
    readout.append(line);
  }
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = pinned
    ? 'Pinned. Click the section to release.'
    : 'Click to pin the crosshair.';
  readout.append(hint);
}

function appendSpans(line: HTMLElement, prefix: string, list: Span[]): void {
  line.append(prefix);
  if (list.length === 0) {
    line.append('no crossings');
    return;
  }
  list.forEach((span, i) => {
    if (i > 0) {
      line.append(' | ');
    }
    const el = document.createElement(span.solid ? 'b' : 'span');
    el.textContent = fmt(span.length);
    line.append(el);
  });
}
