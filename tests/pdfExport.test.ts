import { describe, it, expect } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserCandidates, buildPdfPage, findBrowser, pdfCss, printArgs } from '../src/pdfExport';

describe('browserCandidates', () => {
  it('finds Edge and Chrome under the Windows program folders', () => {
    const out = browserCandidates('win32', {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    });
    expect(out).toContain('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    expect(out).toContain('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    expect(out).toContain('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(out).toContain('C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
  });

  it('tolerates a Windows environment with none of those variables set', () => {
    expect(browserCandidates('win32', {})).toEqual([]);
  });

  it('finds the macOS app bundles, including a per-user install', () => {
    const out = browserCandidates('darwin', { HOME: '/Users/me' });
    expect(out).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(out).toContain('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    expect(out).toContain('/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('offers PATH names and absolute paths elsewhere', () => {
    const out = browserCandidates('linux', {});
    expect(out).toContain('google-chrome');
    expect(out).toContain('chromium');
    expect(out).toContain('/usr/bin/google-chrome');
  });

  it('never repeats a candidate', () => {
    // ProgramW6432 usually duplicates ProgramFiles; probing the same path twice is
    // wasted syscalls.
    const out = browserCandidates('win32', {
      ProgramFiles: 'C:\\Program Files',
      ProgramW6432: 'C:\\Program Files',
    });
    expect(new Set(out).size).toBe(out.length);
  });
});

describe('findBrowser', () => {
  it('takes the configured path verbatim, without probing', async () => {
    await expect(findBrowser('  /opt/my/chrome  ', 'linux', {})).resolves.toBe('/opt/my/chrome');
  });

  it('ignores a blank setting', async () => {
    // Nothing to find on a Windows box with no program folders, so a blank
    // setting has to fall through to detection rather than be returned as a path.
    await expect(findBrowser('   ', 'win32', {})).resolves.toBeUndefined();
  });

  // The two cases above both short-circuit on `configured`, so neither reaches the
  // detection loop. That loop is what decides whether a whole platform gets the
  // headless export or drops to printing by hand, so the cases below drive it with
  // a PATH built for the test rather than whatever the machine happens to have.
  // The regression this guards: taking bare names on trust returns the first entry
  // of the Linux list to every caller, so `google-chrome` wins on a machine that
  // has only Chromium, and the six other names plus every /usr/bin fallback below
  // them become unreachable. Chromium sits third on that list, so resolving to it
  // proves both halves: the two names above it were probed and skipped, and the
  // one that is installed was found. Answering from a PATH built here rather than
  // the machine's keeps it from depending on what the runner has installed, and
  // returning before any /usr/bin candidate is reached keeps it off the disk.
  it('never hands back an unprobed bare name', async () => {
    // The bug in one assertion, and the only form of it that can be checked on
    // every host: with nothing on PATH, the old loop still answered with the
    // literal string 'google-chrome'. Whatever is found now has to have been
    // probed, so it is either an absolute path or nothing at all. This stays true
    // on a CI runner that really does have /usr/bin/chromium.
    const found = await findBrowser(undefined, 'linux', { PATH: '' });
    expect(found === undefined || found.startsWith('/')).toBe(true);
  });

  // Resolution itself needs a real directory on PATH, and a Windows temp path
  // ('C:\...') cannot appear in a POSIX PATH string without its drive colon
  // reading as the separator. So the full assertion runs on POSIX only, and the
  // host-independent half above carries the regression on Windows.
  it.skipIf(process.platform === 'win32')(
    'skips preferred names that are not installed and resolves the one that is',
    async () => {
      // Chromium sits third on the Linux list, so resolving to it proves both
      // halves: the two names above it were probed and skipped, and the one that
      // is installed was found. It returns before any /usr/bin candidate is
      // reached, so the machine's own browsers cannot change the answer.
      const dir = await mkdtemp(join(tmpdir(), 'markcopy-path-'));
      try {
        const chromium = join(dir, 'chromium');
        await writeFile(chromium, '');
        await chmod(chromium, 0o755);
        await expect(findBrowser(undefined, 'linux', { PATH: dir })).resolves.toBe(chromium);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('probes absolute candidates and rejects the ones that are not there', async () => {
    // Every Windows candidate is derived from these variables, so pointing them at
    // a path that exists on no machine makes the whole list absolute and absent.
    // That exercises the `isExecutable` half of the loop, and unlike asserting
    // against the real /Applications or /usr/bin it does not change answer
    // depending on which machine runs the suite.
    const env = { ProgramFiles: 'Z:\\markcopy-test-nonexistent' };
    await expect(findBrowser(undefined, 'win32', env)).resolves.toBeUndefined();
  });
});

describe('printArgs', () => {
  const args = printArgs({
    htmlPath: 'C:\\tmp\\mc\\export.html',
    pdfPath: 'C:\\Users\\me\\out.pdf',
    userDataDir: 'C:\\tmp\\mc\\profile',
  });

  it('prints headlessly to the requested file', () => {
    expect(args).toContain('--headless');
    expect(args).toContain('--print-to-pdf=C:\\Users\\me\\out.pdf');
  });

  it('suppresses the header and footer the print dialog would add', () => {
    // The reason this export exists: no document title across the top, no
    // `file://…` URL across the bottom. Both spellings, old and current.
    expect(args).toContain('--no-pdf-header-footer');
    expect(args).toContain('--print-to-pdf-no-header');
  });

  it('uses a throwaway profile', () => {
    // Without this, launching an already-running browser hands the URL to the
    // existing process and prints nothing at all.
    expect(args).toContain('--user-data-dir=C:\\tmp\\mc\\profile');
  });

  it('passes the page as a file URL, last', () => {
    const url = args[args.length - 1];
    expect(url.startsWith('file:///')).toBe(true);
    expect(url).toContain('export.html');
  });

  it('does not ask for the new headless mode by name', () => {
    // Builds that predate `--headless=new` would fail to parse it and open a
    // visible window instead of printing.
    expect(args).not.toContain('--headless=new');
  });
});

describe('pdfCss', () => {
  it('honours the configured paper size', () => {
    expect(pdfCss('A4')).toContain('@page { size: A4;');
    expect(pdfCss('Letter')).toContain('@page { size: Letter;');
  });

  it('opts into printing background colours', () => {
    // Chromium drops them otherwise, flattening every code block and table header.
    expect(pdfCss('Letter')).toContain('print-color-adjust: exact');
  });

  it('lets tall blocks split across pages', () => {
    // A `break-inside: avoid` a browser cannot honour is what left half-empty
    // pages behind the tall code blocks and long tables.
    const css = pdfCss('Letter');
    expect(css).toMatch(/\.markdown-body pre \{[^}]*break-inside: auto/);
    expect(css).toMatch(/\.markdown-body table \{[^}]*break-inside: auto/);
  });

  it('unclips what the preview would scroll sideways', () => {
    const css = pdfCss('Letter');
    expect(css).toMatch(/\.markdown-body pre \{[^}]*overflow: visible/);
    expect(css).toMatch(/\.markdown-body pre \{[^}]*white-space: pre-wrap/);
  });

  it('repeats a table header on every page the table spans', () => {
    expect(pdfCss('Letter')).toContain('display: table-header-group');
  });

  it('drops the padding the preview keeps for scrolling past the end', () => {
    expect(pdfCss('Letter')).toMatch(/@media print \{[^]*\.markdown-body \{[^}]*padding: 0/);
  });

  it('unclips the CSV grid, which sizes itself past the page margin', () => {
    // preview.css sets `table.mc-csv { width: max-content }` at a specificity the
    // generic `.markdown-body table` rule cannot reach, and a dragged column
    // divider freezes widths inline, so both need !important here.
    const css = pdfCss('Letter');
    expect(css).toMatch(/table\.mc-csv \{[^}]*max-width: 100% !important/);
    expect(css).toMatch(/table\.mc-csv col \{[^}]*width: auto !important/);
  });

  it('refuses a paper size that is not one of the three offered', () => {
    // package.json's `enum` only constrains the settings editor. Anything can be
    // hand-written into settings.json, and this string lands inside a <style> on a
    // page that (unlike the webview) carries no CSP.
    const hostile = '</style><script>fetch("https://evil.example")</script>';
    const css = pdfCss(hostile as unknown as Parameters<typeof pdfCss>[0]);
    expect(css).not.toContain('</style>');
    expect(css).not.toContain('<script>');
    expect(css).toContain('@page { size: Letter;');
  });
});

describe('buildPdfPage', () => {
  const page = (over: Partial<Parameters<typeof buildPdfPage>[0]> = {}) =>
    buildPdfPage({
      bodyHtml: '<h1>Hi</h1>',
      title: 'notes',
      previewCss: '.markdown-body { color: red }',
      katexCss: '',
      pageSize: 'Letter',
      autoPrint: false,
      ...over,
    });

  it('inlines the preview stylesheet and the print rules', () => {
    const html = page();
    expect(html).toContain('.markdown-body { color: red }');
    expect(html).toContain('@page { size: Letter;');
    expect(html).toContain('<h1>Hi</h1>');
  });

  it('forces the light palette whatever the preview was showing', () => {
    expect(page()).toContain('<body class="mc-force-light" data-mc-theme="light">');
  });

  it('escapes the title', () => {
    expect(page({ title: '<script>x</script>' })).not.toContain('<script>x</script>');
  });

  it('omits KaTeX CSS when the document has no math', () => {
    expect(page()).not.toContain('katex');
    expect(page({ katexCss: '.katex { font-size: 1.1em }' })).toContain('.katex');
  });

  it('only self-prints on the manual browser route', () => {
    // A `window.print()` racing `--print-to-pdf` is at best redundant.
    expect(page({ autoPrint: false })).not.toContain('window.print()');
    expect(page({ autoPrint: true })).toContain('window.print()');
  });
});
