// OMML to LaTeX, one construct at a time. Every expected string is also fed to
// KaTeX with throwOnError, because a conversion that reads well but does not
// parse would render as a red error in the preview.
import katex from 'katex';
import { describe, expect, it } from 'vitest';
import { findDeep, parseXml } from '../../src/ooxml/xnode';
import { ommlToLatex } from '../../src/docx/read/omml';

const NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

/** Convert the XML inside an `m:oMath`. */
function convert(inner: string): string {
  const root = parseXml(`<m:oMath ${NS} xmlns:w="urn:w">${inner}</m:oMath>`);
  return ommlToLatex(findDeep(root, 'oMath')!);
}

/** Assert the conversion and that KaTeX accepts the result. */
function check(inner: string, expected: string): void {
  const tex = convert(inner);
  expect(tex).toBe(expected);
  expect(() => katex.renderToString(tex, { throwOnError: true })).not.toThrow();
}

const xmlText = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const r = (t: string, pr = ''): string =>
  `<m:r>${pr ? `<m:rPr>${pr}</m:rPr>` : ''}<m:t>${xmlText(t)}</m:t></m:r>`;
const e = (inner: string): string => `<m:e>${inner}</m:e>`;
const val = (tag: string, v: string): string => `<m:${tag} m:val="${v}"/>`;

describe('runs', () => {
  it('keeps plain ASCII and maps Greek and symbols', () => {
    check(r('x+1'), 'x+1');
    check(r('αβγ'), '\\alpha\\beta\\gamma');
    check(
      r('Γ∞∂∇±×·≤≥≠≈≡'),
      '\\Gamma\\infty\\partial\\nabla\\pm\\times\\cdot\\leq\\geq\\neq\\approx\\equiv',
    );
    check(
      r('⊂⊆∈∀∃→⇒↔…'),
      '\\subset\\subseteq\\in\\forall\\exists\\rightarrow\\Rightarrow\\leftrightarrow\\ldots',
    );
  });

  it('separates a command from a following letter', () => {
    check(r('α') + r('x'), '\\alpha x');
  });

  it('escapes LaTeX specials', () => {
    check(r('#$%&_{}'), '\\#\\$\\%\\&\\_\\{\\}');
    check(r('a~b'), 'a\\sim b');
    check(r('a^b'), 'a\\text{\\textasciicircum}b');
    check(r('a\\b'), 'a\\backslash b');
  });

  it('writes normal text with \\text and escapes inside it', () => {
    check(r('if x', '<m:nor/>'), '\\text{if x}');
    check(r('50% & #1', '<m:nor/>'), '\\text{50\\% \\& \\#1}');
    check(r('a_b~c', '<m:nor/>'), '\\text{a\\_b\\textasciitilde c}');
  });

  it('treats a normal-text operator with no letters as a math symbol', () => {
    check(r('=', '<m:nor/>'), '=');
  });

  it('applies run styles', () => {
    check(r('d', val('sty', 'p')), '\\mathrm{d}');
    check(r('v', val('sty', 'b')), '\\mathbf{v}');
    check(r('R', val('scr', 'double-struck')), '\\mathbb{R}');
    check(r('A', val('scr', 'script')), '\\mathcal{A}');
    check(r('2', val('sty', 'p')), '2');
  });

  it('bolds Greek and digit runs, not only ASCII letters', () => {
    const cls = (tex: string): string[] =>
      katex
        .renderToString(tex, { throwOnError: true, output: 'html' })
        .match(/mathbf|boldsymbol|mathnormal/g) ?? [];
    check(r('α', val('sty', 'bi')), '\\boldsymbol{\\alpha}');
    expect(cls(convert(r('α', val('sty', 'bi'))))).toEqual(['boldsymbol']);
    check(r('α', val('sty', 'b')), '\\boldsymbol{\\alpha}');
    check(r('Γ', val('sty', 'b')), '\\boldsymbol{\\Gamma}');
    check(r('2', val('sty', 'b')), '\\mathbf{2}');
    expect(cls(convert(r('2', val('sty', 'b'))))).toEqual(['mathbf']);
    check(r('2', val('sty', 'bi')), '\\boldsymbol{2}');
    check(r('2', val('sty', 'p')), '2');
    check(r('α', val('sty', 'p')), '\\alpha');
  });

  it('maps mathematical alphanumerics', () => {
    check(r('\u{1d405}'), '\\mathbf{F}');
    check(r('\u{1d465}'), 'x');
    check(r('ℝ'), '\\mathbb{R}');
  });

  it('reads a run that is a function name as the function', () => {
    check(r('sin', val('sty', 'p')) + r('x'), '\\sin x');
    check(r('ln') + r('y'), '\\ln y');
  });
});

describe('fractions and scripts', () => {
  it('fraction', () => {
    check(`<m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`, '\\frac{a}{b}');
  });

  it('linear and skewed fractions', () => {
    for (const type of ['lin', 'skw']) {
      check(
        `<m:f><m:fPr>${val('type', type)}</m:fPr><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`,
        'a/b',
      );
    }
    check(
      `<m:f><m:fPr>${val('type', 'lin')}</m:fPr><m:num>${r('a+b')}</m:num><m:den>${r('c')}</m:den></m:f>`,
      '{a+b}/c',
    );
  });

  it('fraction without a bar', () => {
    check(
      `<m:f><m:fPr>${val('type', 'noBar')}</m:fPr><m:num>${r('n')}</m:num><m:den>${r('k')}</m:den></m:f>`,
      '\\genfrac{}{}{0pt}{}{n}{k}',
    );
  });

  it('subscript, superscript, both', () => {
    check(`<m:sSub>${e(r('x'))}<m:sub>${r('i')}</m:sub></m:sSub>`, 'x_{i}');
    check(`<m:sSup>${e(r('x'))}<m:sup>${r('2')}</m:sup></m:sSup>`, 'x^{2}');
    check(
      `<m:sSubSup>${e(r('x'))}<m:sub>${r('i')}</m:sub><m:sup>${r('2')}</m:sup></m:sSubSup>`,
      'x_{i}^{2}',
    );
  });

  it('braces a multi-token base', () => {
    check(`<m:sSup>${e(r('a+b'))}<m:sup>${r('2')}</m:sup></m:sSup>`, '{a+b}^{2}');
    check(`<m:sSup>${e('')}<m:sup>${r('2')}</m:sup></m:sSup>`, '{}^{2}');
  });

  it('prescripts', () => {
    check(
      `<m:sPre><m:sub>${r('1')}</m:sub><m:sup>${r('2')}</m:sup>${e(r('X'))}</m:sPre>`,
      '{}_{1}^{2}X',
    );
  });
});

describe('radicals', () => {
  it('square root', () => {
    check(
      `<m:rad><m:radPr>${val('degHide', '1')}</m:radPr><m:deg/>${e(r('x'))}</m:rad>`,
      '\\sqrt{x}',
    );
    check(`<m:rad><m:deg/>${e(r('x'))}</m:rad>`, '\\sqrt{x}');
  });

  it('nth root', () => {
    check(`<m:rad><m:deg>${r('3')}</m:deg>${e(r('x'))}</m:rad>`, '\\sqrt[3]{x}');
  });

  it('ignores a degree that is marked hidden', () => {
    check(
      `<m:rad><m:radPr>${val('degHide', '1')}</m:radPr><m:deg>${r('3')}</m:deg>${e(r('x'))}</m:rad>`,
      '\\sqrt{x}',
    );
  });
});

describe('n-ary operators', () => {
  const nary = (
    chr: string | undefined,
    pr: string,
    sub: string,
    sup: string,
    body: string,
  ): string =>
    `<m:nary><m:naryPr>${chr === undefined ? '' : val('chr', chr)}${pr}</m:naryPr>` +
    `<m:sub>${sub}</m:sub><m:sup>${sup}</m:sup>${e(body)}</m:nary>`;

  it('defaults to an integral', () => {
    check(nary(undefined, '', r('0'), r('1'), r('x')), '\\int_{0}^{1} x');
  });

  it('maps the common operators', () => {
    const cases: [string, string][] = [
      ['∑', '\\sum'],
      ['∏', '\\prod'],
      ['∐', '\\coprod'],
      ['∫', '\\int'],
      ['∬', '\\iint'],
      ['∭', '\\iiint'],
      ['∮', '\\oint'],
      ['⋃', '\\bigcup'],
      ['⋂', '\\bigcap'],
    ];
    for (const [chr, cmd] of cases) {
      check(nary(chr, '', '', '', r('x')), `${cmd} x`);
    }
  });

  it('places limits', () => {
    check(
      nary('∑', val('limLoc', 'undOvr'), r('i=1'), r('n'), r('i')),
      '\\sum\\limits_{i=1}^{n} i',
    );
    check(
      nary('∑', val('limLoc', 'subSup'), r('i=1'), r('n'), r('i')),
      '\\sum\\nolimits_{i=1}^{n} i',
    );
    check(nary('∫', val('limLoc', 'subSup'), r('a'), r('b'), r('f')), '\\int_{a}^{b} f');
  });

  it('hides a limit', () => {
    check(nary('∑', val('supHide', '1'), r('i'), r('n'), r('i')), '\\sum_{i} i');
    check(nary('∑', val('subHide', '1') + val('supHide', '1'), r('i'), r('n'), r('i')), '\\sum i');
  });

  it('drops an empty limit', () => {
    check(nary('∑', '', r('i'), '', r('i')), '\\sum_{i} i');
  });
});

describe('delimiters', () => {
  const d = (pr: string, ...items: string[]): string =>
    `<m:d>${pr ? `<m:dPr>${pr}</m:dPr>` : ''}${items.map(e).join('')}</m:d>`;

  it('defaults to parentheses', () => {
    check(d('', r('x')), '\\left(x\\right)');
  });

  it('uses the named characters', () => {
    check(d(val('begChr', '[') + val('endChr', ']'), r('x')), '\\left[x\\right]');
    check(d(val('begChr', '{') + val('endChr', '}'), r('x')), '\\left\\{x\\right\\}');
    check(d(val('begChr', '|') + val('endChr', '|'), r('x')), '\\left|x\\right|');
    check(d(val('begChr', '⟨') + val('endChr', '⟩'), r('x')), '\\left\\langle x\\right\\rangle');
    check(d(val('begChr', '⌊') + val('endChr', '⌋'), r('x')), '\\left\\lfloor x\\right\\rfloor');
  });

  it('writes an empty character as an invisible delimiter', () => {
    check(d(val('begChr', '{') + val('endChr', ''), r('x')), '\\left\\{x\\right.');
    check(d(val('begChr', '') + val('endChr', ')'), r('x')), '\\left.x\\right)');
  });

  it('joins items with the separator', () => {
    check(d(val('sepChr', ','), r('a'), r('b'), r('c')), '\\left(a,b,c\\right)');
    check(d(val('sepChr', '|'), r('a'), r('b')), '\\left(a\\middle|b\\right)');
    check(d(val('sepChr', ''), r('a'), r('b')), '\\left(ab\\right)');
  });

  it('reads a stacked pair in parentheses as a binomial', () => {
    const f = `<m:f><m:fPr>${val('type', 'noBar')}</m:fPr><m:num>${r('n')}</m:num><m:den>${r('k')}</m:den></m:f>`;
    check(d('', f), '\\binom{n}{k}');
  });

  it('reads a brace around a matrix as cases', () => {
    const m = `<m:m><m:mr>${e(r('x'))}${e(r('x>0'))}</m:mr><m:mr>${e(r('0'))}${e(r('else'))}</m:mr></m:m>`;
    check(
      d(val('begChr', '{') + val('endChr', ''), m),
      '\\begin{cases} x & x>0 \\\\ 0 & else \\end{cases}',
    );
  });
});

describe('matrices and arrays', () => {
  it('matrix', () => {
    check(
      `<m:m><m:mr>${e(r('a'))}${e(r('b'))}</m:mr><m:mr>${e(r('c'))}${e(r('d'))}</m:mr></m:m>`,
      '\\begin{matrix} a & b \\\\ c & d \\end{matrix}',
    );
  });

  it('matrix inside delimiters is wrapped by them', () => {
    check(
      `<m:d>${e(`<m:m><m:mr>${e(r('1'))}${e(r('0'))}</m:mr></m:m>`)}</m:d>`,
      '\\left(\\begin{matrix} 1 & 0 \\end{matrix}\\right)',
    );
  });

  it('equation array without alignment is one row per line', () => {
    check(
      `<m:eqArr>${e(r('a'))}${e(r('b'))}</m:eqArr>`,
      '\\begin{gathered} a \\\\ b \\end{gathered}',
    );
  });

  it('equation array with alignment points', () => {
    check(
      `<m:eqArr>${e(r('a') + r('=', '<m:aln/>') + r('b'))}${e(r('c') + r('=', '<m:aln/>') + r('d'))}</m:eqArr>`,
      '\\begin{aligned} a&=b \\\\ c&=d \\end{aligned}',
    );
  });

  it('treats a literal ampersand in an equation array as an alignment point', () => {
    check(
      `<m:eqArr>${e(r('a') + r('&') + r('=') + r('b'))}</m:eqArr>`,
      '\\begin{aligned} a&=b \\end{aligned}',
    );
  });
});

describe('functions and limits', () => {
  const func = (name: string, body: string): string =>
    `<m:func><m:fName>${r(name)}</m:fName>${e(body)}</m:func>`;

  it('maps known names', () => {
    for (const n of ['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'det', 'max', 'min']) {
      check(func(n, r('x')), `\\${n} x`);
    }
  });

  it('uses \\operatorname for anything else', () => {
    check(func('sgn', r('x')), '\\operatorname{sgn} x');
  });

  it('lim with a lower limit', () => {
    check(
      `<m:limLow>${e(r('lim'))}<m:lim>${r('x→0')}</m:lim></m:limLow>`,
      '\\lim_{x\\rightarrow0}',
    );
    check(`<m:limLow>${e(r('max'))}<m:lim>${r('x')}</m:lim></m:limLow>`, '\\max_{x}');
  });

  it('other lower and upper limits', () => {
    check(`<m:limLow>${e(r('x'))}<m:lim>${r('n')}</m:lim></m:limLow>`, '\\underset{n}{x}');
    check(`<m:limUpp>${e(r('x'))}<m:lim>${r('n')}</m:lim></m:limUpp>`, '\\overset{n}{x}');
  });

  it('limit whose "limit" is a brace character', () => {
    check(`<m:limLow>${e(r('a+b'))}<m:lim>${r('⏟')}</m:lim></m:limLow>`, '\\underbrace{a+b}');
    check(`<m:limUpp>${e(r('a+b'))}<m:lim>${r('⏞')}</m:lim></m:limUpp>`, '\\overbrace{a+b}');
  });
});

describe('accents, bars, groups, boxes', () => {
  const acc = (chr: string, body: string): string =>
    `<m:acc><m:accPr>${val('chr', chr)}</m:accPr>${e(body)}</m:acc>`;

  it('accents by character', () => {
    const cases: [string, string][] = [
      ['̂', 'hat'],
      ['̌', 'check'],
      ['̃', 'tilde'],
      ['̄', 'bar'],
      ['̇', 'dot'],
      ['̈', 'ddot'],
      ['⃗', 'vec'],
      ['̆', 'breve'],
      ['̀', 'grave'],
      ['́', 'acute'],
    ];
    for (const [chr, cmd] of cases) {
      check(acc(chr, r('x')), `\\${cmd}{x}`);
    }
  });

  it('defaults to a hat and widens it over several symbols', () => {
    check(`<m:acc>${e(r('x'))}</m:acc>`, '\\hat{x}');
    check(acc('̂', r('xy')), '\\widehat{xy}');
    check(acc('̃', r('xy')), '\\widetilde{xy}');
  });

  it('bars', () => {
    check(`<m:bar><m:barPr>${val('pos', 'top')}</m:barPr>${e(r('AB'))}</m:bar>`, '\\overline{AB}');
    check(`<m:bar><m:barPr>${val('pos', 'bot')}</m:barPr>${e(r('AB'))}</m:bar>`, '\\underline{AB}');
  });

  it('group characters', () => {
    const g = (chr: string, pos: string): string =>
      `<m:groupChr><m:groupChrPr>${val('chr', chr)}${val('pos', pos)}</m:groupChrPr>${e(r('a+b'))}</m:groupChr>`;
    check(g('⏟', 'bot'), '\\underbrace{a+b}');
    check(g('⏞', 'top'), '\\overbrace{a+b}');
  });

  it('attaches a label to a brace', () => {
    const brace = `<m:groupChr><m:groupChrPr>${val('chr', '⏞')}${val('pos', 'top')}</m:groupChrPr>${e(r('c'))}</m:groupChr>`;
    check(`<m:limUpp>${e(brace)}<m:lim>${r('n')}</m:lim></m:limUpp>`, '\\overbrace{c}^{n}');
  });

  it('boxes and phantoms', () => {
    check(`<m:box>${e(r('x'))}</m:box>`, 'x');
    check(`<m:borderBox>${e(r('x'))}</m:borderBox>`, '\\boxed{x}');
    check(`<m:phant>${e(r('x'))}</m:phant>`, 'x');
    check(
      `<m:phant><m:phantPr>${val('show', '0')}</m:phantPr>${e(r('x'))}</m:phant>`,
      '\\phantom{x}',
    );
  });
});

describe('robustness', () => {
  it('converts the children of an unknown element', () => {
    expect(convert(`<m:mystery>${r('x')}${r('y')}</m:mystery>`)).toBe('xy');
  });

  it('ignores property elements and an empty equation', () => {
    expect(convert('<m:ctrlPr><w:rPr/></m:ctrlPr>')).toBe('');
    expect(convert('')).toBe('');
  });

  it('survives absurd nesting without throwing', () => {
    const depth = 300;
    const xml = `${'<m:sSup><m:e>'.repeat(depth)}${r('x')}${'</m:e><m:sup/></m:sSup>'.repeat(depth)}`;
    expect(() => convert(xml)).not.toThrow();
  });

  it('caps the work done on a huge equation', () => {
    const xml = r('x').repeat(40_000);
    expect(convert(xml).length).toBeLessThan(40_000);
  });

  it('drops a result longer than the cap rather than cutting it', () => {
    const xml = `<m:r><m:t>${'a'.repeat(120_000)}</m:t></m:r>`;
    expect(convert(xml)).toBe('');
  });
});

describe('equation size limits', () => {
  it('rejects one oversized text node without converting it', () => {
    expect(convert(r('x'.repeat(100_001)))).toBe('');
    expect(convert(r('x'.repeat(100_000)))).not.toBe('');
  });

  it('counts text across runs toward the same limit', () => {
    expect(convert(r('x'.repeat(60_000)) + r('y'.repeat(60_000)))).toBe('');
  });

  it('converts a large allowed run in linear time', () => {
    const time = (n: number): number => {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const start = performance.now();
        const tex = convert(r('x'.repeat(n)));
        best = Math.min(best, performance.now() - start);
        expect(tex).toHaveLength(n);
      }
      return best;
    };
    // Four times the text should cost about four times as much; a quadratic
    // conversion costs sixteen. The floor keeps timer noise from deciding it.
    expect(time(100_000)).toBeLessThan(10 * Math.max(time(25_000), 10));
  });

  it('still separates a command from a following letter after long output', () => {
    check(r('x'.repeat(500)) + r('α') + r('y'), `${'x'.repeat(500)}\\alpha y`);
  });
});
