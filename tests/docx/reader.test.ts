import { describe, expect, it } from 'vitest';
import DOMPurify from 'dompurify';
import { strToU8, zipSync } from 'fflate';
import { renderDocxHtml, DocxError } from '../../src/docx/read';
import {
  buildDocx,
  cell,
  drawing,
  externalRel,
  imageRel,
  list,
  lvl,
  numPr,
  para,
  PNG_1x1,
  removePart,
  row,
  run,
  style,
  table,
  type DocxSpec,
} from './fixture';

function html(spec: DocxSpec, opts?: Parameters<typeof renderDocxHtml>[1]): string {
  return renderDocxHtml(buildDocx(spec), opts).html;
}

/** The body only, without the `.mc-docx` wrapper. */
function body(spec: DocxSpec, opts?: Parameters<typeof renderDocxHtml>[1]): string {
  return html(spec, opts)
    .replace(/^<div class="mc-docx">/, '')
    .replace(/<\/div>$/, '');
}

describe('headings', () => {
  const styles =
    style('Title') +
    style('Heading1', { name: 'heading 1' }) +
    style('Heading2', { name: 'heading 2', basedOn: 'Normal' }) +
    style('Heading3', { name: 'heading 3' }) +
    // A localized id: only the style name says it is a heading.
    style('Kop1', { name: 'heading 1' }) +
    style('MyHead', { name: 'My Head', basedOn: 'Heading2' }) +
    style('MyDeeper', { name: 'My Deeper', basedOn: 'MyHead' }) +
    style('Outlined', { pPr: '<w:outlineLvl w:val="2"/>' }) +
    style('Deep', { pPr: '<w:outlineLvl w:val="7"/>' }) +
    style('NotAHeading', { basedOn: 'Heading1', pPr: '<w:outlineLvl w:val="9"/>' }) +
    style('Normal');

  it('maps Title to h1 and Heading 1 to h1 too, with a class marking the title', () => {
    const out = body({
      styles,
      body:
        para('The Doc', '<w:pStyle w:val="Title"/>') +
        para('Intro', '<w:pStyle w:val="Heading1"/>'),
    });
    expect(out).toContain('<h1 class="mc-docx-title">The Doc</h1>');
    expect(out).toContain('<h1>Intro</h1>');
  });

  it('maps Heading 1 to 6 through their levels', () => {
    const out = body({
      styles:
        styles +
        style('Heading4', { name: 'heading 4' }) +
        style('Heading6', { name: 'heading 6' }),
      body:
        para('Two', '<w:pStyle w:val="Heading2"/>') +
        para('Three', '<w:pStyle w:val="Heading3"/>') +
        para('Four', '<w:pStyle w:val="Heading4"/>') +
        para('Six', '<w:pStyle w:val="Heading6"/>'),
    });
    expect(out).toBe('<h2>Two</h2><h3>Three</h3><h4>Four</h4><h6>Six</h6>');
  });

  it('resolves a heading through a basedOn chain', () => {
    const out = body({
      styles,
      body:
        para('One level', '<w:pStyle w:val="MyHead"/>') +
        para('Two levels', '<w:pStyle w:val="MyDeeper"/>'),
    });
    expect(out).toBe('<h2>One level</h2><h2>Two levels</h2>');
  });

  it('recognizes a heading by its style name when the id is localized', () => {
    expect(body({ styles, body: para('Kapitel', '<w:pStyle w:val="Kop1"/>') })).toBe(
      '<h1>Kapitel</h1>',
    );
  });

  it('uses outlineLvl from a style, and clamps deep levels to h6', () => {
    const out = body({
      styles,
      body:
        para('Outlined', '<w:pStyle w:val="Outlined"/>') + para('Deep', '<w:pStyle w:val="Deep"/>'),
    });
    expect(out).toBe('<h3>Outlined</h3><h6>Deep</h6>');
  });

  it('lets a paragraph outlineLvl win over its style, and 9 mean body text', () => {
    const out = body({
      styles,
      body:
        para('Direct', '<w:outlineLvl w:val="3"/>') +
        para('Demoted', '<w:pStyle w:val="Heading1"/><w:outlineLvl w:val="9"/>') +
        para('Inherited body', '<w:pStyle w:val="NotAHeading"/>'),
    });
    expect(out).toBe('<h4>Direct</h4><p>Demoted</p><p>Inherited body</p>');
  });

  it('survives a basedOn cycle', () => {
    const out = body({
      styles: style('A', { basedOn: 'B' }) + style('B', { basedOn: 'A' }),
      body: para('Loop', '<w:pStyle w:val="A"/>'),
    });
    expect(out).toBe('<p>Loop</p>');
  });

  it('keeps a numbered heading a heading rather than a list item', () => {
    const out = body({
      styles: style('Heading1', { name: 'heading 1', pPr: numPr(1) }),
      numbering: list(1, lvl(0, 'decimal')),
      body: para('Numbered heading', '<w:pStyle w:val="Heading1"/>'),
    });
    expect(out).toBe('<h1>Numbered heading</h1>');
  });
});

describe('paragraphs and runs', () => {
  it('renders bold, italic, underline, strike, superscript and subscript', () => {
    const out = body({
      body: para(
        run('b', '<w:b/>') +
          run('i', '<w:i/>') +
          run('u', '<w:u w:val="single"/>') +
          run('s', '<w:strike/>') +
          run('up', '<w:vertAlign w:val="superscript"/>') +
          run('dn', '<w:vertAlign w:val="subscript"/>'),
      ),
    });
    expect(out).toBe(
      '<p><strong>b</strong><em>i</em><u>u</u><s>s</s><sup>up</sup><sub>dn</sub></p>',
    );
  });

  it('stacks formats and merges adjacent runs that share them', () => {
    const out = body({
      body: para(run('a', '<w:b/><w:i/>') + run('b', '<w:b/><w:i/>') + run('c', '<w:b/>')),
    });
    expect(out).toBe('<p><strong><em>ab</em></strong><strong>c</strong></p>');
  });

  it('treats val=0 as off and underline none as off', () => {
    const out = body({
      body: para(run('x', '<w:b w:val="0"/><w:u w:val="none"/><w:i w:val="false"/>')),
    });
    expect(out).toBe('<p>x</p>');
  });

  it('takes bold from a character style', () => {
    const out = body({
      styles: style('Strong', { type: 'character', rPr: '<w:b/>' }),
      body: para(run('loud', '<w:rStyle w:val="Strong"/>')),
    });
    expect(out).toBe('<p><strong>loud</strong></p>');
  });

  it('wraps a monospace run in code, whether the font is direct or from a style', () => {
    const out = body({
      styles: style('VerbatimChar', {
        type: 'character',
        rPr: '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>',
      }),
      body: para(
        run('use ') +
          run('foo()', '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>') +
          run(' or ') +
          run('bar()', '<w:rStyle w:val="VerbatimChar"/>'),
      ),
    });
    expect(out).toBe('<p>use <code>foo()</code> or <code>bar()</code></p>');
  });

  it('renders line breaks and tabs, and ignores page breaks', () => {
    const out = body({
      body: para(
        '<w:r><w:t>a</w:t><w:br/><w:t>b</w:t><w:tab/><w:t>c</w:t><w:br w:type="page"/><w:t>d</w:t></w:r>',
      ),
    });
    expect(out).toBe('<p>a<br>b\tcd</p>');
  });

  it('renders symbols best-effort and drops unknown private-use ones', () => {
    const out = body({
      body: para(
        '<w:r><w:sym w:font="Symbol" w:char="F0B7"/><w:t>x</w:t><w:sym w:font="Wingdings" w:char="F0E9"/></w:r>',
      ),
    });
    expect(out).toBe('<p>\u2022x</p>');
  });

  it('escapes text so markup in a document is shown, not run', () => {
    const out = body({
      body: para(run('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img onerror=x&gt;')),
    });
    expect(out).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img onerror=x&gt;</p>');
    expect(out).not.toContain('<script');
  });

  it('adds alignment classes from the paragraph or its style', () => {
    const out = body({
      styles: style('Centered', { pPr: '<w:jc w:val="center"/>' }),
      body:
        para('a', '<w:jc w:val="center"/>') +
        para('b', '<w:jc w:val="right"/>') +
        para('c', '<w:jc w:val="both"/>') +
        para('d', '<w:pStyle w:val="Centered"/>'),
    });
    expect(out).toBe(
      '<p class="mc-docx-center">a</p><p class="mc-docx-right">b</p><p>c</p><p class="mc-docx-center">d</p>',
    );
  });

  it('drops empty and whitespace-only paragraphs rather than emitting spacing', () => {
    const out = body({
      body:
        para('one') +
        '<w:p/>' +
        '<w:p/>' +
        para('   ') +
        '<w:p><w:r><w:br/></w:r></w:p>' +
        para('two'),
    });
    expect(out).toBe('<p>one</p><p>two</p>');
  });

  it('renders block quotes and merges consecutive quoted paragraphs', () => {
    const out = body({
      styles: style('Quote', { name: 'Quote' }),
      body:
        para('first', '<w:pStyle w:val="Quote"/>') +
        para('second', '<w:pStyle w:val="Quote"/>') +
        para('after'),
    });
    expect(out).toBe('<blockquote><p>first</p><p>second</p></blockquote><p>after</p>');
  });

  it('reads through content controls', () => {
    const out = body({
      body:
        `<w:sdt><w:sdtContent>${para('block control')}</w:sdtContent></w:sdt>` +
        `<w:p><w:sdt><w:sdtContent>${run('inline control')}</w:sdtContent></w:sdt></w:p>`,
    });
    expect(out).toBe('<p>block control</p><p>inline control</p>');
  });
});

describe('code blocks', () => {
  const mono = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>';

  it('groups consecutive monospace paragraphs into one pre', () => {
    const out = body({
      body: para(run('let a = 1;', mono)) + para(run('if (a &lt; 2) {}', mono)) + para('prose'),
    });
    expect(out).toBe('<pre><code>let a = 1;\nif (a &lt; 2) {}</code></pre><p>prose</p>');
  });

  it('keeps a blank line inside a block but not one trailing it', () => {
    const out = body({
      body: para(run('a', mono)) + '<w:p/>' + para(run('b', mono)) + '<w:p/>' + para('after'),
    });
    expect(out).toBe('<pre><code>a\n\nb</code></pre><p>after</p>');
  });

  it('treats a code paragraph style the same way', () => {
    const out = body({
      styles: style('Code', { rPr: '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>' }),
      body: para('x = 1', '<w:pStyle w:val="Code"/>') + para('y = 2', '<w:pStyle w:val="Code"/>'),
    });
    expect(out).toBe('<pre><code>x = 1\ny = 2</code></pre>');
  });

  it('leaves a paragraph with mixed fonts as a paragraph with inline code', () => {
    const out = body({ body: para(run('call ') + run('f()', mono)) });
    expect(out).toBe('<p>call <code>f()</code></p>');
  });
});

describe('lists', () => {
  const numbering =
    list(1, lvl(0, 'bullet') + lvl(1, 'bullet') + lvl(2, 'bullet')) +
    list(2, lvl(0, 'decimal') + lvl(1, 'lowerLetter') + lvl(2, 'lowerRoman')) +
    list(3, lvl(0, 'decimal', 5)) +
    list(
      4,
      lvl(0, 'decimal'),
      '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride>',
    ) +
    list(5, lvl(0, 'upperRoman'));
  const item = (text: string, numId: number, ilvl = 0): string => para(text, numPr(numId, ilvl));

  it('builds a nested bullet list', () => {
    const out = body({
      numbering,
      body: item('A', 1) + item('B', 1) + item('B1', 1, 1) + item('B2', 1, 1) + item('C', 1),
    });
    expect(out).toBe('<ul><li>A</li><li>B<ul><li>B1</li><li>B2</li></ul></li><li>C</li></ul>');
  });

  it('makes ordered lists from the number format, with its marker type', () => {
    const out = body({
      numbering,
      body: item('one', 2) + item('sub', 2, 1) + item('deep', 2, 2) + item('two', 2),
    });
    expect(out).toBe(
      '<ol><li>one<ol type="a"><li>sub<ol type="i"><li>deep</li></ol></li></ol></li><li>two</li></ol>',
    );
  });

  it('closes several levels at once and handles a skipped level', () => {
    const out = body({
      numbering,
      body: item('a', 1) + item('c', 1, 2) + item('d', 1),
    });
    expect(out).toBe('<ul><li>a<ul><li>c</li></ul></li><li>d</li></ul>');
  });

  it('starts a new list when the numId changes', () => {
    const out = body({ numbering, body: item('bullet', 1) + item('number', 2) + item('roman', 5) });
    expect(out).toBe(
      '<ul><li>bullet</li></ul><ol><li>number</li></ol><ol type="I"><li>roman</li></ol>',
    );
  });

  it('nests a deeper item under the open list even when it carries its own numId', () => {
    // How this extension's own Word export writes a nested list: a fresh
    // numId for the sublist.
    const out = body({
      numbering: numbering + list(6, lvl(0, 'bullet') + lvl(1, 'bullet')),
      body: item('Fruit', 1) + item('Apple', 6, 1) + item('Pear', 6, 1) + item('Veg', 1),
    });
    expect(out).toBe('<ul><li>Fruit<ul><li>Apple</li><li>Pear</li></ul></li><li>Veg</li></ul>');
  });

  it('joins consecutive bullet lists with different ids but keeps ordered ones apart', () => {
    const more = list(7, lvl(0, 'bullet')) + list(8, lvl(0, 'decimal'));
    expect(body({ numbering: numbering + more, body: item('a', 1) + item('b', 7) })).toBe(
      '<ul><li>a</li><li>b</li></ul>',
    );
    expect(body({ numbering: numbering + more, body: item('a', 2) + item('b', 8) })).toBe(
      '<ol><li>a</li></ol><ol><li>b</li></ol>',
    );
  });

  it('honors a start value from the level and from a restart override', () => {
    expect(body({ numbering, body: item('x', 3) + item('y', 3) })).toBe(
      '<ol start="5"><li>x</li><li>y</li></ol>',
    );
    expect(body({ numbering, body: item('x', 4) })).toBe('<ol start="7"><li>x</li></ol>');
  });

  it('carries the count on when a list resumes after other content', () => {
    const out = body({
      numbering,
      body: item('a', 2) + item('b', 2) + para('interlude') + item('c', 2),
    });
    expect(out).toBe('<ol><li>a</li><li>b</li></ol><p>interlude</p><ol start="3"><li>c</li></ol>');
  });

  it('lets a blank paragraph sit between items without splitting the list', () => {
    const out = body({ numbering, body: item('a', 1) + '<w:p/>' + item('b', 1) });
    expect(out).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('reads the list from a paragraph style', () => {
    const out = body({
      styles: style('ListBullet', { pPr: numPr(1) }),
      numbering,
      body:
        para('x', '<w:pStyle w:val="ListBullet"/>') + para('y', '<w:pStyle w:val="ListBullet"/>'),
    });
    expect(out).toBe('<ul><li>x</li><li>y</li></ul>');
  });

  it('treats numId 0 as no list', () => {
    expect(body({ numbering, body: para('plain', numPr(0)) })).toBe('<p>plain</p>');
  });

  it('falls back to bullets when the numbering part is missing', () => {
    expect(body({ body: item('a', 9) + item('b', 9) })).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('keeps inline formatting inside an item', () => {
    const out = body({ numbering, body: para(run('bold', '<w:b/>'), numPr(1)) });
    expect(out).toBe('<ul><li><strong>bold</strong></li></ul>');
  });
});

describe('tables', () => {
  const p = (t: string): string => para(t);

  it('renders rows and cells, with a tblHeader row as thead and th', () => {
    const out = body({
      body: table(row(cell(p('Name')) + cell(p('Value')), true) + row(cell(p('a')) + cell(p('1')))),
    });
    expect(out).toBe(
      '<table><thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>' +
        '<tbody><tr><td>a</td><td>1</td></tr></tbody></table>',
    );
  });

  it('maps gridSpan to colspan', () => {
    const out = body({
      body: table(
        row(cell(p('wide'), '<w:gridSpan w:val="2"/>') + cell(p('x'))) +
          row(cell(p('a')) + cell(p('b')) + cell(p('c'))),
      ),
    });
    expect(out).toContain('<tr><td colspan="2">wide</td><td>x</td></tr>');
    expect(out).toContain('<tr><td>a</td><td>b</td><td>c</td></tr>');
  });

  it('maps vMerge to rowspan and drops the covered cells', () => {
    const out = body({
      body: table(
        row(cell(p('A'), '<w:vMerge w:val="restart"/>') + cell(p('b1'))) +
          row(cell('<w:p/>', '<w:vMerge/>') + cell(p('b2'))) +
          row(cell(p('C')) + cell(p('b3'))),
      ),
    });
    expect(out).toBe(
      '<table><tbody>' +
        '<tr><td rowspan="2">A</td><td>b1</td></tr>' +
        '<tr><td>b2</td></tr>' +
        '<tr><td>C</td><td>b3</td></tr>' +
        '</tbody></table>',
    );
  });

  it('combines a header, gridSpan and vMerge in one table', () => {
    const out = body({
      body: table(
        row(cell(p('H'), '<w:gridSpan w:val="2"/>') + cell(p('K')), true) +
          row(cell(p('m'), '<w:vMerge w:val="restart"/>') + cell(p('n')) + cell(p('o'))) +
          row(cell('<w:p/>', '<w:vMerge w:val="continue"/>') + cell(p('q')) + cell(p('r'))),
      ),
    });
    expect(out).toContain(
      '<thead><tr><th scope="col" colspan="2">H</th><th scope="col">K</th></tr></thead>',
    );
    expect(out).toContain('<tr><td rowspan="2">m</td><td>n</td><td>o</td></tr>');
    expect(out).toContain('<tr><td>q</td><td>r</td></tr>');
  });

  it('keeps a lone continue cell with no start above it as an ordinary cell', () => {
    const out = body({ body: table(row(cell(p('x'), '<w:vMerge/>') + cell(p('y')))) });
    expect(out).toContain('<td>x</td><td>y</td>');
  });

  it('does not let a rowspan cross from the header into the body', () => {
    const out = body({
      body: table(
        row(cell(p('H'), '<w:vMerge w:val="restart"/>'), true) + row(cell('<w:p/>', '<w:vMerge/>')),
      ),
    });
    expect(out).not.toContain('rowspan');
  });

  it('renders a nested table inside a cell', () => {
    const inner = table(row(cell(p('in'))));
    const out = body({ body: table(row(cell(p('outer') + inner))) });
    expect(out).toBe(
      '<table><tbody><tr><td><p>outer</p><table><tbody><tr><td>in</td></tr></tbody></table></td></tr></tbody></table>',
    );
  });

  it('keeps several paragraphs and a list in one cell', () => {
    const out = body({
      numbering: list(1, lvl(0, 'bullet')),
      body: table(row(cell(p('one') + para('two') + para('item', numPr(1))))),
    });
    expect(out).toContain('<td><p>one</p><p>two</p><ul><li>item</li></ul></td>');
  });

  it('skips a row deleted under track changes and an empty table', () => {
    const out = body({
      body:
        table(
          '<w:tr><w:trPr><w:del/></w:trPr>' + cell(p('gone')) + '</w:tr>' + row(cell(p('kept'))),
        ) + '<w:tbl><w:tblPr/></w:tbl>',
    });
    expect(out).toBe('<table><tbody><tr><td>kept</td></tr></tbody></table>');
  });

  it('names a table nested too deeply rather than recursing without bound', () => {
    let nested = table(row(cell(p('core'))));
    for (let i = 0; i < 12; i++) {
      nested = table(row(cell(nested)));
    }
    const out = body({ body: nested });
    expect(out).toContain('Table nested too deeply to show');
  });
});

describe('hyperlinks', () => {
  const rels =
    externalRel('rIdWeb', 'https://example.com/a?x=1&amp;y=2') +
    externalRel('rIdMail', 'mailto:me@example.com') +
    externalRel('rIdJs', 'javascript:alert(1)') +
    externalRel('rIdFile', 'file:///C:/secret.txt') +
    externalRel('rIdFtp', 'ftp://example.com/x') +
    externalRel('rIdUnc', '\\\\\\\\host\\\\share');
  const link = (rid: string, text: string): string =>
    `<w:hyperlink r:id="${rid}">${run(text)}</w:hyperlink>`;

  it('keeps http, https and mailto links', () => {
    const out = body({
      rels,
      body: para(link('rIdWeb', 'site') + ' ' + link('rIdMail', 'mail')),
    });
    expect(out).toContain('<a href="https://example.com/a?x=1&amp;y=2">site</a>');
    expect(out).toContain('<a href="mailto:me@example.com">mail</a>');
  });

  it('turns every other scheme into plain text', () => {
    const out = body({
      rels,
      body: para(
        link('rIdJs', 'js') +
          link('rIdFile', 'file') +
          link('rIdFtp', 'ftp') +
          link('rIdUnc', 'unc') +
          link('rIdMissing', 'none'),
      ),
    });
    expect(out).toBe('<p>jsfileftpuncnone</p>');
    expect(out).not.toContain('<a');
  });

  it('merges runs inside one hyperlink into a single anchor', () => {
    const out = body({
      rels,
      body: para(
        `<w:hyperlink r:id="rIdWeb">${run('a', '<w:b/>')}${run('b')}${run('c')}</w:hyperlink>`,
      ),
    });
    expect(out).toBe('<p><a href="https://example.com/a?x=1&amp;y=2"><strong>a</strong>bc</a></p>');
  });

  it('does not underline link text twice', () => {
    const out = body({
      rels,
      body: para(`<w:hyperlink r:id="rIdWeb">${run('x', '<w:u w:val="single"/>')}</w:hyperlink>`),
    });
    expect(out).not.toContain('<u>');
  });

  it('links to a bookmark by sanitized id', () => {
    const out = body({
      body:
        para(`<w:hyperlink w:anchor="_Toc1">${run('Jump')}</w:hyperlink>`) +
        `<w:p><w:bookmarkStart w:id="0" w:name="_Toc1"/>${run('Target')}<w:bookmarkEnd w:id="0"/></w:p>`,
    });
    expect(out).toContain('<a href="#mc-bm-_Toc1">Jump</a>');
    expect(out).toContain('<p><span id="mc-bm-_Toc1"></span>Target</p>');
  });

  it('puts a bookmark inside a heading so the id lands on it', () => {
    const out = body({
      styles: style('Heading1', { name: 'heading 1' }),
      body: `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="1" w:name="intro"/>${run('Intro')}</w:p>`,
    });
    expect(out).toBe('<h1><span id="mc-bm-intro"></span>Intro</h1>');
  });

  it('sanitizes hostile bookmark names and keeps only the first of a duplicate', () => {
    const out = body({
      body:
        `<w:p><w:bookmarkStart w:id="0" w:name="a b&quot;&gt;&lt;x"/>${run('1')}</w:p>` +
        `<w:p><w:bookmarkStart w:id="1" w:name="a b&quot;&gt;&lt;x"/>${run('2')}</w:p>` +
        `<w:p><w:bookmarkStart w:id="2" w:name="_GoBack"/>${run('3')}</w:p>`,
    });
    expect(out).toBe('<p><span id="mc-bm-a-b---x"></span>1</p><p>2</p><p>3</p>');
  });

  it('follows a HYPERLINK field and hides its instruction', () => {
    const fld = (type: string): string => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
    const out = body({
      body: para(
        fld('begin') +
          '<w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.org/" </w:instrText></w:r>' +
          fld('separate') +
          run('the site') +
          fld('end') +
          run(' after'),
      ),
    });
    expect(out).toBe('<p><a href="https://example.org/">the site</a> after</p>');
    expect(out).not.toContain('HYPERLINK');
  });

  it('follows a HYPERLINK field to a bookmark with \\l', () => {
    const out = body({
      body: para(
        '<w:fldSimple w:instr=" HYPERLINK \\l &quot;chap1&quot; ">' +
          run('see chapter') +
          '</w:fldSimple>',
      ),
    });
    expect(out).toBe('<p><a href="#mc-bm-chap1">see chapter</a></p>');
  });

  it('refuses a javascript: HYPERLINK field', () => {
    const out = body({
      body: para(
        '<w:fldSimple w:instr=" HYPERLINK &quot;javascript:alert(1)&quot; ">' +
          run('x') +
          '</w:fldSimple>',
      ),
    });
    expect(out).toBe('<p>x</p>');
  });
});

describe('images', () => {
  const rels = imageRel('rIdImg', 'media/image1.png');
  const media = { 'word/media/image1.png': PNG_1x1 };
  const dataUri = `data:image/png;base64,${Buffer.from(PNG_1x1).toString('base64')}`;

  it('inlines an embedded image as a data URI with its alt text and declared size', () => {
    const out = body({
      rels,
      media,
      body: para(drawing({ descr: 'A cat', cx: 952500, cy: 476250 })),
    });
    expect(out).toBe(`<p><img src="${dataUri}" alt="A cat" width="100" height="50"></p>`);
  });

  it('falls back to the title for alt text, then to an empty alt', () => {
    expect(body({ rels, media, body: para(drawing({ title: 'Titled' })) })).toContain(
      'alt="Titled"',
    );
    expect(body({ rels, media, body: para(drawing({})) })).toContain('alt=""');
  });

  it('escapes alt text', () => {
    const out = body({
      rels,
      media,
      body: para(drawing({ descr: 'a &quot;q&quot; &lt;b&gt; &amp;' })),
    });
    expect(out).toContain('alt="a &quot;q&quot; &lt;b&gt; &amp;"');
  });

  it('reads an anchored image too', () => {
    const anchored = drawing({ descr: 'floating' }).replace(/wp:inline/g, 'wp:anchor');
    expect(body({ rels, media, body: para(anchored) })).toContain('alt="floating"');
  });

  it('shows an image in its own paragraph even with no text', () => {
    expect(body({ rels, media, body: para(drawing({ descr: 'x' })) })).toContain('<img');
  });

  it('labels an unsupported format (EMF) instead of showing a broken image', () => {
    const out = body({
      rels: imageRel('rIdImg', 'media/image2.emf'),
      media: { 'word/media/image2.emf': new Uint8Array([1, 2, 3]) },
      body: para(drawing({ descr: 'Chart' })),
    });
    expect(out).toBe('<p><span class="mc-docx-placeholder">Image: Chart</span></p>');
  });

  it('never fetches a linked image and says so', () => {
    const out = body({
      rels: `<Relationship Id="rIdLink" Type="x/image" Target="http://evil.test/p.png" TargetMode="External"/>`,
      body: para(drawing({ link: 'rIdLink', descr: 'remote' })),
    });
    expect(out).toContain('Linked image (not loaded)');
    expect(out).not.toContain('evil.test');
    expect(out).not.toContain('<img');
  });

  it('labels an image whose relationship or part is missing', () => {
    expect(body({ body: para(drawing({ embed: 'rIdGone' })) })).toContain('mc-docx-placeholder');
    expect(body({ rels, body: para(drawing({})) })).toContain('mc-docx-placeholder');
  });

  it('stops inlining once the media budget is spent, but reuses an encoded image', () => {
    const twice = para(drawing({ descr: 'one' }) + drawing({ descr: 'two' }));
    expect(body({ rels, media, body: twice }).match(/<img/g)).toHaveLength(2);
    expect(body({ rels, media, body: twice }, { maxMediaBytes: 4 })).not.toContain('<img');
  });

  it('shows one picture, not two, for a drawing with a VML fallback', () => {
    const alt =
      '<w:r><mc:AlternateContent><mc:Choice Requires="wps">' +
      drawing({ descr: 'modern' }).replace(/^<w:r>|<\/w:r>$/g, '') +
      '</mc:Choice><mc:Fallback><w:pict><v:shape alt="legacy"><v:imagedata r:id="rIdImg"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>';
    const out = body({ rels, media, body: para(alt) });
    expect(out.match(/<img/g)).toHaveLength(1);
    expect(out).toContain('alt="modern"');
  });

  it('reads a legacy VML picture', () => {
    const out = body({
      rels,
      media,
      body: para(
        '<w:r><w:pict><v:shape alt="old school"><v:imagedata r:id="rIdImg"/></v:shape></w:pict></w:r>',
      ),
    });
    expect(out).toContain('alt="old school"');
  });
});

describe('track changes and fields', () => {
  it('shows inserted text and drops deleted text', () => {
    const out = body({
      body: para(
        run('keep ') +
          `<w:ins w:id="1" w:author="a">${run('added ')}</w:ins>` +
          `<w:del w:id="2" w:author="a">${run('removed ')}</w:del>` +
          `<w:moveFrom w:id="3">${run('moved away ')}</w:moveFrom>` +
          `<w:moveTo w:id="4">${run('moved here')}</w:moveTo>`,
      ),
    });
    expect(out).toBe('<p>keep added moved here</p>');
  });

  it('keeps w:delText out even when it sits in an ordinary run', () => {
    const out = body({
      body: para('<w:r><w:delText>gone</w:delText></w:r>' + run('here')),
    });
    expect(out).toBe('<p>here</p>');
  });

  it('shows the result of a simple field', () => {
    const out = body({
      body: para('<w:fldSimple w:instr=" PAGE ">' + run('7') + '</w:fldSimple>'),
    });
    expect(out).toBe('<p>7</p>');
  });

  it('shows the result of a complex field and hides its instruction', () => {
    const fld = (type: string): string => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
    const out = body({
      body: para(
        run('Updated ') +
          fld('begin') +
          '<w:r><w:instrText> DATE \\@ "d MMMM yyyy" </w:instrText></w:r>' +
          fld('separate') +
          run('3 March 2026') +
          fld('end'),
      ),
    });
    expect(out).toBe('<p>Updated 3 March 2026</p>');
  });

  it('skips hidden text', () => {
    const out = body({ body: para(run('secret', '<w:vanish/>') + run('shown')) });
    expect(out).toBe('<p>shown</p>');
  });

  it('skips comments, headers and text boxes', () => {
    const out = body({
      body:
        `<w:p>${run('text')}<w:commentRangeStart w:id="0"/><w:commentRangeEnd w:id="0"/>` +
        '<w:r><w:commentReference w:id="0"/></w:r></w:p>',
      extra: {
        'word/comments.xml':
          '<w:comments xmlns:w="x"><w:comment w:id="0"><w:p><w:r><w:t>COMMENT</w:t></w:r></w:p></w:comment></w:comments>',
        'word/header1.xml': '<w:hdr xmlns:w="x"><w:p><w:r><w:t>HEADER</w:t></w:r></w:p></w:hdr>',
      },
    });
    expect(out).toBe('<p>text</p>');
  });
});

describe('footnotes and endnotes', () => {
  const ref = (kind: 'footnote' | 'endnote', id: number): string =>
    `<w:r><w:${kind}Reference w:id="${id}"/></w:r>`;
  const note = (kind: 'footnote' | 'endnote', id: number, text: string): string =>
    `<w:${kind} w:id="${id}"><w:p><w:r><w:${kind}Ref/></w:r>${run(` ${text}`)}</w:p></w:${kind}>`;

  it('renders references as superscript links and the notes as a list at the end', () => {
    const out = html({
      body: para(run('Claim') + ref('footnote', 2)) + para('Next'),
      footnotes: note('footnote', 2, 'The source.'),
    });
    expect(out).toContain(
      'Claim<sup class="mc-docx-noteref"><a href="#mc-fn-2" id="mc-fnref-2">1</a></sup>',
    );
    expect(out).toContain(
      '<ol><li id="mc-fn-2">The source. <a class="mc-docx-backref" data-mc-ignore="1" href="#mc-fnref-2"',
    );
    expect(out.indexOf('Next')).toBeLessThan(out.indexOf('The source.'));
    expect(out).not.toContain('separator');
  });

  it('numbers notes in the order the body cites them', () => {
    const out = html({
      body: para(ref('footnote', 5) + ref('footnote', 3)),
      footnotes: note('footnote', 3, 'three') + note('footnote', 5, 'five'),
    });
    expect(out.indexOf('five')).toBeLessThan(out.indexOf('three'));
    expect(out).toContain('id="mc-fnref-5">1<');
    expect(out).toContain('id="mc-fnref-3">2<');
  });

  it('renders endnotes separately and ignores a reference to a note that does not exist', () => {
    const out = html({
      body: para(ref('endnote', 1) + ref('footnote', 99)),
      endnotes: note('endnote', 1, 'at the end'),
    });
    expect(out).toContain('href="#mc-en-1"');
    expect(out).toContain('at the end');
    expect(out).not.toContain('mc-fn-99');
  });

  it('resolves a hyperlink inside a note against the notes part rels', () => {
    const out = html({
      body: para(ref('footnote', 2)),
      footnotes: `<w:footnote w:id="2"><w:p><w:hyperlink r:id="rIdN">${run('src')}</w:hyperlink></w:p></w:footnote>`,
      footnoteRels: externalRel('rIdN', 'https://notes.example/'),
    });
    expect(out).toContain('<a href="https://notes.example/">src</a>');
  });
});

describe('robustness', () => {
  it('reports a file that is not a zip, naming the legacy format', () => {
    expect(() => renderDocxHtml(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toThrow(DocxError);
    expect(() => renderDocxHtml(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toThrow(/\.doc format/);
    expect(() => renderDocxHtml(new Uint8Array())).toThrow(DocxError);
  });

  it('reports a package with no document part', () => {
    const bytes = removePart(buildDocx({ body: para('x') }), 'word/document.xml');
    expect(() => renderDocxHtml(bytes)).toThrow(DocxError);
    expect(() => renderDocxHtml(bytes)).toThrow(/no document body/);
  });

  it('reports malformed document XML as a DocxError rather than a raw parser error', () => {
    const bytes = buildDocx({ body: '<w:p><w:r><w:t>unclosed' });
    expect(() => renderDocxHtml(bytes)).toThrow(DocxError);
    expect(() => renderDocxHtml(bytes)).toThrow(/could not be read/);
  });

  it('reports a document with no body element', () => {
    const bytes = buildDocx({
      body: '',
      extra: { 'word/document.xml': '<w:document xmlns:w="x"/>' },
    });
    expect(() => renderDocxHtml(bytes)).toThrow(/no document body/);
  });

  it('still renders when styles, numbering and rels are missing or broken', () => {
    const broken = buildDocx({
      body: para('Hello') + para('item', numPr(1)) + para(drawing({}), ''),
      extra: {
        'word/styles.xml': '<w:styles><w:style',
        'word/numbering.xml': 'not xml at all',
        'word/_rels/document.xml.rels': '<Relationships><Relationship',
      },
    });
    const out = renderDocxHtml(broken).html;
    expect(out).toContain('<p>Hello</p>');
    expect(out).toContain('<ul><li>item</li></ul>');
    expect(out).toContain('mc-docx-placeholder');
  });

  it('still renders without any rels part at all', () => {
    const bytes = removePart(buildDocx({ body: para('plain') }), 'word/_rels/document.xml.rels');
    expect(renderDocxHtml(bytes).html).toContain('<p>plain</p>');
  });

  it('renders broken footnotes as no footnotes', () => {
    const bytes = buildDocx({
      body: para(run('x') + '<w:r><w:footnoteReference w:id="2"/></w:r>'),
      extra: { 'word/footnotes.xml': '<w:footnotes><w:footnote' },
    });
    expect(renderDocxHtml(bytes).html).toContain('<p>x</p>');
  });

  it('says so for a document with nothing in it', () => {
    expect(html({ body: '' })).toContain('no content to show');
  });

  it('finds the main part through the package relationships when it is not word/document.xml', () => {
    const files = {
      '_rels/.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/doc/main.xml"/></Relationships>',
      ),
      'doc/main.xml': strToU8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>moved</w:t></w:r></w:p></w:body></w:document>',
      ),
    };
    expect(renderDocxHtml(zipSync(files)).html).toContain('<p>moved</p>');
  });

  it('refuses an oversized package through the shared zip limits', () => {
    const bytes = buildDocx({ body: para('x') });
    const limits = {
      maxFileBytes: 10,
      maxEntries: 1000,
      maxEntryBytes: 1 << 20,
      maxTotalBytes: 1 << 20,
    };
    expect(() => renderDocxHtml(bytes, { zipLimits: limits })).toThrow(/preview limit/);
    expect(() =>
      renderDocxHtml(bytes, {
        zipLimits: {
          maxFileBytes: 1 << 20,
          maxEntries: 2,
          maxEntryBytes: 1 << 20,
          maxTotalBytes: 1 << 20,
        },
      }),
    ).toThrow(DocxError);
    expect(() =>
      renderDocxHtml(bytes, {
        zipLimits: {
          maxFileBytes: 1 << 20,
          maxEntries: 1000,
          maxEntryBytes: 16,
          maxTotalBytes: 1 << 20,
        },
      }),
    ).toThrow(DocxError);
  });

  it('stops at the paragraph budget and says so', () => {
    const many = Array.from({ length: 10 }, (_, i) => para(`p${i}`)).join('');
    const result = renderDocxHtml(buildDocx({ body: many }), { maxParagraphs: 4 });
    expect(result.truncated).toBe(true);
    expect(result.html).toContain('<p>p3</p>');
    expect(result.html).not.toContain('<p>p4</p>');
    expect(result.html).toContain('Showing the first 4 paragraphs');
  });

  it('does not expand entities declared in a DTD', () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY boom "EXPANDED">]>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:r><w:t>a &boom; b</w:t></w:r></w:p></w:body></w:document>';
    const bytes = buildDocx({ body: '', extra: { 'word/document.xml': xml } });
    let out = '';
    try {
      out = renderDocxHtml(bytes).html;
    } catch (err) {
      expect(err).toBeInstanceOf(DocxError);
    }
    expect(out).not.toContain('EXPANDED');
  });

  it('opens a .docm the same way (same package, same parts)', () => {
    expect(html({ body: para('macro-enabled') })).toContain('macro-enabled');
  });
});

describe('whitespace and the preview sanitizer', () => {
  it('trims the space Word leaves at the ends of a paragraph, but not code indentation', () => {
    const mono = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>';
    const out = body({
      body: para(run('  padded text  ')) + para(run('    indented();', mono)),
    });
    expect(out).toBe('<p>padded text</p><pre><code>    indented();</code></pre>');
  });

  it('produces markup the webview sanitizer (DOMPurify defaults) leaves intact', () => {
    const rels =
      imageRel('rIdImg', 'media/image1.png') + externalRel('rIdWeb', 'https://example.com/');
    const doc = html({
      rels,
      media: { 'word/media/image1.png': PNG_1x1 },
      numbering: list(1, lvl(0, 'lowerRoman', 3)),
      body:
        `<w:p><w:bookmarkStart w:id="0" w:name="top"/>${run('anchor')}</w:p>` +
        para('item', numPr(1)) +
        para(
          drawing({ descr: 'pic' }) +
            `<w:hyperlink r:id="rIdWeb">${run('link')}</w:hyperlink>` +
            '<w:hyperlink w:anchor="top">' +
            run('up') +
            '</w:hyperlink>',
          '<w:jc w:val="center"/>',
        ) +
        table(row(cell(para('H'), '<w:gridSpan w:val="2"/>'), true)),
    });
    const clean = DOMPurify.sanitize(doc);
    const dom = new DOMParser().parseFromString(clean, 'text/html');
    expect(dom.querySelector('span#mc-bm-top')).not.toBeNull();
    expect(dom.querySelector('ol[type="i"][start="3"] > li')).not.toBeNull();
    expect(dom.querySelector('p.mc-docx-center img[width][height]')?.getAttribute('src')).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(dom.querySelector('a[href="https://example.com/"]')).not.toBeNull();
    expect(dom.querySelector('a[href="#mc-bm-top"]')).not.toBeNull();
    expect(dom.querySelector('th[colspan="2"][scope="col"]')).not.toBeNull();
  });
});
