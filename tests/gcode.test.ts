// Coverage for src/webview/gcode.ts: turning sliced G-code into extrusion
// segments (relative and absolute E, retractions, G92, G90/G91, arcs, layer
// markers from Bambu/Orca, Prusa and Cura, feature names, the segment cap,
// malformed input) and reading the print summary from slice_info.config. The
// G-code is written inline in each test so the expected segments can be checked
// by eye against it.
import { describe, expect, it } from 'vitest';
import {
  MAX_SEGMENTS,
  SETTINGS_WINDOW,
  featureColor,
  formatDuration,
  parseGcode,
  readGcodeBed,
  readSliceInfo,
} from '../src/webview/gcode';
import { gcodeProblem } from '../src/webview/modelSniff';
import type { Toolpath } from '../src/webview/gcode';

/** Segment `n` as [x1, y1, z1, x2, y2, z2], rounded to a micron so float32 noise does not matter. */
function seg(tp: Toolpath, n: number): number[] {
  return Array.from(tp.positions.subarray(n * 6, n * 6 + 6)).map(
    (v) => Math.round(v * 1000) / 1000,
  );
}

function lines(...rows: string[]): string {
  return rows.join('\n') + '\n';
}

describe('extrusion', () => {
  it('draws relative-E extrusion and skips travel', () => {
    const tp = parseGcode(
      lines('M83', 'G1 X10 Y0 Z0.2', 'G1 X20 Y0 E1', 'G1 X20 Y10', 'G1 X20 Y20 E1'),
    );
    expect(tp.segments).toBe(2);
    expect(seg(tp, 0)).toEqual([10, 0, 0.2, 20, 0, 0.2]);
    expect(seg(tp, 1)).toEqual([20, 10, 0.2, 20, 20, 0.2]);
    expect(tp.truncated).toBe(false);
  });

  it('treats E as absolute until M83, and honours G92 E resets', () => {
    const tp = parseGcode(
      lines(
        'G1 X10 E1',
        'G1 X20 E2',
        'G92 E0',
        'G1 X30 E1', // 1 > 0 after the reset, so it draws
        'G1 X40 E0.5', // E went backwards: a retraction, not drawn
        'G1 X50 E1.5',
      ),
    );
    expect(tp.segments).toBe(4);
    expect(seg(tp, 2)).toEqual([20, 0, 0, 30, 0, 0]);
    expect(seg(tp, 3)).toEqual([40, 0, 0, 50, 0, 0]);
  });

  it('would not draw the move after a reset without G92', () => {
    const tp = parseGcode(lines('G1 X10 E1', 'G1 X20 E2', 'G1 X30 E1'));
    expect(tp.segments).toBe(2);
  });

  it('does not draw retractions, unretractions or moves with negative E', () => {
    const tp = parseGcode(lines('M83', 'G1 X10 E1', 'G1 E-1', 'G1 X20 Y0 E-0.5', 'G1 E1'));
    expect(tp.segments).toBe(1);
    expect(seg(tp, 0)).toEqual([0, 0, 0, 10, 0, 0]);
  });

  it('honours G91 relative positioning and G90 back to absolute', () => {
    const tp = parseGcode(lines('M83', 'G91', 'G1 X10 E1', 'G1 X10 Y5 E1', 'G90', 'G1 X0 Y0 E1'));
    expect(tp.segments).toBe(3);
    expect(seg(tp, 0)).toEqual([0, 0, 0, 10, 0, 0]);
    expect(seg(tp, 1)).toEqual([10, 0, 0, 20, 5, 0]);
    expect(seg(tp, 2)).toEqual([20, 5, 0, 0, 0, 0]);
  });

  it('reads CRLF, lowercase, no-space words, line numbers and checksums', () => {
    const tp = parseGcode(
      'M83\r\nG1X10Y5E1\r\ng1 x20 e1\r\nN5 G1 X30 E1*71\r\nG1 X40 E1 ; trailing comment\r\n',
    );
    expect(tp.segments).toBe(4);
    expect(seg(tp, 0)).toEqual([0, 0, 0, 10, 5, 0]);
    expect(seg(tp, 1)).toEqual([10, 5, 0, 20, 5, 0]);
    expect(seg(tp, 2)).toEqual([20, 5, 0, 30, 5, 0]);
    expect(seg(tp, 3)).toEqual([30, 5, 0, 40, 5, 0]);
  });

  it('reports the bounds of the kept segments', () => {
    const tp = parseGcode(lines('M83', 'G1 X-5 Y2 Z0.2', 'G1 X30 Y-4 E1', 'G1 X10 Y8 Z0.4 E1'));
    expect(tp.min[0]).toBeCloseTo(-5);
    expect(tp.min[1]).toBeCloseTo(-4);
    expect(tp.min[2]).toBeCloseTo(0.2);
    expect(tp.max[0]).toBeCloseTo(30);
    expect(tp.max[1]).toBeCloseTo(8);
    expect(tp.max[2]).toBeCloseTo(0.4);
  });
});

describe('layers', () => {
  it('drops the purge line before the first Bambu marker and uses Z_HEIGHT', () => {
    const tp = parseGcode(
      lines(
        'M83',
        'G1 X0 Y0 Z0.3',
        'G1 X50 E2', // purge line from the start G-code
        '; FEATURE: Custom',
        '; CHANGE_LAYER',
        '; Z_HEIGHT: 0.2',
        '; FEATURE: Outer wall',
        'G1 X10 Y10 Z0.2 F3000',
        'G1 X20 Y10 E1',
        '; CHANGE_LAYER',
        '; Z_HEIGHT: 0.4',
        'G1 Z0.4',
        'G1 X20 Y20 E1',
      ),
    );
    expect(tp.segments).toBe(2);
    expect(seg(tp, 0)).toEqual([10, 10, 0.2, 20, 10, 0.2]);
    expect(seg(tp, 1)).toEqual([20, 10, 0.4, 20, 20, 0.4]);
    expect(Array.from(tp.layerEnd)).toEqual([1, 2]);
    expect(Array.from(tp.layerZ).map((v) => Math.round(v * 1000) / 1000)).toEqual([0.2, 0.4]);
    // The purge line is gone, and so is its feature name.
    expect(tp.features).toEqual(['Unknown', 'Outer wall']);
    expect(tp.min[0]).toBeCloseTo(10);
    expect(tp.max[0]).toBeCloseTo(20);
  });

  it('layers a file with no markers by Z', () => {
    const tp = parseGcode(
      lines('M83', 'G1 Z0.2', 'G1 X10 E1', 'G1 X20 E1', 'G1 Z0.4', 'G1 X10 E1'),
    );
    expect(tp.segments).toBe(3);
    expect(Array.from(tp.layerEnd)).toEqual([2, 3]);
    expect(Array.from(tp.layerZ).map((v) => Math.round(v * 1000) / 1000)).toEqual([0.2, 0.4]);
  });

  it('does not start a new layer for a Z change inside the tolerance', () => {
    const tp = parseGcode(lines('M83', 'G1 Z0.2', 'G1 X10 E1', 'G1 Z0.20005', 'G1 X20 E1'));
    expect(Array.from(tp.layerEnd)).toEqual([2]);
  });

  it('does not record layers that have no segments', () => {
    const tp = parseGcode(
      lines('M83', ';LAYER_CHANGE', ';Z:0.2', ';LAYER_CHANGE', ';Z:0.4', 'G1 X10 Z0.4 E1'),
    );
    expect(tp.segments).toBe(1);
    expect(Array.from(tp.layerEnd)).toEqual([1]);
    expect(tp.layerZ[0]).toBeCloseTo(0.4);
  });

  it('reads PrusaSlicer markers and TYPE comments', () => {
    const tp = parseGcode(
      lines(
        'M83',
        ';LAYER_CHANGE',
        ';Z:0.2',
        ';TYPE:Perimeter',
        'G1 X10 Y0 Z0.2',
        'G1 X20 E1',
        ';LAYER_CHANGE',
        ';Z:0.4',
        ';TYPE:Solid infill',
        'G1 Z0.4',
        'G1 X10 E1',
      ),
    );
    expect(tp.segments).toBe(2);
    expect(Array.from(tp.layerEnd)).toEqual([1, 2]);
    expect(tp.features).toEqual(['Unknown', 'Perimeter', 'Solid infill']);
    expect(Array.from(tp.feature)).toEqual([1, 2]);
  });

  it('reads Cura markers, ignores LAYER_COUNT, and drops the prime line', () => {
    const tp = parseGcode(
      lines(
        ';LAYER_COUNT:2',
        'M83',
        'G1 X99 Y99 Z0.3 E1', // prime line, before the first ;LAYER:
        ';LAYER:0',
        ';TYPE:WALL-OUTER',
        'G1 X10 Y0 Z0.3',
        'G1 X20 E1',
        ';LAYER:1',
        ';TYPE:SKIN',
        'G1 Z0.5',
        'G1 X30 E1',
      ),
    );
    expect(tp.segments).toBe(2);
    expect(seg(tp, 0)).toEqual([10, 0, 0.3, 20, 0, 0.3]);
    expect(seg(tp, 1)).toEqual([20, 0, 0.5, 30, 0, 0.5]);
    expect(Array.from(tp.layerEnd)).toEqual([1, 2]);
    expect(tp.features).toEqual(['Unknown', 'WALL-OUTER', 'SKIN']);
  });
});

describe('features', () => {
  it('numbers names in first-seen order, with Unknown before any comment', () => {
    const tp = parseGcode(
      lines(
        'M83',
        'G1 Z0.2',
        'G1 X10 E1',
        '; FEATURE: Outer wall',
        'G1 X20 E1',
        ';FEATURE:Inner wall',
        'G1 X30 E1',
        '; FEATURE: Outer wall',
        'G1 X40 E1',
      ),
    );
    expect(tp.features).toEqual(['Unknown', 'Outer wall', 'Inner wall']);
    expect(Array.from(tp.feature)).toEqual([0, 1, 2, 1]);
  });

  it('maps names past 255 distinct ones to Unknown', () => {
    const rows = ['M83'];
    for (let n = 0; n < 300; n++) {
      rows.push(`; FEATURE: f${n}`, `G1 X${n + 1} E1`);
    }
    const tp = parseGcode(lines(...rows));
    expect(tp.segments).toBe(300);
    expect(tp.features.length).toBe(256);
    expect(tp.feature[0]).toBe(1);
    expect(tp.feature[254]).toBe(255);
    expect(tp.feature[255]).toBe(0);
    expect(tp.feature[299]).toBe(0);
  });
});

describe('arcs', () => {
  it('cuts a counter-clockwise quarter arc into chords on the circle', () => {
    // From (10,0) around the origin to (0,10): radius 10, a quarter turn, so
    // ceil(10 * pi/2 / 0.15) = 105 chords.
    const tp = parseGcode(lines('M83', 'G1 X10 Y0', 'G3 X0 Y10 I-10 J0 E1'));
    expect(tp.segments).toBe(105);
    expect(seg(tp, 0).slice(0, 3)).toEqual([10, 0, 0]);
    expect(seg(tp, 104).slice(3)).toEqual([0, 10, 0]);
    for (let n = 0; n < tp.segments; n++) {
      const s = tp.positions.subarray(n * 6, n * 6 + 6);
      expect(Math.hypot(s[0], s[1])).toBeCloseTo(10, 3);
      expect(Math.hypot(s[3], s[4])).toBeCloseTo(10, 3);
      expect(s[0]).toBeGreaterThanOrEqual(-1e-4);
      expect(s[1]).toBeGreaterThanOrEqual(-1e-4);
      if (n > 0) {
        // Each chord starts where the last one ended.
        expect(Array.from(s.subarray(0, 3))).toEqual(
          Array.from(tp.positions.subarray(n * 6 - 3, n * 6)),
        );
      }
    }
  });

  it('goes the long way round for a clockwise arc, capped at 256 chords', () => {
    // Clockwise from (10,0) to (0,10) is three quarters of the circle, which
    // would be 315 chords uncapped.
    const tp = parseGcode(lines('M83', 'G1 X10 Y0', 'G2 X0 Y10 I-10 J0 E1'));
    expect(tp.segments).toBe(256);
    // Clockwise from angle 0 heads down first, into negative Y.
    expect(tp.positions[4]).toBeLessThan(0);
    expect(seg(tp, 255).slice(3)).toEqual([0, 10, 0]);
  });

  it('draws a full circle when the end equals the start', () => {
    // Radius 5, circumference 31.4, so ceil(31.4 / 0.15) = 210 chords.
    const tp = parseGcode(lines('M83', 'G2 I5 J0 E1'));
    expect(tp.segments).toBe(210);
    expect(seg(tp, 0).slice(0, 3)).toEqual([0, 0, 0]);
    expect(seg(tp, 209).slice(3)).toEqual([0, 0, 0]);
    expect(tp.min[0]).toBeCloseTo(0);
    expect(tp.max[0]).toBeCloseTo(10, 3);
  });

  it('uses at least two chords for a tiny arc', () => {
    const tp = parseGcode(lines('M83', 'G3 X0.01 Y0.01 I0.01 J0 E1'));
    expect(tp.segments).toBe(2);
  });

  it('draws an arc given only a radius as a straight chord', () => {
    const tp = parseGcode(lines('M83', 'G2 X10 Y0 R5 E1'));
    expect(tp.segments).toBe(1);
    expect(seg(tp, 0)).toEqual([0, 0, 0, 10, 0, 0]);
  });

  it('does not draw an arc that does not extrude', () => {
    const tp = parseGcode(lines('M83', 'G1 X10 Y0', 'G3 X0 Y10 I-10 J0'));
    expect(tp.segments).toBe(0);
  });
});

describe('limits and bad input', () => {
  it('stops at maxSegments and says so', () => {
    const text = lines('M83', 'G1 X1 E1', 'G1 X2 E1', 'G1 X3 E1', 'G1 X4 E1', 'G1 X5 E1');
    const tp = parseGcode(text, { maxSegments: 3 });
    expect(tp.segments).toBe(3);
    expect(tp.truncated).toBe(true);
    expect(tp.positions.length).toBe(18);
    expect(tp.feature.length).toBe(3);
    expect(Array.from(tp.layerEnd)).toEqual([3]);
    expect(tp.max[0]).toBeCloseTo(3);
  });

  it('is not truncated when the file has exactly maxSegments segments', () => {
    const tp = parseGcode(lines('M83', 'G1 X1 E1', 'G1 X2 E1', 'G1 X3 E1'), { maxSegments: 3 });
    expect(tp.segments).toBe(3);
    expect(tp.truncated).toBe(false);
  });

  it('exports the default cap', () => {
    expect(MAX_SEGMENTS).toBe(4_000_000);
  });

  it('returns an empty toolpath for an empty string', () => {
    const tp = parseGcode('');
    expect(tp.segments).toBe(0);
    expect(tp.positions.length).toBe(0);
    expect(tp.feature.length).toBe(0);
    expect(tp.layerEnd.length).toBe(0);
    expect(tp.layerZ.length).toBe(0);
    expect(tp.features).toEqual(['Unknown']);
    expect(tp.truncated).toBe(false);
    expect(tp.min).toEqual([0, 0, 0]);
    expect(tp.max).toEqual([0, 0, 0]);
  });

  it('survives binary-looking and malformed text', () => {
    let binary = '';
    for (let n = 0; n < 256; n++) {
      binary += String.fromCharCode(n);
    }
    const junk = [
      binary.repeat(20),
      'G1 X E\nG1 X- Y. E+\nG\nM\n;\n*\nG1 X' + '9'.repeat(400) + ' E1\nG1 X1e999 E1\n',
      '\u0000￿\ud800G1 X1 E',
      'G2 I J E1\nG3 X5 E1 I\n',
    ];
    for (const text of junk) {
      const tp = parseGcode(text);
      expect(tp.segments).toBe(0);
      expect(tp.positions.length).toBe(0);
      expect(tp.min).toEqual([0, 0, 0]);
      expect(tp.truncated).toBe(false);
    }
  });
});

describe('readSliceInfo', () => {
  const REAL = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="BL-P001"/>
    <metadata key="nozzle_diameters" value="0.4"/>
    <metadata key="prediction" value="3829"/>
    <metadata key="weight" value="16.92"/>
    <object identify_id="79" name="part.stl" skipped="false" />
    <filament id="1" tray_info_idx="GFG01" type="PETG" color="#00000000" used_m="5.63" used_g="16.92" used_for_object="true"/>
    <filament id="2" type="PLA" color="#FF0000" used_m="1.5" used_g="4.5"/>
    <layer_filament_lists>
      <layer_filament_list filament_list="0" layer_ranges="0 279" />
    </layer_filament_lists>
  </plate>
  <plate>
    <metadata key="prediction" value="9999"/>
    <filament id="1" type="ABS"/>
  </plate>
</config>`;

  it('reads the first plate', () => {
    expect(readSliceInfo(REAL)).toEqual({
      printSeconds: 3829,
      weightGrams: 16.92,
      printer: 'BL-P001',
      nozzle: 0.4,
      filaments: [
        { type: 'PETG', color: '#00000000', usedMeters: 5.63, usedGrams: 16.92 },
        { type: 'PLA', color: '#FF0000', usedMeters: 1.5, usedGrams: 4.5 },
      ],
    });
  });

  it('takes the first number of a multi-nozzle list and skips non-numeric values', () => {
    const info = readSliceInfo(
      '<config><plate><metadata key="nozzle_diameters" value="0.4,0.6"/><metadata key="weight" value="heavy"/></plate></config>',
    );
    expect(info.nozzle).toBe(0.4);
    expect(info.weightGrams).toBeUndefined();
  });

  it('ignores metadata outside a plate', () => {
    const info = readSliceInfo('<config><metadata key="prediction" value="5"/></config>');
    expect(info).toEqual({ filaments: [] });
  });

  it('keeps what was read before malformed XML and never throws', () => {
    const cut = readSliceInfo(
      '<config><plate><metadata key="prediction" value="60"/><metadata key="weight" value="1',
    );
    expect(cut.printSeconds).toBe(60);
    expect(cut.filaments).toEqual([]);
    expect(readSliceInfo('<config><plate></oops>')).toEqual({ filaments: [] });
    expect(readSliceInfo('not xml at all')).toEqual({ filaments: [] });
    expect(readSliceInfo('')).toEqual({ filaments: [] });
  });
});

describe('formatDuration', () => {
  it('shows the two largest nonzero units', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(250)).toBe('4m 10s');
    expect(formatDuration(4980)).toBe('1h 23m');
    expect(formatDuration(183600)).toBe('2d 3h');
    expect(formatDuration(90061)).toBe('1d 1h');
  });

  it('drops a zero second unit', () => {
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(3605)).toBe('1h');
  });

  it('gives 0s for zero, negative, fractional-below-one and non-finite input', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-30)).toBe('0s');
    expect(formatDuration(0.4)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0s');
  });
});

describe('parseGcode extrusion state across mode changes', () => {
  const layer = ['; CHANGE_LAYER', '; Z_HEIGHT: 0.2', 'G1 Z0.2'];

  it('takes E as relative under G91 with no M83', () => {
    // Both moves push a millimetre of filament. Read as absolute, the second
    // would repeat E1 and look like a travel.
    const tp = parseGcode([...layer, 'G91', 'G1 X10 E1', 'G1 X10 E1', ''].join('\n'));
    expect(tp.segments).toBe(2);
    expect(Array.from(tp.positions)).toEqual(
      [0, 0, 0.2, 10, 0, 0.2, 10, 0, 0.2, 20, 0, 0.2].map(Math.fround),
    );
  });

  it('keeps the running E through a relative stretch, so a later absolute E is judged against it', () => {
    // Absolute to 10, two more relative (12 in all), then absolute 11: that is
    // a retraction of one and must not be drawn.
    const tp = parseGcode(
      [...layer, 'G90', 'G1 X10 E10', 'M83', 'G1 X20 E2', 'M82', 'G1 X30 E11', ''].join('\n'),
    );
    expect(tp.segments).toBe(2);
    expect(tp.max[0]).toBe(20);
  });

  it('draws an absolute move that passes the running total after a relative stretch', () => {
    const tp = parseGcode(
      [...layer, 'G90', 'G1 X10 E10', 'M83', 'G1 X20 E2', 'M82', 'G1 X30 E13', ''].join('\n'),
    );
    expect(tp.segments).toBe(3);
  });

  it('still resets the total with G92', () => {
    const tp = parseGcode(
      [...layer, 'M83', 'G1 X10 E5', 'M82', 'G92 E0', 'G1 X20 E1', 'G1 X30 E0.5', ''].join('\n'),
    );
    expect(tp.segments).toBe(2);
  });
});

describe('readGcodeBed', () => {
  it('reads PrusaSlicer and SuperSlicer bed_shape and max_print_height', () => {
    const text = lines(
      'G1 X1 Y1 E1',
      '; prusaslicer_config = begin',
      '; bed_shape = 0x0,250x0,250x210,0x210',
      '; max_print_height = 200',
    );
    expect(readGcodeBed(text)).toEqual({ origin: [0, 0], size: [250, 210, 200] });
  });

  it('reads Bambu Studio and OrcaSlicer printable_area and printable_height', () => {
    const text = lines(
      '; CONFIG_BLOCK_START',
      '; printable_area = 0x0,256x0,256x256,0x256',
      '; printable_height = 250',
    );
    expect(readGcodeBed(text)).toEqual({ origin: [0, 0], size: [256, 256, 250] });
  });

  it('takes the bounding box of a bed that is not at the origin, and leaves the height open', () => {
    const text = lines(';bed_shape = -110x-110,110x-110,110x110,-110x110');
    const bed = readGcodeBed(text);
    expect(bed?.origin).toEqual([-110, -110]);
    expect(bed?.size).toEqual([220, 220, Infinity]);
  });

  it('reads Cura machine settings where a file carries them, and a centred origin', () => {
    expect(readGcodeBed(lines(';MACHINE_WIDTH:220', ';MACHINE_DEPTH:200'))).toEqual({
      origin: [0, 0],
      size: [220, 200, Infinity],
    });
    // Cura serializes its settings into one comment, newlines written as \n.
    const serialized =
      ';SETTING_3 {"global_quality": "[values]\\nmachine_width = 300\\nmachine_depth = 300\\n' +
      'machine_center_is_zero = True\\n"}';
    expect(readGcodeBed(lines(serialized))).toEqual({
      origin: [-150, -150],
      size: [300, 300, Infinity],
    });
  });

  describe('Cura settings wrapped over ;SETTING_3 lines', () => {
    // Cura's GCodeWriter escapes backslashes, newlines and carriage returns,
    // then cuts the JSON into 69-character chunks, each prefixed ';SETTING_3 '.
    const WIDTH = 69;
    it('decodes a long backslash run with no escape after it in linear time', () => {
      // Each doubling of the run used to take four times as long (332 ms at 32 KiB).
      const run = ';SETTING_3 ' + '\\'.repeat(65536) + 'x\n';
      const started = performance.now();
      expect(readGcodeBed(run)).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(50);
      // A run before a real escape still decodes, and the size reads after it.
      const settings =
        ';SETTING_3 ' + '\\'.repeat(9) + 'x\\\\nmachine_width = 220\\\\nmachine_depth = 210\n';
      expect(readGcodeBed(settings)?.size.slice(0, 2)).toEqual([220, 210]);
    });
    const escaped = (settings: string): string =>
      JSON.stringify({ global_quality: settings })
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
    const wrap = (settings: string): string => {
      const json = escaped(settings);
      const out: string[] = [];
      for (let i = 0; i < json.length; i += WIDTH) {
        out.push(';SETTING_3 ' + json.slice(i, i + WIDTH));
      }
      return out.join('\n');
    };
    // Settings text whose escaped JSON puts a chunk boundary 'offset' characters
    // into the first occurrence of 'needle'.
    const splitInside = (needle: string, offset: number, tail: string): string => {
      const head = '[values]\n';
      const body = (pad: number): string => head + 'x'.repeat(pad) + '\n' + tail;
      for (let pad = 0; pad < WIDTH; pad++) {
        const settings = body(pad);
        const json = escaped(settings);
        if ((json.indexOf(needle) + offset) % WIDTH === 0) {
          return settings;
        }
      }
      throw new Error('no padding found');
    };
    const tail = 'machine_width = 220\nmachine_depth = 200\nmachine_height = 250\n';
    const centered = tail + 'machine_center_is_zero = True\n';

    it('reads a key split across two lines', () => {
      const settings = splitInside('machine_width', 11, tail);
      const text = wrap(settings);
      expect(text).toContain('machine_wid\n;SETTING_3 th');
      expect(readGcodeBed(text)).toEqual({ origin: [0, 0], size: [220, 200, 250] });
    });

    it('reads a number split across two lines completely', () => {
      const settings = splitInside('machine_width = 220', 'machine_width = 2'.length, tail);
      const text = wrap(settings);
      expect(text).toContain('machine_width = 2\n;SETTING_3 20');
      expect(readGcodeBed(text)?.size).toEqual([220, 200, 250]);
    });

    it('reads machine_center_is_zero split across two lines', () => {
      const settings = splitInside('machine_center_is_zero', 12, centered);
      const text = wrap(settings);
      expect(text).toContain('machine_cent\n;SETTING_3 er_is_zero');
      expect(readGcodeBed(text)).toEqual({ origin: [-110, -100], size: [220, 200, 250] });
    });

    it('does not take a prefix of a key or a number for a whole one', () => {
      const text = wrap(
        '[values]\nxmachine_width = 999\nmachine_width = 220.5\nmachine_depth = 200\n',
      );
      expect(readGcodeBed(text)?.size).toEqual([220.5, 200, Infinity]);
    });
  });

  it('gives nothing for a file that names no bed, or a bed that is not a rectangle of numbers', () => {
    expect(readGcodeBed(lines('G1 X1 Y1 E1', ';MINX:0', ';MAXX:20'))).toBeUndefined();
    expect(readGcodeBed(lines('; bed_shape = nonsense'))).toBeUndefined();
    expect(readGcodeBed(lines('; bed_shape = 0x0,0x0,0x0'))).toBeUndefined();
    expect(readGcodeBed(lines('; bed_shape = 0x0,99999x0,99999x99999,0x99999'))).toBeUndefined();
    expect(readGcodeBed('')).toBeUndefined();
  });

  it('prefers the end of a large file, then its start, and never looks at the middle', () => {
    const filler = ';'.padEnd(1000, 'x') + '\n';
    const middle = '; bed_shape = 0x0,1x0,1x1,0x1\n';
    const pad = filler.repeat(Math.ceil((SETTINGS_WINDOW * 2.5) / filler.length));
    const start = '; bed_shape = 0x0,100x0,100x100,0x100\n';
    const end = '; printable_area = 0x0,200x0,200x200,0x200\n';
    expect(readGcodeBed(start + pad + end)?.size).toEqual([200, 200, Infinity]);
    expect(readGcodeBed(start + pad + pad)?.size).toEqual([100, 100, Infinity]);
    expect(readGcodeBed(pad + middle + pad)).toBeUndefined();
    expect(readGcodeBed(middle)?.size).toEqual([1, 1, Infinity]);
  });
});

describe('featureColor', () => {
  const ORANGE = 0xff7d38;
  const YELLOW = 0xf2c94c;
  const RED = 0xf04a4a;
  const PURPLE = 0xa35ad6;
  const INFILL = 0xc0453a;
  const BRIDGE = 0x4d9ad9;
  const SUPPORT = 0x3fd65b;
  const SKIRT = 0x00a085;

  it('classifies a long name of repeated words in linear time', () => {
    const long = 'support '.repeat(8192).trim();
    const start = performance.now();
    expect(featureColor(long)).toBe(SUPPORT);
    expect(featureColor(long + ' interface')).toBe(0x1f8a3b);
    expect(featureColor('interface support')).toBe(SUPPORT);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('maps the PrusaSlicer names', () => {
    expect(featureColor('External perimeter')).toBe(ORANGE);
    expect(featureColor('Perimeter')).toBe(YELLOW);
    expect(featureColor('Internal infill')).toBe(INFILL);
    expect(featureColor('Solid infill')).toBe(PURPLE);
    expect(featureColor('Top solid infill')).toBe(RED);
    expect(featureColor('Bridge infill')).toBe(BRIDGE);
    expect(featureColor('Support material')).toBe(SUPPORT);
    expect(featureColor('Support material interface')).toBe(0x1f8a3b);
    expect(featureColor('Skirt/Brim')).toBe(SKIRT);
    expect(featureColor('Overhang perimeter')).toBe(0x4f6bed);
    expect(featureColor('Gap fill')).toBe(0x9aa0a6);
  });

  it('maps the Cura names', () => {
    expect(featureColor('WALL-OUTER')).toBe(ORANGE);
    expect(featureColor('WALL-INNER')).toBe(YELLOW);
    expect(featureColor('FILL')).toBe(INFILL);
    expect(featureColor('SKIN')).toBe(RED);
    expect(featureColor('SUPPORT')).toBe(SUPPORT);
    expect(featureColor('SUPPORT-INTERFACE')).toBe(0x1f8a3b);
    expect(featureColor('SKIRT')).toBe(SKIRT);
    expect(featureColor('PRIME-TOWER')).toBe(0x8fd18a);
  });

  it('still maps the Bambu and Orca names, and leaves an unknown one to the caller', () => {
    expect(featureColor('Outer wall')).toBe(ORANGE);
    expect(featureColor('Inner wall')).toBe(YELLOW);
    expect(featureColor('Sparse infill')).toBe(INFILL);
    expect(featureColor('Custom')).toBeUndefined();
    expect(featureColor('Unknown')).toBeUndefined();
  });

  it('reads Cura and Prusa feature comments into the segments', () => {
    const cura = parseGcode(
      lines(';LAYER:0', ';TYPE:WALL-OUTER', 'G1 X0 Y0', 'G1 X5 Y0 E1', ';TYPE:FILL', 'G1 X5 Y5 E2'),
    );
    expect(cura.features).toEqual(['Unknown', 'WALL-OUTER', 'FILL']);
    const prusa = parseGcode(
      lines(';LAYER_CHANGE', ';Z:.2', ';TYPE:Top solid infill', 'G1 X0 Y0', 'G1 X5 Y0 E1'),
    );
    expect(prusa.features).toEqual(['Unknown', 'Top solid infill']);
  });
});

describe('gcodeProblem', () => {
  const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'));

  it('accepts text G-code, empty or not', () => {
    expect(gcodeProblem(bytes('G1 X1 Y1 E1\n; done\n'))).toBeNull();
    expect(gcodeProblem(new Uint8Array(0))).toBeNull();
  });

  it('refuses Prusa binary G-code by its magic, whatever the rest', () => {
    expect(gcodeProblem(bytes('GCDE\u0001\u0000\u0000'))).toBe(
      'binary G-code (.bgcode) is not supported',
    );
    expect(gcodeProblem(bytes('GCDE plain text after the magic'))).toBe(
      'binary G-code (.bgcode) is not supported',
    );
  });

  it('refuses a NUL byte in the first 64 KiB but not after it', () => {
    expect(gcodeProblem(bytes('G1 X1\u0000 Y1'))).toMatch(/NUL byte/);
    const late = new Uint8Array(70 * 1024).fill(0x41);
    late[65 * 1024] = 0;
    expect(gcodeProblem(late)).toBeNull();
    late[64 * 1024 - 1] = 0;
    expect(gcodeProblem(late)).toMatch(/NUL byte/);
  });
});
