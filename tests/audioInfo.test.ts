// @vitest-environment node
//
// Pure coverage for the waveform peaks, the level maths and the details formatting
// in src/webview/audioInfo.ts. No audio is decoded: the samples are generated.
import { describe, it, expect } from 'vitest';
import {
  CLIP_THRESHOLD,
  PEAK_BUCKETS,
  WAVEFORM_DECODE_BUDGET,
  WAVEFORM_SIZE_CAP,
  analyzeChannels,
  decodedBytes,
  detailRows,
  detailsMarkdown,
  formatBitRate,
  formatClipping,
  formatLevel,
  formatPreciseDuration,
  formatSampleRate,
  parseDetails,
  tagRows,
  timeAtX,
  toDb,
  waveformSkipped,
  waveformTooLong,
} from '../src/webview/audioInfo';

const noYield = () => Promise.resolve();

function sine(amplitude: number, samples: number, cycles: number): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * cycles * i) / samples);
  }
  return out;
}

describe('analyzeChannels', () => {
  it('keeps the min and max of each bucket, per channel', async () => {
    const left = Float32Array.from([0.1, -0.2, 0.5, 0.3, -0.6, 0.2, 0, 0.4]);
    const right = Float32Array.from([0, 0, 0, 0, 0.25, -0.25, 0, 0]);
    const result = await analyzeChannels([left, right], 4, noYield);
    expect(result.buckets).toBe(4);
    expect(result.length).toBe(8);
    const l = Array.from(result.peaks[0]);
    const expected = [-0.2, 0.1, 0.3, 0.5, -0.6, 0.2, 0, 0.4];
    expected.forEach((v, i) => expect(l[i]).toBeCloseTo(v, 5));
    expect(Array.from(result.peaks[1])).toEqual([0, 0, 0, 0, -0.25, 0.25, 0, 0]);
    expect(result.peak).toBeCloseTo(0.6, 5);
  });

  it('never makes more buckets than samples, and has a default resolution', async () => {
    expect((await analyzeChannels([new Float32Array(3)], 100, noYield)).buckets).toBe(3);
    expect((await analyzeChannels([new Float32Array(50_000)], undefined, noYield)).buckets).toBe(
      PEAK_BUCKETS,
    );
  });

  it('reads a half-scale sine as -6.0 dBFS peak and -9.0 dBFS RMS', async () => {
    const result = await analyzeChannels([sine(0.5, 48_000, 440)], 100, noYield);
    expect(toDb(result.peak)).toBeCloseTo(-6.02, 1);
    expect(toDb(result.rms)).toBeCloseTo(-9.03, 1);
    expect(formatLevel(result.peak)).toBe('-6.0 dBFS');
    expect(formatLevel(result.rms)).toBe('-9.0 dBFS');
    expect(result.clipped).toBe(0);
  });

  it('pools every channel into the RMS', async () => {
    const loud = sine(1, 4800, 10);
    const quiet = new Float32Array(4800);
    const result = await analyzeChannels([loud, quiet], 10, noYield);
    // A full-scale sine is -3 dB RMS; half the samples silent costs another 3 dB.
    expect(toDb(result.rms)).toBeCloseTo(-3.01 - 3.01, 1);
  });

  it('counts samples at or past the clip threshold on any channel', async () => {
    const a = Float32Array.from([0, 1, -1, 0.5, CLIP_THRESHOLD, 0.998]);
    const b = Float32Array.from([-0.9995, 0, 0, 0, 0, 0]);
    const result = await analyzeChannels([a, b], 3, noYield);
    expect(result.clipped).toBe(4);
    expect(formatClipping(4, 6, 2)).toBe('4 samples (33.33%)');
    expect(formatClipping(0, 6, 2)).toBe('none');
  });

  it('calls silence silent, not minus infinity', async () => {
    const result = await analyzeChannels([new Float32Array(1000)], 10, noYield);
    expect(result.peak).toBe(0);
    expect(result.rms).toBe(0);
    expect(toDb(result.rms)).toBe(-Infinity);
    expect(formatLevel(result.peak)).toBe('silent');
  });

  it('yields to the event loop on a long file', async () => {
    let yields = 0;
    await analyzeChannels([new Float32Array(5_000_000)], 2000, () => {
      yields++;
      return Promise.resolve();
    });
    expect(yields).toBeGreaterThanOrEqual(2);
  });

  it('copes with no channels at all', async () => {
    const result = await analyzeChannels([], 10, noYield);
    expect(result.peaks).toEqual([]);
    expect(result.rms).toBe(0);
  });
});

describe('formatting', () => {
  it('formats the precise duration', () => {
    expect(formatPreciseDuration(0)).toBe('0:00:00.000');
    expect(formatPreciseDuration(3725.4567)).toBe('1:02:05.457');
    expect(formatPreciseDuration(Number.NaN)).toBe('');
  });

  it('formats rates', () => {
    expect(formatSampleRate(44100)).toBe('44.1 kHz');
    expect(formatSampleRate(48000)).toBe('48 kHz');
    expect(formatBitRate(320_000)).toBe('320 kbps');
  });

  it('maps a pointer position to a time, clamped to the file', () => {
    expect(timeAtX(200, 400, 120)).toBe(60);
    expect(timeAtX(-10, 400, 120)).toBe(0);
    expect(timeAtX(900, 400, 120)).toBe(120);
    expect(timeAtX(10, 0, 120)).toBe(0);
    expect(timeAtX(10, 400, Number.NaN)).toBe(0);
  });

  it('says why a file over the cap has no waveform', () => {
    expect(WAVEFORM_SIZE_CAP).toBe(150 * 1024 * 1024);
    expect(waveformSkipped(200 * 1024 * 1024)).toContain('over the');
  });

  it('estimates decoded bytes as duration x rate x channels x 4', () => {
    // 2 h of stereo at 48 kHz: the 86 MB MP3 that decodes to ~2.5 GB.
    expect(decodedBytes(7200)).toBe(7200 * 48000 * 2 * 4);
    // A lower probed rate is raised to 48 kHz (the context may resample up).
    expect(decodedBytes(10, 22050, 1)).toBe(10 * 48000 * 4);
    expect(decodedBytes(10, 96000, 6)).toBe(10 * 96000 * 6 * 4);
    expect(decodedBytes(10, 0, 0)).toBe(10 * 48000 * 2 * 4);
    expect(decodedBytes(Number.NaN)).toBeNaN();
    expect(decodedBytes(Infinity)).toBeNaN();
  });

  it('budgets about 46 minutes of 48 kHz stereo', () => {
    expect(WAVEFORM_DECODE_BUDGET).toBe(1024 ** 3);
    expect(decodedBytes(45 * 60)).toBeLessThan(WAVEFORM_DECODE_BUDGET);
    expect(decodedBytes(47 * 60)).toBeGreaterThan(WAVEFORM_DECODE_BUDGET);
  });

  it('words the too-long and unknown-length skips', () => {
    expect(waveformTooLong(7080)).toBe('Waveform skipped: 1 h 58 min is too long to decode here.');
    expect(waveformTooLong(3000)).toBe('Waveform skipped: 50 min is too long to decode here.');
    expect(waveformTooLong(Infinity)).toContain('not known');
  });
});

describe('details rows', () => {
  const probe = {
    format: 'MP3',
    codec: 'MP3',
    sampleRate: 44100,
    channels: 2,
    layout: 'stereo',
    bitRate: 192_000,
    duration: 61.5,
    tags: { title: 'Song', artist: 'Band', comment: 'line 1\nline 2' },
  };

  it('lists the rows in order, with the levels from the decode', () => {
    const rows = detailRows('a.mp3', 1_500_000, probe, {
      peak: 0.5,
      rms: 0.25,
      clipped: 0,
      length: 100,
      channels: 2,
    });
    expect(rows.map(([label]) => label)).toEqual([
      'Format',
      'Codec',
      'Sample rate',
      'Channels',
      'Bitrate',
      'Duration',
      'File size',
      'Peak',
      'RMS',
      'Clipping',
    ]);
    expect(rows.find(([l]) => l === 'Channels')?.[1]).toBe('2 (stereo)');
    expect(rows.find(([l]) => l === 'Duration')?.[1]).toBe('0:01:01.500');
  });

  it('falls back to the extension and the decode, and omits what it does not know', () => {
    const rows = detailRows('take.wav', 0, undefined, { duration: 3, channels: 1 });
    expect(rows).toEqual([
      ['Format', 'WAV'],
      ['Channels', '1'],
      ['Duration', '0:00:03.000'],
    ]);
  });

  it('shows tags in display order', () => {
    expect(tagRows(probe)).toEqual([
      ['Title', 'Song'],
      ['Artist', 'Band'],
      ['Comment', 'line 1\nline 2'],
    ]);
  });

  it('builds Markdown with each value on one line', () => {
    const md = detailsMarkdown('a.mp3', [['Format', 'MP3']], tagRows(probe));
    expect(md).toContain('## a.mp3');
    expect(md).toContain('- **Format:** MP3');
    expect(md).toContain('### Tags');
    expect(md).toContain('- **Comment:** line 1 line 2');
  });
});

describe('parseDetails', () => {
  it('keeps valid fields and drops mistyped ones', () => {
    expect(
      parseDetails({
        format: 'FLAC',
        sampleRate: '44100',
        channels: 2.4,
        bitDepth: -1,
        duration: 5,
        tags: { title: 'T', genre: 7, nonsense: 'x' },
        extra: 'ignored',
      }),
    ).toEqual({ format: 'FLAC', channels: 2, duration: 5, tags: { title: 'T' } });
  });

  it('caps long strings and refuses non-objects', () => {
    expect(parseDetails({ tags: { comment: 'x'.repeat(5000) } })?.tags?.comment).toHaveLength(1000);
    expect(parseDetails(null)).toBeUndefined();
    expect(parseDetails([])).toBeUndefined();
    expect(parseDetails('x')).toBeUndefined();
    expect(parseDetails({})).toBeUndefined();
  });
});
