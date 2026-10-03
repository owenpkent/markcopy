import { describe, expect, it } from 'vitest';
import { splitMermaidConfig } from '../src/webview/mermaidDefaults';

describe('splitMermaidConfig', () => {
  it('sends the dagre and classic defaults to site config when the user sets neither', () => {
    expect(splitMermaidConfig({})).toEqual({
      init: {},
      site: { layout: 'dagre', look: 'classic' },
    });
  });

  it('moves a user layout to site config instead of initialize()', () => {
    expect(splitMermaidConfig({ layout: 'elk' })).toEqual({
      init: {},
      site: { layout: 'elk', look: 'classic' },
    });
  });

  it('moves a user look to site config, over the default', () => {
    expect(splitMermaidConfig({ layout: 'elk', look: 'neo' })).toEqual({
      init: {},
      site: { layout: 'elk', look: 'neo' },
    });
  });

  it('leaves every other key for initialize()', () => {
    expect(splitMermaidConfig({ theme: 'forest', flowchart: { curve: 'basis' } })).toEqual({
      init: { theme: 'forest', flowchart: { curve: 'basis' } },
      site: { layout: 'dagre', look: 'classic' },
    });
  });

  it('does not modify the user config it is given', () => {
    const user = { layout: 'elk', theme: 'forest' };
    splitMermaidConfig(user);
    expect(user).toEqual({ layout: 'elk', theme: 'forest' });
  });
});
