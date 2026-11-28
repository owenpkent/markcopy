// @vitest-environment node
// What pdf.js really hands back for a remote GoTo (GoToR) and a Launch action,
// so the link policy is checked against the actual annotation shape rather than
// a hand-written one: a web address arrives in `url` like an ordinary URI action
// (also from a JavaScript action pdf.js can read an address out of) and opens
// through the validated openLink path; a local file never gets a `url`.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { linkTargetOf, type LinkAnnotation } from '../src/webview/pdfLinks';

function linkPdf(actions: string[]): Uint8Array {
  const annots = actions.map((a, i) => `${5 + i} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Annots [${annots}] >>`,
    '<< /Length 0 >>\nstream\n\nendstream',
    ...actions.map(
      (a) => `<< /Type /Annot /Subtype /Link /Rect [10 10 50 30] /Border [0 0 0] /A ${a} >>`,
    ),
  ];
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

async function annotationsOf(actions: string[]): Promise<LinkAnnotation[]> {
  const task = getDocument({ data: linkPdf(actions), isEvalSupported: false });
  try {
    const page = await (await task.promise).getPage(1);
    return (await page.getAnnotations({ intent: 'display' })) as LinkAnnotation[];
  } finally {
    await task.destroy();
  }
}

describe('remote GoTo and Launch actions as pdf.js parses them', () => {
  it('opens a remote GoTo to a web PDF through the same url path as a URI action', async () => {
    const [remote, uri] = await annotationsOf([
      '<< /S /GoToR /F (https://example.com/other.pdf) /D (chap3) >>',
      '<< /S /URI /URI (https://example.com/page) >>',
    ]);
    // The annotation really carries the web address in `url`, fragment included.
    expect(remote.url).toBe('https://example.com/other.pdf#chap3');
    expect(linkTargetOf(remote)).toEqual({
      kind: 'url',
      url: 'https://example.com/other.pdf#chap3',
    });
    expect(linkTargetOf(uri)).toEqual({ kind: 'url', url: 'https://example.com/page' });
  });

  it('opens a Launch naming a web address, and a web address pdf.js finds in JavaScript', async () => {
    const [launch, scripted, unsafe] = await annotationsOf([
      '<< /S /Launch /F (https://example.com/doc.pdf) >>',
      '<< /S /JavaScript /JS (app.launchURL("https://example.com/js", true);) >>',
      '<< /S /JavaScript /JS (app.launchURL("javascript:alert(1)");) >>',
    ]);
    // The policy is about the destination pdf.js supplies in `url`: it is
    // validated and opened by the host, and the script itself is never run.
    expect(linkTargetOf(launch)).toEqual({ kind: 'url', url: 'https://example.com/doc.pdf' });
    expect(linkTargetOf(scripted)).toEqual({ kind: 'url', url: 'https://example.com/js' });
    expect(linkTargetOf(unsafe)).toBeNull();
  });

  it('ignores a remote GoTo or Launch that names a local file', async () => {
    const annots = await annotationsOf([
      '<< /S /GoToR /F (other.pdf) /D (chap3) >>',
      '<< /S /GoToR /F (file:///C:/secret.pdf) >>',
      '<< /S /Launch /F (run.exe) >>',
      '<< /S /Launch /F (file:///C:/Windows/notepad.exe) >>',
    ]);
    expect(annots).toHaveLength(4);
    for (const annot of annots) {
      expect(linkTargetOf(annot)).toBeNull();
    }
  });
});
