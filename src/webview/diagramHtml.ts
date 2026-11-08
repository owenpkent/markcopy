import DOMPurify from 'dompurify';

// Mermaid's `securityLevel: 'strict'` already sanitizes the labels a diagram
// supplies, so this pass is the same defense in depth as the one over the page:
// the diagram source is document text, and the SVG it becomes is the one
// fragment written to the DOM without going through DOMPurify otherwise.
//
// Mermaid draws every node and edge label as HTML inside a `foreignObject`,
// which DOMPurify drops by default. Allowing the tag is not enough on its own:
// without the integration point, the sanitizer still sees the XHTML `div` under
// it as an element in the wrong namespace and removes it, label and all.
// Mermaid's own strict sanitizer sets the same two options.
export function diagramHtml(svg: string): string {
  return DOMPurify.sanitize(svg, {
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  });
}
