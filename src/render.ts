import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import texmath from 'markdown-it-texmath';
import hljs from 'highlight.js';

export interface MarkdownItOptions {
  // Parse `$...$` / `$$...$$` as math. On by default; the `markcopy.math` setting
  // can turn it off for documents that use literal dollar signs.
  math?: boolean;
}

// A single shared markdown-it instance configured for GitHub-flavored output.
// Rendering happens in the extension host; the resulting HTML is shipped to the
// webview, which handles interaction (context menu, clipboard, mermaid, math, PNG).
export function createMarkdownIt(opts: MarkdownItOptions = {}): MarkdownIt {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    breaks: false,
    highlight(code, lang): string {
      // Mermaid fences are rendered client-side; emit a placeholder the webview upgrades.
      if (lang && lang.toLowerCase() === 'mermaid') {
        return `<pre class="mermaid-src" style="display:none">${escapeHtml(code)}</pre>`;
      }
      if (lang && hljs.getLanguage(lang)) {
        try {
          const out = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
          return `<pre class="hljs"><code data-lang="${escapeAttr(lang)}">${out}</code></pre>`;
        } catch {
          /* fall through */
        }
      }
      return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
    },
  });

  md.use(anchor, { permalink: false, tabIndex: false });

  if (opts.math !== false) {
    addMath(md);
  }
  addSourceLineMapping(md);
  rewriteImageSrc(md);
  return md;
}

// texmath requires an `engine` with a `renderToString` method, but we render
// KaTeX client-side (like Mermaid) so the webview can theme it, keep the raw
// LaTeX for copy, and offer copy-as-image. So we borrow only texmath's delimiter
// parsing and a no-op engine, then override its render rules to emit inert
// placeholders carrying the escaped TeX. The webview upgrades them after
// DOMPurify runs, matching how the `mermaid-src` placeholder is handled.
const NO_RENDER_ENGINE = { renderToString: (): string => '' };

function addMath(md: MarkdownIt): void {
  md.use(texmath, { engine: NO_RENDER_ENGINE, delimiters: 'dollars' });

  // Inline: `$...$` (and single-line `$$...$$`, which texmath tags as display).
  md.renderer.rules['math_inline'] = (tokens, idx) =>
    `<span class="mc-math" data-display="0">${escapeHtml(tokens[idx].content)}</span>`;
  md.renderer.rules['math_inline_double'] = (tokens, idx) =>
    `<span class="mc-math" data-display="1">${escapeHtml(tokens[idx].content)}</span>`;

  // Block: `$$...$$` spanning a block. Carry the source line for scroll sync and
  // per-block copy, mirroring addSourceLineMapping. Equation numbers (`$$..$$ (1)`)
  // render as plain display math for now.
  md.renderer.rules['math_block'] = (tokens, idx) => {
    const token = tokens[idx];
    const line = token.map ? ` data-source-line="${token.map[0]}"` : '';
    return `<div class="mc-math" data-display="1"${line}>${escapeHtml(token.content)}</div>\n`;
  };
  md.renderer.rules['math_block_eqno'] = md.renderer.rules['math_block'];
}

// Route every image `src` through an optional `env.resolveImage` hook so the
// extension host can rewrite relative/local paths to webview-safe URIs. When no
// hook is provided (e.g. plain unit tests) the src is emitted unchanged.
function rewriteImageSrc(md: MarkdownIt): void {
  const original = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const resolve = env?.resolveImage as ((src: string) => string) | undefined;
    if (resolve) {
      const token = tokens[idx];
      const i = token.attrIndex('src');
      if (i >= 0 && token.attrs) {
        token.attrs[i][1] = resolve(token.attrs[i][1]);
      }
    }
    return original
      ? original(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };
}

// Tag top-level block tokens with data-source-line so the webview can sync scroll
// to the editor and copy the underlying Markdown for a given element.
function addSourceLineMapping(md: MarkdownIt): void {
  const rules = [
    'paragraph_open',
    'heading_open',
    'blockquote_open',
    'table_open',
    'bullet_list_open',
    'ordered_list_open',
    'fence',
    'code_block',
    'hr',
  ];
  for (const name of rules) {
    const original = md.renderer.rules[name];
    md.renderer.rules[name] = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      if (token.map && token.level === 0) {
        token.attrSet('data-source-line', String(token.map[0]));
      }
      return original
        ? original(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options);
    };
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
