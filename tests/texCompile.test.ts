import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import {
  compile,
  compileArgs,
  CompileCancelled,
  CompileFailed,
  engineFailureText,
  engineFromPath,
  ensureTexDir,
  findTex,
  isInsideDir,
  needsRerun,
  outDirFor,
  parseLatexLog,
  pdfNameFor,
  readTexRoot,
  removeQuietly,
  resolveRootFile,
  sweepTexRoot,
  texCandidates,
  texOutRoot,
  type TexTools,
} from '../src/texCompile';

// `compile` spawns a real engine, which the test machine does not have. The
// process boundary is mocked so the log-reading, retry, and error-mapping
// logic in `compile` can be exercised without one.
//
// The factory has to be synchronous and to return a `default` key: with an
// async factory (even one that eventually resolves both), texCompile.ts's own
// `require('node:child_process')` captures its module object before the
// promise settles and never sees the swap, so its calls reach the real
// `spawn` regardless of what this test file's own binding resolves to.
vi.mock('node:child_process', () => {
  const spawnMock = vi.fn();
  return { spawn: spawnMock, default: { spawn: spawnMock } };
});

describe('texCandidates', () => {
  it('leads with the bare name on every platform', () => {
    // A package manager put the engine on PATH in the overwhelming majority
    // of installs; the absolute paths below are the fallback for a
    // GUI-launched VS Code that did not inherit the shell's PATH.
    expect(texCandidates('pdflatex', 'win32', {}, 2026)[0]).toBe('pdflatex.exe');
    expect(texCandidates('pdflatex', 'darwin', {}, 2026)[0]).toBe('pdflatex');
    expect(texCandidates('pdflatex', 'linux', {}, 2026)[0]).toBe('pdflatex');
  });

  it('builds paths for the target platform, not the host', () => {
    // Pure function of its arguments, so its Windows list is checkable from
    // a test that may itself be running on Windows, macOS, or Linux.
    const found = texCandidates(
      'pdflatex',
      'win32',
      { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      2026,
    );
    expect(found).toContain(
      'C:\\Users\\x\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64\\pdflatex.exe',
    );
    expect(found).toContain('C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\pdflatex.exe');
  });

  it('covers the Windows package managers and the cargo bin tectonic installs to', () => {
    const found = texCandidates(
      'pdflatex',
      'win32',
      { USERPROFILE: 'C:\\Users\\x', ProgramData: 'C:\\ProgramData' },
      2026,
    );
    expect(found).toContain('C:\\Users\\x\\scoop\\shims\\pdflatex.exe');
    expect(found).toContain('C:\\ProgramData\\chocolatey\\bin\\pdflatex.exe');
    expect(found).toContain('C:\\Users\\x\\.cargo\\bin\\pdflatex.exe');
  });

  it('covers both TeX Live directory names Windows has used, across years', () => {
    const found = texCandidates('pdflatex', 'win32', {}, 2026);
    expect(found).toContain('C:\\texlive\\2026\\bin\\windows\\pdflatex.exe');
    expect(found).toContain('C:\\texlive\\2026\\bin\\win32\\pdflatex.exe');
  });

  it('expands eight years descending from the pinned current year', () => {
    const found = texCandidates('pdflatex', 'win32', {}, 2026);
    expect(found).toContain('C:\\texlive\\2026\\bin\\windows\\pdflatex.exe');
    expect(found).toContain('C:\\texlive\\2019\\bin\\windows\\pdflatex.exe');
    expect(found).not.toContain('C:\\texlive\\2018\\bin\\windows\\pdflatex.exe');
  });

  it('puts the MacTeX symlink dir first among the darwin absolute paths', () => {
    const found = texCandidates('pdflatex', 'darwin', { HOME: '/Users/x' }, 2026);
    expect(found).toContain('/Library/TeX/texbin/pdflatex');
    expect(found).toContain('/Users/x/Library/TinyTeX/bin/universal-darwin/pdflatex');
    expect(found).toContain('/opt/homebrew/bin/pdflatex');
  });

  it('covers TinyTeX and cargo under $HOME on linux', () => {
    const found = texCandidates('pdflatex', 'linux', { HOME: '/home/x' }, 2026);
    expect(found).toContain('/home/x/.TinyTeX/bin/x86_64-linux/pdflatex');
    expect(found).toContain('/home/x/.cargo/bin/pdflatex');
    expect(found).toContain('/usr/local/texlive/2026/bin/x86_64-linux/pdflatex');
  });

  it('lists nothing twice', () => {
    const found = texCandidates('pdflatex', 'win32', { ProgramData: 'C:\\Users\\x' }, 2026);
    expect(new Set(found).size).toBe(found.length);
  });

  it('asks a different engine for a different exe name', () => {
    expect(texCandidates('pdflatex', 'linux', {}, 2026)[0]).toBe('pdflatex');
    expect(texCandidates('tectonic', 'linux', {}, 2026)[0]).toBe('tectonic');
    expect(texCandidates('latexmk', 'win32', {}, 2026)[0]).toBe('latexmk.exe');
  });
});

describe('engineFromPath', () => {
  it('recognises every engine this module drives', () => {
    expect(engineFromPath('/usr/bin/latexmk')).toBe('latexmk');
    expect(engineFromPath('/usr/bin/tectonic')).toBe('tectonic');
    expect(engineFromPath('/usr/bin/pdflatex')).toBe('pdflatex');
    expect(engineFromPath('/usr/bin/xelatex')).toBe('xelatex');
    expect(engineFromPath('/usr/bin/lualatex')).toBe('lualatex');
  });

  it('reads a Windows-style path regardless of the host', () => {
    expect(engineFromPath('C:\\texlive\\2026\\bin\\windows\\pdflatex.exe')).toBe('pdflatex');
  });

  it('folds case and strips the .exe suffix', () => {
    expect(engineFromPath('PDFLATEX.EXE')).toBe('pdflatex');
    expect(engineFromPath('XeLaTeX.exe')).toBe('xelatex');
  });

  it('names nothing for an executable it does not know', () => {
    expect(engineFromPath('/usr/bin/texify')).toBeUndefined();
    expect(engineFromPath('mylatex-wrapper')).toBeUndefined();
  });
});

// These cases write real files and then ask findTex to find them, so they run
// on the HOST's platform rather than a pinned one. Pinning 'win32' passed on a
// Windows dev machine and failed on Linux CI for two separate reasons: an
// engine is named `latexmk` there rather than `latexmk.exe`, and win32.join
// against a /tmp directory yields a backslash-joined path that exists nowhere.
const HOST: NodeJS.Platform = process.platform;

/** Put a fake engine binary on disk under the name this platform would use. */
async function installFakeEngine(dir: string, engine: string): Promise<string> {
  const file = join(dir, HOST === 'win32' ? `${engine}.exe` : engine);
  // The mode is the point on POSIX: isExecutable asks access(path, X_OK), which
  // Windows answers yes to for any file that exists and Linux answers honestly.
  await writeFile(file, '', { mode: 0o755 });
  return file;
}

describe('findTex', () => {
  // 'auto' now spawns candidates to check they actually run; reset between
  // tests so one test's mocked exit code never leaks into the next.
  afterEach(() => {
    vi.mocked(spawn).mockReset();
  });

  /** A fake child_process.ChildProcess: an EventEmitter with the bits `run` touches. */
  const fakeChild = (): ReturnType<typeof spawn> => {
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
    const stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
    (stdout as unknown as { setEncoding: () => void }).setEncoding = () => undefined;
    (stderr as unknown as { setEncoding: () => void }).setEncoding = () => undefined;
    Object.assign(child, { stdout, stderr, kill: vi.fn() });
    return child;
  };

  /** Makes every spawned probe exit with `code`, whichever engine it is for. */
  const mockEveryProbe = (code: number): void => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = fakeChild();
      setImmediate(() => child.emit('close', code));
      return child;
    });
  };

  it('takes the configured path without probing it', async () => {
    // Same contract as findFfmpeg/findBrowser: a setting pointing at nothing
    // should fail at spawn time naming the path the user chose, rather than
    // be silently swapped for some other engine they did not ask for.
    const found = await findTex('/nowhere/at/all/pdflatex', 'pdflatex', 'linux', {});
    expect(found).toEqual({ path: '/nowhere/at/all/pdflatex', engine: 'pdflatex' });
  });

  it("infers the engine from a configured path's own name when preferred is auto", async () => {
    const found = await findTex('/opt/texbin/xelatex', 'auto', 'linux', {});
    expect(found).toEqual({ path: '/opt/texbin/xelatex', engine: 'xelatex' });
  });

  it('lets an explicit preferred engine override what the configured name suggests', async () => {
    // The reader typed this on purpose (e.g. a wrapper script named oddly);
    // trust the explicit setting over guessing from the file name.
    const found = await findTex('/opt/texbin/pdflatex', 'xelatex', 'linux', {});
    expect(found).toEqual({ path: '/opt/texbin/pdflatex', engine: 'xelatex' });
  });

  it('falls back to pdflatex when auto search cannot tell what a configured name is', async () => {
    const found = await findTex('/opt/texbin/mytex-wrapper', 'auto', 'linux', {});
    expect(found?.engine).toBe('pdflatex');
  });

  it('ignores an empty or whitespace setting', async () => {
    expect(await findTex('   ', 'auto', 'linux', { PATH: '' })).toBeUndefined();
  });

  it('reports nothing rather than a name it never found', async () => {
    expect(
      await findTex(undefined, 'pdflatex', 'linux', { PATH: '/does/not/exist' }),
    ).toBeUndefined();
  });

  it('honours the auto search order: latexmk, then tectonic, then the bare engines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'markcopy-tex-path-'));
    try {
      // Only tectonic and pdflatex are "installed"; tectonic must win since
      // it precedes pdflatex in the auto order and latexmk is not present.
      await installFakeEngine(dir, 'tectonic');
      await installFakeEngine(dir, 'pdflatex');
      // Only tectonic's probe succeeds, so this stays about the search order
      // even if the host machine happens to have some other engine for real
      // at one of the absolute fallback paths this code also checks.
      vi.mocked(spawn).mockImplementation((command) => {
        const child = fakeChild();
        const code = (command as string).includes('tectonic') ? 0 : 1;
        setImmediate(() => child.emit('close', code));
        return child;
      });
      const found = await findTex(undefined, 'auto', HOST, { PATH: dir });
      expect(found).toEqual({
        path: join(dir, HOST === 'win32' ? 'tectonic.exe' : 'tectonic'),
        engine: 'tectonic',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips a candidate whose probe fails and returns the next one that runs clean', async () => {
    // Models the actual bug: MiKTeX's latexmk.exe exists but cannot run
    // without Perl, so 'auto' has to move past it to tectonic rather than
    // trusting that the file being present means it works.
    const dir = await mkdtemp(join(tmpdir(), 'markcopy-tex-path-'));
    try {
      await installFakeEngine(dir, 'latexmk');
      await installFakeEngine(dir, 'tectonic');
      vi.mocked(spawn).mockImplementation((command) => {
        const child = fakeChild();
        const code = (command as string).includes('latexmk') ? 1 : 0;
        setImmediate(() => child.emit('close', code));
        return child;
      });
      const found = await findTex(undefined, 'auto', HOST, { PATH: dir });
      expect(found).toEqual({
        path: join(dir, HOST === 'win32' ? 'tectonic.exe' : 'tectonic'),
        engine: 'tectonic',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when every candidate that exists fails its probe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'markcopy-tex-path-'));
    try {
      await installFakeEngine(dir, 'latexmk');
      await installFakeEngine(dir, 'tectonic');
      mockEveryProbe(1);
      const found = await findTex(undefined, 'auto', HOST, { PATH: dir });
      expect(found).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an explicitly named engine without spawning a probe for it', async () => {
    // The reader asked for this one by name, so it is trusted outright and
    // left to fail loudly at spawn time, same as a configured path.
    const dir = await mkdtemp(join(tmpdir(), 'markcopy-tex-path-'));
    try {
      await installFakeEngine(dir, 'latexmk');
      const found = await findTex(undefined, 'latexmk', HOST, { PATH: dir });
      expect(found).toEqual({
        path: join(dir, HOST === 'win32' ? 'latexmk.exe' : 'latexmk'),
        engine: 'latexmk',
      });
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never probes a configured path, even when preferred is auto', async () => {
    // Preserves the existing contract: a configured setting always wins
    // outright, whether or not 'auto' probing exists at all.
    const found = await findTex('/nowhere/at/all/pdflatex', 'auto', 'linux', {});
    expect(found).toEqual({ path: '/nowhere/at/all/pdflatex', engine: 'pdflatex' });
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("probes tectonic with '--version', not the '-version' every other engine takes", async () => {
    // Tectonic rejects `-version` outright, so getting this wrong would make
    // a perfectly working tectonic look broken and get skipped by 'auto'.
    const dir = await mkdtemp(join(tmpdir(), 'markcopy-tex-path-'));
    try {
      await installFakeEngine(dir, 'tectonic');
      let seenArgs: readonly string[] = [];
      vi.mocked(spawn).mockImplementation((command, args) => {
        const isTectonic = (command as string).includes('tectonic');
        if (isTectonic) {
          seenArgs = args as readonly string[];
        }
        const child = fakeChild();
        setImmediate(() => child.emit('close', isTectonic ? 0 : 1));
        return child;
      });
      const found = await findTex(undefined, 'auto', HOST, { PATH: dir });
      expect(found).toEqual({
        path: join(dir, HOST === 'win32' ? 'tectonic.exe' : 'tectonic'),
        engine: 'tectonic',
      });
      expect(seenArgs).toEqual(['--version']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('searches only the requested engine when one is specified', async () => {
    // Platform pinned to 'linux' here (unlike the test above) specifically so
    // the absolute MiKTeX/TeX Live fallback paths this falls through to stay
    // POSIX-shaped and cannot coincidentally resolve to something real on
    // whatever machine runs this test, matching findFfmpeg's own convention.
    const dir = await mkdtemp(join(tmpdir(), 'markcopy-tex-path-'));
    try {
      // pdflatex is "installed", but xelatex specifically was asked for.
      await writeFile(join(dir, 'pdflatex'), '');
      const found = await findTex(undefined, 'xelatex', 'linux', { PATH: dir });
      expect(found).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('compileArgs', () => {
  it('drives latexmk with its own multi-pass build', () => {
    const args = compileArgs({ path: 'latexmk', engine: 'latexmk' }, 'main.tex', 'out');
    expect(args).toEqual([
      '-pdf',
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-file-line-error',
      '-outdir=out',
      'main.tex',
    ]);
  });

  it("keeps tectonic's logs and asks it to print, since it deletes both by default", () => {
    const args = compileArgs({ path: 'tectonic', engine: 'tectonic' }, 'main.tex', 'out');
    expect(args).toEqual(['-o', 'out', '--keep-logs', '--print', 'main.tex']);
  });

  it('drives pdflatex/xelatex/lualatex identically apart from the binary itself', () => {
    for (const engine of ['pdflatex', 'xelatex', 'lualatex'] as const) {
      const args = compileArgs({ path: engine, engine }, 'main.tex', 'out');
      expect(args).toEqual([
        '-interaction=nonstopmode',
        '-halt-on-error',
        '-file-line-error',
        '-output-directory=out',
        'main.tex',
      ]);
    }
  });

  it('takes whatever positional file name it is given rather than a UNC root, so a leading backslash never reaches the engine', () => {
    // The bug this guards: `path.win32.resolve` on a UNC path keeps the
    // leading double backslash (confirmed below), and TeX reads a leading
    // backslash on its first argument as a sequence of its own commands
    // rather than a file to open. `compile()` avoids this by passing
    // `basename(rootFile)`, not the resolved path, as the positional
    // argument compileArgs places here; modelling that composition directly
    // since compile() itself spawns a real process and is out of scope here.
    const resolved = win32.resolve('\\\\server\\share\\doc.tex');
    expect(resolved.startsWith('\\\\')).toBe(true); // the defect this exists to dodge

    const args = compileArgs(
      { path: 'pdflatex', engine: 'pdflatex' },
      win32.basename(resolved),
      'out',
    );
    const input = args[args.length - 1];
    expect(input).toBe('doc.tex');
    expect(input.startsWith('\\')).toBe(false);
  });

  it('never lets any engine run arbitrary commands out of the document', () => {
    // \write18 under -shell-escape would let a document run whatever it
    // wants the moment its .tex file is opened for a preview.
    const engines: TexTools[] = [
      { path: 'latexmk', engine: 'latexmk' },
      { path: 'tectonic', engine: 'tectonic' },
      { path: 'pdflatex', engine: 'pdflatex' },
      { path: 'xelatex', engine: 'xelatex' },
      { path: 'lualatex', engine: 'lualatex' },
    ];
    for (const tools of engines) {
      const args = compileArgs(tools, 'main.tex', 'out');
      expect(args.join(' ')).not.toMatch(/--?shell-escape/);
    }
  });
});

describe('parseLatexLog', () => {
  it('parses a realistic -file-line-error log', () => {
    const log = [
      'This is pdfTeX, Version 3.14159265-2.6-1.40.21 (MiKTeX 20.6.1.7)',
      'entering extended mode',
      '(main.tex',
      'LaTeX2e <2020-02-02> patch level 2',
      './chapters/one.tex:12: Undefined control sequence.',
      'l.12 \\foo',
      '        bar',
      './main.tex:40: Missing $ inserted.',
      'l.40 x^2',
      'No pages of output.',
    ].join('\n');
    expect(parseLatexLog(log)).toEqual([
      { file: './chapters/one.tex', line: 12, message: 'Undefined control sequence.' },
      { file: './main.tex', line: 40, message: 'Missing $ inserted.' },
    ]);
  });

  it('reads a Windows drive letter as part of the path, not as the line separator', () => {
    const log = 'C:\\proj\\main.tex:7: Missing $ inserted.';
    expect(parseLatexLog(log)).toEqual([
      { file: 'C:\\proj\\main.tex', line: 7, message: 'Missing $ inserted.' },
    ]);
  });

  it('parses a tectonic-shaped log, which never carries a file:line prefix at all', () => {
    // Real output observed from Tectonic 0.17.0: bare `!` errors, a source
    // snippet under `l.<n>` as the only place the line number appears, and a
    // trailing summary from the wrapper itself that must not be mistaken for
    // one of the document's own errors.
    const log = [
      '! Misplaced \\noalign.',
      '\\midrule ->\\noalign',
      '                    {\\ifnum 0=`}\\fi \\@aboverulesep =\\aboverulesep \\global \\@...',
      'l.40     \\midrule',
      '',
      "! LaTeX Error: File `nosuch.sty' not found.",
      '',
      'error: the XeTeX engine had an unrecoverable error',
      'caused by: halted on potentially-recoverable error as specified',
    ].join('\n');
    const errors = parseLatexLog(log);
    expect(errors[0]).toEqual({ file: undefined, line: 40, message: 'Misplaced \\noalign.' });
    expect(errors.some((e) => e.message.includes('XeTeX engine'))).toBe(false);
    expect(errors.some((e) => e.message.includes('caused by'))).toBe(false);
  });

  it('deduplicates the same fault reported more than once', () => {
    const log = [
      './main.tex:12: Undefined control sequence.',
      './main.tex:12: Undefined control sequence.',
    ].join('\n');
    expect(parseLatexLog(log)).toHaveLength(1);
  });

  it('caps the list well below what a broken preamble can cascade into', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `./main.tex:${i}: error number ${i}.`);
    expect(parseLatexLog(lines.join('\n'))).toHaveLength(20);
  });

  it('says nothing about a clean log', () => {
    expect(parseLatexLog('This is pdfTeX\nOutput written on main.pdf (1 page).\n')).toEqual([]);
  });
});

describe('needsRerun', () => {
  it('recognises every phrase that asks for another pass', () => {
    expect(needsRerun('LaTeX Warning: Rerun to get cross-references right.')).toBe(true);
    expect(needsRerun('Package rerunfilecheck Warning: Please rerun LaTeX.')).toBe(true);
    expect(needsRerun('LaTeX Warning: There were undefined references.')).toBe(true);
  });

  it('says no to a log that resolved cleanly', () => {
    expect(needsRerun('Output written on main.pdf (1 page).\n')).toBe(false);
  });
});

describe('texOutRoot / outDirFor / pdfNameFor', () => {
  it('names one fixed root under the temp directory', () => {
    expect(texOutRoot()).toBe(join(tmpdir(), 'markcopy-tex'));
  });

  it('gives the same file the same output directory every time', () => {
    const a = outDirFor(join('project', 'main.tex'));
    const b = outDirFor(join('project', 'main.tex'));
    expect(a).toBe(b);
    expect(dirname(a)).toBe(texOutRoot());
  });

  it('gives two different files two different directories', () => {
    const a = outDirFor(join('project-a', 'main.tex'));
    const b = outDirFor(join('project-b', 'main.tex'));
    expect(a).not.toBe(b);
  });

  it('hashes to a short, fixed-width, file-name-safe string', () => {
    const dir = outDirFor(join('project', 'main.tex'));
    expect(dirname(dir)).toBe(texOutRoot());
    const hash = dir.slice(texOutRoot().length + 1);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('names the PDF after the source, minus its extension', () => {
    expect(pdfNameFor(join('project', 'chapter-1.tex'))).toBe('chapter-1.pdf');
    expect(pdfNameFor('main.tex')).toBe('main.pdf');
  });
});

describe('ensureTexDir', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'markcopy-tex-dir-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates the root and the per-file directory when neither exists yet', async () => {
    const dir = join(root, 'markcopy-tex', 'abc123456789');
    await ensureTexDir(dir);
    expect(await readdir(dir)).toEqual([]);
    expect(await readdir(join(root, 'markcopy-tex'))).toEqual(['abc123456789']);
  });

  it('accepts a directory it already made', async () => {
    const dir = join(root, 'markcopy-tex', 'abc123456789');
    await ensureTexDir(dir);
    await expect(ensureTexDir(dir)).resolves.toBeUndefined();
  });

  it('refuses a file standing in for the output directory', async () => {
    const parent = join(root, 'markcopy-tex');
    await mkdir(parent);
    const dir = join(parent, 'abc123456789');
    await writeFile(dir, 'not a directory');
    await expect(ensureTexDir(dir)).rejects.toThrow(/not a directory/);
  });

  // Not `recursive`, which would follow this happily: the directory this
  // names is read back into the pdf.js webview.
  it('refuses a symlink standing in for the output directory', async () => {
    const parent = join(root, 'markcopy-tex');
    await mkdir(parent);
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    const dir = join(parent, 'abc123456789');
    try {
      await symlink(elsewhere, dir, 'dir');
    } catch {
      return; // Windows without developer mode cannot make one; nothing to test
    }
    await expect(ensureTexDir(dir)).rejects.toThrow(/not a directory/);
  });
});

describe('sweepTexRoot', () => {
  const root = texOutRoot();
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 0, 2);

  const outputDir = async (name: string, ageMs: number): Promise<string> => {
    const full = join(root, name);
    await mkdir(full);
    const when = new Date(now - ageMs);
    await utimes(full, when, when);
    return full;
  };

  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes output directories a crashed window left behind', async () => {
    await outputDir('deadbeef0001', 3 * DAY);
    await sweepTexRoot(now);
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps one a preview open right now could still be using', async () => {
    await outputDir('livecafe0001', 60_000);
    await outputDir('stalecafe0002', 2 * DAY);
    await sweepTexRoot(now);
    expect(await readdir(root)).toEqual(['livecafe0001']);
  });

  it('says nothing about a root that was never made', async () => {
    await rm(root, { recursive: true, force: true });
    await expect(sweepTexRoot(now)).resolves.toBeUndefined();
  });
});

describe('removeQuietly', () => {
  it('deletes a directory and everything in it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'markcopy-tex-rm-'));
    await writeFile(join(dir, 'x.txt'), 'x');
    await removeQuietly(dir);
    await expect(stat(dir)).rejects.toThrow();
  });

  it('does not throw over a path that was never there', async () => {
    await expect(
      removeQuietly(join(tmpdir(), 'markcopy-tex-never-existed-xyz')),
    ).resolves.toBeUndefined();
  });
});

describe('readTexRoot', () => {
  it('reads every common spelling of the magic comment', () => {
    expect(readTexRoot('% !TEX root = main.tex\n\\documentclass{article}')).toBe('main.tex');
    expect(readTexRoot('%!TEX root=main.tex\n')).toBe('main.tex');
    expect(readTexRoot('% !TeX Root = ../main.tex\n')).toBe('../main.tex');
  });

  it('finds it a few lines down, not only on the very first line', () => {
    const source = [
      '% license header',
      '% more header',
      '% !TEX root = main.tex',
      '\\documentclass{article}',
    ].join('\n');
    expect(readTexRoot(source)).toBe('main.tex');
  });

  it('says nothing when there is no magic comment', () => {
    expect(readTexRoot('\\documentclass{article}\n\\begin{document}\n')).toBeUndefined();
  });

  it('does not look past the first handful of lines', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `% line ${i}`);
    lines.push('% !TEX root = main.tex');
    expect(readTexRoot(lines.join('\n'))).toBeUndefined();
  });
});

describe('resolveRootFile', () => {
  const doc = join('project', 'chapters', 'ch1.tex');
  const workspaceRoot = join('project');

  it('lets the configured setting win over a magic comment and the document itself', () => {
    const source = '% !TEX root = ../main.tex\n\\documentclass{article}\n';
    const result = resolveRootFile(doc, source, 'book/root.tex', workspaceRoot);
    expect(result).toBe(resolve(workspaceRoot, 'book/root.tex'));
  });

  it('resolves a relative configured path against the workspace root, not the document', () => {
    const result = resolveRootFile(doc, '', 'root.tex', workspaceRoot);
    expect(result).toBe(resolve(workspaceRoot, 'root.tex'));
  });

  it("falls back to the document's own directory when no workspace is open", () => {
    const result = resolveRootFile(doc, '', 'root.tex', undefined);
    expect(result).toBe(resolve(dirname(doc), 'root.tex'));
  });

  it('lets the magic comment win over the document itself when nothing is configured', () => {
    const source = '% !TEX root = ../main.tex\n';
    const result = resolveRootFile(doc, source, undefined, workspaceRoot);
    expect(result).toBe(resolve(dirname(doc), '../main.tex'));
  });

  it("resolves the magic comment against the document's own directory, not the workspace", () => {
    const source = '%!TEX root=root.tex\n';
    const result = resolveRootFile(doc, source, undefined, workspaceRoot);
    expect(result).toBe(resolve(dirname(doc), 'root.tex'));
  });

  it('compiles the document itself when nothing else says otherwise', () => {
    const result = resolveRootFile(doc, '\\documentclass{article}\n', undefined, workspaceRoot);
    expect(result).toBe(resolve(doc));
  });

  it('ignores a whitespace-only configured setting', () => {
    const result = resolveRootFile(doc, '', '   ', workspaceRoot);
    expect(result).toBe(resolve(doc));
  });
});

describe('isInsideDir', () => {
  it('accepts a file nested under the root', () => {
    expect(isInsideDir(join('project'), join('project', 'chapters', 'one.tex'))).toBe(true);
  });

  it('rejects the root directory itself: nothing left over to call a descendant', () => {
    expect(isInsideDir(join('project'), join('project'))).toBe(false);
  });

  it('rejects a sibling directory that merely shares a name prefix', () => {
    expect(isInsideDir(join('project'), join('project-2', 'x.tex'))).toBe(false);
  });

  it('rejects a path that only reaches the root by climbing out via ..', () => {
    expect(isInsideDir(join('project', 'chapters'), join('project', 'other.tex'))).toBe(false);
  });

  it('regression: rejects a second Windows drive with no relative route to the first', () => {
    // The exact bug this was written for: path.relative between two drives
    // can express neither `..` nor `..` + a separator, since there is no
    // relative route between them at all, so it hands back the second path
    // untouched instead. Pinned to 'win32' so this reproduces from any host,
    // the same way texCandidates's own Windows cases are pinned.
    expect(isInsideDir('C:\\proj', 'D:\\other\\x.tex', 'win32')).toBe(false);
  });

  it('still recognises a same-drive descendant once the cross-drive guard is in place', () => {
    expect(isInsideDir('C:\\proj', 'C:\\proj\\chapters\\one.tex', 'win32')).toBe(true);
  });
});

describe('engineFailureText', () => {
  it('regression: surfaces the missing-Perl reason rather than the MiKTeX update nag after it', () => {
    // The exact bug this was written for: latexmk.exe cannot run without
    // Perl and says so, but the MiKTeX update nag comes after it and would
    // win under "just take the last line", sending the reader nowhere useful.
    const output = [
      'This is MiKTeX-pdfTeX, Version 3.14159265 (MiKTeX 24.1)',
      'Sorry, but latexmk.exe did not succeed for the following reason:',
      "    MiKTeX could not find the script engine 'perl' which is required to execute 'latexmk'.",
      'latexmk: major issue: So far, you have not checked for MiKTeX updates.',
    ].join('\n');
    const text = engineFailureText(output);
    expect(text).toContain("script engine 'perl'");
    expect(text).not.toContain('major issue');
    expect(text).not.toContain('updates');
  });

  it('joins a fault line that only announces a reason to the line beneath it', () => {
    // A line ending in a colon is worthless alone; the actual reason is
    // whatever follows it, so the two have to come back as one string.
    const output = ['LaTeX failed for the following reason:', 'file not found: chapter1.tex'].join(
      '\n',
    );
    expect(engineFailureText(output)).toBe(
      'LaTeX failed for the following reason: file not found: chapter1.tex',
    );
  });

  it('says nothing about a run that produced only noise', () => {
    const output = [
      'This is pdfTeX, Version 3.14159265',
      'entering extended mode',
      'Latexmk: Run number 1',
      'latexmk: major issue: So far, you have not checked for MiKTeX updates.',
    ].join('\n');
    expect(engineFailureText(output)).toBe('');
  });

  it('says nothing about empty output', () => {
    expect(engineFailureText('')).toBe('');
  });

  it('falls back to the last line when nothing looks like a fault', () => {
    const output = ['This is pdfTeX', 'Output written on main.pdf (3 pages, 12345 bytes).'].join(
      '\n',
    );
    expect(engineFailureText(output)).toBe('Output written on main.pdf (3 pages, 12345 bytes).');
  });
});

describe('compile', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'markcopy-tex-compile-'));
  });
  afterEach(async () => {
    vi.mocked(spawn).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  /** A fake child_process.ChildProcess: an EventEmitter with the bits `run` touches. */
  const fakeChild = (): ReturnType<typeof spawn> => {
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
    const stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
    (stdout as unknown as { setEncoding: () => void }).setEncoding = () => undefined;
    (stderr as unknown as { setEncoding: () => void }).setEncoding = () => undefined;
    Object.assign(child, { stdout, stderr, kill: vi.fn() });
    return child;
  };

  it('throws CompileFailed with the parsed errors and the raw log when the engine fails', async () => {
    const rootFile = join(dir, 'main.tex');
    const logContent = [
      'This is pdfTeX',
      './main.tex:12: Undefined control sequence.',
      'l.12 \\foo',
      'No pages of output.',
    ].join('\n');
    await writeFile(join(dir, 'main.log'), logContent);

    vi.mocked(spawn).mockImplementation(() => {
      const child = fakeChild();
      setImmediate(() => child.emit('close', 1));
      return child;
    });

    const tools: TexTools = { path: 'pdflatex', engine: 'tectonic' };
    let caught: unknown;
    try {
      await compile({ tools, rootFile, outDir: dir });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CompileFailed);
    const failure = caught as CompileFailed;
    // The message is exactly the first parsed error, not a generic exit-code
    // string, so the caller's overlay can show the reader something useful.
    expect(failure.message).toBe('Undefined control sequence.');
    expect(failure.errors).toEqual([
      { file: './main.tex', line: 12, message: 'Undefined control sequence.' },
    ]);
    expect(failure.log).toBe(logContent);
  });

  it('throws CompileCancelled, not CompileFailed, when the signal aborts mid-run', async () => {
    const rootFile = join(dir, 'main.tex');

    vi.mocked(spawn).mockImplementation(() => {
      const child = fakeChild();
      // A well-behaved engine exits promptly once signalled; the important
      // part is that it does not close on its own before that.
      (child.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
        setImmediate(() => child.emit('close', null));
        return true;
      });
      return child;
    });

    const controller = new AbortController();
    const tools: TexTools = { path: 'pdflatex', engine: 'tectonic' };
    const promise = compile({ tools, rootFile, outDir: dir, signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(CompileCancelled);
    await expect(promise).rejects.not.toBeInstanceOf(CompileFailed);
  });
});
