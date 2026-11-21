// Reading sliced G-code into the line segments the 3D preview draws, and the
// print summary a slicer writes next to it.
//
// A `.gcode.3mf` from Bambu Studio or OrcaSlicer is a zip holding
// `Metadata/plate_1.gcode` and `Metadata/slice_info.config`. The G-code is a
// list of machine moves, and only the ones that deposit plastic belong in a
// toolpath preview: travel moves and retractions are left out, because drawing
// them buries the part under a tangle of hops.
//
// The text can be over 100 MB and is untrusted, so the scan never builds a line
// array (that would double the memory), reads the handful of letter/number
// words it cares about by hand instead of allocating a match per line, grows
// its output in typed arrays that double, and stops at a segment cap. Nothing
// here throws on any string: a word that does not parse is ignored, and an
// unknown command is skipped.
//
// No DOM or Three.js dependency, so it is unit-tested in tests/gcode.test.ts.
import { attr, walkXml } from '../ooxml/xml';

export interface Toolpath {
  /** Six floats per extrusion segment: x1 y1 z1 x2 y2 z2, in the G-code's own bed coordinates (mm). Sorted by layer. */
  positions: Float32Array;
  /** Per segment, an index into `features`. */
  feature: Uint8Array;
  /** Feature names in first-seen order. Index 0 is always 'Unknown' (segments extruded before any feature comment). */
  features: string[];
  /** Per layer, the segment index one past the layer's last segment (ascending, last equals `segments`). */
  layerEnd: Uint32Array;
  /** Per layer, its Z height. */
  layerZ: Float32Array;
  segments: number;
  /** True when maxSegments was reached and the rest of the file was dropped. */
  truncated: boolean;
  /** Bounds of the kept segments; all zeros when there are none. */
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * The most segments kept. Each costs 25 bytes in the arrays, so this is a
 * 100 MB budget, and it is already more lines than a GPU draws usefully at once.
 */
export const MAX_SEGMENTS = 4_000_000;

// An arc is cut into chords of about this length. Finer than a nozzle width, so
// a circle reads as a circle without spending segments the eye cannot resolve.
const CHORD_MM = 0.15;
const MAX_CHORDS = 256;

// Two extrusions at Z values closer than this are on the same layer. Slicers
// write Z with three decimals, so anything below a tenth of a micron is noise.
const Z_EPSILON = 1e-4;

// Feature indices are stored in a byte; index 0 is 'Unknown'.
const MAX_FEATURES = 256;

// A word larger than this is not a coordinate on any printer, it is garbage (or
// an attempt to overflow the float arrays), so the word is ignored.
const MAX_COORD = 1e7;

type Typed = Float32Array | Uint8Array | Uint32Array;

class Grow<T extends Typed> {
  data: T;
  length = 0;
  constructor(
    private readonly make: new (n: number) => T,
    initial: number,
  ) {
    this.data = new make(initial);
  }
  private reserve(n: number): void {
    if (this.length + n > this.data.length) {
      const next = new this.make(Math.max(this.data.length * 2, this.length + n));
      next.set(this.data);
      this.data = next;
    }
  }
  push(a: number): void {
    this.reserve(1);
    this.data[this.length++] = a;
  }
  push6(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.reserve(6);
    const data = this.data;
    let n = this.length;
    data[n++] = a;
    data[n++] = b;
    data[n++] = c;
    data[n++] = d;
    data[n++] = e;
    data[n++] = f;
    this.length = n;
  }
  /** An exact-length copy, so a returned array does not pin the spare capacity. */
  finish(): T {
    return this.data.slice(0, this.length) as T;
  }
}

// Where the last readNumber stopped. A module-level cell rather than a returned
// pair, so the hot loop allocates nothing.
let numEnd = 0;

/** Parse `[+-]digits[.digits]` at `i`, or NaN (with numEnd moved past it) when there is none. */
function readNumber(text: string, i: number, end: number): number {
  let neg = false;
  let c = text.charCodeAt(i);
  if (c === 45 || c === 43) {
    neg = c === 45;
    i++;
  }
  let mantissa = 0;
  let digits = 0;
  let scale = 1;
  let dot = false;
  for (; i < end; i++) {
    c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      mantissa = mantissa * 10 + (c - 48);
      digits++;
      if (dot) {
        scale *= 10;
      }
    } else if (c === 46 && !dot) {
      dot = true;
    } else {
      break;
    }
  }
  numEnd = i;
  if (digits === 0) {
    return NaN;
  }
  const value = mantissa / scale;
  if (!Number.isFinite(value) || value > MAX_COORD) {
    return NaN;
  }
  return neg ? -value : value;
}

/** Turn G-code text into extrusion line segments. Never throws. */
export function parseGcode(text: string, options: { maxSegments?: number } = {}): Toolpath {
  const requested = options.maxSegments;
  const maxSegments =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.max(0, Math.min(Math.floor(requested), MAX_SEGMENTS))
      : MAX_SEGMENTS;

  const positions = new Grow(Float32Array, 6 * 1024);
  const featureIdx = new Grow(Uint8Array, 1024);
  const layerEnd = new Grow(Uint32Array, 256);
  const layerZ = new Grow(Float32Array, 256);

  let features: string[] = ['Unknown'];
  let featureIndex = new Map<string, number>();
  let currentFeature = ''; // '' means no feature comment seen yet
  let currentFeatureIdx = 0;
  let featureStale = false;

  let count = 0;
  let truncated = false;
  let done = false;

  // Printer state. Firmware starts in absolute positioning and absolute E.
  let x = 0;
  let y = 0;
  let z = 0;
  let lastE = 0;
  let relativeXyz = false;
  let relativeE = false;

  // Layer state. Before the first slicer marker the layer follows Z; after it,
  // only markers start layers.
  let markerSeen = false;
  let layerOpen = false;
  let layerZNow = 0;
  let pendingZ = NaN;

  const closeLayer = (): void => {
    if (layerOpen) {
      layerEnd.push(count);
      layerOpen = false;
    }
  };

  const onMarker = (): void => {
    if (!markerSeen) {
      // Everything so far is the start G-code's purge or prime line. It sits
      // off the part and would stretch the bounds, so it is dropped.
      markerSeen = true;
      count = 0;
      positions.length = 0;
      featureIdx.length = 0;
      layerEnd.length = 0;
      layerZ.length = 0;
      layerOpen = false;
      features = ['Unknown'];
      featureIndex = new Map();
      featureStale = true;
    }
    closeLayer();
    pendingZ = NaN;
  };

  const resolveFeature = (): number => {
    if (featureStale) {
      featureStale = false;
      if (currentFeature === '') {
        currentFeatureIdx = 0;
      } else {
        let idx = featureIndex.get(currentFeature);
        if (idx === undefined) {
          if (features.length < MAX_FEATURES) {
            idx = features.length;
            features.push(currentFeature);
            featureIndex.set(currentFeature, idx);
          } else {
            idx = 0;
          }
        }
        currentFeatureIdx = idx;
      }
    }
    return currentFeatureIdx;
  };

  const emit = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): void => {
    if (count >= maxSegments) {
      truncated = true;
      done = true;
      return;
    }
    if (!markerSeen && layerOpen && Math.abs(z2 - layerZNow) > Z_EPSILON) {
      closeLayer();
    }
    if (!layerOpen) {
      layerOpen = true;
      layerZNow = Number.isNaN(pendingZ) ? z2 : pendingZ;
      layerZ.push(layerZNow);
    }
    positions.push6(x1, y1, z1, x2, y2, z2);
    featureIdx.push(resolveFeature());
    count++;
  };

  const arc = (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    i: number,
    j: number,
    clockwise: boolean,
  ): void => {
    const radius = Math.hypot(i, j);
    if (!(radius > 1e-6)) {
      emit(x0, y0, z0, x1, y1, z1);
      return;
    }
    const cx = x0 + i;
    const cy = y0 + j;
    const a0 = Math.atan2(-j, -i);
    const a1 = Math.atan2(y1 - cy, x1 - cx);
    const turn = Math.PI * 2;
    // The swept angle in the arc's own direction, in (0, 2 pi]. A start equal to
    // the end is a full circle, which is how slicers write one.
    const raw = clockwise ? a0 - a1 : a1 - a0;
    let sweep = ((raw % turn) + turn) % turn;
    if (sweep < 1e-9) {
      sweep = turn;
    }
    const chords = Math.min(MAX_CHORDS, Math.max(2, Math.ceil((radius * sweep) / CHORD_MM)));
    const sign = clockwise ? -1 : 1;
    let px = x0;
    let py = y0;
    let pz = z0;
    for (let k = 1; k <= chords && !done; k++) {
      let nx = x1;
      let ny = y1;
      let nz = z1;
      if (k < chords) {
        const t = k / chords;
        const angle = a0 + sign * sweep * t;
        nx = cx + radius * Math.cos(angle);
        ny = cy + radius * Math.sin(angle);
        nz = z0 + (z1 - z0) * t;
      }
      emit(px, py, pz, nx, ny, nz);
      px = nx;
      py = ny;
      pz = nz;
    }
  };

  const comment = (start: number, end: number): void => {
    let i = start;
    while (i < end && text.charCodeAt(i) <= 32) {
      i++;
    }
    if (i >= end) {
      return;
    }
    const first = text.charCodeAt(i);
    if (first === 70 /* F */ && text.startsWith('FEATURE:', i)) {
      setFeature(text.slice(i + 8, end).trim());
    } else if (first === 84 /* T */ && text.startsWith('TYPE:', i)) {
      setFeature(text.slice(i + 5, end).trim());
    } else if (first === 67 /* C */ && text.startsWith('CHANGE_LAYER', i)) {
      onMarker();
    } else if (first === 76 /* L */ && text.startsWith('LAYER_CHANGE', i)) {
      onMarker();
    } else if (first === 76 && text.startsWith('LAYER:', i)) {
      onMarker();
    } else if (markerSeen && first === 90 /* Z */) {
      let at = -1;
      if (text.startsWith('Z_HEIGHT:', i)) {
        at = i + 9;
      } else if (text.startsWith('Z:', i)) {
        at = i + 2;
      }
      if (at !== -1) {
        while (at < end && text.charCodeAt(at) <= 32) {
          at++;
        }
        const value = readNumber(text, at, end);
        if (!Number.isNaN(value) && !layerOpen) {
          pendingZ = value;
        }
      }
    }
  };

  const setFeature = (name: string): void => {
    if (name !== currentFeature) {
      currentFeature = name;
      featureStale = true;
    }
  };

  const length = text.length;
  let pos = 0;
  while (pos < length && !done) {
    let end = text.indexOf('\n', pos);
    if (end === -1) {
      end = length;
    }
    const next = end + 1;

    let cmdLetter = 0;
    let cmdNumber = NaN;
    let hasX = false;
    let hasY = false;
    let hasZ = false;
    let hasE = false;
    let hasI = false;
    let hasJ = false;
    let wx = 0;
    let wy = 0;
    let wz = 0;
    let we = 0;
    let wi = 0;
    let wj = 0;
    let commentAt = -1;

    let i = pos;
    while (i < end) {
      const c = text.charCodeAt(i);
      if (c === 59) {
        commentAt = i + 1;
        break;
      }
      if (c === 42) {
        // A checksum: nothing after it is a word.
        break;
      }
      const letter = c & 0xdf;
      if (letter < 65 || letter > 90) {
        i++;
        continue;
      }
      const value = readNumber(text, i + 1, end);
      i = Math.max(numEnd, i + 1);
      if (Number.isNaN(value)) {
        continue;
      }
      switch (letter) {
        case 71: // G
        case 77: // M
          if (cmdLetter === 0) {
            cmdLetter = letter;
            cmdNumber = value;
          }
          break;
        case 88:
          hasX = true;
          wx = value;
          break;
        case 89:
          hasY = true;
          wy = value;
          break;
        case 90:
          hasZ = true;
          wz = value;
          break;
        case 69:
          hasE = true;
          we = value;
          break;
        case 73:
          hasI = true;
          wi = value;
          break;
        case 74:
          hasJ = true;
          wj = value;
          break;
        default:
          break;
      }
    }

    if (cmdLetter === 71) {
      if (cmdNumber >= 0 && cmdNumber <= 3 && Number.isInteger(cmdNumber)) {
        const nx = hasX ? (relativeXyz ? x + wx : wx) : x;
        const ny = hasY ? (relativeXyz ? y + wy : wy) : y;
        const nz = hasZ ? (relativeXyz ? z + wz : wz) : z;
        // E is relative when either G91 or M83 says so, as the slicers' own
        // readers take it, and its running total is kept in both modes: after
        // a stretch of relative moves, an absolute E is compared against where
        // the filament really is, not where it was before them.
        let extruding = false;
        if (hasE) {
          const nextE = relativeE || relativeXyz ? lastE + we : we;
          extruding = nextE > lastE;
          lastE = nextE;
        }
        if (extruding && (nx !== x || ny !== y || nz !== z)) {
          if (cmdNumber >= 2) {
            arc(x, y, z, nx, ny, nz, hasI ? wi : 0, hasJ ? wj : 0, cmdNumber === 2);
          } else {
            emit(x, y, z, nx, ny, nz);
          }
        } else if (extruding && cmdNumber >= 2 && (hasI || hasJ)) {
          // A full circle ends where it began, so it did not move.
          arc(x, y, z, nx, ny, nz, hasI ? wi : 0, hasJ ? wj : 0, cmdNumber === 2);
        }
        x = nx;
        y = ny;
        z = nz;
      } else if (cmdNumber === 90) {
        relativeXyz = false;
      } else if (cmdNumber === 91) {
        relativeXyz = true;
      } else if (cmdNumber === 92 && hasE) {
        lastE = we;
      }
    } else if (cmdLetter === 77) {
      if (cmdNumber === 82) {
        relativeE = false;
      } else if (cmdNumber === 83) {
        relativeE = true;
      }
    }

    if (commentAt !== -1) {
      comment(commentAt, end);
    }
    pos = next;
  }

  closeLayer();

  const segments = count;
  const out = positions.finish();
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  if (segments > 0) {
    min[0] = min[1] = min[2] = Infinity;
    max[0] = max[1] = max[2] = -Infinity;
    for (let n = 0; n < segments * 6; n++) {
      const axis = n % 3;
      const v = out[n];
      if (v < min[axis]) {
        min[axis] = v;
      }
      if (v > max[axis]) {
        max[axis] = v;
      }
    }
  }

  return {
    positions: out,
    feature: featureIdx.finish(),
    features,
    layerEnd: layerEnd.finish(),
    layerZ: layerZ.finish(),
    segments,
    truncated,
    min,
    max,
  };
}

export interface SliceInfo {
  printSeconds?: number;
  weightGrams?: number;
  printer?: string;
  nozzle?: number;
  filaments: Array<{ type?: string; color?: string; usedMeters?: number; usedGrams?: number }>;
}

function finiteNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Read the print summary from a Bambu/Orca `slice_info.config`. Only the first
 * plate is read. A malformed file returns whatever was read before the error,
 * because a half-good summary beats refusing to show the toolpath.
 */
export function readSliceInfo(xml: string): SliceInfo {
  const info: SliceInfo = { filaments: [] };
  let inPlate = false;
  let plateSeen = false;
  try {
    walkXml(xml, {
      open(name, attrs) {
        if (name === 'plate') {
          if (!plateSeen) {
            plateSeen = true;
            inPlate = true;
          }
          return;
        }
        if (!inPlate) {
          return;
        }
        if (name === 'metadata') {
          const key = attr(attrs, 'key');
          const value = attr(attrs, 'value');
          if (value === undefined) {
            return;
          }
          if (key === 'prediction') {
            info.printSeconds = finiteNumber(value);
          } else if (key === 'weight') {
            info.weightGrams = finiteNumber(value);
          } else if (key === 'printer_model_id') {
            info.printer = value;
          } else if (key === 'nozzle_diameters') {
            info.nozzle = finiteNumber(value);
          }
        } else if (name === 'filament') {
          info.filaments.push({
            type: attr(attrs, 'type'),
            color: attr(attrs, 'color'),
            usedMeters: finiteNumber(attr(attrs, 'used_m')),
            usedGrams: finiteNumber(attr(attrs, 'used_g')),
          });
        }
      },
      close(name) {
        if (name === 'plate') {
          inPlate = false;
        }
      },
    });
  } catch {
    // Keep what was read before the error.
  }
  return info;
}

/** '1h 23m', '4m 10s', '45s', '2d 3h': the two largest nonzero units. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) {
    return '0s';
  }
  const total = Math.floor(seconds);
  const parts: Array<[number, string]> = [
    [Math.floor(total / 86400), 'd'],
    [Math.floor((total % 86400) / 3600), 'h'],
    [Math.floor((total % 3600) / 60), 'm'],
    [total % 60, 's'],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  const shown = parts.slice(first, first + 2).filter(([n], idx) => idx === 0 || n > 0);
  return shown.map(([n, unit]) => `${n}${unit}`).join(' ');
}
