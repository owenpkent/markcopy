// Office Math Markup Language (OMML) to LaTeX.
//
// Word stores an equation as `m:oMath` (inline) or `m:oMathPara` (display)
// elements. The preview already renders LaTeX through KaTeX for Markdown math,
// so the cheapest faithful route is to translate OMML into the LaTeX KaTeX
// understands and let that pipeline (rendering, copy as LaTeX, copy as PNG)
// take over.
//
// Pure and DOM free: it reads the small XNode tree built from the document
// part. Namespace prefixes are already stripped, so `m:r` and `w:r` are both
// `r`; that is harmless here because the converter only ever walks the inside
// of an `m:oMath`, where every `r` is a math run. Unknown elements fall back to
// converting their children, and nothing here throws: a crafted file can cost
// an empty result, never the document.
import { attr } from '../../ooxml/xml';
import { child, children, findAll, type XNode } from '../../ooxml/xnode';

/** Deeper than any real equation nests; beyond it the subtree is dropped. */
const MAX_DEPTH = 48;
/** Elements visited per equation, so a hostile file cannot burn unbounded time. */
const MAX_NODES = 20_000;
/** Longest LaTeX string returned; a longer result is dropped rather than cut mid-command. */
const MAX_LENGTH = 100_000;

const GREEK: Record<string, string> = {
  α: '\\alpha',
  β: '\\beta',
  γ: '\\gamma',
  δ: '\\delta',
  ε: '\\varepsilon',
  ϵ: '\\epsilon',
  ζ: '\\zeta',
  η: '\\eta',
  θ: '\\theta',
  ϑ: '\\vartheta',
  ι: '\\iota',
  κ: '\\kappa',
  ϰ: '\\varkappa',
  λ: '\\lambda',
  μ: '\\mu',
  ν: '\\nu',
  ξ: '\\xi',
  ο: 'o',
  π: '\\pi',
  ϖ: '\\varpi',
  ρ: '\\rho',
  ϱ: '\\varrho',
  σ: '\\sigma',
  ς: '\\varsigma',
  τ: '\\tau',
  υ: '\\upsilon',
  ϕ: '\\phi',
  φ: '\\varphi',
  χ: '\\chi',
  ψ: '\\psi',
  ω: '\\omega',
  Α: 'A',
  Β: 'B',
  Γ: '\\Gamma',
  Δ: '\\Delta',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Θ: '\\Theta',
  Ι: 'I',
  Κ: 'K',
  Λ: '\\Lambda',
  Μ: 'M',
  Ν: 'N',
  Ξ: '\\Xi',
  Ο: 'O',
  Π: '\\Pi',
  Ρ: 'P',
  Σ: '\\Sigma',
  Τ: 'T',
  Υ: '\\Upsilon',
  Φ: '\\Phi',
  Χ: 'X',
  Ψ: '\\Psi',
  Ω: '\\Omega',
};

const SYMBOLS: Record<string, string> = {
  '∞': '\\infty',
  '∂': '\\partial',
  '∇': '\\nabla',
  '±': '\\pm',
  '∓': '\\mp',
  '×': '\\times',
  '÷': '\\div',
  '·': '\\cdot',
  '⋅': '\\cdot',
  '∙': '\\cdot',
  '∗': '\\ast',
  '⋆': '\\star',
  '∘': '\\circ',
  '∼': '\\sim',
  '≃': '\\simeq',
  '≅': '\\cong',
  '≈': '\\approx',
  '≡': '\\equiv',
  '≠': '\\neq',
  '≤': '\\leq',
  '≥': '\\geq',
  '≦': '\\leqq',
  '≧': '\\geqq',
  '≪': '\\ll',
  '≫': '\\gg',
  '∝': '\\propto',
  '≺': '\\prec',
  '≻': '\\succ',
  '⊂': '\\subset',
  '⊃': '\\supset',
  '⊆': '\\subseteq',
  '⊇': '\\supseteq',
  '⊄': '\\not\\subset',
  '∈': '\\in',
  '∉': '\\notin',
  '∋': '\\ni',
  '∀': '\\forall',
  '∃': '\\exists',
  '∄': '\\nexists',
  '∅': '\\emptyset',
  '∧': '\\wedge',
  '∨': '\\vee',
  '¬': '\\neg',
  '∩': '\\cap',
  '∪': '\\cup',
  '⊕': '\\oplus',
  '⊗': '\\otimes',
  '⊙': '\\odot',
  '⊥': '\\perp',
  '∥': '\\parallel',
  '∣': '\\mid',
  '∠': '\\angle',
  '∴': '\\therefore',
  '∵': '\\because',
  '∖': '\\setminus',
  '⊢': '\\vdash',
  '⊨': '\\models',
  '→': '\\rightarrow',
  '←': '\\leftarrow',
  '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow',
  '⇐': '\\Leftarrow',
  '⇔': '\\Leftrightarrow',
  '↦': '\\mapsto',
  '↑': '\\uparrow',
  '↓': '\\downarrow',
  '⟶': '\\longrightarrow',
  '⟵': '\\longleftarrow',
  '⟹': '\\Longrightarrow',
  '⟸': '\\Longleftarrow',
  '⟺': '\\Longleftrightarrow',
  '…': '\\ldots',
  '⋯': '\\cdots',
  '⋮': '\\vdots',
  '⋱': '\\ddots',
  '′': "'",
  '″': "''",
  '°': '^\\circ',
  ℏ: '\\hbar',
  ℓ: '\\ell',
  ℵ: '\\aleph',
  ℜ: '\\Re',
  ℑ: '\\Im',
  '√': '\\surd',
  '∑': '\\sum',
  '∏': '\\prod',
  '∐': '\\coprod',
  '∫': '\\int',
  '∬': '\\iint',
  '∭': '\\iiint',
  '∮': '\\oint',
  '⟨': '\\langle',
  '⟩': '\\rangle',
  '⌈': '\\lceil',
  '⌉': '\\rceil',
  '⌊': '\\lfloor',
  '⌋': '\\rfloor',
  '‖': '\\|',
  '−': '-',
  '‐': '-',
  '–': '-',
  ' ': '\\ ',
  ' ': '\\ ',
  ' ': '\\,',
  ' ': '\\quad ',
  ℝ: '\\mathbb{R}',
  ℕ: '\\mathbb{N}',
  ℤ: '\\mathbb{Z}',
  ℚ: '\\mathbb{Q}',
  ℂ: '\\mathbb{C}',
  ℙ: '\\mathbb{P}',
  ℎ: 'h',
};

// ASCII characters that mean something to LaTeX and must be escaped in math.
const ASCII_MATH: Record<string, string> = {
  '#': '\\#',
  $: '\\$',
  '%': '\\%',
  '&': '\\&',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\sim',
  '^': '\\text{\\textasciicircum}',
  '\\': '\\backslash',
};

// The same set inside `\text{}`, where the math commands do not exist.
const ASCII_TEXT: Record<string, string> = {
  '#': '\\#',
  $: '\\$',
  '%': '\\%',
  '&': '\\&',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde ',
  '^': '\\textasciicircum ',
  '\\': '\\textbackslash ',
};

// Mathematical Alphanumeric Symbols, in the order Unicode lays them out: each
// style is 26 capitals then 26 lowercase letters.
const MATH_ALPHA: (string | undefined)[] = [
  '\\mathbf',
  undefined, // italic: KaTeX's default for a letter
  '\\boldsymbol',
  '\\mathcal',
  '\\mathcal',
  '\\mathfrak',
  '\\mathbb',
  '\\mathfrak',
  '\\mathsf',
  '\\mathsf',
  '\\mathsf',
  '\\mathsf',
  '\\mathtt',
];

// `m:scr` letterforms: Word's double-struck, script, fraktur and so on.
const SCRIPT_STYLES: Record<string, string> = {
  script: '\\mathcal',
  fraktur: '\\mathfrak',
  'double-struck': '\\mathbb',
  'sans-serif': '\\mathsf',
  monospace: '\\mathtt',
};

const FUNCTIONS = new Set([
  'sin',
  'cos',
  'tan',
  'cot',
  'sec',
  'csc',
  'arcsin',
  'arccos',
  'arctan',
  'sinh',
  'cosh',
  'tanh',
  'coth',
  'log',
  'ln',
  'lg',
  'exp',
  'lim',
  'limsup',
  'liminf',
  'max',
  'min',
  'sup',
  'inf',
  'det',
  'dim',
  'ker',
  'deg',
  'gcd',
  'hom',
  'arg',
  'Pr',
]);

// Names whose limits sit under the name, as `\lim_{x \to 0}` does.
const LIMIT_NAMES = new Set(['lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'det', 'gcd']);

const NARY: Record<string, string> = {
  '∑': '\\sum',
  '∏': '\\prod',
  '∐': '\\coprod',
  '∫': '\\int',
  '∬': '\\iint',
  '∭': '\\iiint',
  '∮': '\\oint',
  '∯': '\\oiint',
  '∰': '\\oiiint',
  '⋃': '\\bigcup',
  '⋂': '\\bigcap',
  '⋁': '\\bigvee',
  '⋀': '\\bigwedge',
  '⨁': '\\bigoplus',
  '⨂': '\\bigotimes',
  '⨀': '\\bigodot',
  '⨄': '\\biguplus',
  '⨆': '\\bigsqcup',
};

// Operators TeX sets with limits above and below in display style, which is
// where an explicit "subscript and superscript" placement has to be forced.
const LIMIT_OPERATORS = new Set([
  '\\sum',
  '\\prod',
  '\\coprod',
  '\\bigcup',
  '\\bigcap',
  '\\bigvee',
  '\\bigwedge',
  '\\bigoplus',
  '\\bigotimes',
  '\\bigodot',
  '\\biguplus',
  '\\bigsqcup',
]);

const DELIMS: Record<string, string> = {
  '(': '(',
  ')': ')',
  '[': '[',
  ']': ']',
  '{': '\\{',
  '}': '\\}',
  '|': '|',
  '‖': '\\|',
  '∣': '|',
  '⟨': '\\langle',
  '⟩': '\\rangle',
  '〈': '\\langle',
  '〉': '\\rangle',
  '⌈': '\\lceil',
  '⌉': '\\rceil',
  '⌊': '\\lfloor',
  '⌋': '\\rfloor',
  '<': '\\langle',
  '>': '\\rangle',
  '/': '/',
  '\\': '\\backslash',
  '⟦': '\\lBrack',
  '⟧': '\\rBrack',
};

// Accents by combining mark, spacing mark, or the arrow Word uses for a vector.
const ACCENTS: Record<string, string> = {
  '̂': 'hat',
  '^': 'hat',
  '̌': 'check',
  ˇ: 'check',
  '̃': 'tilde',
  '~': 'tilde',
  '̄': 'bar',
  '¯': 'bar',
  '‾': 'bar',
  '̅': 'bar',
  '̇': 'dot',
  '˙': 'dot',
  '̈': 'ddot',
  '¨': 'ddot',
  '⃛': 'dddot',
  '⃗': 'vec',
  '→': 'vec',
  '̆': 'breve',
  '˘': 'breve',
  '̀': 'grave',
  '`': 'grave',
  '́': 'acute',
  '´': 'acute',
  '̊': 'mathring',
  '˚': 'mathring',
};

const WIDE: Record<string, string> = {
  hat: '\\widehat',
  tilde: '\\widetilde',
  bar: '\\overline',
  vec: '\\overrightarrow',
};

/** True for an OMML on/off value: absent means on, as it does for `<m:nor/>`. */
function on(node: XNode | undefined): boolean {
  if (node === undefined) {
    return false;
  }
  const v = attr(node.attrs, 'val');
  return v === undefined || ['1', 'on', 'true'].includes(v);
}

/** A single TeX token (one character or one command) can be used as a script base unbraced. */
function isAtom(s: string): boolean {
  return /^(\\[A-Za-z]+|[^\\{}])$/.test(s);
}

function grp(s: string): string {
  return s === '' ? '{}' : isAtom(s) ? s : `{${s}}`;
}

/** Concatenate, adding the space that stops `\alpha` fusing with a following letter. */
function cat(parts: string[]): string {
  let out = '';
  for (const p of parts) {
    if (p === '') {
      continue;
    }
    if (/(?<!\\)\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(p)) {
      out += ' ';
    }
    out += p;
  }
  return out;
}

function mathAlpha(cp: number): string | undefined {
  if (cp < 0x1d400 || cp > 0x1d6a3) {
    return undefined;
  }
  const style = Math.floor((cp - 0x1d400) / 52);
  const idx = (cp - 0x1d400) % 52;
  const letter = String.fromCharCode(idx < 26 ? 65 + idx : 97 + idx - 26);
  const cmd = MATH_ALPHA[style];
  return cmd === undefined ? letter : `${cmd}{${letter}}`;
}

/** One character of math-mode text as LaTeX. */
function mathChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    ASCII_MATH[ch] ??
    GREEK[ch] ??
    SYMBOLS[ch] ??
    mathAlpha(cp) ??
    (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ? '' : ch)
  );
}

function fractionType(f: XNode): string | undefined {
  const fPr = child(f, 'fPr');
  return fPr && attr(child(fPr, 'type')?.attrs ?? {}, 'val');
}

class Converter {
  private nodes = 0;
  /** Inside an equation array, a literal `&` in a run is an alignment point. */
  private eqDepth = 0;

  convert(n: XNode, depth: number): string {
    if (depth > MAX_DEPTH || ++this.nodes > MAX_NODES) {
      return '';
    }
    switch (n.name) {
      case 'r':
        return this.run(n);
      case 'f':
        return this.fraction(n, depth);
      case 'sSub':
        return this.script(n, depth, true, false);
      case 'sSup':
        return this.script(n, depth, false, true);
      case 'sSubSup':
        return this.script(n, depth, true, true);
      case 'sPre':
        return this.preScript(n, depth);
      case 'rad':
        return this.radical(n, depth);
      case 'nary':
        return this.nary(n, depth);
      case 'd':
        return this.delimiter(n, depth);
      case 'm':
        return this.matrix(n, depth);
      case 'eqArr':
        return this.eqArray(n, depth);
      case 'func':
        return this.func(n, depth);
      case 'acc':
        return this.accent(n, depth);
      case 'bar':
        return this.bar(n, depth);
      case 'limLow':
        return this.limit(n, depth, false);
      case 'limUpp':
        return this.limit(n, depth, true);
      case 'groupChr':
        return this.groupChr(n, depth);
      case 'borderBox':
        return `\\boxed{${this.part(n, 'e', depth)}}`;
      case 'phant':
        return this.phantom(n, depth);
      default:
        // Property elements (`fPr`, `ctrlPr`, `rPr`, ...) carry no content.
        if (n.name.endsWith('Pr')) {
          return '';
        }
        // `box`, `e`, `num`, `oMath`, and anything unknown: just the children.
        return this.kids(n, depth);
    }
  }

  kids(n: XNode, depth: number): string {
    return cat(n.children.map((c) => this.convert(c, depth + 1)));
  }

  /** The converted content of a named child, or '' when it is absent. */
  part(n: XNode, name: string, depth: number): string {
    const c = child(n, name);
    return c === undefined ? '' : this.kids(c, depth + 1);
  }

  private run(r: XNode): string {
    const rPr = child(r, 'rPr');
    let text = '';
    for (const c of r.children) {
      if (c.name === 't') {
        text += c.text;
      }
    }
    // `m:aln` marks an alignment point; inside an equation array it becomes `&`.
    const align = rPr !== undefined && child(rPr, 'aln') !== undefined ? '&' : '';
    if (text === '') {
      return align;
    }
    const sty = rPr && attr(child(rPr, 'sty')?.attrs ?? {}, 'val');
    const scr = rPr && attr(child(rPr, 'scr')?.attrs ?? {}, 'val');
    // Some writers (LibreOffice) mark every operator as normal text; with no
    // letter or digit in it, that is just math symbols, not words.
    if (rPr !== undefined && on(child(rPr, 'nor')) && /[\p{L}\p{N}]/u.test(text)) {
      return align + this.plainText(text, sty);
    }
    // A run that is exactly a function name is that function, whether it is
    // upright by style (pandoc) or was written as a plain run (LibreOffice).
    if ((sty === undefined || sty === 'p') && scr === undefined && FUNCTIONS.has(text.trim())) {
      return `${align}\\${text.trim()}`;
    }
    const body = cat(
      Array.from(text, (ch) => (ch === '&' && this.eqDepth > 0 ? '&' : mathChar(ch))),
    );
    if (body === '') {
      return align;
    }
    // Word shows a letter italic unless its style asks otherwise.
    const hasLetter = /[A-Za-z]/.test(text);
    let wrapped = body;
    const family = scr === undefined ? undefined : SCRIPT_STYLES[scr];
    if (family !== undefined && hasLetter) {
      wrapped = `${family}{${body}}`;
    } else if (sty === 'p' && hasLetter) {
      wrapped = `\\mathrm{${body}}`;
    } else if (sty === 'b' && hasLetter) {
      wrapped = `\\mathbf{${body}}`;
    } else if (sty === 'bi' && hasLetter) {
      wrapped = `\\boldsymbol{${body}}`;
    }
    return align + wrapped;
  }

  /** Normal (non-math) text: `\text`, with LaTeX specials escaped. */
  private plainText(text: string, sty: string | undefined): string {
    const escaped = Array.from(text, (ch) => ASCII_TEXT[ch] ?? ch)
      .join('')
      .replace(/\s+/g, ' ');
    if (escaped.trim() === '') {
      return '\\ ';
    }
    const cmd =
      sty === 'b' ? '\\textbf' : sty === 'bi' ? '\\textbf' : sty === 'i' ? '\\textit' : '\\text';
    return `${cmd}{${escaped}}`;
  }

  /** The text of a run-only subtree, or undefined when it holds anything structural. */
  private plainOf(n: XNode | undefined): string | undefined {
    if (n === undefined) {
      return undefined;
    }
    let text = '';
    for (const c of n.children) {
      if (c.name === 'r') {
        for (const t of children(c, 't')) {
          text += t.text;
        }
      } else if (!c.name.endsWith('Pr')) {
        return undefined;
      }
    }
    return text.trim();
  }

  private fraction(n: XNode, depth: number): string {
    const num = this.part(n, 'num', depth);
    const den = this.part(n, 'den', depth);
    switch (fractionType(n)) {
      case 'lin':
      case 'skw':
        return `${grp(num)}/${grp(den)}`;
      case 'noBar':
        return `\\genfrac{}{}{0pt}{}{${num}}{${den}}`;
      default:
        return `\\frac{${num}}{${den}}`;
    }
  }

  private script(n: XNode, depth: number, sub: boolean, sup: boolean): string {
    const base = this.part(n, 'e', depth);
    let out = grp(base);
    if (sub) {
      const s = this.part(n, 'sub', depth);
      out += s === '' ? '' : `_{${s}}`;
    }
    if (sup) {
      const s = this.part(n, 'sup', depth);
      out += s === '' ? '' : `^{${s}}`;
    }
    return out;
  }

  private preScript(n: XNode, depth: number): string {
    const sub = this.part(n, 'sub', depth);
    const sup = this.part(n, 'sup', depth);
    const pre = `{}${sub === '' ? '' : `_{${sub}}`}${sup === '' ? '' : `^{${sup}}`}`;
    return cat([pre, this.part(n, 'e', depth)]);
  }

  private radical(n: XNode, depth: number): string {
    const body = this.part(n, 'e', depth);
    const pr = child(n, 'radPr');
    const hidden = on(pr && child(pr, 'degHide'));
    const deg = hidden ? '' : this.part(n, 'deg', depth);
    return deg === '' ? `\\sqrt{${body}}` : `\\sqrt[${deg}]{${body}}`;
  }

  private nary(n: XNode, depth: number): string {
    const pr = child(n, 'naryPr');
    const chrNode = pr && child(pr, 'chr');
    const chr = chrNode === undefined ? '∫' : (attr(chrNode.attrs, 'val') ?? '∫');
    let op = NARY[chr] ?? (chr === '' ? '\\mathop{}' : `\\mathop{${mathChar(chr)}}`);
    const loc = pr && attr(child(pr, 'limLoc')?.attrs ?? {}, 'val');
    if (loc === 'undOvr') {
      op += '\\limits';
    } else if (loc === 'subSup' && LIMIT_OPERATORS.has(op)) {
      op += '\\nolimits';
    }
    const sub = on(pr && child(pr, 'subHide')) ? '' : this.part(n, 'sub', depth);
    const sup = on(pr && child(pr, 'supHide')) ? '' : this.part(n, 'sup', depth);
    if (sub !== '') {
      op += `_{${sub}}`;
    }
    if (sup !== '') {
      op += `^{${sup}}`;
    }
    const body = this.part(n, 'e', depth);
    return body === '' ? op : `${op} ${body}`;
  }

  private delimiter(n: XNode, depth: number): string {
    const pr = child(n, 'dPr');
    const chr = (name: string, dflt: string): string => {
      const node = pr && child(pr, name);
      return node === undefined ? dflt : (attr(node.attrs, 'val') ?? dflt);
    };
    const open = chr('begChr', '(');
    const close = chr('endChr', ')');
    const sep = chr('sepChr', '|');
    const items = children(n, 'e').map((e) => this.kids(e, depth + 1));

    // A two-part stack in parentheses is the binomial coefficient.
    if (open === '(' && close === ')' && items.length === 1) {
      const only = child(n, 'e')?.children.filter((c) => !c.name.endsWith('Pr'));
      if (only?.length === 1 && only[0].name === 'f' && fractionType(only[0]) === 'noBar') {
        const num = this.part(only[0], 'num', depth + 1);
        return `\\binom{${num}}{${this.part(only[0], 'den', depth + 1)}}`;
      }
    }

    // A brace with nothing closing it, around one matrix or equation array, is
    // the cases construct.
    if (open === '{' && close === '' && items.length === 1) {
      const only = child(n, 'e')?.children.filter((c) => !c.name.endsWith('Pr'));
      if (only?.length === 1 && only[0].name === 'm') {
        return this.matrix(only[0], depth + 1, 'cases');
      }
      if (only?.length === 1 && only[0].name === 'eqArr') {
        return this.eqArray(only[0], depth + 1, true);
      }
    }

    const delim = (c: string): string => (c === '' ? '.' : (DELIMS[c] ?? '.'));
    let joined = '';
    items.forEach((item, i) => {
      if (i > 0 && sep !== '') {
        joined += sep === '|' || sep === '‖' ? `\\middle${delim(sep)}` : mathChar(sep);
      }
      joined = cat([joined, item]);
    });
    const o = delim(open);
    const gap = /[A-Za-z]$/.test(o) && joined !== '' ? ' ' : '';
    return `\\left${o}${gap}${joined}\\right${delim(close)}`;
  }

  private matrix(n: XNode, depth: number, env = 'matrix'): string {
    const rows = children(n, 'mr').map((mr) =>
      children(mr, 'e')
        .map((e) => this.kids(e, depth + 1))
        .join(' & '),
    );
    return `\\begin{${env}} ${rows.join(' \\\\ ')} \\end{${env}}`;
  }

  private eqArray(n: XNode, depth: number, cases = false): string {
    this.eqDepth++;
    const rows = children(n, 'e').map((e) => this.kids(e, depth + 1));
    this.eqDepth--;
    const aligned = rows.some((r) => /(?<!\\)&/.test(r));
    const env = cases ? 'cases' : aligned ? 'aligned' : 'gathered';
    return `\\begin{${env}} ${rows.join(' \\\\ ')} \\end{${env}}`;
  }

  private func(n: XNode, depth: number): string {
    const fName = child(n, 'fName');
    const plain = this.plainOf(fName);
    let name: string;
    if (plain !== undefined && plain !== '') {
      name = FUNCTIONS.has(plain)
        ? `\\${plain}`
        : `\\operatorname{${Array.from(plain, (c) => ASCII_TEXT[c] ?? c).join('')}}`;
    } else {
      name = fName === undefined ? '' : this.kids(fName, depth + 1);
    }
    const body = this.part(n, 'e', depth);
    return body === '' ? name : `${name} ${body}`;
  }

  private accent(n: XNode, depth: number): string {
    const pr = child(n, 'accPr');
    const chrNode = pr && child(pr, 'chr');
    const chr = chrNode === undefined ? '̂' : (attr(chrNode.attrs, 'val') ?? '̂');
    const body = this.part(n, 'e', depth);
    const kind = ACCENTS[chr];
    if (kind === undefined) {
      return `\\overset{${mathChar(chr)}}{${body}}`;
    }
    if (!isAtom(body) && WIDE[kind] !== undefined) {
      return `${WIDE[kind]}{${body}}`;
    }
    return `\\${kind}{${body}}`;
  }

  private bar(n: XNode, depth: number): string {
    const pr = child(n, 'barPr');
    const pos = pr && attr(child(pr, 'pos')?.attrs ?? {}, 'val');
    const body = this.part(n, 'e', depth);
    return pos === 'top' ? `\\overline{${body}}` : `\\underline{${body}}`;
  }

  private limit(n: XNode, depth: number, upper: boolean): string {
    const limNode = child(n, 'lim');
    const lim = this.part(n, 'lim', depth);
    const e = child(n, 'e');
    const body = e === undefined ? '' : this.kids(e, depth + 1);
    // Word spells a brace over or under an expression as a limit whose "limit"
    // is the brace character itself.
    const brace = this.plainOf(limNode);
    if (brace === '⏟') {
      return `\\underbrace{${body}}`;
    }
    if (brace === '⏞') {
      return `\\overbrace{${body}}`;
    }
    const name = this.plainOf(e);
    if (name !== undefined && LIMIT_NAMES.has(name)) {
      return `\\${name}${upper ? '^' : '_'}{${lim}}`;
    }
    if (lim === '') {
      return body;
    }
    // A label on a brace attaches to it as a script: `\underbrace{x}_{n}`.
    const inner = e?.children.filter((c) => !c.name.endsWith('Pr'));
    if (inner?.length === 1 && this.isBrace(inner[0])) {
      return `${body}${upper ? '^' : '_'}{${lim}}`;
    }
    return upper ? `\\overset{${lim}}{${body}}` : `\\underset{${lim}}{${body}}`;
  }

  private isBrace(n: XNode): boolean {
    if (n.name === 'groupChr') {
      const chr = child(n, 'groupChrPr') && child(child(n, 'groupChrPr')!, 'chr');
      const v = chr === undefined ? '⏟' : (attr(chr.attrs, 'val') ?? '⏟');
      return v === '⏞' || v === '⏟';
    }
    if (n.name === 'limLow' || n.name === 'limUpp') {
      const brace = this.plainOf(child(n, 'lim'));
      return brace === '⏟' || brace === '⏞';
    }
    return false;
  }

  private groupChr(n: XNode, depth: number): string {
    const pr = n.children.find((c) => c.name === 'groupChrPr');
    const chrNode = pr && child(pr, 'chr');
    const chr = chrNode === undefined ? '⏟' : (attr(chrNode.attrs, 'val') ?? '⏟');
    const pos = pr && attr(child(pr, 'pos')?.attrs ?? {}, 'val');
    const body = this.part(n, 'e', depth);
    if (chr === '⏞') {
      return `\\overbrace{${body}}`;
    }
    if (chr === '⏟') {
      return pos === 'top' ? `\\overbrace{${body}}` : `\\underbrace{${body}}`;
    }
    return pos === 'top'
      ? `\\overset{${mathChar(chr)}}{${body}}`
      : `\\underset{${mathChar(chr)}}{${body}}`;
  }

  private phantom(n: XNode, depth: number): string {
    const pr = child(n, 'phantPr');
    const show = pr && child(pr, 'show');
    const body = this.part(n, 'e', depth);
    // `show` defaults to on; an explicit off keeps the space and hides the ink.
    return show !== undefined && !on(show) ? `\\phantom{${body}}` : body;
  }
}

/**
 * LaTeX for one `m:oMath` element, or '' when it holds nothing or is too big.
 * A display wrapper (`m:oMathPara`) is the caller's to unwrap.
 */
export function ommlToLatex(node: XNode): string {
  try {
    const tex = new Converter()
      .convert(node, 0)
      .replace(/[ \t\r\n]+/g, ' ')
      .trim();
    return tex.length > MAX_LENGTH ? '' : tex;
  } catch {
    return '';
  }
}

/** Every `m:oMath` under a display wrapper, in order. */
export function mathParaMembers(para: XNode): XNode[] {
  const direct = children(para, 'oMath');
  return direct.length > 0 ? direct : findAll(para, 'oMath');
}
