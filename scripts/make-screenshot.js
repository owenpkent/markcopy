// Generates a real screenshot of the Markdown preview with the copy context
// menu open, by rendering the actual preview HTML + media/preview.css in
// headless Chrome/Edge. The output is pixel-accurate to the preview pane.
//
// Usage: node scripts/make-screenshot.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'media');
fs.mkdirSync(outDir, { recursive: true });

// Mirror the extension's markdown-it config (render.ts) closely enough for a shot.
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        /* fall through */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

const sample = `# Release notes

Paste this straight into **email**, **Word**, or **Google Docs** with the
formatting intact. Right-click anything in the preview to copy it.

| Feature        | Built-in | MarkCopy |
| -------------- | :------: | :------: |
| Rich-text copy |    No    |   Yes    |
| Table as CSV   |    No    |   Yes    |
| Diagram as PNG |    No    |   Yes    |
`;

const body = md.render(sample);
const css = fs.readFileSync(path.join(root, 'media', 'preview.css'), 'utf8');

// A context menu positioned over the table, with the top item "hovered".
const menu = `
<div class="mc-menu" style="left:300px; top:250px;">
  <div class="mc-menu-item" style="background:#0969da; color:#fff;">Copy Table (Rich Text)</div>
  <div class="mc-menu-item">Copy Table as CSV</div>
  <div class="mc-menu-item">Copy Table as TSV</div>
  <div class="mc-menu-item">Copy Table as PNG</div>
  <div class="mc-menu-item">Copy Whole Document as Rich Text</div>
</div>`;

// dark = true simulates VS Code's dark theme (it adds `vscode-dark` to body).
function buildHtml(dark) {
  const pageBg = dark ? '#010409' : '#f6f8fa';
  const cardBorder = dark ? '#30363d' : '#d1d9e0';
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
body { background: ${pageBg}; ${menuVars} }
.frame { max-width: 820px; margin: 0 auto; }
.markdown-body { border:1px solid ${cardBorder}; border-radius:10px; box-shadow:0 4px 24px rgba(0,0,0,.14); }
</style></head>
<body class="${dark ? 'vscode-dark' : 'vscode-light'}" data-style="github">
  <div class="frame">
    <div class="markdown-body">${body}</div>
  </div>
  ${menu}
</body></html>`;
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

for (const [name, dark] of [
  ['context-menu.png', false],
  ['context-menu-dark.png', true],
]) {
  const htmlPath = path.join(outDir, '_shot.html');
  fs.writeFileSync(htmlPath, buildHtml(dark));
  const outPng = path.join(outDir, name);
  execFileSync(browser, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--window-size=880,470',
    `--screenshot=${outPng}`,
    `file:///${htmlPath.replace(/\\/g, '/')}`,
  ]);
  fs.unlinkSync(htmlPath);
  console.log('Wrote', path.relative(root, outPng));
}
