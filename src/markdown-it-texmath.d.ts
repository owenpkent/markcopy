declare module 'markdown-it-texmath' {
  import type { MarkdownIt } from 'markdown-it';

  // We only use texmath for its `$...$` / `$$...$$` delimiter parsing; the render
  // rules are overridden in render.ts to emit client-side KaTeX placeholders.
  interface TexmathOptions {
    engine?: unknown;
    delimiters?: string | string[];
    katexOptions?: Record<string, unknown>;
  }

  const texmath: (md: MarkdownIt, opts?: TexmathOptions) => void;
  export default texmath;
}
