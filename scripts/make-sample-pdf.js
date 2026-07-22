// Generates sample.pdf (repo root, gitignored): a 12-page PDF where every page
// shows its own page number in large type. It is the fixture for the manual
// PDF-viewer checks in docs/TESTING.md (page indicator, go-to-page, zoom,
// theming), where "which page am I looking at" must be obvious at a glance.
//
// The PDF is written by hand (raw objects + xref) so the script needs no
// dependencies and the output is deterministic.
//
// Usage: node scripts/make-sample-pdf.js
const fs = require('fs');
const path = require('path');

const PAGES = 12;
const objects = []; // 1-indexed object bodies (without the "N 0 obj" wrapper)

// obj 1: catalog, obj 2: pages tree, obj 3: shared font
objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
const kids = [];
for (let i = 0; i < PAGES; i++) {
  kids.push(`${4 + i * 2} 0 R`);
}
objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${PAGES} >>`;
objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';

// Two objects per page: the page dict and its content stream.
for (let i = 0; i < PAGES; i++) {
  const pageObj = 4 + i * 2;
  const contentObj = pageObj + 1;
  const stream = [
    'BT',
    '/F1 96 Tf',
    '180 400 Td',
    `(Page ${i + 1}) Tj`,
    'ET',
    'BT',
    '/F1 18 Tf',
    '180 360 Td',
    `(of ${PAGES} - MarkCopy manual test fixture) Tj`,
    'ET',
  ].join('\n');
  objects[pageObj] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
  objects[contentObj] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
}

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

const dest = path.join(__dirname, '..', 'sample.pdf');
fs.writeFileSync(dest, out, 'binary');
console.log('Wrote', path.relative(process.cwd(), dest), `(${PAGES} pages)`);
