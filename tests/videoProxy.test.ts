import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkerboardFilter,
  codecLabel,
  ensureProxyDir,
  ffmpegCandidates,
  ffprobeFor,
  findFfmpeg,
  hasAlphaPixelFormat,
  parseProbe,
  parseProgressSeconds,
  probeArgs,
  proxyFileName,
  sweepProxyDir,
  transcodeArgs,
  type SourceProbe,
} from '../src/videoProxy';

const PROBE: SourceProbe = {
  durationSec: 5,
  width: 1920,
  height: 1080,
  frameRate: 24,
  hasAlpha: false,
  hasAudio: false,
  codec: 'prores',
  profile: '4444',
};
const probe = (over: Partial<SourceProbe> = {}): SourceProbe => ({ ...PROBE, ...over });

describe('hasAlphaPixelFormat', () => {
  it('recognises the formats that carry an alpha channel', () => {
    // ProRes 4444, ProRes 4444 XQ, PNG/TIFF sources, and the packed RGB forms.
    for (const fmt of ['yuva444p12le', 'yuva420p', 'rgba', 'bgra', 'argb', 'ya8', 'gbrap10le']) {
      expect(hasAlphaPixelFormat(fmt), fmt).toBe(true);
    }
  });

  it('is not fooled by an "a" somewhere else in the name', () => {
    // The whole reason this matches on a prefix: `yuv420p` and `pal8` both
    // contain an "a", and a checkerboard behind an opaque clip would be a bug
    // nobody could explain.
    for (const fmt of ['yuv420p', 'yuv444p10le', 'nv21', 'pal8', 'gbrp', 'gray', '']) {
      expect(hasAlphaPixelFormat(fmt), fmt).toBe(false);
    }
  });
});

describe('ffmpegCandidates', () => {
  it('leads with the bare name on every platform', () => {
    // A package manager put it on PATH in the overwhelming majority of installs;
    // the absolute paths exist for the GUI-launched editor that did not inherit
    // the user's PATH, which is a fallback rather than the common case.
    expect(ffmpegCandidates('win32', {})[0]).toBe('ffmpeg.exe');
    expect(ffmpegCandidates('darwin', {})[0]).toBe('ffmpeg');
    expect(ffmpegCandidates('linux', {})[0]).toBe('ffmpeg');
  });

  it('covers the Windows package managers that install to a known place', () => {
    const found = ffmpegCandidates('win32', {
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\x',
    });
    expect(found).toContain('C:\\Users\\x\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe');
    expect(found).toContain('C:\\Users\\x\\scoop\\shims\\ffmpeg.exe');
  });

  it('puts Homebrew first on macOS and skips it elsewhere', () => {
    expect(ffmpegCandidates('darwin', {})).toContain('/opt/homebrew/bin/ffmpeg');
    expect(ffmpegCandidates('linux', {})).not.toContain('/opt/homebrew/bin/ffmpeg');
  });

  it('builds paths for the target platform, not the host', () => {
    // The whole list has to be a pure function of its arguments, or the tests
    // only ever describe the machine they ran on.
    expect(ffmpegCandidates('win32', { ProgramData: 'C:\\ProgramData' })).toContain(
      'C:\\ProgramData\\Chocolatey\\bin\\ffmpeg.exe',
    );
  });

  it('lists nothing twice when two roots resolve the same', () => {
    const found = ffmpegCandidates('win32', { ProgramFiles: 'C:\\PF', ProgramData: 'C:\\PF' });
    expect(new Set(found).size).toBe(found.length);
  });
});

describe('ffprobeFor', () => {
  it('takes the sibling of the ffmpeg that was found', () => {
    // They ship together, and probing with one build while encoding with another
    // would write a command line from facts that do not describe it.
    expect(ffprobeFor('/opt/homebrew/bin/ffmpeg', 'darwin')).toBe('/opt/homebrew/bin/ffprobe');
    expect(ffprobeFor('C:\\tools\\ffmpeg.exe', 'win32')).toBe('C:\\tools\\ffprobe.exe');
  });

  it('leaves a bare name bare, to be resolved on PATH like any other', () => {
    expect(ffprobeFor('ffmpeg', 'linux')).toBe('ffprobe');
    expect(ffprobeFor('ffmpeg.exe', 'win32')).toBe('ffprobe.exe');
  });

  it('keeps the case of a path that shouts', () => {
    expect(ffprobeFor('C:\\TOOLS\\FFMPEG.EXE', 'win32')).toBe('C:\\TOOLS\\FFPROBE.EXE');
  });
});

describe('findFfmpeg', () => {
  it('takes the configured path without probing it', async () => {
    // Same contract as markcopy.pdf.browserPath: a setting pointing at nothing
    // should fail at spawn time naming the path the user chose, rather than be
    // silently swapped for some other ffmpeg they did not ask for.
    const found = await findFfmpeg('/nowhere/at/all/ffmpeg', 'linux', {});
    expect(found).toEqual({ ffmpeg: '/nowhere/at/all/ffmpeg', ffprobe: '/nowhere/at/all/ffprobe' });
  });

  it('ignores an empty or whitespace setting', async () => {
    expect(await findFfmpeg('   ', 'linux', { PATH: '' })).toBeUndefined();
  });

  it('reports nothing rather than a name it never found', async () => {
    // Returning a bare `ffmpeg` unprobed would make every machine look equipped
    // and turn "not installed" into a spawn failure at the worst moment.
    expect(await findFfmpeg('', 'linux', { PATH: '/does/not/exist' })).toBeUndefined();
  });
});

describe('probeArgs', () => {
  it('asks only for the fields the encode reads', () => {
    // A camera original's full -show_streams runs to hundreds of lines of side
    // data per stream, all of it parsed and thrown away.
    const args = probeArgs('/tmp/clip.mov');
    expect(args).toContain('-show_entries');
    expect(args.join(' ')).toContain('pix_fmt');
    expect(args.slice(-2)).toEqual(['-i', '/tmp/clip.mov']);
  });
});

describe('parseProbe', () => {
  const json = JSON.stringify({
    streams: [
      {
        index: 0,
        codec_name: 'prores',
        profile: '4444',
        codec_type: 'video',
        pix_fmt: 'yuva444p12le',
        width: 1920,
        height: 1080,
        r_frame_rate: '24/1',
      },
      { index: 1, codec_type: 'audio', codec_name: 'pcm_s24le' },
    ],
    format: { duration: '5.000000' },
  });

  it('reads what the encode needs out of ffprobe', () => {
    expect(parseProbe(json)).toEqual({
      durationSec: 5,
      width: 1920,
      height: 1080,
      frameRate: 24,
      hasAlpha: true,
      hasAudio: true,
      codec: 'prores',
      profile: '4444',
    });
  });

  it('works out a fractional frame rate', () => {
    const ntsc = parseProbe(
      JSON.stringify({ streams: [{ codec_type: 'video', r_frame_rate: '30000/1001' }] }),
    );
    expect(ntsc.frameRate).toBeCloseTo(29.97, 2);
  });

  it('answers blankly rather than throwing on junk', () => {
    // Every field here is an optimisation: the codec in the message, the total
    // behind the percentage, the checkerboard behind an alpha channel. A probe
    // that fails should cost those, not the transcode.
    for (const bad of ['', 'not json', '{}', '{"streams":null}']) {
      const result = parseProbe(bad);
      expect(result.codec, bad).toBe('');
      expect(result.hasAlpha, bad).toBe(false);
      expect(result.durationSec, bad).toBe(0);
    }
  });

  it('treats a missing or zero duration as unknown', () => {
    expect(parseProbe(JSON.stringify({ format: { duration: 'N/A' } })).durationSec).toBe(0);
  });

  it('reports no audio for a video-only file', () => {
    expect(parseProbe(JSON.stringify({ streams: [{ codec_type: 'video' }] })).hasAudio).toBe(false);
  });
});

describe('codecLabel', () => {
  it('spells the names the way the industry does', () => {
    expect(codecLabel(probe())).toBe('ProRes 4444');
    expect(codecLabel(probe({ codec: 'dnxhd', profile: '' }))).toBe('DNxHD');
    expect(codecLabel(probe({ codec: 'hevc', profile: 'Main 10' }))).toBe('HEVC Main 10');
  });

  it('passes an unknown codec through rather than guessing', () => {
    expect(codecLabel(probe({ codec: 'cfhd', profile: '' }))).toBe('CFHD');
  });

  it('drops a profile that says nothing', () => {
    expect(codecLabel(probe({ codec: 'h264', profile: 'unknown' }))).toBe('H.264');
  });

  it('names nothing when the probe found nothing', () => {
    expect(codecLabel(probe({ codec: '', profile: '' }))).toBe('');
  });
});

describe('transcodeArgs', () => {
  it('encodes H.264 that a browser will start before the file is read', () => {
    const args = transcodeArgs('in.mov', 'out.mp4', probe());
    expect(args).toContain('libx264');
    expect(args.join(' ')).toContain('-movflags +faststart');
    expect(args[args.length - 1]).toBe('out.mp4');
  });

  it('rounds odd dimensions off, which yuv420p cannot carry', () => {
    expect(transcodeArgs('in.mov', 'out.mp4', probe()).join(' ')).toContain(
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    );
  });

  it('lays a clip with alpha over a checkerboard instead of black', () => {
    // Flattening a lower third onto black gives a frame that is 99% black and
    // reads as "this clip renders nothing".
    const args = transcodeArgs('in.mov', 'out.mp4', probe({ hasAlpha: true }));
    expect(args).toContain('-filter_complex');
    expect(args).toContain('[v]');
    expect(args.join(' ')).toContain('overlay=shortest=1');
  });

  it('falls back to the plain path when the probe gave no dimensions', () => {
    // There is no checkerboard to draw without a size, and refusing the encode
    // over it would lose a proxy that would have worked.
    const args = transcodeArgs('in.mov', 'out.mp4', probe({ hasAlpha: true, width: 0, height: 0 }));
    expect(args).not.toContain('-filter_complex');
    expect(args).toContain('0:v:0');
  });

  it('takes the first audio stream, optionally, and re-encodes it', () => {
    // ProRes originals routinely carry PCM, which no browser plays in an MP4.
    const args = transcodeArgs('in.mov', 'out.mp4', probe({ hasAudio: true }));
    expect(args).toContain('0:a:0?');
    expect(args).toContain('aac');
  });

  it('asks for silence when there is no audio to take', () => {
    expect(transcodeArgs('in.mov', 'out.mp4', probe())).toContain('-an');
  });

  it('reports progress on stdout so stderr holds only the failure', () => {
    const args = transcodeArgs('in.mov', 'out.mp4', probe());
    expect(args.join(' ')).toContain('-progress pipe:1');
    expect(args.join(' ')).toContain('-loglevel error');
  });

  it('never lets a path be read as anything but a path', () => {
    // The argument vector is what makes that true: a file named like a switch is
    // still just the input, because it is never pasted into a command string.
    const args = transcodeArgs('-not-a-flag.mov', 'out.mp4', probe());
    expect(args[args.indexOf('-i') + 1]).toBe('-not-a-flag.mov');
  });
});

describe('checkerboardFilter', () => {
  it('evaluates the board once and holds it, rather than per frame', () => {
    // geq is a per-pixel expression; running it over two million pixels for
    // every frame costs more than the encode it is decorating.
    const filter = checkerboardFilter(1920, 1080, 24);
    expect(filter).toContain('d=1:r=1');
    expect(filter).toContain('loop=loop=-1:size=1:start=0');
    expect(filter).toContain('fps=24');
  });

  it('escapes the commas inside the expression', () => {
    // ffmpeg's filtergraph parser splits on commas before the expression parser
    // ever sees the string, so an unescaped one truncates the condition.
    expect(checkerboardFilter(64, 64, 24)).toContain('\\,');
  });

  it('picks a frame rate when the probe could not', () => {
    expect(checkerboardFilter(64, 64, 0)).toContain('fps=30');
  });
});

describe('parseProgressSeconds', () => {
  it('reads the position out of a progress block', () => {
    expect(parseProgressSeconds('frame=120\nout_time_us=5000000\nprogress=end\n')).toBe(5);
  });

  it('takes the last position when a read holds several blocks', () => {
    const chunk =
      'out_time_us=1000000\nprogress=continue\nout_time_us=3083333\nprogress=continue\n';
    expect(parseProgressSeconds(chunk)).toBeCloseTo(3.083, 3);
  });

  it('reads out_time_ms as microseconds, which is what ffmpeg means by it', () => {
    // A long-standing quirk of ffmpeg's own output, not a mistake here.
    expect(parseProgressSeconds('out_time_ms=2000000\n')).toBe(2);
  });

  it('ignores the negative placeholder ffmpeg emits before the first frame', () => {
    expect(parseProgressSeconds('out_time_us=-9223372036854775807\n')).toBeUndefined();
  });

  it('says nothing about a chunk that carried no timestamp', () => {
    expect(parseProgressSeconds('frame=1\nfps=0.00\nbitrate=N/A\n')).toBeUndefined();
    expect(parseProgressSeconds('')).toBeUndefined();
  });
});

describe('proxyFileName', () => {
  it('keeps the source recognisable in a temp listing', () => {
    expect(proxyFileName('lower-third-khan-5s.mov', 'abc123')).toBe(
      'lower-third-khan-5s-abc123.mp4',
    );
  });

  it('takes characters a file name cannot carry out of the name', () => {
    expect(proxyFileName('take 3 (final?).mov', 'x')).toBe('take-3-final-x.mp4');
  });

  it('bounds the length, so a deep temp path stays inside MAX_PATH', () => {
    const long = `${'x'.repeat(200)}.mov`;
    expect(proxyFileName(long, 'x').length).toBeLessThanOrEqual(70);
  });

  it('still produces a name for a file that had none left', () => {
    expect(proxyFileName('...', 'x')).toBe('video-x.mp4');
    expect(proxyFileName('', 'x')).toBe('video-x.mp4');
    expect(proxyFileName('!!!.mov', 'x')).toBe('video-x.mp4');
  });
});

describe('ensureProxyDir', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'markcopy-test-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates the directory when it is not there', async () => {
    const dir = join(root, 'proxies');
    expect(await ensureProxyDir(dir)).toBe(dir);
    expect(await readdir(dir)).toEqual([]);
  });

  it('accepts a directory it already made', async () => {
    const dir = join(root, 'proxies');
    await ensureProxyDir(dir);
    await expect(ensureProxyDir(dir)).resolves.toBe(dir);
  });

  it('refuses a path that is a file rather than a directory', async () => {
    const dir = join(root, 'proxies');
    await writeFile(dir, 'not a directory');
    await expect(ensureProxyDir(dir)).rejects.toThrow(/not a directory/);
  });

  // The reason `recursive` is not used: it would follow this happily, and the
  // directory is handed to the webview as a localResourceRoot.
  it('refuses a symlink standing in for the directory', async () => {
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    const dir = join(root, 'proxies');
    try {
      await symlink(elsewhere, dir, 'dir');
    } catch {
      return; // Windows without developer mode cannot make one; nothing to test
    }
    await expect(ensureProxyDir(dir)).rejects.toThrow(/not a directory/);
  });
});

describe('sweepProxyDir', () => {
  let dir = '';
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 0, 2);

  const proxy = async (name: string, ageMs: number): Promise<string> => {
    const full = join(dir, name);
    await writeFile(full, 'x');
    const when = new Date(now - ageMs);
    await utimes(full, when, when);
    return full;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'markcopy-sweep-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes proxies a crashed window left behind', async () => {
    await proxy('old-a1b2c3.mp4', 3 * DAY);
    await sweepProxyDir(dir, now);
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps one a panel open right now could still be playing', async () => {
    await proxy('live-a1b2c3.mp4', 60_000);
    await proxy('stale-d4e5f6.mp4', 2 * DAY);
    await sweepProxyDir(dir, now);
    expect(await readdir(dir)).toEqual(['live-a1b2c3.mp4']);
  });

  it('leaves subdirectories alone', async () => {
    await mkdir(join(dir, 'nested'));
    await sweepProxyDir(dir, now + 10 * DAY);
    expect(await readdir(dir)).toEqual(['nested']);
  });

  it('says nothing about a directory that was never made', async () => {
    await expect(sweepProxyDir(join(dir, 'absent'), now)).resolves.toBeUndefined();
  });
});
