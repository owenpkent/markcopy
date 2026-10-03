import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { splitMermaidConfig } from '../src/webview/mermaidDefaults';

// Mirrors configureMermaid() in src/webview/main.ts against the real package.
function init(user: Record<string, unknown>): void {
  const { init: options, site } = splitMermaidConfig(user);
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', ...options });
  mermaid.mermaidAPI.updateSiteConfig(site);
}

describe('mermaid site config defaults', () => {
  it('applies dagre to getConfig without a user layout', () => {
    init({});
    expect(mermaid.mermaidAPI.getConfig().layout).toBe('dagre');
    expect(mermaid.mermaidAPI.getConfig().look).toBe('classic');
  });

  it('applies a user layout of elk through site config', () => {
    init({ layout: 'elk' });
    expect(mermaid.mermaidAPI.getConfig().layout).toBe('elk');
  });

  it('is reset by a bare initialize(), so every initialize() must re-apply it', () => {
    init({});
    mermaid.initialize({ startOnLoad: false });
    // Mermaid 12's own default, which MarkCopy's site config replaces.
    expect(mermaid.mermaidAPI.getConfig().layout).toBe('elk');
  });
});
