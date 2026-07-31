// Turning the preview into a PDF file, without a browser window or a print dialog.
//
// Every Chromium-family browser can render a page straight to a PDF from the
// command line (`--headless --print-to-pdf`). That path is what the export uses:
// it writes a real, text-based PDF with no print dialog to dismiss and, crucially,
// none of the header/footer furniture the interactive print dialog adds by default
// (the document title on the top-left, the source URL on the bottom-right).
//
// Nothing here touches the `vscode` module, so it is all unit-testable.
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { escapeHtml } from './render';

// A floor for "the browser created the file but never finished writing it".
//
// Deliberately not a check for the browser's error page: measured, a one-paragraph
// render and Chromium's "file couldn't be accessed" page come out 14 bytes apart
// (59,731 vs 59,745), because both are dominated by the same embedded fonts. No
// byte threshold can separate those, so renderPdf does not try. What rules the
// error page out is rendering to a path inside the throwaway directory: a browser
// sandboxed away from that directory cannot read the page from it either, so the
// failure surfaces as a missing file rather than as a plausible-looking PDF.
const MIN_PDF_BYTES = 1024;

// Long enough for a big document with web fonts and images on a cold browser
// start, short enough that a wedged process does not hang the export forever.
const RENDER_TIMEOUT_MS = 90_000;

// How long a killed browser gets to actually exit before we give up waiting. The
// caller deletes the profile directory as soon as the render settles, and a
// browser still shutting down holds files open under it, which on Windows fails
// the delete with EBUSY and strands roughly 2 MB per timed-out export.
const KILL_GRACE_MS = 2_000;

export type PageSize = 'Letter' | 'A4' | 'Legal';

// The values `markcopy.pdf.pageSize` may take, as data rather than only as a type,
// so what reaches the export page can be checked at runtime. Keep in step with the
// `enum` on that setting in package.json.
const PAGE_SIZES: readonly string[] = ['Letter', 'A4', 'Legal'];

/**
 * Chromium-family executables to try, most preferred first.
 *
 * Edge leads on Windows because it is always present; Chrome leads elsewhere.
 * Bare names (Linux) are resolved through PATH by `spawn`, so they are returned
 * as-is and probed by running them.
 *
 * Paths are joined with the separator of the *target* platform rather than the
 * host's, so the result depends only on the arguments.
 */
export function browserCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === 'win32') {
    const roots = [
      env['ProgramFiles'],
      env['ProgramFiles(x86)'],
      env['ProgramW6432'],
      env['LOCALAPPDATA'],
    ].filter((r): r is string => Boolean(r));
    const relative = [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Google', 'Chrome Beta', 'Application', 'chrome.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ];
    const out: string[] = [];
    for (const rel of relative) {
      for (const root of roots) {
        out.push(win32.join(root, ...rel));
      }
    }
    return dedupe(out);
  }

  if (platform === 'darwin') {
    const apps = [
      ['Google Chrome.app', 'Google Chrome'],
      ['Microsoft Edge.app', 'Microsoft Edge'],
      ['Chromium.app', 'Chromium'],
      ['Brave Browser.app', 'Brave Browser'],
    ];
    const roots = [
      '/Applications',
      env['HOME'] ? posix.join(env['HOME'], 'Applications') : undefined,
    ];
    const out: string[] = [];
    for (const [app, bin] of apps) {
      for (const root of roots) {
        if (root) {
          out.push(posix.join(root, app, 'Contents', 'MacOS', bin));
        }
      }
    }
    return dedupe(out);
  }

  // Linux and friends: PATH names, plus the usual absolute locations for the
  // (common) case of a PATH that a GUI-launched VS Code did not inherit.
  const names = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'microsoft-edge-stable',
    'brave-browser',
  ];
  return dedupe([...names, ...names.map((n) => `/usr/bin/${n}`)]);
}

function dedupe(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

/**
 * The command line that renders `htmlPath` to `pdfPath`.
 *
 * Both no-header flags are passed on purpose: `--no-pdf-header-footer` is the
 * current name and `--print-to-pdf-no-header` the older one, and Chromium ignores
 * switches it does not know. Between them the output carries no title header and
 * no `file://…` footer on any supported build.
 *
 * `--headless` deliberately, not `--headless=new`: recent Chromium maps it to the
 * new mode anyway, and older builds that predate `=new` would fail to parse it and
 * launch a visible window instead of printing.
 */
export function printArgs(opts: {
  htmlPath: string;
  pdfPath: string;
  userDataDir: string;
}): string[] {
  return [
    '--headless',
    '--disable-gpu',
    // A throwaway profile: without it, launching an already-running browser just
    // hands the URL to the existing process and prints nothing. It also keeps the
    // user's extensions, sync, and session out of the render.
    `--user-data-dir=${opts.userDataDir}`,
    '--disable-extensions',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--no-pdf-header-footer',
    '--print-to-pdf-no-header',
    // Let deferred work (web fonts, images, layout) settle before the snapshot,
    // instead of printing a half-laid-out first frame.
    '--virtual-time-budget=10000',
    '--run-all-compositor-stages-before-draw',
    `--print-to-pdf=${opts.pdfPath}`,
    pathToFileURL(opts.htmlPath).href,
  ];
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
 * Returns the absolute path rather than the name, so the caller hands `spawn`
 * something unambiguous and a failure names a real file.
 */
async function resolveOnPath(
  name: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  // Windows spells the variable inconsistently depending on who set it, and its
  // candidates are all absolute anyway, so this only really runs on Unix.
  const raw = env['PATH'] ?? env['Path'] ?? env['path'];
  if (!raw) {
    return undefined;
  }
  const path = platform === 'win32' ? win32 : posix;
  for (const dir of raw.split(platform === 'win32' ? ';' : ':')) {
    if (dir === '') {
      continue;
    }
    const full = path.join(dir, name);
    if (await isExecutable(full)) {
      return full;
    }
  }
  return undefined;
}

/**
 * Locate a browser able to print the export, or undefined if there is none.
 *
 * `configured` (the `markcopy.pdf.browserPath` setting) wins outright, so a user
 * with a browser in an unusual place can point at it. Absolute candidates are
 * checked on disk, and bare names (the Linux list) are looked up on PATH.
 *
 * Both halves have to actually probe. Accepting a bare name unprobed returns the
 * first one on the list to every caller, which is `google-chrome`: the six other
 * names and every `/usr/bin` fallback below them become unreachable, and a machine
 * with only Chromium installed is told Chrome is missing instead of printing. When
 * nothing is found, returning undefined is what lets the caller fall back to
 * opening the preview in the user's own browser, which is the documented behaviour.
 *
 * The configured path is deliberately not probed: a setting pointing somewhere
 * wrong should fail at spawn time with a message naming it, rather than be
 * silently ignored in favour of a browser the user did not choose. It is also
 * machine-scoped in package.json, so a workspace cannot set it.
 */
export async function findBrowser(
  configured: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const trimmed = configured?.trim();
  if (trimmed) {
    return trimmed;
  }
  for (const candidate of browserCandidates(platform, env)) {
    const bare = !candidate.includes('/') && !candidate.includes('\\');
    const found = bare
      ? await resolveOnPath(candidate, platform, env)
      : (await isExecutable(candidate))
        ? candidate
        : undefined;
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** A fresh, empty directory for one export's browser profile. */
export async function createProfileDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'markcopy-pdf-'));
}

/**
 * Best-effort recursive delete; a leftover temp directory is not worth failing over.
 *
 * Retries because a browser that has just been killed may still hold files open
 * under its profile directory, which Windows reports as EBUSY rather than waiting.
 */
export async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* ignore */
  }
}

/**
 * Render an HTML file to a PDF file with a headless browser.
 *
 * Rejects with a message fit to show the user: a non-zero exit, a timeout, or an
 * exit that reported success but left no usable PDF behind (which is what a
 * browser too old for `--print-to-pdf` looks like).
 *
 * `pdfPath` must be a path that does not exist yet, inside a directory we made.
 * That precondition is what makes the check below mean anything: `stat` cannot
 * tell "the browser just wrote this" from "this was already here", so pointing
 * this at a file the user chose would report success for a browser that exited 0
 * without writing, leaving the reader with a stale export they believe is fresh.
 * Callers render to a scratch path and move the result into place afterwards.
 */
export async function renderPdf(opts: {
  browser: string;
  htmlPath: string;
  pdfPath: string;
  userDataDir: string;
  timeoutMs?: number;
}): Promise<void> {
  if (await exists(opts.pdfPath)) {
    // A caller bug, not a user-facing condition: the freshness check below is
    // only sound on a path that was empty going in.
    throw new Error('internal error: the PDF scratch path already exists.');
  }
  const args = printArgs(opts);
  const stderr = await run(opts.browser, args, opts.timeoutMs ?? RENDER_TIMEOUT_MS);

  let size = 0;
  try {
    size = (await stat(opts.pdfPath)).size;
  } catch {
    throw new Error(`the browser wrote no PDF.${detail(stderr)}`);
  }
  if (size < MIN_PDF_BYTES) {
    throw new Error(`the browser wrote an empty PDF.${detail(stderr)}`);
  }
}

/** Whether `path` exists at all. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// The tail of the browser's stderr, if it said anything worth repeating. Chromium
// is chatty about harmless GPU and registry warnings on every start, so this is
// only ever a hint appended to our own message.
function detail(stderr: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/bytes written to file/i.test(l))
    .pop();
  return line ? ` (${line.slice(0, 200)})` : '';
}

/**
 * Assemble the standalone page that gets rendered to PDF.
 *
 * It carries the preview's own stylesheet, so the export looks like what the
 * reader was just looking at, and forces the light palette regardless of the
 * preview's display theme: nobody wants a black page on paper.
 *
 * Note what the body deliberately does *not* carry: `data-mc-kind`. A CSV preview
 * uses it to become a viewport-tall flex column that scrolls internally, which is
 * right for a panel and wrong for paper, where there is nothing to scroll and
 * everything past the first page's worth of rows would be clipped away. Leaving it
 * off means a grid flows as ordinary content and paginates. Anything added here
 * that reintroduces the attribute needs a print rule to undo that layout.
 */
export function buildPdfPage(opts: {
  bodyHtml: string;
  title: string;
  previewCss: string;
  katexCss: string;
  pageSize: PageSize;
  /** Have the page invoke the print dialog itself; only the manual browser route wants this. */
  autoPrint: boolean;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(opts.title || 'MarkCopy')}</title>
<style>${opts.previewCss}</style>
${opts.katexCss ? `<style>${opts.katexCss}</style>` : ''}
<style>${pdfCss(opts.pageSize)}</style>
</head>
<body class="mc-force-light" data-mc-theme="light">
<div id="content" class="markdown-body">${opts.bodyHtml}</div>
${opts.autoPrint ? AUTO_PRINT_SCRIPT : ''}
</body>
</html>`;
}

// A headless render prints the page itself, so only the manual route needs this; a
// `window.print()` racing `--print-to-pdf` would be at best redundant.
const AUTO_PRINT_SCRIPT = `<script>
window.addEventListener('load', function () {
  var print = function () { setTimeout(function () { window.print(); }, 200); };
  if (document.fonts && document.fonts.ready) { document.fonts.ready.then(print, print); }
  else { print(); }
});
</script>`;

/**
 * Print tuning for the export page, layered on top of the preview's stylesheet.
 *
 * Grouped by the problem each rule solves rather than by selector, because most of
 * them undo something the on-screen preview needs and paper does not.
 */
export function pdfCss(pageSize: PageSize): string {
  // `pageSize` reaches us from settings.json, where the package.json `enum` is a
  // settings-editor hint and not a runtime guarantee: WorkspaceConfiguration.get
  // returns whatever string is there, so the PageSize type is a compile-time
  // fiction at the call site. Unchecked, a value carrying `</style>` would close
  // this element and let the rest parse as markup, and the export page (unlike the
  // webview) has no CSP to fall back on.
  const size: PageSize = PAGE_SIZES.includes(pageSize) ? pageSize : 'Letter';
  return `
@page { size: ${size}; margin: 16mm; }

html, body { background: #ffffff; }
body {
  box-sizing: border-box;
  /* Chromium omits background colours from a print unless the page opts in, which
     would flatten every code block, table header, and blockquote to plain white. */
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}

/* On screen this page is only ever seen through the print-by-hand fallback, where
   it is a normal document in a normal window: keep the preview's readable column.
   The flattening below is what paper needs, and applies only there. */
body { padding: 24px 28px; }
.markdown-body { max-width: 820px; margin: 0 auto; }
@media print {
  html, body { margin: 0; padding: 0; }
  /* The preview centres its column in the panel and leaves 120px of room to scroll
     past the end. The @page margin does that job here, and that bottom padding
     would otherwise print as a blank final page. */
  .markdown-body { max-width: none; margin: 0; padding: 0; }
}

/* Pagination.
   Only genuinely atomic things forbid a break inside them. A blanket
   \`pre, table { break-inside: avoid }\` cannot be honoured for a block taller than
   the page, and a browser that cannot honour it pushes the block to a fresh page
   anyway -- leaving the rest of the previous one blank. That is where the stray
   page breaks came from. Tall blocks may now split, and only the things that would
   look broken split are protected. */
h1, h2, h3, h4, h5, h6 { break-inside: avoid; break-after: avoid; }
p, li, blockquote { orphans: 3; widows: 3; }
img, .mc-mermaid, .mc-math { break-inside: avoid; }
tr { break-inside: avoid; }
/* Repeat a table's header on every page it spans. */
thead { display: table-header-group; break-inside: avoid; }

/* On screen a code block or a wide table scrolls sideways. There is nowhere to
   scroll on paper, so \`overflow: auto\` just clips whatever does not fit and the
   content is silently lost. Wrap it instead. */
.markdown-body pre {
  overflow: visible;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  break-inside: auto;
}
.markdown-body table {
  display: table;
  max-width: 100%;
  overflow: visible;
  break-inside: auto;
}
/* The CSV grid opts out of the rule above: preview.css sizes it \`width: max-content\`
   at (0,2,1), which outranks the (0,1,1) selector there whatever the source order,
   so a wide grid would run off the page margin. Dragging a column divider also
   freezes per-<col> widths as inline styles, which only \`!important\` can reach.
   Both are undone here so a grid fits the paper and re-flows to it. */
.markdown-body table.mc-csv {
  width: 100% !important;
  max-width: 100% !important;
  table-layout: auto !important;
}
.markdown-body table.mc-csv col { width: auto !important; }
.markdown-body th, .markdown-body td { overflow-wrap: anywhere; }
.markdown-body img { max-width: 100%; height: auto; }
.mc-mermaid svg { max-width: 100%; height: auto; }

/* Interactive chrome that means nothing in a document. */
.mc-menu, .mc-toast { display: none !important; }
`;
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      reject(new Error(`could not start ${command} (${String(err)}).`));
      return;
    }

    let stderr = '';
    let settled = false;
    let timedOut = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        fn();
      }
    };
    const timeoutError = () =>
      new Error(`the browser did not finish within ${Math.round(timeoutMs / 1000)}s.`);

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      // Kill, then let the 'close' handler settle us once the process is really
      // gone, so the profile directory is unlocked before the caller deletes it.
      // The grace timer is the backstop for a process that will not die.
      timedOut = true;
      child.kill();
      graceTimer = setTimeout(() => finish(() => reject(timeoutError())), KILL_GRACE_MS);
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded: a wedged browser can log without limit, and only the tail is used.
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', (err) =>
      finish(() => reject(new Error(`could not start ${command} (${err.message}).`))),
    );
    child.on('close', (code) =>
      finish(() => {
        if (timedOut) {
          reject(timeoutError());
        } else if (code === 0) {
          resolve(stderr);
        } else {
          reject(new Error(`the browser exited with code ${code}.${detail(stderr)}`));
        }
      }),
    );
  });
}
