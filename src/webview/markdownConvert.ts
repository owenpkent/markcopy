// Converts rendered preview HTML back to Markdown for "Copy Selection as
// Markdown". Turndown (and its GFM plugin) are only needed on that path, so they
// are imported lazily on first use and the configured instance is cached.
import type TurndownService from 'turndown';

let _turndown: TurndownService | undefined;

async function getTurndown(): Promise<TurndownService> {
  if (_turndown) {
    return _turndown;
  }
  const [{ default: TurndownService }, { gfm }] = await Promise.all([
    import('turndown'),
    import('turndown-plugin-gfm'),
  ]);
  // Configured to match the flavor the source is typically written in.
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

  _turndown = turndown;
  return turndown;
}

export async function htmlToMarkdown(html: string): Promise<string> {
  const turndown = await getTurndown();
  return turndown.turndown(html);
}
