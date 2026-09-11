// markdown-it 15 ships its own types and its default export is a callable value,
// not a class, so the instance type has to be imported separately by name.
import MarkdownIt, {
  type MarkdownIt as MarkdownItInstance,
  type StateCore,
  type Token,
} from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import texmath from 'markdown-it-texmath';
import hljs from 'highlight.js';
import { escapeAttr, escapeHtml } from './escape';

export interface MarkdownItOptions {
  // Parse `$...$` / `$$...$$` as math. On by default; the `markcopy.math` setting
  // can turn it off for documents that use literal dollar signs.
  math?: boolean;
  // Parse `[^note]` footnote references and `[^note]: text` definitions. On by
  // default; the `markcopy.footnotes` setting can turn it off for documents
  // that use literal `[^...]` text for something else.
  footnotes?: boolean;
}

// A single shared markdown-it instance configured for GitHub-flavored output.
// Rendering happens in the extension host; the resulting HTML is shipped to the
// webview, which handles interaction (context menu, clipboard, mermaid, math, PNG).
export function createMarkdownIt(opts: MarkdownItOptions = {}): MarkdownItInstance {
  const md = new MarkdownIt({
    html: true,
    // Autolinks URLs that carry a scheme, plus emails. Since markdown-it 15 this
    // no longer covers schemeless text like `github.com`, because linkify-it 6
    // dropped fuzzy links -- kept deliberately, since `.md`/`.io`/`.ts` are real
    // TLDs and fuzzy matching turned bare filename mentions into dead
    // `http://RELEASING.md` links that openExternal then fired at the OS.
    // tests/render.test.ts pins the behavior and the author-side escape hatch.
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

  // No `permalink` key: anchor types it as a generator function and treats its
  // absence as "no permalink", which is what we want. Passing `permalink: false`
  // rendered the same but only type-checked because markdown-it 14 declared
  // `use(plugin, ...params: any[])` and never validated plugin options.
  md.use(anchor, { tabIndex: false });

  if (opts.footnotes !== false) {
    addFootnotes(md);
  }
  if (opts.math !== false) {
    addMath(md);
  }
  addSourceLineMapping(md);
  rewriteImageSrc(md);
  return md;
}

// markdown-it-footnote (node_modules/markdown-it-footnote/index.mjs) stashes its
// per-document bookkeeping on `env.footnotes`. It ships no types of its own, so
// this is the shape we read back from it, plus the two fields footnoteFixups
// below adds for our own renderer overrides to read.
interface FootnoteEnv {
  // refs[':label'] is -1 until `[^label]` is actually referenced somewhere in
  // the document, then the index into `list`. The leading `:` is the plugin's
  // own guard against a label that collides with an Object.prototype member
  // (`toString`, `constructor`, etc.).
  refs?: Record<string, number>;
  list?: Array<{ label?: string; count?: number }>;
  // Our additions: each *referenced* definition's starting source line, keyed
  // the same way, and the earliest of them, for the footnote_open /
  // footnote_block_open overrides below.
  sourceLines?: Record<string, number>;
  firstDefLine?: number;
}

// The plugin's own `footnote_tail` core rule pulls every `[^label]: text`
// definition out of the token stream into a map keyed by label, then only puts
// back the ones whose label made it into `env.footnotes.list` -- which only
// happens when `[^label]` is actually referenced somewhere. A document with
// definitions and no references at all never gets a `list` in the first place,
// so footnote_tail bails out before re-emitting anything and the definitions
// vanish with nothing left to show for them. That is a real problem in a live
// preview: an author who types the definition before the reference watches the
// paragraph blank out.
//
// This rule runs one step ahead of footnote_tail (still after inline parsing,
// so `env.footnotes.refs` already reflects every reference in the document)
// and, for every definition whose label was never referenced, re-parses its
// original source lines as ordinary Markdown -- with the footnote_def block
// rule turned off, so it renders exactly as it would have before this plugin
// existed, `[^label]:` prefix and all -- and splices that in, in place, instead
// of the plugin's own (also unreachable) tokens for it. GitHub drops an
// unreferenced definition instead; we deliberately do not, because silently
// deleting the author's text from a live preview is the worse failure.
//
// For every definition that *is* referenced, this also records its source line
// so the footnote_open / footnote_block_open overrides below can tag the
// footnotes section with data-source-line (see addSourceLineMapping's comment
// for why the webview needs that attribute).
function footnoteFixups(state: StateCore): void {
  const footnotes = state.env.footnotes as FootnoteEnv | undefined;
  if (!footnotes) return;
  const refs = footnotes.refs ?? {};
  const sourceLines: Record<string, number> = {};
  const srcLines = state.src.split('\n');
  const kept: Token[] = [];

  let i = 0;
  while (i < state.tokens.length) {
    const tok = state.tokens[i];
    if (tok.type !== 'footnote_reference_open') {
      kept.push(tok);
      i++;
      continue;
    }

    // Find the matching close. Depth-tracked rather than assumed adjacent:
    // footnote_def tokenizes a definition's body with the full block ruler
    // (itself included), so one definition could in principle contain another.
    const label = (tok.meta as { label: string }).label;
    const referenced = (refs[`:${label}`] ?? -1) >= 0;
    let depth = 1;
    let j = i + 1;
    while (j < state.tokens.length && depth > 0) {
      if (state.tokens[j].type === 'footnote_reference_open') depth++;
      else if (state.tokens[j].type === 'footnote_reference_close') depth--;
      if (depth > 0) j++;
    }
    const body = state.tokens.slice(i + 1, j);
    const firstMapped = body.find((t) => t.map);
    const lastMapped = [...body].reverse().find((t) => t.map);

    if (referenced) {
      // Left untouched, close token included: footnote_tail (which runs right
      // after this rule) still needs to see a balanced open/close pair here to
      // find this definition's own content and move it under the reference.
      kept.push(tok, ...body, state.tokens[j]);
      if (firstMapped?.map) {
        sourceLines[`:${label}`] = firstMapped.map[0];
      }
    } else if (firstMapped?.map && lastMapped?.map) {
      const startLine = firstMapped.map[0];
      const endLine = lastMapped.map[1];
      const raw = srcLines.slice(startLine, endLine).join('\n');
      // Disabled only for the duration of this nested parse, so a real,
      // later `[^other]: ...` in the rest of the document is unaffected.
      state.md.block.ruler.disable('footnote_def');
      let replacement: Token[];
      try {
        replacement = state.md.parse(raw, {});
      } finally {
        state.md.block.ruler.enable('footnote_def');
      }
      for (const rt of replacement) {
        if (rt.map) rt.map = [rt.map[0] + startLine, rt.map[1] + startLine];
      }
      kept.push(...replacement);
    }
    // Neither branch matched (an empty, mapless body): nothing to recover, so
    // this drops silently rather than risk emitting broken markup.

    i = j + 1; // past the matching footnote_reference_close
  }

  state.tokens = kept;
  footnotes.sourceLines = sourceLines;
  const lines = Object.values(sourceLines);
  if (lines.length > 0) {
    footnotes.firstDefLine = Math.min(...lines);
  }
}

function addFootnotes(md: MarkdownItInstance): void {
  md.use(footnote);

  // The plugin's `^[inline footnote]` shorthand is undocumented here (the
  // README and CHANGELOG only describe `[^note]`) and `^[` shows up constantly
  // in prose about regular expressions ("the pattern ^[A-Z]+ matches
  // capitals"), so only the reference/definition form is supported.
  md.inline.ruler.disable('footnote_inline');

  md.core.ruler.before('footnote_tail', 'footnote_fixups', footnoteFixups);

  // GitHub renders every occurrence of a repeated reference as the same `[1]`;
  // the plugin's default instead appends `:1`, `:2`... to disambiguate, which
  // is a concern for the anchor `id`s (kept unique below, untouched) and not
  // for what the reader sees.
  md.renderer.rules.footnote_caption = (tokens, idx) => {
    const meta = (tokens[idx].meta ?? {}) as { id: number };
    return `[${meta.id + 1}]`;
  };

  // The plugin's own `footnote_open` renders `<li id="fn1" class="footnote-item">`
  // with no source line on it: by the time it runs, the definition has moved to
  // the end of the token stream, and addSourceLineMapping's `token.level === 0`
  // guard cannot see it anyway (the definition's paragraph sits one level deep,
  // inside the reference-open wrapper that footnoteFixups strips above). Emit
  // the same `<li>`, plus data-source-line from the map footnoteFixups built,
  // so the webview's block copy, scroll-sync anchors, and right-click menu all
  // work inside the footnotes section the way they do everywhere else.
  md.renderer.rules.footnote_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const meta = (token.meta ?? {}) as { id: number; label?: string; subId?: number };
    let id = self.rules.footnote_anchor_name(tokens, idx, options, env, self);
    if ((meta.subId ?? 0) > 0) id += `:${meta.subId}`;
    const footnotes = env?.footnotes as FootnoteEnv | undefined;
    const line = meta.label !== undefined ? footnotes?.sourceLines?.[`:${meta.label}`] : undefined;
    const lineAttr = line !== undefined ? ` data-source-line="${line}"` : '';
    return `<li id="fn${id}" class="footnote-item"${lineAttr}>`;
  };

  // Same idea for the section itself: tag it with the earliest definition's
  // line, so blockMarkdown (src/webview/main.ts) has an anchor to stop at.
  // Without this, "Copy Block > Markdown" on the last real paragraph ran off
  // the end of the file and pulled in every footnote definition with it, since
  // it found no next data-source-line to bound the copy.
  md.renderer.rules.footnote_block_open = (tokens, idx, options, env) => {
    const footnotes = env?.footnotes as FootnoteEnv | undefined;
    const line = footnotes?.firstDefLine;
    const lineAttr = line !== undefined ? ` data-source-line="${line}"` : '';
    return (
      (options.xhtmlOut ? '<hr class="footnotes-sep" />\n' : '<hr class="footnotes-sep">\n') +
      `<section class="footnotes"${lineAttr}>\n` +
      '<ol class="footnotes-list">\n'
    );
  };
}

// texmath requires an `engine` with a `renderToString` method, but we render
// KaTeX client-side (like Mermaid) so the webview can theme it, keep the raw
// LaTeX for copy, and offer copy-as-image. So we borrow only texmath's delimiter
// parsing and a no-op engine, then override its render rules to emit inert
// placeholders carrying the escaped TeX. The webview upgrades them after
// DOMPurify runs, matching how the `mermaid-src` placeholder is handled.
const NO_RENDER_ENGINE = { renderToString: (): string => '' };

function addMath(md: MarkdownItInstance): void {
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
function rewriteImageSrc(md: MarkdownItInstance): void {
  const original = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const resolve = env?.resolveImage as ((src: string) => string) | undefined;
    if (resolve) {
      const token = tokens[idx];
      const i = token.attrIndex('src');
      if (i >= 0 && token.attrs) {
        // markdown-it 15 types an attribute value as `string | number`. A parsed
        // image src is always a string, so this only keeps the resolver's contract.
        token.attrs[i][1] = resolve(String(token.attrs[i][1]));
      }
    }
    return original
      ? original(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };
}

// Tag top-level block tokens with data-source-line so the webview can sync scroll
// to the editor and copy the underlying Markdown for a given element.
function addSourceLineMapping(md: MarkdownItInstance): void {
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
