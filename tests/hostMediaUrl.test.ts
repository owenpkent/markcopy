import { describe, it, expect } from 'vitest';
import { hostMediaUrl } from '../src/webview/hostMediaUrl';

describe('hostMediaUrl', () => {
  it('passes the https webview-resource URL the host sends', () => {
    const src = 'https://file+.vscode-resource.vscode-cdn.net/c%3A/clips/a.mp4?v=1';
    expect(hostMediaUrl(src)).toBe(src);
  });

  it('refuses every other scheme and anything that is not a URL', () => {
    expect(hostMediaUrl('javascript:alert(1)')).toBe('');
    expect(hostMediaUrl('data:video/mp4;base64,AAAA')).toBe('');
    expect(hostMediaUrl('file:///c:/clips/a.mp4')).toBe('');
    expect(hostMediaUrl('http://example.com/a.mp4')).toBe('');
    expect(hostMediaUrl('/clips/a.mp4')).toBe('');
    expect(hostMediaUrl('')).toBe('');
    expect(hostMediaUrl(undefined)).toBe('');
    expect(hostMediaUrl(42)).toBe('');
  });
});
