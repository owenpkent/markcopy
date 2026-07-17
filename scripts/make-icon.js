// Renders the MarkCopy marketplace icon (256x256 PNG) from an inline SVG using
// headless Chrome/Edge, so it is reproducible. Output: media/icon.png.
//
// Usage: node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'media');
fs.mkdirSync(outDir, { recursive: true });

// A "copy" glyph (two stacked sheets) with formatted text lines: the front
// sheet's second line is accented to hint rich text. Reads well down to 32px.
const svg = `<svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b82f6"/>
      <stop offset="1" stop-color="#0969da"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="256" height="256" rx="56" fill="url(#bg)"/>
  <rect x="66" y="52" width="96" height="122" rx="16" fill="#ffffff" opacity="0.42"/>
  <rect x="92" y="80" width="98" height="124" rx="16" fill="#ffffff"/>
  <rect x="110" y="108" width="62" height="11" rx="5.5" fill="#0969da"/>
  <rect x="110" y="131" width="54" height="11" rx="5.5" fill="#ffa657"/>
  <rect x="110" y="154" width="62" height="11" rx="5.5" fill="#8b949e"/>
  <rect x="110" y="177" width="40" height="11" rx="5.5" fill="#8b949e"/>
</svg>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0}svg{display:block}
</style></head><body>${svg}</body></html>`;

const htmlPath = path.join(outDir, '_icon.html');
fs.writeFileSync(htmlPath, html);

const browsers = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const browser = browsers.find((b) => fs.existsSync(b));
if (!browser) {
  console.error('No Chrome/Edge found for headless rendering.');
  process.exit(1);
}

const out = path.join(outDir, 'icon.png');
execFileSync(browser, [
  '--headless',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--default-background-color=00000000',
  '--window-size=256,256',
  `--screenshot=${out}`,
  `file:///${htmlPath.replace(/\\/g, '/')}`,
]);

fs.unlinkSync(htmlPath);
console.log('Wrote', path.relative(root, out));
