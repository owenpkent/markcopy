import { describe, it, expect } from 'vitest';
import { diagramHtml } from '../src/webview/diagramHtml';

// The shape Mermaid 12 emits for `flowchart LR; A[Alpha] -->|Edge| B[Beta]`:
// an SVG with its own <style>, markers, and every label as XHTML inside a
// foreignObject. Trimmed to what the sanitizer has to get right.
const FLOWCHART =
  '<svg id="d" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'role="graphics-document document" aria-roledescription="flowchart-v2" viewBox="0 0 300 80">' +
  '<style>#d .edgeLabel{background-color:#fff}</style>' +
  '<defs><marker id="d_arrow" orient="auto" markerWidth="8" markerHeight="8" refX="5" refY="5">' +
  '<path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>' +
  '<g class="edgePaths"><path d="M10,40 L140,40" class="flowchart-link" marker-end="url(#d_arrow)"/></g>' +
  '<g class="edgeLabels"><g class="edgeLabel" transform="translate(75, 40)">' +
  '<foreignObject width="30" height="20"><div xmlns="http://www.w3.org/1999/xhtml" ' +
  'style="display: table-cell; white-space: nowrap;"><span class="edgeLabel"><p>Edge</p></span></div>' +
  '</foreignObject></g></g>' +
  '<g class="nodes"><g class="node default" id="flowchart-A-0" transform="translate(40, 40)">' +
  '<rect class="basic label-container" x="-30" y="-20" width="60" height="40"/>' +
  '<g class="label" transform="translate(-20, -10)"><foreignObject width="40" height="20">' +
  '<div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell;"><span class="nodeLabel">' +
  '<p>Alpha</p></span></div></foreignObject></g></g>' +
  '<g class="node default" id="flowchart-B-1" transform="translate(200, 40)">' +
  '<rect class="basic label-container" x="-30" y="-20" width="60" height="40"/>' +
  '<g class="label" transform="translate(-20, -10)"><foreignObject width="40" height="20">' +
  '<div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Beta</p></span></div>' +
  '</foreignObject></g></g></g></svg>';

function labels(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('foreignObject')].map((fo) => fo.textContent?.trim() ?? '');
}

describe('diagramHtml', () => {
  it('keeps the node and edge labels Mermaid draws as HTML in a foreignObject', () => {
    const out = diagramHtml(FLOWCHART);
    expect(labels(out)).toEqual(['Edge', 'Alpha', 'Beta']);
    // The diagram's own styling and arrowheads survive too.
    expect(out).toContain('<style>');
    expect(out).toContain('marker-end="url(#d_arrow)"');
    expect(out).toContain('<marker id="d_arrow"');
  });

  it('still removes script, event handlers and javascript: links from the SVG', () => {
    const hostile = FLOWCHART.replace(
      '<p>Beta</p>',
      '<p>Beta</p><script>window.pwned = 1</script>' +
        '<img src="x" onerror="window.pwned = 1">' +
        '<a href="javascript:window.pwned = 1">x</a>',
    ).replace('<rect class="basic', '<rect onclick="window.pwned = 1" class="basic');
    const out = diagramHtml(hostile);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('javascript:');
    // The label the hostile markup sat beside is intact.
    expect(labels(out)[2]).toContain('Beta');
  });
});
