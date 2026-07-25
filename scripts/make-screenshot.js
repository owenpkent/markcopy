// Generates real screenshots of the Markdown and PDF previews for the README,
// by rendering the actual preview bundles (media/webview.js, media/pdf.js) and
// media/preview.css in headless Chrome/Edge. The output is pixel-accurate to
// the preview pane.
//
// - context-menu.png / context-menu-dark.png: static preview HTML with the copy
//   context menu drawn open (light and dark themes).
// - rendering-dark.png: the real webview bundle upgrading KaTeX math and a
//   Mermaid diagram in the dark theme.
// - terminal-green.png: the green-on-black terminal palette.
// - pdf-viewer.png: the real pdf.js viewer with the floating page/zoom toolbar.
//
// The static shots load file:// HTML directly; the live shots stub
// acquireVsCodeApi and post the same messages the extension host sends, with
// the repo served over a local HTTP server so ES-module chunks and the pdf.js
// worker resolve.
//
// Usage: node scripts/make-screenshot.js
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const esbuild = require('esbuild');

const execFileAsync = promisify(execFile);

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'media');
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Markdown rendering: bundle the extension host's real render.ts so the HTML
// (hljs classes, mermaid/math placeholders, source-line mapping) is exactly
// what the webview receives in production.
// ---------------------------------------------------------------------------
const renderBundle = path.join(outDir, '_render.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'render.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: renderBundle,
  logLevel: 'silent',
});
const { createMarkdownIt } = require(renderBundle);
fs.unlinkSync(renderBundle);
const md = createMarkdownIt();

const css = fs.readFileSync(path.join(root, 'media', 'preview.css'), 'utf8');

// ---------------------------------------------------------------------------
// Shot 1 + 2: the copy context menu over a table (light and dark).
// ---------------------------------------------------------------------------
const menuSample = `# Release notes

Paste this straight into **email**, **Word**, or **Google Docs** with the
formatting intact. Right-click anything in the preview to copy it.

| Feature        | Built-in | MarkCopy |
| -------------- | :------: | :------: |
| Rich-text copy |    No    |   Yes    |
| Table as CSV   |    No    |   Yes    |
| Diagram as PNG |    No    |   Yes    |
`;

// The menu as buildMenu() in src/webview/main.ts produces it for a right-click
// on a table: a short top level naming what you clicked, with that element's
// remaining formats one level down under "Copy as", shown here hovered open.
//
// This is static markup because these two shots render preview.css over plain
// HTML rather than booting the webview bundle, so it has to be kept in step
// with buildMenu() by hand. (The PDF shot below drives the real menu engine, so
// it follows along on its own.) The geometry mirrors createMenu(): a submenu
// sits 4px inside the parent panel's right edge and 4px above its own row.
const highlighted =
  'background:var(--vscode-menu-selectionBackground,#0969da); ' +
  'color:var(--vscode-menu-selectionForeground,#fff);';
const menu = `
<div class="mc-menu" style="left:300px; top:250px;">
  <div class="mc-menu-item">Copy Table</div>
  <div class="mc-menu-item mc-menu-item--submenu" style="${highlighted}">
    <span>Copy as</span><span class="mc-menu-arrow">▸</span>
  </div>
  <div class="mc-menu-divider"></div>
  <div class="mc-menu-item">Copy Whole Document</div>
  <div class="mc-menu-item">Save as PDF…</div>
  <div class="mc-menu-divider"></div>
  <div class="mc-menu-item mc-menu-item--submenu">
    <span>Preferences</span><span class="mc-menu-arrow">▸</span>
  </div>
</div>
<div class="mc-menu mc-menu--sub" style="left:518px; top:279px;">
  <div class="mc-menu-item">Rich Text</div>
  <div class="mc-menu-item">CSV</div>
  <div class="mc-menu-item">TSV</div>
  <div class="mc-menu-item">PNG</div>
</div>`;

// Framing shared by every Markdown shot: page background plus a rounded card
// around the rendered document, standing in for the preview pane.
function frameCss(dark) {
  const pageBg = dark ? '#010409' : '#f6f8fa';
  const cardBorder = dark ? '#30363d' : '#d1d9e0';
  return `
body { background: ${pageBg}; }
.frame { max-width: 820px; margin: 0 auto; }
.markdown-body { border:1px solid ${cardBorder}; border-radius:10px; box-shadow:0 4px 24px rgba(0,0,0,.14); }`;
}

// dark = true simulates VS Code's dark theme (it adds `vscode-dark` to body).
function buildMenuHtml(dark) {
  // Stand in for the VS Code menu theme variables so the context menu renders
  // as it would in the real editor (dark menu in a dark theme).
  const menuVars = dark
    ? `--vscode-menu-background:#252526; --vscode-menu-foreground:#cccccc;
       --vscode-menu-border:#454545; --vscode-menu-selectionBackground:#04395e;
       --vscode-menu-selectionForeground:#ffffff;`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
${css}
${frameCss(dark)}
body { ${menuVars} }
</style></head>
<body class="${dark ? 'vscode-dark' : 'vscode-light'}" data-style="github">
  <div class="frame">
    <div class="markdown-body">${md.render(menuSample)}</div>
  </div>
  ${menu}
</body></html>`;
}

// ---------------------------------------------------------------------------
// Shot 3: KaTeX math + a Mermaid diagram, upgraded by the real webview bundle.
// ---------------------------------------------------------------------------
const renderingSample = `# Weekly metrics

Growth compounds as $r_t = r_{t-1}(1 + g)$, so over a quarter:

$$ R = \\prod_{t=1}^{13} (1 + g_t) - 1 $$

\`\`\`mermaid
flowchart LR
  A[Markdown] --> B{MarkCopy}
  B -->|Rich text| C[Word / Gmail / Docs]
  B -->|CSV / TSV| D[Excel / Sheets]
  B -->|PNG / SVG| E[Slides / Chat]
\`\`\`

Right-click the equation for **LaTeX or PNG**, the diagram for **PNG or SVG**.
`;

// The real webview skeleton (extension.ts htmlShell) with acquireVsCodeApi
// stubbed and the host's `render` message posted from the page itself.
function buildWebviewHarness(sample, theme) {
  const message = {
    type: 'render',
    html: md.render(sample),
    source: sample,
    styleProfile: 'github',
    theme,
    mermaidConfig: {},
    syncScroll: false,
    autoPreview: false,
    math: true,
    docKey: 'screenshot',
  };
  return `<!doctype html>
<html><head><meta charset="utf-8">
<link href="/media/preview.css" rel="stylesheet">
<link href="/media/katex/katex.min.css" rel="stylesheet">
<style>${frameCss(theme !== 'light')}</style>
<script>
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
</script>
</head>
<body>
  <div class="frame">
    <div id="content" class="markdown-body"></div>
  </div>
  <div id="mc-menu" class="mc-menu" role="menu" hidden></div>
  <div id="mc-toast" class="mc-toast" hidden></div>
  <script type="module" src="/media/webview.js"></script>
  <script type="module">
    window.postMessage(${JSON.stringify(message)}, '*');
  </script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Shot 4: the green-on-black terminal palette on a code-heavy document.
// ---------------------------------------------------------------------------
const greenSample = `# deploy runbook

Roll the canary first, then promote:

\`\`\`bash
kubectl rollout restart deploy/api --context=canary
kubectl rollout status deploy/api --watch
\`\`\`

| Stage   | Traffic | Rollback   |
| ------- | ------: | ---------- |
| Canary  |      5% | automatic  |
| Beta    |     25% | one click  |
| Prod    |    100% | \`git revert\` |

> Copies stay light-safe: paste into a white doc and it is still readable.
`;

// ---------------------------------------------------------------------------
// Shot 5: the real pdf.js viewer (pdfEditor.ts skeleton + `load` message).
// ---------------------------------------------------------------------------
// A small hand-written PDF (raw objects + xref, like make-sample-pdf.js) that
// looks like a real document, so the viewer shot shows a plausible page rather
// than the stark manual-test fixture.
function buildShotPdf() {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const text = (font, size, x, y, lines, leading = 18) =>
    [
      'BT',
      `/${font} ${size} Tf`,
      `${leading} TL`,
      `${x} ${y} Td`,
      ...lines.map((l, i) => (i === 0 ? `(${esc(l)}) Tj` : `T* (${esc(l)}) Tj`)),
      'ET',
    ].join('\n');

  const page1 = [
    text('F1', 26, 72, 700, ['Quarterly Engineering Review']),
    '0.75 w 72 686 m 540 686 l S',
    text('F2', 12, 72, 656, [
      'The preview pipeline moved to code-split ES modules this quarter, dropping',
      'the initial bundle from 8.5 MB to 19 KB. Mermaid, KaTeX, and the clipboard',
      'serializers now load on demand, so first paint stays instant on large',
      'documents while diagrams and equations hydrate in the background.',
    ]),
    text('F1', 15, 72, 560, ['Goals']),
    text('F2', 12, 84, 534, [
      '-  Ship the PDF page indicator and a keyboard-accessible toolbar.',
      '-  Land the green-on-black terminal palette across both previews.',
      '-  Keep every copy flavor light-safe when pasted into white documents.',
    ]),
    text('F1', 15, 72, 452, ['Risks']),
    text('F2', 12, 72, 426, [
      'Large PDFs must stay memory-bounded: only pages near the viewport are',
      'rasterised, and offscreen pages are torn down as you scroll.',
    ]),
    text('F2', 10, 72, 60, ['1 of 5']),
  ].join('\n');
  const rest = (n) =>
    [
      text('F1', 18, 72, 700, [`Section ${n}`]),
      '0.75 w 72 688 m 540 688 l S',
      text('F2', 12, 72, 660, [
        'Continued notes for the review. Scroll to see the page indicator track',
        'whichever page sits under the middle of the viewport.',
      ]),
      text('F2', 10, 72, 60, [`${n} of 5`]),
    ].join('\n');
  const streams = [page1, rest(2), rest(3), rest(4), rest(5)];

  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = streams.map((_, i) => `${5 + i * 2} 0 R`);
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${streams.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  streams.forEach((stream, i) => {
    const pageObj = 5 + i * 2;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageObj + 1} 0 R >>`;
    objects[pageObj + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(out);
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) {
    out += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, 'binary');
}

// pdf.js renders on a real Web Worker, which Chrome's virtual-time budget
// fast-forwards past, so this harness instead holds the page's `load` event
// open with a never-completing image request (`/hold`) and releases it once a
// page canvas and the page indicator exist; headless `--screenshot` fires on
// the load event, capturing the finished view. Before releasing, it opens the
// real right-click menu over the page.
function buildPdfHarness(theme) {
  const pdfBase64 = buildShotPdf().toString('base64');
  const message = {
    type: 'load',
    data: pdfBase64,
    workerSrc: '/media/pdf.worker.js',
    comments: [],
  };
  return `<!doctype html>
<html><head><meta charset="utf-8">
<link href="/media/preview.css" rel="stylesheet">
<script>
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
</script>
</head>
<style>
#mc-toast { display: none !important; }
/* Stand in for the VS Code menu theme variables (dark editor theme). */
body {
  --vscode-menu-background:#252526; --vscode-menu-foreground:#cccccc;
  --vscode-menu-border:#454545; --vscode-menu-selectionBackground:#04395e;
  --vscode-menu-selectionForeground:#ffffff;
}
</style>
<body class="mc-pdf" data-mc-theme="${theme}">
  <div id="pdf-root"></div>
  <div id="mc-menu" class="mc-menu" role="menu" hidden></div>
  <div id="mc-toast" class="mc-toast" hidden></div>
  <img id="mc-hold" src="/hold" alt="" style="position:fixed; width:1px; height:1px; opacity:0">
  <script type="module" src="/media/pdf.js"></script>
  <script type="module">
    window.postMessage(${JSON.stringify(message)}, '*');
    const started = performance.now();
    const timer = setInterval(() => {
      const canvas = document.querySelector('#pdf-root canvas');
      const label = document.getElementById('mc-page-label');
      const ready = canvas && label?.textContent.includes('/');
      if (ready || performance.now() - started > 25000) {
        clearInterval(timer);
        // A beat for the visible pages to finish painting, then open the real
        // right-click menu over the page and release the held request
        // (swapping src cancels it and lets the load event fire).
        setTimeout(() => requestAnimationFrame(() => {
          if (canvas) {
            const r = canvas.getBoundingClientRect();
            canvas.dispatchEvent(new MouseEvent('contextmenu', {
              bubbles: true,
              clientX: r.left + r.width * 0.62,
              clientY: r.top + 96,
            }));
          }
          document.getElementById('mc-hold').src =
            'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
        }), 800);
      }
    }, 100);
  </script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Plumbing: local HTTP server (ES-module chunks and the pdf.js worker cannot
// load over file://) and headless Chrome/Edge.
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (rel === '/hold') {
        return; // never respond: holds the harness page's load event open
      }
      const file = path.join(root, rel);
      if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const browsers = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const browser = browsers.find((b) => fs.existsSync(b));
if (!browser) {
  console.error('No Chrome/Edge found for headless screenshot.');
  process.exit(1);
}

async function shoot(url, outName, { width, height, budgetMs = 0 }) {
  const outPng = path.join(outDir, outName);
  const args = [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--window-size=${width},${height}`,
  ];
  if (budgetMs > 0) {
    args.push(`--virtual-time-budget=${budgetMs}`);
  }
  args.push(`--screenshot=${outPng}`, url);
  await execFileAsync(browser, args);
  console.log('Wrote', path.relative(root, outPng));
}

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const harness = (name, html) => {
    fs.writeFileSync(path.join(root, name), html);
    return `${base}/${name}`;
  };
  try {
    // Static shots (no scripts) load straight from disk.
    for (const [name, dark] of [
      ['context-menu.png', false],
      ['context-menu-dark.png', true],
    ]) {
      const htmlPath = path.join(outDir, '_shot.html');
      fs.writeFileSync(htmlPath, buildMenuHtml(dark));
      await shoot(`file:///${htmlPath.replace(/\\/g, '/')}`, name, { width: 880, height: 470 });
      fs.unlinkSync(htmlPath);
    }

    // Live shots run the real bundles; the virtual-time budget lets Mermaid,
    // KaTeX, and pdf.js finish their async rendering before the capture.
    await shoot(
      harness('_shot-rendering.html', buildWebviewHarness(renderingSample, 'dark')),
      'rendering-dark.png',
      { width: 880, height: 640, budgetMs: 20000 },
    );
    await shoot(
      harness('_shot-green.html', buildWebviewHarness(greenSample, 'green')),
      'terminal-green.png',
      { width: 880, height: 500, budgetMs: 20000 },
    );
    await shoot(harness('_shot-pdf.html', buildPdfHarness('dark')), 'pdf-viewer.png', {
      width: 880,
      height: 580,
    });
  } finally {
    for (const f of ['_shot-rendering.html', '_shot-green.html', '_shot-pdf.html']) {
      fs.rmSync(path.join(root, f), { force: true });
    }
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
