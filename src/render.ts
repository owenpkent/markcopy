import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import hljs from 'highlight.js';

// A single shared markdown-it instance configured for GitHub-flavored output.
// Rendering happens in the extension host; the resulting HTML is shipped to the
// webview, which handles interaction (context menu, clipboard, mermaid, PNG).
export function createMarkdownIt(): MarkdownIt {
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
    }
  });

  md.use(anchor, { permalink: false, tabIndex: false });

  addSourceLineMapping(md);
  return md;
}

// Tag top-level block tokens with data-source-line so the webview can sync scroll
// to the editor and copy the underlying Markdown for a given element.
function addSourceLineMapping(md: MarkdownIt): void {
  const rules = ['paragraph_open', 'heading_open', 'blockquote_open', 'table_open', 'bullet_list_open', 'ordered_list_open', 'fence', 'code_block', 'hr'];
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
