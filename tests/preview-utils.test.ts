import { describe, it, expect } from 'vitest';
import { classifyLink, localImageRef, shouldAutoPreview } from '../src/preview-utils';

describe('localImageRef', () => {
  it('leaves remote and inline URIs untouched', () => {
    for (const src of [
      'https://example.com/a.png',
      'http://example.com/a.png',
      'data:image/png;base64,iVBORw0KGgo=',
      'blob:https://x/y',
      'vscode-webview://abc/def.png',
      'mailto:me@example.com',
      '//cdn.example.com/a.png',
      '#section',
      '',
    ]) {
      expect(localImageRef(src), src).toBeNull();
    }
  });

  it('flags a relative path for resolution', () => {
    expect(localImageRef('media/foo.png')).toEqual({
      path: 'media/foo.png',
      suffix: '',
      absolute: false,
    });
    expect(localImageRef('./img/x.png')).toMatchObject({ absolute: false });
    expect(localImageRef('../up.png')).toMatchObject({ absolute: false });
  });

  it('recognizes POSIX and Windows absolute paths', () => {
    expect(localImageRef('/abs/x.png')).toMatchObject({ absolute: true, path: '/abs/x.png' });
    expect(localImageRef('C:\\Users\\me\\x.png')).toMatchObject({
      absolute: true,
      path: 'C:\\Users\\me\\x.png',
    });
    // A single-letter drive must not be mistaken for a URL scheme.
    expect(localImageRef('C:/Users/me/x.png')).not.toBeNull();
  });

  it('splits off query and fragment as a re-appendable suffix', () => {
    expect(localImageRef('img.png?v=2')).toMatchObject({ path: 'img.png', suffix: '?v=2' });
    expect(localImageRef('img.png#frag')).toMatchObject({ path: 'img.png', suffix: '#frag' });
    expect(localImageRef('a.png?x=1#f')).toMatchObject({ path: 'a.png', suffix: '?x=1#f' });
  });

  it('trims surrounding whitespace', () => {
    expect(localImageRef('  x.png  ')).toMatchObject({ path: 'x.png' });
  });
});

describe('classifyLink', () => {
  it('returns null for an empty href', () => {
    expect(classifyLink('')).toBeNull();
    expect(classifyLink('   ')).toBeNull();
  });

  it('classifies pure in-page anchors as fragments', () => {
    expect(classifyLink('#features')).toEqual({ kind: 'fragment', fragment: 'features' });
    expect(classifyLink('#a%20b')).toEqual({ kind: 'fragment', fragment: 'a b' });
  });

  it('treats remote, mailto, and protocol-relative links as external', () => {
    expect(classifyLink('https://example.com/x')).toEqual({
      kind: 'external',
      href: 'https://example.com/x',
    });
    expect(classifyLink('mailto:me@example.com')).toMatchObject({ kind: 'external' });
    expect(classifyLink('//cdn.example.com/x')).toEqual({
      kind: 'external',
      href: 'https://cdn.example.com/x',
    });
  });

  it('resolves relative Markdown links, splitting off the fragment', () => {
    expect(classifyLink('docs/COPY-MATRIX.md')).toEqual({
      kind: 'local',
      path: 'docs/COPY-MATRIX.md',
      absolute: false,
      fragment: '',
      markdown: true,
    });
    expect(classifyLink('other.md#section')).toMatchObject({
      kind: 'local',
      path: 'other.md',
      fragment: 'section',
      markdown: true,
    });
    expect(classifyLink('../guide.markdown')).toMatchObject({ kind: 'local', markdown: true });
  });

  it('flags non-Markdown local targets so the host opens them in VS Code', () => {
    expect(classifyLink('report.pdf')).toMatchObject({ kind: 'local', markdown: false });
    expect(classifyLink('diagram.png')).toMatchObject({ kind: 'local', markdown: false });
  });

  it('recognizes absolute local paths and percent-decodes the path', () => {
    expect(classifyLink('/abs/notes.md')).toMatchObject({ absolute: true, path: '/abs/notes.md' });
    expect(classifyLink('C:/Users/me/notes.md')).toMatchObject({ absolute: true, markdown: true });
    expect(classifyLink('my%20notes.md')).toMatchObject({ path: 'my notes.md', markdown: true });
  });
});

describe('shouldAutoPreview', () => {
  const base = {
    enabled: true,
    languageId: 'markdown',
    scheme: 'file',
    docKey: 'file:///a.md',
    dismissed: new Set<string>(),
  };

  it('opens for an on-disk markdown file when enabled', () => {
    expect(shouldAutoPreview(base)).toBe(true);
  });

  it('is suppressed when the setting is off', () => {
    expect(shouldAutoPreview({ ...base, enabled: false })).toBe(false);
  });

  it('ignores non-markdown documents', () => {
    expect(shouldAutoPreview({ ...base, languageId: 'plaintext' })).toBe(false);
  });

  it('ignores non-file schemes (untitled, output, git, etc.)', () => {
    expect(shouldAutoPreview({ ...base, scheme: 'untitled' })).toBe(false);
  });

  it('does not reopen a document the user dismissed', () => {
    expect(shouldAutoPreview({ ...base, dismissed: new Set([base.docKey]) })).toBe(false);
  });
});
