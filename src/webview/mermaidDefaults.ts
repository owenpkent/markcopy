import type { MermaidConfig } from 'mermaid';

type SiteConfig = Pick<MermaidConfig, 'layout' | 'look'>;

// Mermaid 12 defaults to the ELK layout. MarkCopy keeps the classic dagre
// layout and look, and applies them, together with any `layout` or `look` the
// user sets in `markcopy.mermaid`, as Mermaid site config after initialize()
// rather than as initialize() options. initialize() records its options as the
// user's own choice, and a mindmap keeps its cose-bilkent layout only when no
// such choice exists: through initialize(), dagre turns every mindmap into a
// tree and ELK fails to render one at all. A diagram's frontmatter still
// overrides both.
export const MERMAID_DEFAULTS: SiteConfig = {
  layout: 'dagre',
  look: 'classic',
};

const SITE_KEYS = ['layout', 'look'] as const;

// Split the user's config into what goes to initialize() and what goes to site
// config: `layout` and `look` over MarkCopy's defaults.
export function splitMermaidConfig(userConfig: Record<string, unknown>): {
  init: Record<string, unknown>;
  site: SiteConfig;
} {
  const init = { ...userConfig };
  const site: Record<string, unknown> = { ...MERMAID_DEFAULTS };
  for (const key of SITE_KEYS) {
    if (key in init) {
      site[key] = init[key];
      delete init[key];
    }
  }
  return { init, site: site as SiteConfig };
}
