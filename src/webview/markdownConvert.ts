import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// Converts rendered preview HTML back to Markdown for "Copy Selection as
// Markdown". Configured to match the flavor the source is typically written in.
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});
turndown.use(gfm);

// Restore LaTeX from a rendered KaTeX element instead of serializing its spans.
// The original source is stashed on `data-tex` by renderKatex().
turndown.addRule('mcMath', {
  filter: (node) => node.nodeType === 1 && node.classList.contains('mc-math'),
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const tex = (el.getAttribute('data-tex') ?? '').trim();
    return el.getAttribute('data-display') === '1' ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
  },
});

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}
