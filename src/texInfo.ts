// Pure, user-facing strings for the LaTeX preview, kept out of the compile
// driver so every message a reader sees is a tested function rather than a
// string literal buried in UI code (same split as src/webview/videoInfo.ts).
//
// Unlike videoInfo, this lives host-side rather than under src/webview/. The
// interesting text here is built from parsed LaTeX errors, which only the host
// has, so the host formats these and sends finished strings to the overlay
// rather than shipping error structures across and duplicating the wording.

import type { TexEngine, TexError } from './texCompile';

/** Shown while the engine is running. `name` is the file being compiled. */
export function compiling(name: string): string {
  return `Compiling ${name}…`;
}

/** The `ask` mode offer, before anything is run. */
export function compileOffer(name: string, engine: TexEngine): string {
  return `MarkCopy can compile ${name} with ${engineLabel(engine)} and show the result as a PDF, without changing the file itself.`;
}

/** No engine found, or compiling is switched off in settings. */
export function compileUnavailable(
  reason: 'missing' | 'disabled',
  platform: NodeJS.Platform,
): string {
  if (reason === 'disabled') {
    // Named so the way back is findable, same as proxyDisabled in videoInfo.ts.
    return 'Compiling is off (markcopy.tex.compile), so there is nothing to show here. Turn it on to see this document as a rendered PDF.';
  }
  return `MarkCopy needs a LaTeX engine to turn this into a PDF preview. ${installHint(platform)}`;
}

/**
 * A compile that ran and failed. Summarizes the first error and says how many
 * more there are.
 *
 * TeX's own log is a wall of text even for a one-line mistake, and most of it
 * is macro expansion trace the reader did not cause. Leading with the first
 * error's own location and words, and only counting the rest, is the terse
 * summary that still points at something fixable.
 */
export function compileFailed(errors: TexError[]): string {
  const [first, ...rest] = errors;
  if (!first) {
    // The engine exited without leaving anything the log parser recognized as
    // an error, which in practice means it gave up before writing a log at all
    // (a missing script engine, a bad path, an engine that cannot run here).
    // Pointing at "the log" would be sending the reader to a file that does not
    // exist, so point at the engine's own words instead: the caller renders
    // those directly underneath this line.
    return 'The compile failed before it got far enough to report a LaTeX error. The engine said:';
  }
  const location = errorLocation(first);
  const lead = location ? `${location}: ${first.message}` : first.message;
  if (rest.length === 0) {
    return lead;
  }
  const more = rest.length === 1 ? '1 more error' : `${rest.length} more errors`;
  return `${lead}, and ${more}.`;
}

/**
 * Where to get an engine, per platform. Used inside compileUnavailable's
 * 'missing' text.
 *
 * Tectonic is named everywhere alongside the full distribution, because a
 * full TeX Live or MacTeX install is multiple gigabytes, and being told to
 * install that just to preview one file is a genuinely surprising ask. A
 * single small binary that fetches packages as the document needs them is
 * the honest lighter-weight alternative.
 */
export function installHint(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32':
      return 'Install MiKTeX or TeX Live, or Tectonic if you would rather not pull down several gigabytes: it is a single binary that fetches packages as your document needs them.';
    case 'darwin':
      return 'Install MacTeX (or `brew install --cask mactex-no-gui`), or Tectonic if you would rather not pull down several gigabytes: it is a single binary that fetches packages as your document needs them.';
    default:
      // Covers linux and any other unix-like platform the same way: a distro
      // TeX Live package is the normal path, Tectonic the lighter one.
      return "Install your distro's TeX Live package, or Tectonic if you would rather not pull down several gigabytes: it is a single binary that fetches packages as your document needs them.";
  }
}

/** Human name for an engine, e.g. 'latexmk', 'Tectonic', 'pdfTeX', 'XeTeX', 'LuaTeX'. */
export function engineLabel(engine: TexEngine): string {
  switch (engine) {
    case 'latexmk':
      return 'latexmk';
    case 'tectonic':
      return 'Tectonic';
    case 'pdflatex':
      return 'pdfTeX';
    case 'xelatex':
      return 'XeTeX';
    case 'lualatex':
      return 'LuaTeX';
    default:
      // Defensive: keeps the function total even if TexEngine grows a member
      // this file has not been updated for yet.
      return engine;
  }
}

/**
 * One-line location prefix for an error, e.g. 'chapters/one.tex, line 12'.
 * Empty when unknown.
 */
export function errorLocation(error: TexError): string {
  if (error.file && error.line) {
    return `${error.file}, line ${error.line}`;
  }
  if (error.file) {
    return error.file;
  }
  if (error.line) {
    return `line ${error.line}`;
  }
  return '';
}
