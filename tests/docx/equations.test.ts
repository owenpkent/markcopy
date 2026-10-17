// Equations through the whole reader, and in documents real tools wrote.
//
// tests/fixtures/docx/equations.md is the source. equations.docx is pandoc's
// OMML for it and equations-lo.docx is that file round-tripped through
// LibreOffice (docx to odt to docx), which rewrites every equation and so is a
// second, independent writer.
import katex from 'katex';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { renderDocxHtml } from '../../src/docx/read';
import { ommlToLatex } from '../../src/docx/read/omml';
import { findAll, parseXml } from '../../src/ooxml/xnode';
import { buildDocx } from './fixture';

const dir = resolve(__dirname, '..', 'fixtures', 'docx');
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

function equations(name: string): string[] {
  const zip = unzipSync(new Uint8Array(readFileSync(resolve(dir, name))));
  const root = parseXml(strFromU8(zip['word/document.xml']));
  return findAll(root, 'oMath').map(ommlToLatex);
}

const EQUATION_COUNT = 29;

// A selection both writers must agree on, by position in equations.md.
const COMMON: Record<number, string> = {
  0: '\\frac{a}{b}',
  3: 'x_{i}^{2}',
  4: '\\sqrt{x}',
  7: '\\frac{a+b}{c-d}',
  8: 'x=\\frac{-b\\pm\\sqrt{b^{2}-4ac}}{2a}',
  9: '\\sqrt[3]{x+1}',
  13: '\\left(\\begin{matrix} a & b \\\\ c & d \\end{matrix}\\right)',
  14: '\\left[\\begin{matrix} 1 & 0 \\\\ 0 & 1 \\end{matrix}\\right]',
  16: '\\begin{aligned} f(x)&=(x+1)^{2} \\\\ &=x^{2}+2x+1 \\end{aligned}',
  20: '\\overline{AB}+\\underline{CD}',
  22: 'f(x)=\\begin{cases} x & x\\geq0 \\\\ -x & x<0 \\end{cases}',
  25: '\\left(\\frac{a}{b}\\right)\\left\\{x\\right\\}\\left\\langle y\\right\\rangle',
  26: 'a\\rightarrow b\\Rightarrow c\\leftrightarrow d',
  28: 'e^{i\\pi}+1=0',
};

// What only pandoc's richer markup (limits placement, functions, styles) yields.
const PANDOC: Record<number, string> = {
  10: '\\sum\\limits_{i=1}^{n} i^{2}',
  11: '\\int_{0}^{1} x^{2}\\,dx',
  15: '\\left|\\begin{matrix} a & b \\\\ c & d \\end{matrix}\\right|',
  17: '\\sin x+\\cos^{2}\\theta=\\ln y',
  18: '\\lim_{x\\rightarrow0}\\frac{\\sin x}{x}=1',
  19: '\\hat{x}+\\vec{v}+\\bar{y}+\\tilde{z}+\\dot{w}',
  21: '\\binom{n}{k}=\\frac{n!}{k!(n-k)!}',
  23: '\\underbrace{a+b}_{\\text{sum}} \\overbrace{c+d}^{n}',
  24: 'A\\cup B\\subseteq C, x\\in\\mathbb{R}, \\forall x\\exists y',
};

describe.each(['equations.docx', 'equations-lo.docx'])('real document: %s', (name) => {
  const tex = equations(name);

  it('has every equation', () => {
    expect(tex).toHaveLength(EQUATION_COUNT);
    expect(tex.every((t) => t !== '')).toBe(true);
  });

  it('converts every equation to LaTeX that KaTeX parses', () => {
    for (const t of tex) {
      expect(() => katex.renderToString(t, { throwOnError: true }), t).not.toThrow();
    }
  });

  it('matches the expected LaTeX for the shared selection', () => {
    for (const [i, expected] of Object.entries(COMMON)) {
      expect(norm(tex[Number(i)]), `equation ${i}`).toBe(expected);
    }
  });

  it('draws them through the reader as math placeholders', () => {
    const html = renderDocxHtml(new Uint8Array(readFileSync(resolve(dir, name)))).html;
    const dom = new DOMParser().parseFromString(html, 'text/html');
    const math = [...dom.querySelectorAll('.mc-math')];
    expect(math).toHaveLength(EQUATION_COUNT);
    // Eight sit inside a sentence; the rest stand alone on their own line.
    expect(math.filter((m) => m.getAttribute('data-display') === '0')).toHaveLength(8);
    expect(math.filter((m) => m.getAttribute('data-display') === '1')).toHaveLength(21);
    expect(math.filter((m) => m.tagName === 'DIV')).toHaveLength(21);
    // No empty paragraph is left behind by a display equation.
    expect([...dom.querySelectorAll('p')].filter((p) => p.textContent === '')).toHaveLength(0);
    for (const m of math) {
      expect(() => katex.renderToString(m.textContent ?? '', { throwOnError: true })).not.toThrow();
    }
  });
});

describe('pandoc-specific markup', () => {
  const tex = equations('equations.docx');
  it('matches the expected LaTeX', () => {
    for (const [i, expected] of Object.entries(PANDOC)) {
      expect(norm(tex[Number(i)]), `equation ${i}`).toBe(expected);
    }
  });
});

describe('LibreOffice quirks', () => {
  const tex = equations('equations-lo.docx');
  it('reads plain function-name runs and operator text runs as math', () => {
    expect(tex[17]).toBe('\\sin x+\\cos^{2}\\theta=\\ln y');
    expect(tex[5]).toBe('\\alpha+\\beta\\leq\\gamma\\neq\\infty');
  });
});

describe('equations in the reader', () => {
  const M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  const run = (t: string): string => `<m:r><m:t>${t}</m:t></m:r>`;
  const inline = `<m:oMath ${M}>${run('x')}</m:oMath>`;
  const html = (body: string, opts = {}): string => renderDocxHtml(buildDocx({ body }), opts).html;

  it('draws an equation inside text as inline math', () => {
    const out = html(
      `<w:p><w:r><w:t xml:space="preserve">Let </w:t></w:r>${inline}<w:r><w:t xml:space="preserve"> be.</w:t></w:r></w:p>`,
    );
    expect(out).toContain('<p>Let <span class="mc-math" data-display="0">x</span> be.</p>');
  });

  it('draws an equation alone in its paragraph as display math', () => {
    const out = html(`<w:p>${inline}</w:p>`);
    expect(out).toContain('<div class="mc-math" data-display="1">x</div>');
    expect(out).not.toContain('<p>');
  });

  it('draws an oMathPara as display math, one block per equation', () => {
    const out = html(
      `<w:p><m:oMathPara ${M}><m:oMath>${run('a')}</m:oMath><m:oMath>${run('b')}</m:oMath></m:oMathPara></w:p>`,
    );
    expect(out).toContain(
      '<div class="mc-math" data-display="1">a</div><div class="mc-math" data-display="1">b</div>',
    );
  });

  it('keeps display math that shares a paragraph with text as a span', () => {
    const out = html(
      `<w:p><w:r><w:t>See</w:t></w:r><m:oMathPara ${M}><m:oMath>${run('x')}</m:oMath></m:oMathPara></w:p>`,
    );
    expect(out).toContain('<p>See<span class="mc-math" data-display="1">x</span></p>');
  });

  it('escapes the LaTeX it puts in markup', () => {
    const out = html(`<w:p><m:oMath ${M}>${run('a&lt;b')}</m:oMath></w:p>`);
    expect(out).toContain('>a&lt;b</div>');
  });

  it('finds equations in a table cell, a list item and a footnote-free heading', () => {
    const cell = html(`<w:tbl><w:tr><w:tc><w:p>${inline}</w:p></w:tc></w:tr></w:tbl>`);
    expect(cell).toContain('<td><div class="mc-math" data-display="1">x</div></td>');
  });

  it('shows the LaTeX as code when math is turned off', () => {
    const out = html(`<w:p>${inline}</w:p>`, { math: false });
    expect(out).toContain('<p><code>x</code></p>');
    expect(out).not.toContain('mc-math');
  });

  it('skips an equation that converts to nothing', () => {
    const out = html(`<w:p><m:oMath ${M}/></w:p>`);
    expect(out).toContain('no content to show');
  });
});
