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

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}
