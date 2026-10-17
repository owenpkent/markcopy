// Headers and footers, text boxes, comments, and charts in the .docx reader.
import { describe, expect, it } from 'vitest';
import { renderDocxHtml } from '../../src/docx/read';
import { buildDocx, imageRel, NS, para, PNG_1x1, REL, run, XML, type DocxSpec } from './fixture';

function dom(spec: DocxSpec, opts?: Parameters<typeof renderDocxHtml>[1]): Document {
  const html = renderDocxHtml(buildDocx(spec), opts).html;
  return new DOMParser().parseFromString(html, 'text/html');
}

const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** A WordprocessingML part (header, footer, comments) with every namespace declared. */
function wml(root: string, inner: string): string {
  return `${XML}<w:${root} ${NS}>${inner}</w:${root}>`;
}

const relOf = (id: string, type: string, target: string): string =>
  `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`;

const refs = (h?: string, f?: string, type = 'default'): string =>
  (h ? `<w:headerReference w:type="${type}" r:id="${h}"/>` : '') +
  (f ? `<w:footerReference w:type="${type}" r:id="${f}"/>` : '');

const PAGE_FIELD =
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>7</w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>';

describe('headers and footers', () => {
  it('shows the first header and last footer once, drops page fields, resolves header rels', () => {
    const d = dom({
      body:
        para('First section') +
        // The first section ends here; its footer is superseded by the last section's.
        `<w:p><w:pPr><w:sectPr>${refs('rIdH', 'rIdF1')}</w:sectPr></w:pPr></w:p>` +
        para('Second section') +
        `<w:sectPr>${refs('rIdH2', 'rIdF2')}</w:sectPr>`,
      rels:
        relOf('rIdH', 'header', 'header1.xml') +
        relOf('rIdF1', 'footer', 'footer1.xml') +
        relOf('rIdH2', 'header', 'header2.xml') +
        relOf('rIdF2', 'footer', 'footer2.xml'),
      media: { 'word/media/logo.png': PNG_1x1 },
      extra: {
        'word/header1.xml': wml(
          'hdr',
          para(
            run('Acme Corp ') +
              PAGE_FIELD +
              '<w:r><w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/>' +
              '<wp:docPr id="1" name="Logo" descr="Acme logo"/><a:graphic>' +
              '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
              '<pic:pic><pic:blipFill><a:blip r:embed="rIdLogo"/></pic:blipFill></pic:pic>' +
              '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>',
          ),
        ),
        'word/_rels/header1.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${imageRel('rIdLogo', 'media/logo.png')}</Relationships>`,
        'word/header2.xml': wml('hdr', para('Second header')),
        'word/footer1.xml': wml('ftr', para('First footer')),
        'word/footer2.xml': wml(
          'ftr',
          `<w:p>${run('Confidential')}<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>9</w:t></w:r></w:fldSimple></w:p>`,
        ),
      },
    });
    const root = d.querySelector('.mc-docx')!;
    const head = d.querySelector('header.mc-docx-pagehead')!;
    expect(root.firstElementChild).toBe(head);
    expect(head.getAttribute('data-mc-ignore')).toBe('1');
    expect(head.getAttribute('aria-label')).toBe('Page header');
    expect(text(head)).toBe('Acme Corp');
    expect(head.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(d.querySelectorAll('header')).toHaveLength(1);

    const foot = d.querySelector('footer.mc-docx-pagefoot')!;
    expect(root.lastElementChild).toBe(foot);
    expect(foot.getAttribute('data-mc-ignore')).toBe('1');
    expect(text(foot)).toBe('Confidential');
    expect(d.querySelectorAll('footer')).toHaveLength(1);
    expect(text(d.body)).not.toContain('First footer');
    expect(text(d.body)).not.toContain('Second header');
  });

  it('falls back to the first-page header when there is no default', () => {
    const d = dom({
      body: para('Body') + `<w:sectPr>${refs('rIdH', undefined, 'first')}</w:sectPr>`,
      rels: relOf('rIdH', 'header', 'header1.xml'),
      extra: { 'word/header1.xml': wml('hdr', para('Title page header')) },
    });
    expect(text(d.querySelector('header'))).toBe('Title page header');
  });

  it('omits a header that is empty once the page number is gone', () => {
    const d = dom({
      body: para('Body') + `<w:sectPr>${refs('rIdH', 'rIdF')}</w:sectPr>`,
      rels: relOf('rIdH', 'header', 'header1.xml') + relOf('rIdF', 'footer', 'footer1.xml'),
      extra: {
        'word/header1.xml': wml('hdr', `<w:p>${PAGE_FIELD}</w:p>`),
        'word/footer1.xml': wml('ftr', '<w:p/>'),
      },
    });
    expect(d.querySelector('header')).toBeNull();
    expect(d.querySelector('footer')).toBeNull();
    expect(text(d.body)).toBe('Body');
  });

  it('survives a missing or malformed header part', () => {
    const d = dom({
      body: para('Body') + `<w:sectPr>${refs('rIdH', 'rIdF')}</w:sectPr>`,
      rels: relOf('rIdH', 'header', 'header1.xml') + relOf('rIdF', 'footer', 'gone.xml'),
      extra: { 'word/header1.xml': '<w:hdr><w:p>' },
    });
    expect(d.querySelector('header')).toBeNull();
    expect(text(d.body)).toBe('Body');
  });

  it('keeps PAGEREF fields, which are not page numbers', () => {
    const d = dom({
      body:
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGEREF x </w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>12</w:t></w:r>' +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
    });
    expect(text(d.body)).toBe('12');
  });
});

describe('text boxes', () => {
  const box = (paras: string): string => `<w:txbxContent>${paras}</w:txbxContent>`;
  const wsp = (paras: string): string => `<wps:wsp><wps:txbx>${box(paras)}</wps:txbx></wps:wsp>`;
  const drawingOf = (graphic: string, host = 'wp:anchor'): string =>
    `<w:drawing><${host}><wp:extent cx="9525" cy="9525"/><wp:docPr id="2" name="Box"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">${graphic}</a:graphicData></a:graphic></${host}></w:drawing>`;
  const vml = (paras: string): string =>
    `<w:pict><v:shape><v:textbox>${box(paras)}</v:textbox></v:shape></w:pict>`;

  it('reads one branch of mc:AlternateContent, so the text is not duplicated', () => {
    const d = dom({
      body:
        '<w:p>' +
        run('Anchor text') +
        '<w:r><mc:AlternateContent><mc:Choice Requires="wps">' +
        drawingOf(wsp(para('Boxed words'))) +
        '</mc:Choice><mc:Fallback>' +
        vml(para('Boxed words')) +
        '</mc:Fallback></mc:AlternateContent></w:r></w:p>' +
        para('After'),
    });
    const html = d.body.innerHTML;
    expect(html.split('Boxed words')).toHaveLength(2);
    const aside = d.querySelector('aside.mc-docx-textbox')!;
    expect(text(aside)).toBe('Boxed words');
    // The box is a sibling after the anchoring paragraph, never inside it.
    expect(aside.parentElement?.tagName).toBe('DIV');
    expect(aside.previousElementSibling?.tagName).toBe('P');
    expect(text(aside.previousElementSibling)).toBe('Anchor text');
    expect(text(aside.nextElementSibling)).toBe('After');
    expect(d.querySelector('p aside')).toBeNull();
  });

  it('reads the VML fallback when there is no Choice', () => {
    const d = dom({
      body: `<w:p><w:r><mc:AlternateContent><mc:Fallback>${vml(para('Only VML'))}</mc:Fallback></mc:AlternateContent></w:r></w:p>`,
    });
    expect(d.querySelectorAll('aside')).toHaveLength(1);
    expect(text(d.querySelector('aside'))).toBe('Only VML');
  });

  it('reads a plain VML text box with several paragraphs and a list', () => {
    const d = dom({
      body: `<w:p><w:r>${vml(para('One') + para('Two'))}</w:r></w:p>`,
    });
    expect([...d.querySelectorAll('aside p')].map(text)).toEqual(['One', 'Two']);
  });

  it('reads every text box in a group', () => {
    const group =
      '<wpg:wgp>' +
      wsp(para('Left box')) +
      wsp('<w:p/>') +
      '<wpg:grpSp>' +
      wsp(para('Right box')) +
      '</wpg:grpSp></wpg:wgp>';
    const d = dom({ body: `<w:p><w:r>${drawingOf(group, 'wp:inline')}</w:r></w:p>` });
    expect([...d.querySelectorAll('aside')].map(text)).toEqual(['Left box', 'Right box']);
  });

  it('draws nothing for a shape with no text', () => {
    const d = dom({
      body: `<w:p>${run('Hi')}<w:r>${drawingOf('<wps:wsp><wps:bodyPr/></wps:wsp>')}</w:r></w:p>`,
    });
    expect(d.querySelector('aside')).toBeNull();
    expect(text(d.body)).toBe('Hi');
  });

  it('shows a box whose paragraph holds nothing else', () => {
    const d = dom({
      body: `<w:p><w:r>${drawingOf(wsp(para('Alone')))}</w:r></w:p>`,
    });
    expect(text(d.querySelector('aside'))).toBe('Alone');
  });

  it('escapes the text it shows', () => {
    const d = dom({
      body: `<w:p><w:r>${drawingOf(wsp(para('&lt;img src=x onerror=alert(1)&gt;')))}</w:r></w:p>`,
    });
    expect(d.querySelector('aside img')).toBeNull();
    expect(text(d.querySelector('aside'))).toBe('<img src=x onerror=alert(1)>');
  });

  it('stops at a bounded nesting depth', () => {
    let inner = para('deepest');
    for (let i = 0; i < 10; i++) {
      inner = `<w:p><w:r>${drawingOf(wsp(inner))}</w:r></w:p>`;
    }
    const d = dom({ body: inner });
    expect(d.querySelectorAll('aside').length).toBeLessThan(10);
  });
});

describe('comments', () => {
  const comment = (id: number, author: string, body: string, paraId?: string, date?: string) =>
    `<w:comment w:id="${id}" w:author="${author}"${date ? ` w:date="${date}"` : ''}>` +
    `<w:p${paraId ? ` w14:paraId="${paraId}"` : ''}><w:r><w:t>${body}</w:t></w:r></w:p></w:comment>`;
  const start = (id: number): string => `<w:commentRangeStart w:id="${id}"/>`;
  const end = (id: number): string =>
    `<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`;
  const ext = (entries: string): string =>
    `${XML}<w15:commentsEx ${NS}>${entries}</w15:commentsEx>`;

  it('marks a single run and lists the comment with author and date', () => {
    const d = dom({
      body: `<w:p>${run('Before ')}${start(0)}${run('target')}${end(0)}${run(' after')}</w:p>`,
      extra: {
        'word/comments.xml': wml(
          'comments',
          comment(0, 'Ann &amp; Co', 'Fix this', 'P1', '2026-10-16T09:30:00Z'),
        ),
      },
    });
    const mark = d.querySelector('mark.mc-docx-comment')!;
    expect(mark.getAttribute('data-mc-comment')).toBe('0');
    expect(text(mark)).toBe('target');
    const marker = d.querySelector('sup.mc-docx-commentref')!;
    expect(marker.getAttribute('data-mc-ignore')).toBe('1');
    expect(marker.querySelector('a')?.getAttribute('href')).toBe('#mc-cm-0');

    const section = d.querySelector('section.mc-docx-comments')!;
    expect(section.getAttribute('data-mc-ignore')).toBe('1');
    expect(section.getAttribute('aria-label')).toBe('Comments');
    expect(text(section.querySelector('li'))).toMatch(/Ann & Co\s*2026-10-16\s*Fix this/);
    expect(section.querySelector('li')?.id).toBe('mc-cm-0');
    expect(section.querySelector('a.mc-docx-backref')?.getAttribute('href')).toBe('#mc-cmref-0');
    // The body text reads through, unchanged, around the mark.
    expect(text(d.querySelector('.mc-docx > p'))).toBe('Before targetC1 after');
  });

  it('marks a range that spans several runs and formats', () => {
    const d = dom({
      body: `<w:p>${start(0)}${run('one ')}${run('two', '<w:b/>')}${run(' three')}${end(0)}</w:p>`,
      extra: { 'word/comments.xml': wml('comments', comment(0, 'A', 'x')) },
    });
    const marks = d.querySelectorAll('mark.mc-docx-comment');
    expect(marks).toHaveLength(1);
    expect(text(marks[0])).toBe('one two three');
    expect(marks[0].querySelector('strong')?.textContent).toBe('two');
  });

  it('marks the part in each paragraph when a range crosses paragraphs', () => {
    const d = dom({
      body:
        `<w:p>${run('lead ')}${start(0)}${run('first')}</w:p>` +
        `<w:p>${run('middle')}</w:p>` +
        `<w:p>${run('last')}${end(0)}${run(' tail')}</w:p>`,
      extra: { 'word/comments.xml': wml('comments', comment(0, 'A', 'x')) },
    });
    const marks = [...d.querySelectorAll('mark.mc-docx-comment')];
    expect(marks.map(text)).toEqual(['first', 'middle', 'last']);
    expect(marks.every((m) => m.getAttribute('data-mc-comment') === '0')).toBe(true);
    expect(d.querySelectorAll('sup.mc-docx-commentref')).toHaveLength(1);
    expect(d.querySelectorAll('section.mc-docx-comments li')).toHaveLength(1);
  });

  it('keeps overlapping ranges tied to their own text', () => {
    const d = dom({
      body: `<w:p>${start(0)}${run('a')}${start(1)}${run('b')}${end(0)}${run('c')}${end(1)}</w:p>`,
      extra: { 'word/comments.xml': wml('comments', comment(0, 'A', 'x') + comment(1, 'B', 'y')) },
    });
    const text1 = [...d.querySelectorAll('mark[data-mc-comment="1"]')].map((m) =>
      (m.textContent ?? '').replace(/C\d/g, ''),
    );
    expect(text1.join('')).toBe('bc');
    const text0 = [...d.querySelectorAll('mark[data-mc-comment="0"]')].map((m) =>
      (m.textContent ?? '').replace(/C\d/g, ''),
    );
    expect(text0.join('')).toBe('ab');
  });

  it('nests replies under their parent and labels a resolved thread', () => {
    const d = dom({
      body: `<w:p>${start(0)}${run('text')}${end(0)}${end(1)}${end(2)}</w:p>`,
      extra: {
        'word/comments.xml': wml(
          'comments',
          comment(0, 'Ann', 'Question?', 'AAA') +
            comment(1, 'Bob', 'Answer.', 'BBB') +
            comment(2, 'Cy', 'Separate note', 'CCC'),
        ),
        'word/commentsExtended.xml': ext(
          '<w15:commentEx w15:paraId="AAA" w15:done="1"/>' +
            '<w15:commentEx w15:paraId="BBB" w15:paraIdParent="AAA" w15:done="1"/>' +
            '<w15:commentEx w15:paraId="CCC" w15:done="0"/>',
        ),
      },
    });
    const top = [...d.querySelectorAll('section.mc-docx-comments > ol > li')];
    expect(top.map((li) => li.id)).toEqual(['mc-cm-0', 'mc-cm-2']);
    const replies = [...top[0].querySelectorAll(':scope > ol > li')];
    expect(replies.map((li) => li.id)).toEqual(['mc-cm-1']);
    expect(text(replies[0])).toContain('Bob');
    expect(text(replies[0])).toContain('Answer.');
    expect(top[0].querySelectorAll('.mc-docx-resolved')).toHaveLength(1);
    expect(top[1].querySelector('.mc-docx-resolved')).toBeNull();
  });

  it('lists replies in order when there is no thread data', () => {
    const d = dom({
      body: `<w:p>${start(0)}${run('text')}${end(0)}${end(1)}</w:p>`,
      extra: {
        'word/comments.xml': wml('comments', comment(0, 'Ann', 'One') + comment(1, 'Bob', 'Two')),
      },
    });
    expect(
      [...d.querySelectorAll('section.mc-docx-comments > ol > li')].map((li) => li.id),
    ).toEqual(['mc-cm-0', 'mc-cm-1']);
  });

  it('places the Comments section after the footnotes', () => {
    const d = dom({
      body: `<w:p>${start(0)}${run('text')}<w:r><w:footnoteReference w:id="1"/></w:r>${end(0)}</w:p>`,
      footnotes: '<w:footnote w:id="1"><w:p><w:r><w:t>A note.</w:t></w:r></w:p></w:footnote>',
      extra: { 'word/comments.xml': wml('comments', comment(0, 'Ann', 'One')) },
    });
    const kids = [...d.querySelector('.mc-docx')!.children].map((c) => c.className);
    expect(kids.indexOf('mc-docx-notes')).toBeLessThan(kids.indexOf('mc-docx-comments'));
  });

  it('shows a comment that the body never anchors', () => {
    const d = dom({
      body: para('Plain'),
      extra: { 'word/comments.xml': wml('comments', comment(0, 'Ann', 'Orphan')) },
    });
    expect(text(d.querySelector('section.mc-docx-comments'))).toContain('Orphan');
    expect(d.querySelector('section.mc-docx-comments a.mc-docx-backref')).toBeNull();
  });

  it('survives malformed comments and thread parts', () => {
    const d = dom({
      body: `<w:p>${start(0)}${run('text')}${end(0)}</w:p>`,
      extra: {
        'word/comments.xml': '<w:comments><w:comment w:id="0"><w:p>',
        'word/commentsExtended.xml': '<broken',
      },
    });
    expect(text(d.querySelector('.mc-docx > p'))).toBe('text');
    expect(d.querySelector('section.mc-docx-comments')).toBeNull();
    expect(d.querySelector('sup.mc-docx-commentref')).toBeNull();
  });

  it('survives malformed thread data beside good comments', () => {
    const d = dom({
      body: `<w:p>${start(0)}${run('text')}${end(0)}</w:p>`,
      extra: {
        'word/comments.xml': wml('comments', comment(0, 'Ann', 'Fine', 'AAA')),
        'word/commentsExtended.xml': '<broken',
      },
    });
    expect(text(d.querySelector('section.mc-docx-comments'))).toContain('Fine');
  });

  it('survives a thread that names itself as its parent', () => {
    const d = dom({
      body: `<w:p>${start(0)}${run('text')}${end(0)}</w:p>`,
      extra: {
        'word/comments.xml': wml('comments', comment(0, 'Ann', 'Loop', 'AAA')),
        'word/commentsExtended.xml': ext(
          '<w15:commentEx w15:paraId="AAA" w15:paraIdParent="AAA"/>',
        ),
      },
    });
    expect(d.querySelectorAll('section.mc-docx-comments li')).toHaveLength(1);
  });
});

describe('charts', () => {
  const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
  const chartDrawing = (descr?: string, uri = C): string =>
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/>' +
    `<wp:docPr id="5" name="Chart 1"${descr ? ` descr="${descr}"` : ''}/>` +
    `<a:graphic><a:graphicData uri="${uri}"><c:chart r:id="rIdChart"/></a:graphicData></a:graphic>` +
    '</wp:inline></w:drawing></w:r></w:p>';
  const space = (inner: string): string =>
    `${XML}<c:chartSpace ${NS}><c:chart>${inner}</c:chart></c:chartSpace>`;
  const str = (...v: string[]): string =>
    `<c:strRef><c:f>Sheet1!A1</c:f><c:strCache><c:ptCount val="${v.length}"/>${v
      .map((s, i) => `<c:pt idx="${i}"><c:v>${s}</c:v></c:pt>`)
      .join('')}</c:strCache></c:strRef>`;
  const nums = (code: string, ...v: (string | undefined)[]): string =>
    `<c:numRef><c:f>Sheet1!B1</c:f><c:numCache><c:formatCode>${code}</c:formatCode><c:ptCount val="${v.length}"/>${v
      .map((s, i) => (s === undefined ? '' : `<c:pt idx="${i}"><c:v>${s}</c:v></c:pt>`))
      .join('')}</c:numCache></c:numRef>`;
  const ser = (name: string, cat: string, val: string): string =>
    `<c:ser><c:tx>${str(name)}</c:tx><c:cat>${cat}</c:cat><c:val>${val}</c:val></c:ser>`;
  const withChart = (xml: string, drawingXml = chartDrawing()) => ({
    body: drawingXml,
    rels: relOf('rIdChart', 'chart', 'charts/chart1.xml'),
    extra: { 'word/charts/chart1.xml': xml },
  });
  const rowsOf = (d: Document): string[][] =>
    [...d.querySelectorAll('figure.mc-docx-chart tr')].map((tr) => [...tr.children].map(text));

  it('draws a bar chart with two series as a table', () => {
    const d = dom(
      withChart(
        space(
          '<c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title>' +
            '<c:plotArea><c:barChart><c:barDir val="col"/>' +
            ser(
              '2025',
              `<c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef>`,
              nums('General', '10', '20'),
            ) +
            ser('2026', str('Q1', 'Q2'), nums('General', '12', '25')) +
            '</c:barChart></c:plotArea>',
        ),
        chartDrawing('Revenue by quarter'),
      ),
    );
    const fig = d.querySelector('figure.mc-docx-chart')!;
    expect(text(fig.querySelector('figcaption'))).toBe('Revenue (Bar chart)');
    expect(fig.getAttribute('aria-label')).toBe('Revenue by quarter');
    expect(rowsOf(d)).toEqual([
      ['Category', '2025', '2026'],
      ['Q1', '10', '12'],
      ['Q2', '20', '25'],
    ]);
    expect(fig.querySelectorAll('thead th')).toHaveLength(3);
    // The figure sits between paragraphs, not inside one.
    expect(d.querySelector('p figure')).toBeNull();
  });

  it('draws a pie chart with percent formatting, and the alt text as the title', () => {
    const d = dom(
      withChart(
        space(
          '<c:plotArea><c:pieChart><c:ser><c:tx>' +
            str('Share') +
            '</c:tx><c:cat>' +
            str('A', 'B') +
            '</c:cat><c:val>' +
            nums('0%', '0.25', '0.75') +
            '</c:val></c:ser></c:pieChart></c:plotArea>',
        ),
        chartDrawing('Market share'),
      ),
    );
    expect(text(d.querySelector('figcaption'))).toBe('Market share (Pie chart)');
    expect(rowsOf(d)).toEqual([
      ['Category', 'Share'],
      ['A', '25%'],
      ['B', '75%'],
    ]);
  });

  it('applies a fixed-decimal format code and leaves other codes raw', () => {
    const d = dom(
      withChart(
        space(
          `<c:plotArea><c:lineChart>${ser('S', str('a', 'b'), nums('0.00', '1.5', '2'))}${ser('T', str('a', 'b'), nums('#,##0', '1234', '5'))}</c:lineChart></c:plotArea>`,
        ),
      ),
    );
    expect(rowsOf(d).slice(1)).toEqual([
      ['a', '1.50', '1234'],
      ['b', '2.00', '5'],
    ]);
    expect(text(d.querySelector('figcaption'))).toBe('Line chart');
  });

  it('draws a scatter chart from xVal and yVal', () => {
    const d = dom(
      withChart(
        space(
          '<c:plotArea><c:scatterChart><c:ser><c:tx>' +
            str('Trend') +
            '</c:tx><c:xVal>' +
            nums('General', '1', '2', '3') +
            '</c:xVal><c:yVal>' +
            nums('General', '4', '5', '6') +
            '</c:yVal></c:ser></c:scatterChart></c:plotArea>',
        ),
      ),
    );
    expect(text(d.querySelector('figcaption'))).toBe('Scatter chart');
    expect(rowsOf(d)).toEqual([
      ['X', 'Trend'],
      ['1', '4'],
      ['2', '5'],
      ['3', '6'],
    ]);
  });

  it('uses the innermost level of multi-level categories and keeps point gaps', () => {
    const multi =
      '<c:multiLvlStrRef><c:multiLvlStrCache><c:ptCount val="3"/>' +
      '<c:lvl><c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="1"><c:v>Feb</c:v></c:pt><c:pt idx="2"><c:v>Jan</c:v></c:pt></c:lvl>' +
      '<c:lvl><c:pt idx="0"><c:v>2025</c:v></c:pt><c:pt idx="2"><c:v>2026</c:v></c:pt></c:lvl>' +
      '</c:multiLvlStrCache></c:multiLvlStrRef>';
    const d = dom(
      withChart(
        space(
          `<c:plotArea><c:areaChart>${ser('S', multi, nums('General', '1', undefined, '3'))}</c:areaChart></c:plotArea>`,
        ),
      ),
    );
    expect(rowsOf(d)).toEqual([
      ['Category', 'S'],
      ['Jan', '1'],
      ['Feb', ''],
      ['Jan', '3'],
    ]);
    expect(text(d.querySelector('figcaption'))).toBe('Area chart');
  });

  it('names combined chart types', () => {
    const d = dom(
      withChart(
        space(
          `<c:plotArea><c:barChart>${ser('A', str('x'), nums('General', '1'))}</c:barChart><c:lineChart>${ser('B', str('x'), nums('General', '2'))}</c:lineChart></c:plotArea>`,
        ),
      ),
    );
    expect(text(d.querySelector('figcaption'))).toBe('Bar and line chart');
    expect(rowsOf(d)[0]).toEqual(['Category', 'A', 'B']);
  });

  it('shows a labeled placeholder when the chart has no cached values', () => {
    const d = dom(
      withChart(
        space(
          '<c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:f>Sheet1!B1</c:f></c:strRef></c:tx>' +
            '<c:val><c:numRef><c:f>Sheet1!B2:B3</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea>',
        ),
        chartDrawing('Sales'),
      ),
    );
    expect(d.querySelector('figure')).toBeNull();
    expect(text(d.querySelector('.mc-docx-placeholder'))).toBe('Chart (no data to show): Sales');
  });

  it('shows a placeholder for a chartex chart, a missing part, and a malformed part', () => {
    const chartex = dom(
      withChart(
        space(''),
        chartDrawing(undefined, 'http://schemas.microsoft.com/office/drawing/2014/chartex').replace(
          'c:chart r:id',
          'cx:chart r:id',
        ),
      ),
    );
    expect(text(chartex.querySelector('.mc-docx-placeholder'))).toMatch(/not supported/);

    const missing = dom({ body: chartDrawing(), rels: relOf('rIdChart', 'chart', 'charts/x.xml') });
    expect(text(missing.querySelector('.mc-docx-placeholder'))).toBe('Chart (data not available)');

    const broken = dom(withChart('<c:chartSpace><c:chart><c:plotArea>'));
    expect(text(broken.querySelector('.mc-docx-placeholder'))).toBe('Chart (no data to show)');
    expect(text(broken.querySelector('.mc-docx-placeholder'))).not.toBe('');
  });

  it('escapes titles, series names, and values', () => {
    const d = dom(
      withChart(
        space(
          '<c:title><c:tx><c:rich><a:p><a:r><a:t>&lt;b&gt;T&lt;/b&gt;</a:t></a:r></a:p></c:rich></c:tx></c:title>' +
            `<c:plotArea><c:barChart>${ser('&lt;i&gt;n', str('&lt;u&gt;c'), nums('General', '1'))}</c:barChart></c:plotArea>`,
        ),
      ),
    );
    expect(d.querySelector('figure b, figure i, figure u')).toBeNull();
    expect(text(d.querySelector('figcaption'))).toBe('<b>T</b> (Bar chart)');
  });
});
