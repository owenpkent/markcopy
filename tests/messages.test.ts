// @vitest-environment node
//
// The webview message parsers (src/messages/*): the host's trust boundary, tested
// without vscode. Each accepts the shapes its handler acts on and nothing else.
import { describe, it, expect } from 'vitest';
import { parseGifMessage } from '../src/messages/gif';
import { parseMarkdownMessage } from '../src/messages/markdown';
import { parseOoxmlMessage } from '../src/messages/ooxml';
import { parsePdfMessage } from '../src/messages/pdf';
import { parseStlMessage } from '../src/messages/stl';
import { parseTexMessage } from '../src/messages/tex';
import { parseVideoMessage } from '../src/messages/video';

type Parser = (raw: unknown) => unknown;

// Things that are not a message object, for every parser.
const NOT_MESSAGES: unknown[] = [
  undefined,
  null,
  0,
  1,
  'ready',
  true,
  [],
  [{ type: 'ready' }],
  {},
  { type: 5 },
  { type: null },
  { type: ['ready'] },
  { type: 'nope' },
  { type: '__proto__' },
  { type: 'constructor' },
  { type: 'toString' },
];

describe.each<[string, Parser]>([
  ['markdown', parseMarkdownMessage],
  ['ooxml', parseOoxmlMessage],
  ['pdf', parsePdfMessage],
  ['tex', parseTexMessage],
  ['stl', parseStlMessage],
  ['video', parseVideoMessage],
  ['gif', parseGifMessage],
])('%s parser', (_name, parse) => {
  it('rejects anything that is not a message with a known type', () => {
    for (const raw of NOT_MESSAGES) {
      expect(parse(raw)).toBeUndefined();
    }
  });
});

describe('parseMarkdownMessage', () => {
  it('accepts the bare messages', () => {
    expect(parseMarkdownMessage({ type: 'revealInOS' })).toEqual({ type: 'revealInOS' });
    expect(parseMarkdownMessage({ type: 'openSettings' })).toEqual({ type: 'openSettings' });
  });

  it('accepts revealLine with a finite number only', () => {
    expect(parseMarkdownMessage({ type: 'revealLine', line: 12 })).toEqual({
      type: 'revealLine',
      line: 12,
    });
    for (const line of ['12', null, undefined, NaN, Infinity, {}, [1]]) {
      expect(parseMarkdownMessage({ type: 'revealLine', line })).toBeUndefined();
    }
  });

  it('accepts toast, updateSetting and openLink with their string fields', () => {
    expect(parseMarkdownMessage({ type: 'toast', text: 'Copied' })).toEqual({
      type: 'toast',
      text: 'Copied',
    });
    expect(parseMarkdownMessage({ type: 'updateSetting', key: 'theme', value: 'dark' })).toEqual({
      type: 'updateSetting',
      key: 'theme',
      value: 'dark',
    });
    expect(parseMarkdownMessage({ type: 'openLink', href: 'https://example.com' })).toEqual({
      type: 'openLink',
      href: 'https://example.com',
    });
    for (const key of [5, null, undefined, ['theme'], {}]) {
      expect(parseMarkdownMessage({ type: 'updateSetting', key, value: 1 })).toBeUndefined();
    }
    for (const href of [5, null, undefined, ['x'], {}]) {
      expect(parseMarkdownMessage({ type: 'openLink', href })).toBeUndefined();
    }
  });

  it('accepts the three export messages with a string body', () => {
    expect(parseMarkdownMessage({ type: 'pdfHtml', bodyHtml: '<p>x</p>' })).toEqual({
      type: 'pdfHtml',
      body: '<p>x</p>',
    });
    expect(parseMarkdownMessage({ type: 'docxXhtml', bodyXhtml: '<p/>' })).toEqual({
      type: 'docxXhtml',
      body: '<p/>',
    });
    expect(parseMarkdownMessage({ type: 'pptxXhtml', bodyXhtml: '<p/>' })).toEqual({
      type: 'pptxXhtml',
      body: '<p/>',
    });
    // Each export names its own field.
    expect(parseMarkdownMessage({ type: 'pdfHtml', bodyXhtml: 'x' })).toBeUndefined();
    expect(parseMarkdownMessage({ type: 'docxXhtml', bodyHtml: 'x' })).toBeUndefined();
    expect(parseMarkdownMessage({ type: 'pptxXhtml', bodyXhtml: 5 })).toBeUndefined();
    expect(parseMarkdownMessage({ type: 'pdfHtml' })).toBeUndefined();
  });

  it('accepts editCell with integer coordinates and a string value', () => {
    expect(
      parseMarkdownMessage({ type: 'editCell', line: 3, column: 1, value: 'x', docVersion: 7 }),
    ).toEqual({ type: 'editCell', line: 3, column: 1, value: 'x', docVersion: 7 });
    // No (or a non-numeric) docVersion is left out, not carried as garbage.
    expect(parseMarkdownMessage({ type: 'editCell', line: 3, column: 1, value: '' })).toEqual({
      type: 'editCell',
      line: 3,
      column: 1,
      value: '',
    });
    expect(
      parseMarkdownMessage({ type: 'editCell', line: 3, column: 1, value: '', docVersion: '7' }),
    ).toEqual({ type: 'editCell', line: 3, column: 1, value: '' });
    const base = { type: 'editCell', line: 3, column: 1, value: 'x' };
    expect(parseMarkdownMessage({ ...base, line: 1.5 })).toBeUndefined();
    expect(parseMarkdownMessage({ ...base, column: NaN })).toBeUndefined();
    expect(parseMarkdownMessage({ ...base, line: undefined })).toBeUndefined();
    expect(parseMarkdownMessage({ ...base, column: {} })).toBeUndefined();
    expect(parseMarkdownMessage({ ...base, value: 5 })).toBeUndefined();
    expect(parseMarkdownMessage({ ...base, value: undefined })).toBeUndefined();
  });

  it('accepts gridOp for the known operations only', () => {
    expect(
      parseMarkdownMessage({ type: 'gridOp', op: 'deleteRow', line: 2, column: 0, docVersion: 4 }),
    ).toEqual({ type: 'gridOp', op: 'deleteRow', line: 2, column: 0, docVersion: 4 });
    const base = { type: 'gridOp', op: 'insertColumnLeft', line: 0, column: 0 };
    expect(parseMarkdownMessage(base)).toEqual(base);
    expect(parseMarkdownMessage({ ...base, op: 'dropTable' })).toBeUndefined();
    expect(parseMarkdownMessage({ ...base, op: 5 })).toBeUndefined();
    expect(parseMarkdownMessage({ ...base, op: undefined })).toBeUndefined();
    expect(parseMarkdownMessage({ ...base, line: 0.5 })).toBeUndefined();
    expect(parseMarkdownMessage({ ...base, column: Infinity })).toBeUndefined();
  });

  it('accepts editBlock whatever its fields, so a refused edit is still answered', () => {
    const full = {
      type: 'editBlock',
      editId: 4,
      docKey: 'file:///a.md',
      startLine: 0,
      endLine: 2,
      original: 'a',
      text: 'b',
    };
    expect(parseMarkdownMessage(full)).toEqual(full);
    // editId must be a safe integer to be carried; the rest is for planBlockEdit.
    expect(parseMarkdownMessage({ ...full, editId: 1.5 })).not.toHaveProperty('editId');
    expect(parseMarkdownMessage({ ...full, editId: '4' })).not.toHaveProperty('editId');
    expect(parseMarkdownMessage({ ...full, editId: 2 ** 60 })).not.toHaveProperty('editId');
    expect(parseMarkdownMessage({ type: 'editBlock' })).toMatchObject({ type: 'editBlock' });
  });

  it('ignores types that belong to other surfaces', () => {
    for (const type of ['ready', 'saveFrame', 'saveComments', 'texRecompile', 'selectSheet']) {
      expect(parseMarkdownMessage({ type })).toBeUndefined();
    }
  });
});

describe('parseOoxmlMessage', () => {
  it('accepts the shared messages', () => {
    for (const type of ['ready', 'revealInOS', 'openSettings']) {
      expect(parseOoxmlMessage({ type })).toEqual({ type });
    }
    expect(parseOoxmlMessage({ type: 'toast', text: 'hi' })).toEqual({ type: 'toast', text: 'hi' });
    expect(parseOoxmlMessage({ type: 'updateSetting', key: 'theme', value: 'dark' })).toEqual({
      type: 'updateSetting',
      key: 'theme',
      value: 'dark',
    });
    expect(parseOoxmlMessage({ type: 'openLink', href: 'mailto:a@b.c' })).toEqual({
      type: 'openLink',
      href: 'mailto:a@b.c',
    });
    expect(parseOoxmlMessage({ type: 'pdfHtml', bodyHtml: 'x' })).toEqual({
      type: 'pdfHtml',
      body: 'x',
    });
    expect(parseOoxmlMessage({ type: 'docxXhtml', bodyXhtml: 'x' })).toEqual({
      type: 'docxXhtml',
      body: 'x',
    });
    expect(parseOoxmlMessage({ type: 'pptxXhtml', bodyXhtml: 'x' })).toEqual({
      type: 'pptxXhtml',
      body: 'x',
    });
  });

  it('rejects the wrong field types', () => {
    expect(parseOoxmlMessage({ type: 'updateSetting', key: 1 })).toBeUndefined();
    expect(parseOoxmlMessage({ type: 'openLink', href: null })).toBeUndefined();
    expect(parseOoxmlMessage({ type: 'pdfHtml', bodyHtml: 1 })).toBeUndefined();
    expect(parseOoxmlMessage({ type: 'docxXhtml', bodyHtml: 'x' })).toBeUndefined();
  });

  it('accepts selectSheet with a non-negative integer index', () => {
    expect(parseOoxmlMessage({ type: 'selectSheet', index: 0 })).toEqual({
      type: 'selectSheet',
      index: 0,
    });
    expect(parseOoxmlMessage({ type: 'selectSheet', index: 3 })).toEqual({
      type: 'selectSheet',
      index: 3,
    });
    for (const index of [-1, 1.5, NaN, Infinity, undefined, {}]) {
      expect(parseOoxmlMessage({ type: 'selectSheet', index })).toBeUndefined();
    }
  });

  it('ignores editing messages, which these previews never accept', () => {
    for (const type of ['editCell', 'gridOp', 'editBlock', 'revealLine', 'saveComments']) {
      expect(parseOoxmlMessage({ type, line: 1, column: 1, value: 'x' })).toBeUndefined();
    }
  });
});

describe('parsePdfMessage and parseTexMessage', () => {
  it('accept the PDF messages', () => {
    for (const parse of [parsePdfMessage, parseTexMessage]) {
      expect(parse({ type: 'ready' })).toEqual({ type: 'ready' });
      expect(parse({ type: 'revealInOS' })).toEqual({ type: 'revealInOS' });
      expect(parse({ type: 'saveComments', comments: [{ page: 1 }] })).toEqual({
        type: 'saveComments',
        comments: [{ page: 1 }],
      });
      expect(parse({ type: 'updateSetting', key: 'theme', value: 'dark' })).toEqual({
        type: 'updateSetting',
        key: 'theme',
        value: 'dark',
      });
      expect(parse({ type: 'updateSetting', key: 3, value: 'dark' })).toBeUndefined();
    }
  });

  it('accept texRecompile on the LaTeX preview only', () => {
    expect(parseTexMessage({ type: 'texRecompile' })).toEqual({ type: 'texRecompile' });
    expect(parsePdfMessage({ type: 'texRecompile' })).toBeUndefined();
  });
});

describe('parseStlMessage', () => {
  it('accepts only ready', () => {
    expect(parseStlMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseStlMessage({ type: 'revealInOS' })).toBeUndefined();
    expect(parseStlMessage({ type: 'updateSetting', key: 'theme', value: 'dark' })).toBeUndefined();
  });
});

describe('parseGifMessage', () => {
  it('accepts the GIF messages', () => {
    for (const type of ['ready', 'revealInOS', 'openExternal']) {
      expect(parseGifMessage({ type })).toEqual({ type });
    }
    expect(parseGifMessage({ type: 'saveFrame', data: 'AAAA', name: 'f.png' })).toEqual({
      type: 'saveFrame',
      data: 'AAAA',
      name: 'f.png',
    });
    expect(parseGifMessage({ type: 'saveFrame', data: 'AAAA' })).toEqual({
      type: 'saveFrame',
      data: 'AAAA',
      name: undefined,
    });
    expect(parseGifMessage({ type: 'saveFrame', data: 'AAAA', name: 5 })).toMatchObject({
      name: undefined,
    });
    expect(parseGifMessage({ type: 'saveFrame', data: 'AAAA', name: '' })).toMatchObject({
      name: undefined,
    });
  });

  it('refuses a frame without data', () => {
    for (const data of ['', 5, null, undefined, ['AAAA']]) {
      expect(parseGifMessage({ type: 'saveFrame', data, name: 'f.png' })).toBeUndefined();
    }
  });

  it('writes only the theme setting, and only a known theme', () => {
    expect(parseGifMessage({ type: 'updateSetting', key: 'theme', value: 'green' })).toEqual({
      type: 'updateSetting',
      key: 'theme',
      value: 'green',
    });
    expect(parseGifMessage({ type: 'updateSetting', key: 'theme', value: 'pink' })).toBeUndefined();
    expect(parseGifMessage({ type: 'updateSetting', key: 'theme', value: 5 })).toBeUndefined();
    expect(
      parseGifMessage({ type: 'updateSetting', key: 'video.ffmpegPath', value: 'calc' }),
    ).toBeUndefined();
    expect(
      parseGifMessage({ type: 'updateSetting', key: 'video.loop', value: true }),
    ).toBeUndefined();
  });
});

describe('parseVideoMessage', () => {
  it('accepts the bare messages', () => {
    for (const type of [
      'ready',
      'revealInOS',
      'openExternal',
      'proxyRequest',
      'playable',
      'proxyCancel',
      'reviewEnable',
      'reviewCopy',
    ]) {
      expect(parseVideoMessage({ type })).toEqual({ type });
    }
  });

  it('reads proxyStart as the picture path unless it asks for sound', () => {
    expect(parseVideoMessage({ type: 'proxyStart' })).toEqual({
      type: 'proxyStart',
      kind: 'picture',
    });
    expect(parseVideoMessage({ type: 'proxyStart', kind: 'sound' })).toEqual({
      type: 'proxyStart',
      kind: 'sound',
    });
    for (const kind of ['picture', 'SOUND', 5, null, {}, ['sound']]) {
      expect(parseVideoMessage({ type: 'proxyStart', kind })).toEqual({
        type: 'proxyStart',
        kind: 'picture',
      });
    }
  });

  it('accepts saveFrame with data and an optional name', () => {
    expect(parseVideoMessage({ type: 'saveFrame', data: 'AAAA', name: 'f.png' })).toEqual({
      type: 'saveFrame',
      data: 'AAAA',
      name: 'f.png',
    });
    expect(parseVideoMessage({ type: 'saveFrame', data: '' })).toBeUndefined();
    expect(parseVideoMessage({ type: 'saveFrame', name: 'f.png' })).toBeUndefined();
    expect(parseVideoMessage({ type: 'saveFrame', data: 5 })).toBeUndefined();
  });

  it('carries the review edits for the session to validate against the video', () => {
    const add = { type: 'reviewAdd', at: 1, text: 'x' };
    expect(parseVideoMessage(add)).toEqual({ type: 'reviewAdd', raw: add });
    const del = { type: 'reviewDelete', id: 'n1' };
    expect(parseVideoMessage(del)).toEqual({ type: 'reviewDelete', raw: del });
    const restore = { type: 'reviewRestore' };
    expect(parseVideoMessage(restore)).toEqual({ type: 'reviewRestore', raw: restore });
  });

  it('writes only the viewer settings, with values of the right type', () => {
    for (const [key, value] of [
      ['theme', 'light'],
      ['video.loop', true],
      ['video.autoplay', false],
      ['video.review', true],
    ] as const) {
      expect(parseVideoMessage({ type: 'updateSetting', key, value })).toEqual({
        type: 'updateSetting',
        key,
        value,
      });
    }
    const refused: [unknown, unknown][] = [
      ['theme', 'pink'],
      ['theme', true],
      ['video.loop', 'true'],
      ['video.autoplay', 1],
      ['video.review', null],
      // Settings the host later executes or reads files from.
      ['video.ffmpegPath', '/bin/sh'],
      ['pdf.browserPath', '/bin/sh'],
      ['tex.enginePath', '/bin/sh'],
      ['video.transcode', 'always'],
      ['__proto__', {}],
      [5, true],
      [undefined, true],
    ];
    for (const [key, value] of refused) {
      expect(parseVideoMessage({ type: 'updateSetting', key, value })).toBeUndefined();
    }
  });

  it('ignores types that belong to other surfaces', () => {
    for (const type of ['saveComments', 'texRecompile', 'openLink', 'editCell', 'selectSheet']) {
      expect(parseVideoMessage({ type })).toBeUndefined();
    }
  });
});

// Tightened checks: a preview's Preferences menu writes five settings and the PDF
// viewer's Theme menu one, so a page cannot set a path the host later executes.
describe('settings a page may write through updateSetting', () => {
  const executable = [
    'video.ffmpegPath',
    'pdf.browserPath',
    'tex.enginePath',
    'tex.compile',
    'tex.rootFile',
    'video.transcode',
    'mermaid',
    'styleProfile',
    'csv.delimiter',
    '__proto__',
    'constructor',
    '',
  ];

  describe.each<[string, Parser]>([
    ['markdown', parseMarkdownMessage],
    ['ooxml', parseOoxmlMessage],
  ])('%s preview', (_name, parse) => {
    it('accepts the theme and the four toggles', () => {
      for (const [key, value] of [
        ['theme', 'auto'],
        ['theme', 'green'],
        ['syncScroll', false],
        ['autoPreview', true],
        ['math', true],
        ['footnotes', false],
      ] as const) {
        expect(parse({ type: 'updateSetting', key, value })).toEqual({
          type: 'updateSetting',
          key,
          value,
        });
      }
    });

    it('refuses any other key, and a value of the wrong type', () => {
      for (const key of executable) {
        expect(parse({ type: 'updateSetting', key, value: '/bin/sh' })).toBeUndefined();
        expect(parse({ type: 'updateSetting', key, value: true })).toBeUndefined();
      }
      for (const [key, value] of [
        ['theme', 'pink'],
        ['theme', true],
        ['theme', undefined],
        ['syncScroll', 'false'],
        ['math', 1],
        ['footnotes', null],
        // Video and GIF settings are not this surface's.
        ['video.loop', true],
      ] as const) {
        expect(parse({ type: 'updateSetting', key, value })).toBeUndefined();
      }
    });

    it('requires toast text to be a string', () => {
      expect(parse({ type: 'toast', text: 'Copied' })).toEqual({ type: 'toast', text: 'Copied' });
      for (const text of [undefined, null, 5, {}, ['x']]) {
        expect(parse({ type: 'toast', text })).toBeUndefined();
      }
    });
  });

  describe.each<[string, Parser]>([
    ['pdf', parsePdfMessage],
    ['tex', parseTexMessage],
  ])('%s viewer', (_name, parse) => {
    it('accepts the theme and nothing else', () => {
      expect(parse({ type: 'updateSetting', key: 'theme', value: 'light' })).toEqual({
        type: 'updateSetting',
        key: 'theme',
        value: 'light',
      });
      expect(parse({ type: 'updateSetting', key: 'theme', value: 'pink' })).toBeUndefined();
      expect(parse({ type: 'updateSetting', key: 'theme', value: 3 })).toBeUndefined();
      for (const key of [...executable, 'syncScroll', 'math', 'video.loop']) {
        expect(parse({ type: 'updateSetting', key, value: true })).toBeUndefined();
        expect(parse({ type: 'updateSetting', key, value: '/bin/sh' })).toBeUndefined();
      }
    });
  });
});

// Found by the nightly fuzzer: Number() throws on a value that cannot become a
// primitive, which would have let one hostile message take the host down inside
// the validator. A null-prototype object and a throwing toString are the two
// shapes that reach that path.
describe('numeric fields that cannot be coerced', () => {
  const hostile: unknown[] = [
    Object.create(null),
    {
      toString: () => {
        throw new Error('nope');
      },
      valueOf: undefined,
    },
    [Object.create(null)],
  ];

  it('are rejected by the Markdown grid messages without throwing', () => {
    for (const value of hostile) {
      expect(
        parseMarkdownMessage({ type: 'editCell', line: value, column: 0, value: 'x' }),
      ).toBeUndefined();
      expect(
        parseMarkdownMessage({ type: 'editCell', line: 0, column: value, value: 'x' }),
      ).toBeUndefined();
      expect(
        parseMarkdownMessage({ type: 'gridOp', op: 'insertRowBelow', line: value, column: 0 }),
      ).toBeUndefined();
      expect(
        parseMarkdownMessage({ type: 'gridOp', op: 'insertRowBelow', line: 0, column: value }),
      ).toBeUndefined();
    }
  });

  it('are rejected by selectSheet without throwing', () => {
    for (const value of hostile) {
      expect(parseOoxmlMessage({ type: 'selectSheet', index: value })).toBeUndefined();
    }
  });

  it('no longer accept numeric strings', () => {
    expect(
      parseMarkdownMessage({ type: 'editCell', line: '1', column: 0, value: 'x' }),
    ).toBeUndefined();
    expect(parseOoxmlMessage({ type: 'selectSheet', index: '2' })).toBeUndefined();
  });
});
