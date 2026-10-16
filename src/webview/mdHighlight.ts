// Syntax highlighting for the in-preview block editor's backdrop layer.
//
// The editor is a transparent <textarea> laid over a <div> that paints this
// output, so the two must line up glyph for glyph. That rules out anything that
// changes advance widths: no font-weight, no italics, no extra characters. Bold
// is faked with a text stroke, markers are only dimmed. Every character of the
// input appears exactly once in the output text, so the backdrop's textContent
// equals the source (plus the trailing newline guard added by `highlightMarkdown`).
//
// Deliberately regex-based and forgiving: a miss only loses a colour.

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESC[c]);
}

const dim = (text: string): string => `<span class="mc-hl-dim">${esc(text)}</span>`;

// Inline highlighting of one line's worth of already-prefix-stripped text. Works
// on raw text and escapes each piece itself, so nothing unescaped is ever emitted.
function inline(text: string): string {
  // Order matters: code spans first so their contents are left alone, then
  // images/links, bold, strikethrough, emphasis.
  const pattern =
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|(!?\[)([^\]\n]*)(\]\()([^)\n]*)(\))|(\*\*|__)(?=\S)([\s\S]*?\S)\8|(~~)(?=\S)([\s\S]*?\S)\10|(\*|_)(?=\S)([^*_\n]*?\S)\12/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out += dim(m[1]) + esc(m[2]) + dim(m[1]);
    } else if (m[3] !== undefined) {
      out +=
        dim(m[3]) +
        inline(m[4]) +
        dim(m[5]) +
        `<span class="mc-hl-url">${esc(m[6])}</span>` +
        dim(m[7]);
    } else if (m[8] !== undefined) {
      out += dim(m[8]) + `<span class="mc-hl-bold">${inline(m[9])}</span>` + dim(m[8]);
    } else if (m[10] !== undefined) {
      out += dim(m[10]) + inline(m[11]) + dim(m[10]);
    } else {
      out += dim(m[12]) + inline(m[13]) + dim(m[12]);
    }
    last = m.index + m[0].length;
    if (m[0].length === 0) {
      pattern.lastIndex++;
    }
  }
  return out + esc(text.slice(last));
}

function highlightLine(line: string): string {
  // Heading: leading #s.
  let m = /^(\s{0,3})(#{1,6})(\s+)([\s\S]*)$/.exec(line);
  if (m) {
    return esc(m[1]) + dim(m[2]) + esc(m[3]) + `<span class="mc-hl-bold">${inline(m[4])}</span>`;
  }
  // Blockquote markers, possibly nested ("> > text").
  m = /^(\s{0,3}(?:>\s?)+)([\s\S]*)$/.exec(line);
  if (m) {
    return dim(m[1]) + inline(m[2]);
  }
  // List bullets and ordered markers, with optional task checkbox.
  m = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?([\s\S]*)$/.exec(line);
  if (m) {
    return esc(m[1]) + dim(m[2]) + esc(m[3]) + (m[4] ? dim(m[4]) : '') + inline(m[5]);
  }
  // Fence delimiters and thematic breaks.
  if (/^\s*(```+|~~~+)/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
    return dim(line);
  }
  return inline(line);
}

/**
 * Highlight Markdown `source` as HTML for the editor backdrop. Everything is
 * HTML-escaped. A newline is appended when the text ends with one, so the
 * backdrop's last line keeps its height like a textarea's does.
 */
export function highlightMarkdown(source: string): string {
  let fence: string | undefined;
  const html = source
    .split('\n')
    .map((line) => {
      const open = /^\s*(```+|~~~+)/.exec(line);
      if (fence === undefined) {
        if (open) {
          fence = open[1][0];
          return dim(line);
        }
        return highlightLine(line);
      }
      // Inside a fence no Markdown applies, so only the closing line is dimmed.
      if (open && open[1][0] === fence) {
        fence = undefined;
        return dim(line);
      }
      return esc(line);
    })
    .join('\n');
  return html + '\n';
}
