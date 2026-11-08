// @vitest-environment node
//
// Host-side shaping of ffprobe's JSON for the audio details panel. The samples are
// recorded ffprobe output (trimmed to the fields the probe asks for); ffprobe itself
// is never run.
import { describe, it, expect } from 'vitest';
import { audioProbeArgs, shapeAudioProbe } from '../src/audioProbe';

const MP3 = JSON.stringify({
  streams: [
    {
      codec_name: 'mp3',
      codec_long_name: 'MP3 (MPEG audio layer 3)',
      codec_type: 'audio',
      sample_rate: '44100',
      channels: 2,
      channel_layout: 'stereo',
      bits_per_sample: 0,
      bit_rate: '192000',
      duration: '215.032000',
    },
    { codec_name: 'mjpeg', codec_type: 'video' },
  ],
  format: {
    format_name: 'mp3',
    format_long_name: 'MP2/3 (MPEG audio layer 2/3)',
    duration: '215.058000',
    bit_rate: '192200',
    tags: {
      title: 'Blue <b>Monday</b>',
      artist: 'New Order',
      album: 'Power, Corruption & Lies',
      album_artist: 'New Order',
      date: '1983',
      track: '3/8',
      genre: 'Synth-pop',
      comment: 'ripped\u0000 from CD',
      encoder: 'LAME',
    },
  },
});

const FLAC = JSON.stringify({
  streams: [
    {
      codec_name: 'flac',
      codec_long_name: 'FLAC (Free Lossless Audio Codec)',
      codec_type: 'audio',
      sample_rate: '96000',
      channels: 2,
      channel_layout: 'stereo',
      bits_per_sample: 0,
      bits_per_raw_sample: '24',
      duration: '12.500000',
      tags: { TITLE: 'Upper case', ALBUMARTIST: 'Vorbis style', TRACKNUMBER: '4' },
    },
  ],
  format: {
    format_name: 'flac',
    format_long_name: 'raw FLAC',
    duration: '12.500000',
    bit_rate: '2900000',
  },
});

const M4A = JSON.stringify({
  streams: [
    {
      codec_name: 'aac',
      codec_long_name: 'AAC (Advanced Audio Coding)',
      codec_type: 'audio',
      sample_rate: '48000',
      channels: 6,
      channel_layout: '5.1',
      bit_rate: '384000',
      duration: '30.0',
    },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '30.01', bit_rate: '390000' },
});

describe('shapeAudioProbe', () => {
  it('shapes an MP3 with ID3 tags', () => {
    expect(shapeAudioProbe(MP3)).toEqual({
      format: 'MP3',
      codec: 'MP3',
      sampleRate: 44100,
      channels: 2,
      layout: 'stereo',
      bitRate: 192000,
      duration: 215.032,
      tags: {
        title: 'Blue <b>Monday</b>',
        artist: 'New Order',
        album: 'Power, Corruption & Lies',
        albumArtist: 'New Order',
        date: '1983',
        track: '3/8',
        genre: 'Synth-pop',
        comment: 'ripped from CD',
      },
    });
  });

  it('reads bit depth and upper-case Vorbis tags from a FLAC', () => {
    const details = shapeAudioProbe(FLAC);
    expect(details?.bitDepth).toBe(24);
    expect(details?.bitRate).toBe(2_900_000);
    expect(details?.tags).toEqual({ title: 'Upper case', albumArtist: 'Vorbis style', track: '4' });
  });

  it('labels the MP4 family as M4A and keeps a surround layout', () => {
    const details = shapeAudioProbe(M4A);
    expect(details?.format).toBe('MPEG-4 audio (M4A)');
    expect(details?.codec).toBe('AAC');
    expect(details?.layout).toBe('5.1');
    expect(details?.bitDepth).toBeUndefined();
    expect(details?.tags).toBeUndefined();
  });

  it('gives a layout from the channel count when ffprobe names none', () => {
    const json = JSON.stringify({
      streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '8000' }],
      format: { format_name: 'wav' },
    });
    const details = shapeAudioProbe(json);
    expect(details?.layout).toBe('mono');
    expect(details?.format).toBe('WAV');
  });

  it('refuses an unsafe layout string and mistyped values', () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: 'audio', channels: 2, channel_layout: '<script>', sample_rate: 'abc' },
      ],
      format: { format_name: 'ogg', tags: { title: { nested: true }, artist: 42 } },
    });
    const details = shapeAudioProbe(json);
    expect(details?.layout).toBe('stereo');
    expect(details?.sampleRate).toBeUndefined();
    expect(details?.tags).toEqual({ artist: '42' });
  });

  it('caps a very long tag', () => {
    const json = JSON.stringify({
      streams: [{ codec_type: 'audio' }],
      format: { tags: { comment: 'y'.repeat(5000) } },
    });
    expect(shapeAudioProbe(json)?.tags?.comment).toHaveLength(1000);
  });

  it('is undefined for output that is not a probe result', () => {
    expect(shapeAudioProbe('')).toBeUndefined();
    expect(shapeAudioProbe('not json')).toBeUndefined();
    expect(shapeAudioProbe('[]')).toBeUndefined();
    expect(shapeAudioProbe('{}')).toBeUndefined();
  });
});

describe('audioProbeArgs', () => {
  it('passes the file as a single argument after -i', () => {
    const args = audioProbeArgs('C:\\Music\\a b & c.mp3');
    expect(args.slice(-2)).toEqual(['-i', 'C:\\Music\\a b & c.mp3']);
    expect(args).toContain('json');
  });
});
