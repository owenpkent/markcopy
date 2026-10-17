// What a Word document's page chrome, comments, and chart tables do to the clipboard.
//
// Headers, footers, comment markers and the Comments section are review and page
// furniture, not document content: they carry `data-mc-ignore` (or, for the
// highlight, are unwrapped), and every copy path that already honors that
// attribute has to leave them out. A chart's table is real data and goes out
// as CSV like any other table. The plain-text flavor of a whole-document copy
// comes from innerText, which jsdom does not implement, so these assert on the
// HTML flavor and on the Markdown conversion.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { boot, type Harness } from '../webview/harness';
import { renderDocxHtml } from '../../src/docx/read';
import { buildDocx, NS, REL, run, XML } from '../docx/fixture';

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

beforeEach(async () => {
  h.reset();
  await h.render({ html: DOC_HTML, kind: 'docx' });
});

const wml = (root: string, inner: string): string => `${XML}<w:${root} ${NS}>${inner}</w:${root}>`;
const strRef = (...v: string[]): string =>
  `<c:strRef><c:strCache>${v.map((s, i) => `<c:pt idx="${i}"><c:v>${s}</c:v></c:pt>`).join('')}</c:strCache></c:strRef>`;
const numRef = (...v: string[]): string =>
  `<c:numRef><c:numCache><c:formatCode>General</c:formatCode>${v.map((s, i) => `<c:pt idx="${i}"><c:v>${s}</c:v></c:pt>`).join('')}</c:numCache></c:numRef>`;

const DOC_HTML = renderDocxHtml(
  buildDocx({
    body:
      `<w:p>${run('Alpha ')}<w:commentRangeStart w:id="0"/>${run('reviewed words')}` +
      '<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>' +
      `${run(' omega.')}</w:p>` +
      '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/>' +
      '<wp:docPr id="1" name="Chart"/><a:graphic>' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
      '<c:chart r:id="rIdChart"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
      `<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/></w:sectPr>`,
    rels:
      `<Relationship Id="rIdChart" Type="${REL}/chart" Target="charts/chart1.xml"/>` +
      `<Relationship Id="rIdH" Type="${REL}/header" Target="header1.xml"/>` +
      `<Relationship Id="rIdF" Type="${REL}/footer" Target="footer1.xml"/>`,
    extra: {
      'word/header1.xml': wml('hdr', `<w:p>${run('HEADERTEXT')}</w:p>`),
      'word/footer1.xml': wml('ftr', `<w:p>${run('FOOTERTEXT')}</w:p>`),
      'word/comments.xml': wml(
        'comments',
        '<w:comment w:id="0" w:author="Ann"><w:p><w:r><w:t>COMMENTBODY</w:t></w:r></w:p></w:comment>',
      ),
      'word/charts/chart1.xml':
        `${XML}<c:chartSpace ${NS}><c:chart><c:plotArea><c:barChart>` +
        `<c:ser><c:tx>${strRef('Units')}</c:tx><c:cat>${strRef('Q1', 'Q2')}</c:cat>` +
        `<c:val>${numRef('10', '20')}</c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`,
    },
  }),
).html;

describe('a Word document with chrome', () => {
  it('shows the header, footer, comment, and chart in the preview', () => {
    const text = h.content().textContent ?? '';
    for (const s of ['HEADERTEXT', 'FOOTERTEXT', 'COMMENTBODY', 'reviewed words', 'Units']) {
      expect(text).toContain(s);
    }
  });

  it('copies the whole document without the header, footer, or any comment markup', async () => {
    await h.rightClick(h.find('p')).click('Copy Whole Document');
    const html = h.lastClip()?.html ?? '';
    expect(html).toContain('Alpha');
    expect(html).toContain('reviewed words');
    expect(html).toContain('omega.');
    for (const gone of [
      'HEADERTEXT',
      'FOOTERTEXT',
      'COMMENTBODY',
      'Ann',
      'data-mc-comment',
      'mc-docx-comment',
      'mc-docx-commentref',
      '<mark',
    ]) {
      expect(html, gone).not.toContain(gone);
    }
    // The chart is data, so it comes along.
    expect(html).toContain('Units');
  });

  it('copies a selection as Markdown with the words and no comment marker', async () => {
    const p = h.find('.mc-docx > p');
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    const last = p.lastChild!;
    range.setEnd(last, (last.textContent ?? '').length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const m = h.rightClick(p);
    // jsdom drops the selection when the menu takes focus; a browser keeps it.
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    await m.click('Copy as');
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    await m.click('Markdown');
    const md = h.lastClip()?.plain ?? '';
    expect(md).toContain('reviewed words');
    expect(md).not.toContain('C1');
    expect(md).not.toContain('COMMENTBODY');
    window.getSelection()?.removeAllRanges();
  });

  it('copies a selection as rich text with neither flavor carrying comment markup', async () => {
    const root = h.find('.mc-docx');
    const range = document.createRange();
    range.selectNodeContents(root);
    const select = () => {
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    };
    select();
    const m = h.rightClick(h.find('.mc-docx > p'));
    select();
    await m.click('Copy Selection');
    const clip = h.lastClip();
    for (const flavor of [clip?.html ?? '', clip?.plain ?? '']) {
      expect(flavor).toContain('reviewed words');
      expect(flavor).not.toContain('C1');
      expect(flavor).not.toContain('COMMENTBODY');
      expect(flavor).not.toContain('Comments');
    }
    // Paragraphs stay on their own lines.
    expect(clip?.plain).toMatch(/Alpha reviewed words omega\.\n/);
    window.getSelection()?.removeAllRanges();
  });

  it('copies the chart table as CSV and TSV', async () => {
    const chart = h.find('figure.mc-docx-chart table');
    await h.rightClick(chart.querySelector('td')!).click('Copy as', 'CSV');
    expect(h.lastClip()?.plain).toBe('Category,Units\r\nQ1,10\r\nQ2,20');
    await h.rightClick(chart.querySelector('td')!).click('Copy as', 'TSV');
    expect(h.lastClip()?.plain).toBe('Category\tUnits\r\nQ1\t10\r\nQ2\t20');
  });
});
