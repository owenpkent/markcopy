// Compiling a .tex file to a PDF, so a LaTeX source can be previewed the same
// way MarkCopy already previews a plain PDF: through the existing pdf.js
// webview, just fed bytes read back from a temp file instead of the file the
// user has open.
//
// LaTeX is not one program. `latexmk` and `tectonic` each drive their own
// multi-pass build (rerunning the engine when the aux files ask for it,
// pulling in bibtex/biber as needed) and are strongly preferred for that
// reason; the bare engines (pdflatex, xelatex, lualatex) do none of that, so
// this module reruns one of those itself, once, when the log says
// cross-references are still unresolved.
//
// Output goes to one fixed temp directory per source file rather than a fresh
// mkdtemp on every keystroke, so reopening the same document reuses (and
// overwrites) the PDF from the previous compile instead of leaking a new
// directory every time.
//
// Nothing here imports `vscode`, so it is all unit-testable.
import { spawn } from 'node:child_process';
import { access, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, posix, resolve, win32 } from 'node:path';

// How long a compile may go without producing a single new line of output
// before it is treated as wedged. `-interaction=nonstopmode -halt-on-error`
// should mean an engine never actually waits on stdin, but a handful of fatal
// conditions (a macro stuck in a loop, a missing package that still manages to
// prompt) get past that, and this exists to stop those from holding the
// preview's spinner forever rather than to bound an ordinarily slow compile.
// A document that keeps producing output, however slowly, is never killed.
const STALL_TIMEOUT_MS = 45_000;
// A `-version` probe either answers at once or is not going to. Kept far below
// STALL_TIMEOUT_MS because this runs before the reader sees anything at all,
// and 'auto' may walk several candidates before it finds one that works.
const PROBE_TIMEOUT_MS = 10_000;

// How long a killed engine gets to actually exit before the wait gives up.
// Same reasoning as videoProxy.ts's ffmpeg: on Windows the .log and .pdf files
// cannot be deleted or reread while the process still holds them open.
const KILL_GRACE_MS = 2_000;

// A bare engine (not latexmk, not tectonic) is rerun at most once beyond its
// first pass, which is enough to resolve the cross-references a single
// nonstopmode run cannot see yet without turning a broken document into an
// unbounded loop of reruns.
const MAX_PASSES = 2;

// A broken preamble can cascade into hundreds of near-duplicate errors; the
// preview UI only ever surfaces the first handful, so parsing stops well
// before that.
const MAX_PARSED_ERRORS = 20;

// How stale a compile's output directory has to be before a sweep will take
// it. Long enough that a document left open overnight keeps its PDF, short
// enough that a window that was killed mid-compile does not litter the disk.
const STALE_TEX_MS = 24 * 60 * 60 * 1000;

export type TexEngine = 'latexmk' | 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';

/** A resolved TeX engine: the executable to run and which one it is. */
export interface TexTools {
  path: string;
  engine: TexEngine;
}

// ---------------------------------------------------------------------------
// Finding a TeX engine
// ---------------------------------------------------------------------------

// TeX Live and MacTeX both install under a directory named for the release
// year, and a machine keeps only the last several around. `currentYear` is a
// parameter (rather than reading the clock inline) purely so a test can pin
// it and get a stable list back.
function candidateYears(currentYear: number): number[] {
  return Array.from({ length: 8 }, (_, i) => currentYear - i);
}

function dedupe(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

/**
 * Executables to try for one engine, most preferred first.
 *
 * The bare name leads, because every one of these distributions puts itself
 * on PATH during install and that is overwhelmingly where it will be found.
 * The absolute paths below it cover a GUI-launched VS Code that did not
 * inherit the PATH a terminal would have, the same gap `ffmpegCandidates` and
 * `browserCandidates` exist to cover.
 *
 * Paths are joined with the separator of the *target* platform rather than
 * the host's, so the result depends only on the arguments and a test can ask
 * for any platform's list on any host (same contract as those two).
 */
export function texCandidates(
  engine: TexEngine,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  currentYear: number = new Date().getFullYear(),
): string[] {
  const years = candidateYears(currentYear);

  if (platform === 'win32') {
    const exe = `${engine}.exe`;
    const out = [exe];
    if (env['LOCALAPPDATA']) {
      out.push(win32.join(env['LOCALAPPDATA'], 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64', exe));
    }
    // MiKTeX's machine-wide installer always lands here regardless of what
    // %ProgramFiles% happens to be on this machine, so it is worth checking
    // literally rather than only through the environment variable.
    out.push(win32.join('C:\\Program Files', 'MiKTeX', 'miktex', 'bin', 'x64', exe));
    for (const year of years) {
      out.push(win32.join('C:\\texlive', String(year), 'bin', 'windows', exe));
      // TeX Live renamed this directory from `win32` to `windows` around 2019;
      // older installs that have not been reinstalled since still use it.
      out.push(win32.join('C:\\texlive', String(year), 'bin', 'win32', exe));
    }
    if (env['APPDATA']) {
      out.push(win32.join(env['APPDATA'], 'TinyTeX', 'bin', 'windows', exe));
    }
    if (env['USERPROFILE']) {
      out.push(win32.join(env['USERPROFILE'], 'scoop', 'shims', exe));
    }
    if (env['ProgramData']) {
      out.push(win32.join(env['ProgramData'], 'chocolatey', 'bin', exe));
    }
    if (env['USERPROFILE']) {
      // `cargo install tectonic` is a common path to tectonic specifically,
      // since it is not bundled by MiKTeX or TeX Live.
      out.push(win32.join(env['USERPROFILE'], '.cargo', 'bin', exe));
    }
    return dedupe(out);
  }

  if (platform === 'darwin') {
    const out = [engine, posix.join('/Library/TeX/texbin', engine)];
    for (const year of years) {
      out.push(posix.join('/usr/local/texlive', String(year), 'bin', 'universal-darwin', engine));
    }
    if (env['HOME']) {
      out.push(posix.join(env['HOME'], 'Library', 'TinyTeX', 'bin', 'universal-darwin', engine));
    }
    out.push(posix.join('/opt/homebrew/bin', engine));
    out.push(posix.join('/usr/local/bin', engine));
    return dedupe(out);
  }

  // linux
  const out = [engine, posix.join('/usr/bin', engine), posix.join('/usr/local/bin', engine)];
  for (const year of years) {
    out.push(posix.join('/usr/local/texlive', String(year), 'bin', 'x86_64-linux', engine));
  }
  if (env['HOME']) {
    out.push(posix.join(env['HOME'], '.TinyTeX', 'bin', 'x86_64-linux', engine));
    out.push(posix.join(env['HOME'], '.cargo', 'bin', engine));
  }
  return dedupe(out);
}

const KNOWN_ENGINES: TexEngine[] = ['latexmk', 'tectonic', 'pdflatex', 'xelatex', 'lualatex'];

/**
 * Work out which engine an executable path names, or undefined if it names
 * none of the ones this module knows how to drive.
 *
 * Split on both slash styles rather than going through `node:path`, so a
 * Windows-style path (`C:\...\pdflatex.exe`) is read correctly even off a
 * value that did not come from the host's own path module, which is exactly
 * what a `markcopy.tex.enginePath` setting typed on one OS and read on
 * another would be.
 */
export function engineFromPath(p: string): TexEngine | undefined {
  const file = p.split(/[\\/]/).pop() ?? p;
  const name = file.toLowerCase().replace(/\.exe$/, '');
  return KNOWN_ENGINES.find((engine) => engine === name);
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

/** Resolve a bare command name against PATH, or undefined if it is not there. */
async function resolveOnPath(
  name: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
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
    // Strip the quotes Windows tolerates around a PATH entry with a space in
    // it; path.join would otherwise build a directory name that includes them.
    const full = path.join(platform === 'win32' ? dir.replace(/^"|"$/g, '') : dir, name);
    if (await isExecutable(full)) {
      return full;
    }
  }
  return undefined;
}

/**
 * Locate a TeX engine able to compile a document, or undefined if there is
 * none.
 *
 * `configured` (the `markcopy.tex.enginePath` setting) wins outright and is
 * deliberately NOT probed, matching `findFfmpeg`/`findBrowser`: a setting
 * pointing somewhere wrong should fail loudly at spawn time naming the path
 * the user chose, rather than be silently swapped for some other engine.
 *
 * `preferred` of `'auto'` searches in order: latexmk, tectonic, pdflatex,
 * xelatex, lualatex, since the first two drive their own multi-pass builds
 * and are worth using whenever either is on the machine. A specific engine
 * searches only that one.
 */
export async function findTex(
  configured: string | undefined,
  preferred: 'auto' | TexEngine,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TexTools | undefined> {
  const trimmed = configured?.trim();
  if (trimmed) {
    // A configured path's own file name tells us which engine it is when
    // `preferred` is 'auto'; when the setting names a specific engine that
    // choice wins outright, since the reader typed it on purpose. Falling
    // back to pdflatex, the most basic engine, keeps compileArgs well-defined
    // even for a path whose name gives no clue (a wrapper script, say).
    const engine = preferred !== 'auto' ? preferred : (engineFromPath(trimmed) ?? 'pdflatex');
    return { path: trimmed, engine };
  }

  const order: TexEngine[] = preferred === 'auto' ? KNOWN_ENGINES : [preferred];
  // Searching for a named engine is a decision the reader made, so take the
  // first one that is there and let it fail loudly if it is broken. Searching
  // on 'auto' is a decision this code is making on their behalf, and it has to
  // be a working one, so each candidate has to prove it actually runs.
  const mustRun = preferred === 'auto';
  for (const engine of order) {
    for (const candidate of texCandidates(engine, platform, env)) {
      const bare = !candidate.includes('/') && !candidate.includes('\\');
      const found = bare
        ? await resolveOnPath(candidate, platform, env)
        : (await isExecutable(candidate))
          ? candidate
          : undefined;
      if (found !== undefined && (!mustRun || (await engineRuns(found, engine)))) {
        return { path: found, engine };
      }
    }
  }
  return undefined;
}

/**
 * Whether an engine binary can actually be executed.
 *
 * Existing on disk is not the same as working, and on Windows it is not even
 * close. `access(path, X_OK)` there only means the file is present, and MiKTeX
 * ships `latexmk.exe` as a wrapper around the latexmk *Perl script*: on a
 * machine with no Perl (the common case, since Windows ships none and MiKTeX
 * does not bundle one) it exits 1 with "MiKTeX could not find the script engine
 * 'perl'" before writing a single line of log. Preferring latexmk on the
 * strength of the file existing therefore handed the reader a broken engine and
 * an empty build directory, on a machine whose pdflatex was fine all along.
 *
 * Every failure is answered `false` rather than thrown: this runs while
 * deciding what to use, and missing, not executable, and wedged all mean the
 * same thing here, which is to try the next candidate.
 */
async function engineRuns(enginePath: string, engine: TexEngine): Promise<boolean> {
  // Tectonic is the odd one out: it wants `--version` and rejects `-version`.
  const arg = engine === 'tectonic' ? '--version' : '-version';
  try {
    const probe = await run(enginePath, [arg], {
      cwd: dirname(enginePath),
      stallMs: PROBE_TIMEOUT_MS,
    });
    return probe.code === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Building the command line
// ---------------------------------------------------------------------------

/** Full argv (excluding the executable itself) to compile `input` into `outDir`. */
export function compileArgs(tools: TexTools, input: string, outDir: string): string[] {
  // -shell-escape (and --shell-escape) is never added here, for any engine,
  // under any circumstance: it lets a document's own LaTeX source run
  // arbitrary shell commands via \write18, and the entire point of a preview
  // is that opening someone's repository must not run whatever it contains.
  switch (tools.engine) {
    case 'latexmk':
      // latexmk drives its own multi-pass build, which is exactly why it is
      // preferred over the bare engines below.
      return [
        '-pdf',
        '-interaction=nonstopmode',
        '-halt-on-error',
        '-file-line-error',
        `-outdir=${outDir}`,
        input,
      ];
    case 'tectonic':
      // Also self-driving on passes. `--keep-logs` looks removable, and is
      // not: tectonic deletes the .log by default once it is done with it
      // ("Skipped writing N intermediate files"), which is exactly the file
      // `compile` reads back afterward for diagnostics, so without this flag
      // a failed compile would have nothing to parse. `--print` sends the
      // engine's own chatter to stdout, where `onOutput` and the failure
      // fallback below can see it.
      return ['-o', outDir, '--keep-logs', '--print', input];
    case 'pdflatex':
    case 'xelatex':
    case 'lualatex':
      return [
        '-interaction=nonstopmode',
        '-halt-on-error',
        '-file-line-error',
        `-output-directory=${outDir}`,
        input,
      ];
    default: {
      const exhaustive: never = tools.engine;
      throw new Error(`unrecognized TeX engine: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Reading the log
// ---------------------------------------------------------------------------

export interface TexError {
  file?: string;
  line?: number;
  message: string;
}

// `./chapters/one.tex:12: Undefined control sequence.` is what -file-line-error
// turns a normal error into. The path half is matched non-greedily so a
// Windows drive letter (`C:\...`) is not mistaken for the file/line separator:
// `C:` is never followed by digits, so the engine keeps extending until it
// finds a colon that is.
const FILE_LINE_ERROR = /^(.+?):(\d+):\s*(.+)$/;
// A handful of fatal conditions (a missing class, a package that fails before
// any input file has even been opened) have no file to blame and print as a
// bare `!` line instead. This is also the *only* shape tectonic's own errors
// take: it never emits -file-line-error output at all, so for it this is not
// a fallback but the primary path.
const BARE_ERROR = /^!\s*(.+)$/;
// The source snippet the engine echoes under a bare error, e.g. `l.40
// \midrule`. This is the only place a line number shows up when there is no
// file:line prefix to read it from, which for tectonic is every error.
const LINE_CONTINUATION = /^l\.(\d+)\b/;

/**
 * Pull the errors out of an engine's log.
 *
 * Deduplicated, since the same fault often reappears verbatim across a
 * document's remaining passes, and capped well below what a broken preamble
 * can cascade into: the preview only ever shows the first few anyway.
 */
export function parseLatexLog(log: string): TexError[] {
  const lines = log.split(/\r?\n/);
  const errors: TexError[] = [];
  const seen = new Set<string>();

  const push = (file: string | undefined, line: number | undefined, rawMessage: string): void => {
    const message = rawMessage.trim();
    if (!message) {
      return;
    }
    const key = `${file ?? ''}:${line ?? ''}:${message}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    errors.push({ file, line, message });
  };

  for (let i = 0; i < lines.length && errors.length < MAX_PARSED_ERRORS; i++) {
    const fileLineMatch = FILE_LINE_ERROR.exec(lines[i]);
    if (fileLineMatch) {
      push(fileLineMatch[1], Number(fileLineMatch[2]), fileLineMatch[3]);
      continue;
    }
    const bareMatch = BARE_ERROR.exec(lines[i]);
    if (bareMatch) {
      let line: number | undefined;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const continuation = LINE_CONTINUATION.exec(lines[j]);
        if (continuation) {
          line = Number(continuation[1]);
          break;
        }
      }
      push(undefined, line, bareMatch[1]);
    }
  }
  return errors.slice(0, MAX_PARSED_ERRORS);
}

/** Whether a bare engine's log says another pass would resolve something. */
export function needsRerun(log: string): boolean {
  return (
    log.includes('Rerun to get cross-references right') ||
    log.includes('Please rerun') ||
    log.includes('There were undefined references')
  );
}

// ---------------------------------------------------------------------------
// Temp files
// ---------------------------------------------------------------------------

/**
 * Where compiled output lives: one fixed root, mirroring `proxyDir` in
 * videoProxy.ts for the same reason. Individual documents are kept apart by
 * the per-file subdirectory from `outDirFor`, not by a fresh mkdtemp each time.
 */
export function texOutRoot(): string {
  return join(tmpdir(), 'markcopy-tex');
}

/** The base name a compile's aux files (.log, .pdf, ...) share with the source. */
function texBaseName(rootFile: string): string {
  return basename(rootFile, extname(rootFile));
}

/**
 * A stable subdirectory name for one root file's output.
 *
 * Hashed rather than derived from the file name because two different
 * projects routinely share a `main.tex`, and the directory has to be the same
 * across repeated opens of the same file so a second preview reuses the
 * first's output instead of piling up a fresh directory per keystroke. The
 * path is lower-cased before hashing on Windows, whose file system treats
 * `C:\Foo` and `c:\foo` as the same document.
 */
export function outDirFor(rootFile: string): string {
  const absolute = resolve(rootFile);
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return join(texOutRoot(), hash);
}

/** The PDF name a compile of `rootFile` produces, e.g. `main.tex` -> `main.pdf`. */
export function pdfNameFor(rootFile: string): string {
  return `${texBaseName(rootFile)}.pdf`;
}

/**
 * Make `dir` and refuse to use one that is not ours.
 *
 * Deliberately not `recursive`, for the same reason as `ensureProxyDir` in
 * videoProxy.ts: this lives under a shared tmpdir, and `recursive: true`
 * would happily create against, or silently accept, a directory another user
 * planted first or a symlink pointed somewhere of their choosing. The path is
 * two levels deep (`markcopy-tex/<hash>`), so each level gets its own
 * deliberate check rather than asking `mkdir` to walk down through whatever
 * already exists at either one.
 */
async function ensureDirStrict(dir: string): Promise<void> {
  try {
    await mkdir(dir, { mode: 0o700 });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
  // `lstat`, not `stat`: a symlink to a directory has to read as a symlink
  // here, which is the whole point of looking.
  const info = await lstat(dir);
  if (!info.isDirectory()) {
    throw new Error(`${dir} exists and is not a directory.`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`${dir} is owned by another user.`);
  }
}

export async function ensureTexDir(dir: string): Promise<void> {
  await ensureDirStrict(dirname(dir));
  await ensureDirStrict(dir);
}

/** Best-effort delete; a stranded output directory is not worth failing over. */
export async function removeQuietly(p: string): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* ignore */
  }
}

/**
 * Delete output directories left behind by a window that never got the
 * chance to clean up.
 *
 * Meant to be fired and forgotten from `activate`, so it must never throw:
 * every failure along the way is swallowed, on the theory that another
 * window's own cleanup (or the next sweep) can have whatever this one could
 * not touch.
 */
export async function sweepTexRoot(now: number = Date.now()): Promise<void> {
  const root = texOutRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return; // no directory yet, which is the common case
  }
  await Promise.all(
    entries.map(async (name) => {
      const full = join(root, name);
      try {
        const info = await stat(full);
        if (info.isDirectory() && now - info.mtimeMs > STALE_TEX_MS) {
          await removeQuietly(full);
        }
      } catch {
        /* raced with another window's own cleanup; it can have it */
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Locating the root file
// ---------------------------------------------------------------------------

// Matches `% !TEX root = main.tex`, `%!TEX root=main.tex`, and
// `% !TeX Root = ../main.tex` alike: case folds the whole thing and tolerates
// the optional space every one of those spellings varies on.
const TEX_ROOT_COMMENT = /^\s*%\s*!\s*tex\s+root\s*=\s*(.+?)\s*$/i;
// Every tool that honours this convention only looks near the top of the
// file, so a `main.tex` mentioned in a license header deep in the document is
// not mistaken for the declaration.
const TEX_ROOT_SCAN_LINES = 20;

/** Read a `% !TEX root = ../main.tex` magic comment out of a document's source. */
export function readTexRoot(source: string): string | undefined {
  const lines = source.split(/\r?\n/, TEX_ROOT_SCAN_LINES);
  for (const line of lines) {
    const match = TEX_ROOT_COMMENT.exec(line);
    if (match) {
      return match[1].trim() || undefined;
    }
  }
  return undefined;
}

/**
 * Decide which file to actually compile.
 *
 * `configured` (the `markcopy.tex.rootFile` setting) beats the magic comment,
 * which beats the document itself, the same precedence every other LaTeX
 * tool uses. A relative `configured` is resolved against the workspace root
 * (or the document's own directory when there is none open); a relative magic
 * comment is resolved against the document's own directory, which is the
 * convention. `resolve` does the actual normalising, so neither can wander
 * off into something absurd.
 */
export function resolveRootFile(
  docPath: string,
  source: string,
  configured: string | undefined,
  workspaceRoot: string | undefined,
): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    return resolve(workspaceRoot ?? dirname(docPath), trimmed);
  }
  const magic = readTexRoot(source);
  if (magic) {
    return resolve(dirname(docPath), magic);
  }
  return resolve(docPath);
}

// ---------------------------------------------------------------------------
// Running the engine
// ---------------------------------------------------------------------------

export class CompileCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CompileCancelled';
  }
}

/**
 * A compile that ran to completion but did not produce a usable PDF.
 *
 * Carries the parsed errors and the raw log alongside the message, rather
 * than just throwing a plain Error, because the caller renders the failure
 * into an overlay and needs both to do it: re-deriving them would mean
 * re-running `parseLatexLog` on output the caller no longer has, or reading
 * the log file back off disk a second time.
 */
export class CompileFailed extends Error {
  constructor(
    message: string,
    readonly errors: TexError[],
    readonly log: string,
  ) {
    super(message);
    this.name = 'CompileFailed';
  }
}

export interface CompileResult {
  pdf: string;
  log: string;
  errors: TexError[];
}

async function readLogQuietly(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** The most specific thing the engine said, which is the last thing it said. */
// Noise an engine prints that is never the reason a compile failed. MiKTeX
// nags about update checks on every single invocation, and because it does so
// last, taking "the final line of output" as the explanation reported that nag
// instead of the actual fault underneath it.
const ENGINE_NOISE =
  /major issue:|^This is |^Latexmk: (Run number|Examining|Getting|All targets)|^entering extended mode/i;

// Lines that are the engine saying why it gave up. MiKTeX's script-engine
// failure is the motivating case: it prints "Sorry, but latexmk.exe did not
// succeed for the following reason:" and puts the reason on the NEXT line, so
// matching a line is not enough, the follower has to come with it.
const ENGINE_FAULT =
  /(could not find|not found|no such file|Sorry, but|^error:|failed|cannot |denied)/i;

/**
 * The engine's own explanation for a failed run, or '' when it offered none.
 *
 * Only used when the log yielded no parsed error, which in practice means the
 * engine died before it wrote a log at all. That output is the only thing the
 * reader has to go on, so picking the wrong line out of it is the difference
 * between "MiKTeX could not find the script engine 'perl'", which says exactly
 * what to install, and "you have not checked for MiKTeX updates", which sends
 * them somewhere with no bearing on the problem whatsoever.
 */
export function engineFailureText(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !ENGINE_NOISE.test(line));

  const faultAt = lines.findIndex((line) => ENGINE_FAULT.test(line));
  if (faultAt !== -1) {
    const fault = lines[faultAt];
    // A line that only announces a reason is worthless without the reason, so
    // carry the follower along when the fault line does not stand alone.
    const needsFollower = /reason:$|:$/.test(fault);
    const follower = needsFollower ? lines[faultAt + 1] : undefined;
    return follower ? `${fault} ${follower}` : fault;
  }
  return lines[lines.length - 1] ?? '';
}

interface RunOptions {
  cwd: string;
  signal?: AbortSignal;
  stallMs?: number;
  onLine?: (line: string) => void;
}

/**
 * Spawn the engine and collect what it said.
 *
 * Unlike ffmpeg, a TeX engine does not cleanly split progress onto stdout and
 * failures onto stderr: nonstopmode writes almost everything, errors
 * included, to stdout, and stderr is reserved for the rare case the engine
 * itself could not start. Both streams are folded into one ordered feed here,
 * both for `onLine` and for the accumulated text `compile` falls back to
 * quoting when the log file carries no parsed error.
 *
 * `spawn` rather than `exec`, and an argument vector rather than a command
 * string, so a document's own path (which may contain a space or worse) is
 * always data and never something a shell could reinterpret.
 */
function run(
  command: string,
  args: string[],
  { cwd, signal, stallMs, onLine }: RunOptions,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true });
    } catch (err) {
      reject(new Error(`could not run ${command} (${String(err)}).`));
      return;
    }

    let stdout = '';
    let lineBuffer = '';
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
            ? new CompileCancelled()
            : new Error('the TeX engine stopped making progress and was cancelled.'),
        ),
      );
    };

    const kill = (): void => {
      child.kill();
      // A process that ignores the polite signal still holds the .log and
      // .pdf files open, which on Windows fails the reread and the next
      // compile's overwrite. Insist after a moment.
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref?.();
      // And stop waiting eventually regardless: a caller left hanging on a
      // process that will not die is worse than settling early.
      exitTimer = setTimeout(rejectKilled, KILL_GRACE_MS * 2);
      exitTimer.unref?.();
    };

    function onAbort(): void {
      cancelled = true;
      kill();
    }

    const feedLine = (chunk: string): void => {
      lineBuffer += chunk;
      const parts = lineBuffer.split(/\r?\n/);
      lineBuffer = parts.pop() ?? '';
      for (const line of parts) {
        onLine?.(line);
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      armStall();
      stdout += chunk;
      feedLine(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      armStall();
      stdout += chunk;
      feedLine(chunk);
    });

    child.on('error', (err) => {
      finish(() => reject(new Error(`could not run ${command} (${err.message}).`)));
    });
    child.on('close', (code) => {
      if (cancelled || stalled) {
        rejectKilled();
        return;
      }
      if (lineBuffer) {
        onLine?.(lineBuffer);
        lineBuffer = '';
      }
      finish(() => resolvePromise({ code: code ?? 0, stdout }));
    });

    // Wired only now that `close` can settle the promise: an already-aborted
    // signal kills the child immediately, and nothing else would ever
    // resolve it.
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    armStall();
  });
}

/**
 * Compile `rootFile` to a PDF in `outDir`.
 *
 * `cwd` is the document's own directory, so a relative `\input` or
 * `\includegraphics` resolves the way the author's editor resolves it. Bare
 * engines (not latexmk, not tectonic, which already drive their own passes)
 * get a second pass when the first one's log asks for a rerun, capped at
 * `MAX_PASSES` so an document that can never resolve its references does not
 * loop forever.
 *
 * The .log file is read from `outDir` after each pass rather than parsed from
 * the process's own output, since the engine writes far better diagnostics
 * there than to stdout. Rejects with `CompileFailed` (carrying the parsed
 * errors and the raw log) when the engine exits non-zero or produces no PDF
 * at all, and with `CompileCancelled` when `signal` aborts the run.
 */
export async function compile(opts: {
  tools: TexTools;
  rootFile: string;
  outDir: string;
  signal?: AbortSignal;
  onOutput?: (line: string) => void;
}): Promise<CompileResult> {
  const { tools, rootFile, outDir, signal, onOutput } = opts;
  const selfDriving = tools.engine === 'latexmk' || tools.engine === 'tectonic';
  const maxPasses = selfDriving ? 1 : MAX_PASSES;
  const logPath = join(outDir, `${texBaseName(rootFile)}.log`);

  let log = '';
  let stdout = '';
  let exitCode = 0;
  for (let pass = 1; pass <= maxPasses; pass++) {
    const result = await run(tools.path, compileArgs(tools, rootFile, outDir), {
      cwd: dirname(rootFile),
      signal,
      stallMs: STALL_TIMEOUT_MS,
      onLine: onOutput,
    });
    exitCode = result.code;
    stdout = result.stdout;
    log = await readLogQuietly(logPath);
    if (!selfDriving && pass < maxPasses && needsRerun(log)) {
      continue;
    }
    break;
  }

  const errors = parseLatexLog(log);
  const pdfPath = join(outDir, pdfNameFor(rootFile));
  const producedPdf = await pathExists(pdfPath);

  if (exitCode !== 0 || !producedPdf) {
    const fallback = producedPdf
      ? `${basename(tools.path)} exited with code ${exitCode}.`
      : `${basename(tools.path)} finished without producing a PDF.`;
    const message = errors[0]?.message ?? (engineFailureText(stdout) || fallback);
    throw new CompileFailed(message, errors, log);
  }

  return { pdf: pdfPath, log, errors };
}
