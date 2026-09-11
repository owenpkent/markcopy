// The seam between the two halves of PowerPoint support.
//
// The reader and the writer were built against docs/PPTX-DESIGN.md rather than
// against each other, and nothing else in the suite makes them meet: the reader
// tests feed it hand-built fixtures, and the writer tests unzip its output and
// read the XML back. That leaves exactly one thing untested, and it is the one a
// user hits first: whether a deck this extension writes is a deck this extension
// can read.
//
// It is also the cheapest proxy we have for "PowerPoint opens it". We cannot
// launch PowerPoint in CI, but a package whose slide list, relationships and
// content types do not close over each other fails here for the same reason it
// would fail there.
import { describe, it, expect } from 'vitest';
import { htmlToPptx } from '../src/pptxExport';
import { renderDeckHtml } from '../src/pptx/read';

const DECK = `<div>
  <h1>Quarterly review</h1>
  <p>Prepared for the board.</p>
  <hr />
  <h2>Revenue</h2>
  <ul>
    <li>Up 14 percent
      <ul><li>Driven by renewals</li></ul>
    </li>
    <li>Churn flat</li>
  </ul>
  <hr />
  <h2>Detail</h2>
  <table>
    <thead><tr><th>Region</th><th>Revenue</th></tr></thead>
    <tbody><tr><td>EMEA</td><td>1,200</td></tr></tbody>
  </table>
</div>`;

function roundTrip(bodyXhtml: string, slideSize: '16:9' | '4:3' = '16:9'): string {
  const written = htmlToPptx(bodyXhtml, {
    title: 'Round trip',
    slideSize,
    now: new Date('2026-01-01T00:00:00Z'),
  });
  return renderDeckHtml(written.bytes).html;
}

describe('pptx round trip', () => {
  it('reads back a deck it wrote', () => {
    const html = roundTrip(DECK);
    expect(html).toContain('mc-pptx-slide');
    expect(html).toContain('Quarterly review');
    expect(html).toContain('Revenue');
    expect(html).toContain('Driven by renewals');
    expect(html).toContain('EMEA');
  });

  it('keeps one slide per boundary in order', () => {
    const written = htmlToPptx(DECK, { title: 'Round trip', now: new Date(0) });
    expect(written.report.slides).toBe(3);

    const deck = renderDeckHtml(written.bytes);
    expect(deck.slides).toBe(3);
    expect(deck.rendered).toBe(3);

    // Slide order is the presentation's sldIdLst, not the order the parts happen
    // to sit in the zip, so this is the assertion that catches a writer emitting
    // slide10 before slide2 or a reader sorting by filename.
    // Tag-stripped rather than matched literally: whether a title's text is
    // wrapped in <strong> is the deck's business, not this test's, and pinning
    // the markup here once pushed the reader into suppressing bold to match.
    const titles = [
      ...deck.html.matchAll(/<h2[^>]*class="[^"]*mc-pptx-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/g),
    ].map((m) => m[1].replace(/<[^>]*>/g, '').trim());
    expect(titles).toEqual(['Quarterly review', 'Revenue', 'Detail']);
  });

  it('carries a table through as a table', () => {
    const html = roundTrip(DECK);
    expect(html).toContain('<table');
    expect(html).toContain('Region');
    // The header row survives as a header, which is what a screen reader and a
    // re-export to Markdown both need. What that header cell wraps its text in
    // is left open, for the same reason as the titles above.
    const headers = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
      m[1].replace(/<[^>]*>/g, '').trim(),
    );
    expect(headers).toContain('Region');
  });

  it('honours the 4:3 slide size it was asked for', () => {
    // 9144000 x 6858000 EMU is 4:3; the reader turns that into the aspect ratio
    // it puts on the slide box, so a mismatch shows up as 1.7778 here.
    expect(roundTrip(DECK, '4:3')).toContain('aspect-ratio:1.3333');
    expect(roundTrip(DECK, '16:9')).toContain('aspect-ratio:1.7778');
  });

  it('does not let XML-invalid input through either half', () => {
    // A vertical tab arrives from an ordinary paste and XML 1.0 has no
    // representation for it at all, so a deck carrying one simply will not open.
    const vt = String.fromCharCode(0x0b);
    const html = roundTrip(`<div><h2>Bad${vt}input</h2><p>body</p></div>`);
    expect(html).not.toContain(vt);
    expect(html).toContain('Badinput');
  });
});
