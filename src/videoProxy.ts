// Making an unplayable video playable, by transcoding a proxy copy with ffmpeg.
//
// QuickTime is a container, not a codec. VS Code's Chromium decodes H.264 with
// AAC and little else, while a `.mov` out of a camera or an editor is usually
// ProRes, DNxHD, or HEVC. The viewer used to stop there and hand the file to the
// OS player. When ffmpeg is on the machine there is a better answer: encode a
// throwaway H.264 copy next to it and play that.
//
// The proxy is a preview, not an export. It is written to a temp directory and
// nothing offers to keep it: the panel closing deletes the one it was playing,
// an encode that is cancelled or fails deletes what it had written, and a sweep
// at startup takes anything a window was killed before it could tidy away.
//
// Nothing here imports `vscode`, so it is all unit-testable.
import { spawn } from 'node:child_process';
import { access, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, extname, join, posix, win32 } from 'node:path';

// How long a transcode may go without reporting a single new timestamp before it
// is treated as wedged. ffmpeg reports progress roughly twice a second on any
// input it is making headway on, so this is two orders of magnitude of slack
// rather than a performance budget: it exists to stop a hung process holding the
// panel's spinner (and a temp file) forever, not to bound a slow encode. A long
// encode that is still moving is never killed, and the reader can cancel.
const STALL_TIMEOUT_MS = 120_000;

// How long a killed ffmpeg gets to actually exit. Same reasoning as the browser
// in src/pdfExport.ts: on Windows the output file cannot be deleted while the
// process still holds it open, so the cleanup waits rather than stranding it.
const KILL_GRACE_MS = 2_000;

// The checkerboard squares behind a video with an alpha channel, in pixels, and
// the two greys they alternate between. Sized and toned like the transparency
// checkerboard in every compositing tool, because that is the convention the
// reader already knows: a lower third that is 99% transparent has to read as
// transparent rather than as a graphic on a flat background.
const CHECKER_SQUARE = 24;
const CHECKER_LIGHT = 168;
const CHECKER_DARK = 120;

/** An ffmpeg install: the encoder and the prober that ships beside it. */
export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
}

/** What the source turns out to be, which decides how the proxy is built. */
export interface SourceProbe {
  /** Seconds, or 0 when the container does not say. */
  durationSec: number;
  width: number;
  height: number;
  /** Frames per second, or 0 when unknown. */
  frameRate: number;
  hasAlpha: boolean;
  hasAudio: boolean;
  /** ffmpeg's codec name, e.g. `prores`. Empty when there is no video stream. */
  codec: string;
  /** ffmpeg's profile name, e.g. `4444`. Often absent. */
  profile: string;
}

/**
 * Pixel formats that carry an alpha channel.
 *
 * Matched on the prefix rather than by looking for an `a`, which would take
 * `yuv420p` apart in the wrong place and call every gbrp/nv21 format
 * transparent. The suffixes ffmpeg appends (bit depth, endianness) are all after
 * the part that names the channels, so the prefix is the whole signal.
 */
const ALPHA_PIX_FMT = /^(?:ya|yuva|gbrap|rgba|bgra|argb|abgr)/;

export function hasAlphaPixelFormat(pixFmt: string): boolean {
  return ALPHA_PIX_FMT.test(pixFmt);
}

// ---------------------------------------------------------------------------
// Finding ffmpeg
// ---------------------------------------------------------------------------

/**
 * ffmpeg executables to try, most preferred first.
 *
 * The bare name leads on every platform, because ffmpeg is overwhelmingly
 * installed by a package manager that puts it on PATH (winget, Homebrew, apt).
 * The absolute paths below it cover the case a GUI-launched VS Code inherits a
 * PATH that the user's shell has and it does not, which is the normal state of
 * affairs on macOS.
 *
 * Paths are joined with the separator of the *target* platform rather than the
 * host's, so the result depends only on the arguments (same contract as
 * `browserCandidates` in src/pdfExport.ts).
 */
export function ffmpegCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === 'win32') {
    const roots = [env['LOCALAPPDATA'], env['ProgramFiles'], env['ProgramData']].filter(
      (r): r is string => Boolean(r),
    );
    const relative = [
      // winget's shim directory, which is on PATH for a shell but not always for
      // an app launched from the Start menu.
      ['Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'],
      ['Chocolatey', 'bin', 'ffmpeg.exe'],
      ['ffmpeg', 'bin', 'ffmpeg.exe'],
    ];
    const out = ['ffmpeg.exe'];
    for (const rel of relative) {
      for (const root of roots) {
        out.push(win32.join(root, ...rel));
      }
    }
    // Scoop installs under the user profile rather than any of the roots above.
    if (env['USERPROFILE']) {
      out.push(win32.join(env['USERPROFILE'], 'scoop', 'shims', 'ffmpeg.exe'));
    }
    return dedupe(out);
  }

  const absolute =
    platform === 'darwin'
      ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg']
      : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg'];
  return dedupe(['ffmpeg', ...absolute]);
}

function dedupe(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

/**
 * The ffprobe that belongs to `ffmpeg`, found by swapping the file name.
 *
 * They ship together and are always installed side by side, so the sibling is a
 * far better answer than a second PATH search: a machine with two ffmpeg builds
 * must not probe with one and encode with the other, since what the probe
 * reports (a pixel format, an alpha channel) is used to write the other's
 * command line.
 *
 * A bare name stays bare, and is resolved on PATH like any other.
 */
export function ffprobeFor(ffmpeg: string, platform: NodeJS.Platform = process.platform): string {
  const path = platform === 'win32' ? win32 : posix;
  const dir = path.dirname(ffmpeg);
  const name = path
    .basename(ffmpeg)
    .replace(/ffmpeg/i, (m) =>
      m === 'FFMPEG' ? 'FFPROBE' : m === 'Ffmpeg' ? 'Ffprobe' : 'ffprobe',
    );
  return dir === '.' ? name : path.join(dir, name);
}

/** Whether `path` exists and is executable by us. */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a bare command name against PATH, or undefined if it is not there.
 *
 * Unlike the equivalent in src/pdfExport.ts, this has to work on Windows: the
 * candidate list above leads with a bare `ffmpeg.exe` there, because that is
 * what every Windows package manager puts on PATH and the absolute fallbacks
 * only cover the three that install to a predictable place.
 */
async function resolveOnPath(
  name: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const raw = env['PATH'] ?? env['Path'] ?? env['path'];
  if (!raw) {
    return undefined;
  }
  const path = platform === 'win32' ? win32 : posix;
  for (const dir of raw.split(platform === 'win32' ? ';' : ':')) {
    if (dir === '') {
      continue;
    }
    // Strip the quotes Windows tolerates around a PATH entry with a space in it;
    // path.join would otherwise build a directory name that includes them.
    const full = path.join(platform === 'win32' ? dir.replace(/^"|"$/g, '') : dir, name);
    if (await isExecutable(full)) {
      return full;
    }
  }
  return undefined;
}

/**
 * Locate an ffmpeg able to build a proxy, or undefined if there is none.
 *
 * `configured` (the `markcopy.video.ffmpegPath` setting) wins outright, and is
 * deliberately not probed, for the same reason `markcopy.pdf.browserPath` is
 * not: a setting pointing somewhere wrong should fail at spawn time with a
 * message naming it, rather than be silently ignored in favour of some other
 * ffmpeg the user did not choose.
 *
 * Both halves of the search probe. A bare name returned unprobed would be
 * `ffmpeg` on every machine, making the absolute paths below it dead code and
 * turning "no ffmpeg installed" into a spawn failure at the worst moment,
 * instead of the message the viewer wants to show up front.
 */
export async function findFfmpeg(
  configured: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): Promise<FfmpegTools | undefined> {
  const trimmed = configured?.trim();
  if (trimmed) {
    return { ffmpeg: trimmed, ffprobe: ffprobeFor(trimmed, platform) };
  }
  for (const candidate of ffmpegCandidates(platform, env)) {
    const bare = !candidate.includes('/') && !candidate.includes('\\');
    const found = bare
      ? await resolveOnPath(candidate, platform, env)
      : (await isExecutable(candidate))
        ? candidate
        : undefined;
    if (found !== undefined) {
      return { ffmpeg: found, ffprobe: ffprobeFor(found, platform) };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Probing the source
// ---------------------------------------------------------------------------

/**
 * Ask ffprobe only for the fields the transcode actually reads.
 *
 * `-show_entries` rather than a full `-show_streams`, which on a camera original
 * runs to hundreds of lines of side data per stream.
 */
export function probeArgs(input: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_entries',
    'format=duration:stream=index,codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate',
    '-i',
    input,
  ];
}

/** `24/1` -> 24, `30000/1001` -> 29.97, anything unparseable -> 0. */
function parseRate(raw: unknown): number {
  if (typeof raw !== 'string') {
    return 0;
  }
  const [num, den] = raw.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  return Number.isFinite(n) && Number.isFinite(d) && d > 0 && n > 0 ? n / d : 0;
}

function firstNumber(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Read ffprobe's JSON into the handful of facts the encode needs.
 *
 * Tolerant on purpose: a file that probes strangely should still get a proxy
 * attempt on the plain path, because the fields that go missing (frame rate,
 * duration) only drive the checkerboard and the progress readout. The one thing
 * worth being certain about is the alpha channel, and that comes from a pixel
 * format ffprobe either reports or does not.
 */
export function parseProbe(json: string): SourceProbe {
  const empty: SourceProbe = {
    durationSec: 0,
    width: 0,
    height: 0,
    frameRate: 0,
    hasAlpha: false,
    hasAudio: false,
    codec: '',
    profile: '',
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return empty;
  }
  const root = parsed as { streams?: unknown; format?: { duration?: unknown } };
  const streams = Array.isArray(root.streams) ? (root.streams as Record<string, unknown>[]) : [];
  const video = streams.find((s) => s.codec_type === 'video');
  return {
    durationSec: firstNumber(root.format?.duration),
    width: firstNumber(video?.width),
    height: firstNumber(video?.height),
    frameRate: parseRate(video?.r_frame_rate),
    hasAlpha: hasAlphaPixelFormat(typeof video?.pix_fmt === 'string' ? video.pix_fmt : ''),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    codec: typeof video?.codec_name === 'string' ? video.codec_name : '',
    profile: typeof video?.profile === 'string' ? video.profile : '',
  };
}

/**
 * How to name the source codec in a sentence: `prores` + `4444` -> `ProRes 4444`.
 *
 * ffmpeg's codec names are lowercase identifiers, and the ones a reader is
 * likely to meet here have established spellings that are not just a
 * capitalisation of those. Anything not on the list is passed through uppercased
 * rather than guessed at, and an unprobed file gets no name at all.
 */
export function codecLabel(probe: SourceProbe): string {
  const names: Record<string, string> = {
    prores: 'ProRes',
    dnxhd: 'DNxHD',
    hevc: 'HEVC',
    h264: 'H.264',
    vp9: 'VP9',
    av1: 'AV1',
    mpeg2video: 'MPEG-2',
    mjpeg: 'Motion JPEG',
    rawvideo: 'uncompressed video',
    cineform: 'CineForm',
    ffv1: 'FFV1',
  };
  if (!probe.codec) {
    return '';
  }
  const base = names[probe.codec] ?? probe.codec.toUpperCase();
  // A profile is only worth showing when it says something the codec name does
  // not. ffmpeg reports "Main"/"High" for H.264, which nobody needs, but "4444"
  // is the whole reason a ProRes file behaves the way it does.
  const profile = probe.profile && probe.profile !== 'unknown' ? probe.profile : '';
  return profile ? `${base} ${profile}` : base;
}

// ---------------------------------------------------------------------------
// Building the proxy
// ---------------------------------------------------------------------------

/** Even dimensions, which is what H.264 in yuv420p requires. */
function evenSize(probe: SourceProbe): { width: number; height: number } | undefined {
  const width = probe.width - (probe.width % 2);
  const height = probe.height - (probe.height % 2);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * The filter chain that lays a video with an alpha channel over a checkerboard.
 *
 * H.264 has no alpha, so something has to go behind the picture, and the choice
 * is not cosmetic. Flattening a lower third onto black produces a frame that is
 * 99% black and looks exactly like a clip that renders nothing; the checkerboard
 * says "this part is transparent" in the one visual language every compositing
 * tool already uses.
 *
 * The board is drawn once and held, not evaluated per frame: `geq` is a
 * per-pixel expression, and running it over two million pixels for every frame
 * of a clip costs more than the encode it is decorating. `d=1:r=1` asks the
 * source for a single frame, `loop` repeats that frame forever, and `fps`
 * retimes the result to the video, so the expression runs exactly once.
 *
 * Commas inside the `geq` expression are escaped because ffmpeg's own filtergraph
 * parser splits on them before the expression parser ever sees the string.
 */
export function checkerboardFilter(width: number, height: number, frameRate: number): string {
  const rate = frameRate > 0 ? frameRate : 30;
  const board = [
    `color=c=black:s=${width}x${height}:d=1:r=1`,
    'format=gray',
    `geq=lum='if(mod(floor(X/${CHECKER_SQUARE})+floor(Y/${CHECKER_SQUARE})\\,2)\\,${CHECKER_LIGHT}\\,${CHECKER_DARK})'`,
    'loop=loop=-1:size=1:start=0',
    `fps=${rate}`,
    'format=rgb24',
  ].join(',');
  return [
    `${board}[bg]`,
    `[0:v]scale=${width}:${height},format=rgba[fg]`,
    '[bg][fg]overlay=shortest=1:format=rgb,format=yuv420p[v]',
  ].join(';');
}

/**
 * The command line that turns `input` into a playable `output`.
 *
 * Everything here is chosen for "a preview, now" over "an archive, eventually":
 * `veryfast` and CRF 22 land within a rounding error of the source's apparent
 * quality on a laptop screen while encoding several times faster than realtime,
 * and `+faststart` puts the index at the front so the <video> element can start
 * playing before the file is fully read.
 *
 * The stream maps are explicit because a camera or editor original routinely
 * carries more than the picture and its sound: timecode tracks, a second audio
 * language, a thumbnail attachment. Taking the first video and the first audio
 * and dropping the rest is what makes the output a thing Chromium will play,
 * rather than a faithful copy of a container it already refused once.
 */
export function transcodeArgs(input: string, output: string, probe: SourceProbe): string[] {
  const size = evenSize(probe);
  const args = [
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    // Progress on stdout, so stderr holds nothing but the reason a failure
    // failed and can be shown to the reader as-is.
    '-progress',
    'pipe:1',
    '-nostats',
    '-i',
    input,
  ];

  if (probe.hasAlpha && size) {
    args.push('-filter_complex', checkerboardFilter(size.width, size.height, probe.frameRate));
    args.push('-map', '[v]');
  } else {
    args.push('-map', '0:v:0');
    // Odd dimensions are rare but fatal to yuv420p, and the source's own numbers
    // are not trustworthy when the probe came back empty, so the rounding is
    // expressed in ffmpeg's terms rather than computed here.
    args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p');
  }

  if (probe.hasAudio) {
    // `?` makes the map optional: a file whose only audio stream ffprobe saw is
    // one ffmpeg declines to decode should still produce a silent proxy rather
    // than failing outright.
    args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '160k');
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-movflags',
    '+faststart',
    output,
  );
  return args;
}

/**
 * The position ffmpeg last reported, in seconds, from a chunk of `-progress`
 * output, or undefined if the chunk carried none.
 *
 * ffmpeg writes `key=value` lines in blocks terminated by `progress=continue`,
 * and a single read can hold several blocks, so the *last* timestamp in the
 * chunk is the current one. `out_time_us` is preferred; `out_time_ms` is read as
 * a fallback and is also microseconds, despite its name, which is a
 * long-standing quirk of ffmpeg rather than a mistake here.
 */
export function parseProgressSeconds(chunk: string): number | undefined {
  let latest: number | undefined;
  for (const line of chunk.split(/\r?\n/)) {
    const match = /^out_time_(us|ms)=(-?\d+)$/.exec(line.trim());
    if (match) {
      const micros = Number(match[2]);
      // ffmpeg emits `out_time_us=N/A` as a large negative number before the
      // first frame lands; a position cannot be before the start of the file.
      if (Number.isFinite(micros) && micros >= 0) {
        latest = micros / 1_000_000;
      }
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Temp files
// ---------------------------------------------------------------------------

/**
 * Where proxies live: one fixed directory rather than a fresh mkdtemp per panel.
 *
 * It has to be named up front, before any proxy exists, because the webview's
 * `localResourceRoots` is what decides whether the <video> element may load the
 * file at all, and a root cannot usefully be a directory invented later. A fixed
 * path is registrable at panel-open time; individual proxies are kept apart by
 * the random component in their file names.
 */
export function proxyDir(): string {
  return join(tmpdir(), 'markcopy-video');
}

/** A collision-proof proxy name that still says which file it came from. */
export function proxyFileName(sourceName: string, random: string = randomBytes(6).toString('hex')) {
  const stem =
    basename(sourceName, extname(sourceName))
      .replace(/[^\w.-]+/g, '-')
      // Trailing punctuation would butt straight up against the random suffix
      // ("clip--a1b2"), and a trailing dot is not a name Windows will accept.
      .replace(/[-.]+$/, '') || 'video';
  // Long enough to keep the source recognisable in a temp listing, short enough
  // that a deeply nested temp path plus this name stays inside Windows' MAX_PATH.
  return `${stem.slice(0, 60)}-${random}.mp4`;
}

/**
 * Make the proxy directory, and refuse to use one that is not ours.
 *
 * Deliberately not `recursive`, which succeeds against whatever already sits at
 * the path. On a shared `/tmp` that could be a directory another user created
 * first, or a symlink they pointed somewhere of their choosing, and this path is
 * handed to the webview as a `localResourceRoot`. `mkdir` failing with EEXIST is
 * the signal to go and look at what is there instead of writing into it.
 */
export async function ensureProxyDir(dir: string = proxyDir()): Promise<string> {
  try {
    await mkdir(dir, { mode: 0o700 });
    return dir;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
  // `lstat`, not `stat`: a symlink to a directory has to read as a symlink here,
  // which is the whole point of looking.
  const info = await lstat(dir);
  if (!info.isDirectory()) {
    throw new Error(`${dir} exists and is not a directory.`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`${dir} is owned by another user.`);
  }
  return dir;
}

// How stale a proxy has to be before a sweep will take it. Long enough that a
// panel left open overnight keeps the file it is playing, short enough that a
// crashed window's leftovers do not live on the disk forever.
const STALE_PROXY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete proxies left behind by a window that never got the chance to clean up.
 *
 * Every proxy is removed when its panel closes and every abandoned one when its
 * encode ends, so in the normal case this finds nothing. It exists for the case
 * where there is no normal case: an extension host that was killed, a machine
 * that lost power. Age-gated because another window may be playing a proxy right
 * now, and that file is minutes old rather than a day.
 */
export async function sweepProxyDir(
  dir: string = proxyDir(),
  now: number = Date.now(),
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // no directory yet, which is the common case
  }
  await Promise.all(
    entries.map(async (name) => {
      const full = join(dir, name);
      try {
        const info = await stat(full);
        if (info.isFile() && now - info.mtimeMs > STALE_PROXY_MS) {
          await removeQuietly(full);
        }
      } catch {
        /* raced with another window's own cleanup; it can have it */
      }
    }),
  );
}

/** Best-effort delete; a stranded proxy is not worth failing a close over. */
export async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Running ffmpeg
// ---------------------------------------------------------------------------

export class TranscodeCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'TranscodeCancelled';
  }
}

/** Run ffprobe and read what it says about `input`. */
export async function probeSource(ffprobe: string, input: string): Promise<SourceProbe> {
  const { stdout } = await run(ffprobe, probeArgs(input), {});
  return parseProbe(stdout);
}

/**
 * Encode `input` to `output`, reporting progress as a fraction of the duration.
 *
 * Rejects with a message fit to show the reader: ffmpeg's own stderr when it
 * exits non-zero (it is terse and specific at `-loglevel error`, typically one
 * line naming the encoder or stream it could not handle), or a plain statement
 * that it stalled. Cancellation rejects with `TranscodeCancelled`, which the
 * caller is expected to swallow.
 */
export async function transcode(opts: {
  ffmpeg: string;
  input: string;
  output: string;
  probe: SourceProbe;
  signal?: AbortSignal;
  onProgress?: (seconds: number) => void;
}): Promise<void> {
  const { code, stderr } = await run(
    opts.ffmpeg,
    transcodeArgs(opts.input, opts.output, opts.probe),
    {
      signal: opts.signal,
      stallMs: STALL_TIMEOUT_MS,
      onStdout: (chunk) => {
        const seconds = parseProgressSeconds(chunk);
        if (seconds !== undefined) {
          opts.onProgress?.(seconds);
        }
      },
    },
  );
  if (code !== 0) {
    throw new Error(lastLine(stderr) || `ffmpeg exited with code ${code}.`);
  }
}

/** The most specific thing ffmpeg said, which is the last thing it said. */
function lastLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

interface RunOptions {
  signal?: AbortSignal;
  /** Kill the process if `onStdout` goes this long without being called. */
  stallMs?: number;
  onStdout?: (chunk: string) => void;
}

/**
 * Spawn a tool and collect what it said.
 *
 * `spawn` rather than `exec` because the progress stream has to be read as it
 * arrives, and because an ffmpeg command line carries user-supplied file paths:
 * passing an argument vector means a path with a space, a quote, or a `&` in it
 * is data, and never something a shell could reinterpret.
 */
function run(
  command: string,
  args: string[],
  { signal, stallMs, onStdout }: RunOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      reject(new Error(`could not run ${command} (${String(err)}).`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let stallTimer: NodeJS.Timeout | undefined;
    let exitTimer: NodeJS.Timeout | undefined;
    let stalled = false;
    let cancelled = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(stallTimer);
      clearTimeout(exitTimer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const armStall = (): void => {
      if (!stallMs) {
        return;
      }
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        kill();
      }, stallMs);
    };

    /** Why a killed run rejected: the reader stopped it, or it wedged. */
    const rejectKilled = (): void => {
      finish(() =>
        reject(
          cancelled
            ? new TranscodeCancelled()
            : new Error('ffmpeg stopped making progress and was cancelled.'),
        ),
      );
    };

    const kill = (): void => {
      child.kill();
      // A process that ignores the polite signal still holds the output file
      // open, which on Windows fails the cleanup delete. Insist after a moment.
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref?.();
      // And stop waiting eventually regardless. Settling on `close` is what lets
      // the caller delete the half-written file (below), but a caller left
      // hanging on a process that will not die is the worse failure of the two.
      exitTimer = setTimeout(rejectKilled, KILL_GRACE_MS * 2);
      exitTimer.unref?.();
    };

    /**
     * Kill the run, but settle it on the child's own exit rather than here.
     *
     * The caller deletes the half-written output the moment this rejects, and on
     * Windows that delete fails while ffmpeg still holds the handle open. ffmpeg
     * goes on SIGTERM in milliseconds, so the wait costs nothing the reader can
     * see, and `kill` bounds it either way.
     */
    function onAbort(): void {
      cancelled = true;
      kill();
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      armStall();
      if (onStdout) {
        // Handed straight on and dropped. The transcode streams `-progress`
        // here and reads each chunk as it lands; keeping the chunks too would
        // hold megabytes of superseded timestamps for the length of an encode
        // that nothing ever reads back.
        onStdout(chunk);
      } else {
        stdout += chunk;
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      finish(() => reject(new Error(`could not run ${command} (${err.message}).`)));
    });
    child.on('close', (code) => {
      if (cancelled || stalled) {
        rejectKilled();
        return;
      }
      finish(() => resolve({ code: code ?? 0, stdout, stderr }));
    });

    // Wired only now that `close` can settle the promise: an already-aborted
    // signal kills the child immediately, and nothing else would ever resolve it.
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    armStall();
  });
}
