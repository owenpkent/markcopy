// @vitest-environment node
//
// Regression coverage for src/externalLink.ts, asked for in PR review once
// vscode itself became mockable in a unit test (see tests/ooxmlEditor.test.ts
// for the message router that calls this in the OOXML editors).
//
// vscode.env.openExternal is mocked because there is no real host to open a
// link in a Vitest run. What matters here is what openExternalLink hands it:
// the href exactly as it was given -- never re-encoded, never wrapped in a
// Uri -- and only for a scheme the OS should actually be asked to open. See
// the comment in src/externalLink.ts for why the raw string matters: VS
// Code's own Uri would decode %26/%2B/%3D back out of the query.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const openExternal = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  Uri: {
    // A minimal stand-in for VS Code's strict Uri.parse: derive the scheme
    // from the string, and throw the way the real one does for something it
    // cannot make sense of at all.
    parse: (value: string) => {
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1];
      if (!scheme) {
        throw new Error(`cannot parse a URI with no scheme: ${value}`);
      }
      return { scheme: scheme.toLowerCase() };
    },
  },
  env: { openExternal },
}));

import { openExternalLink } from '../src/externalLink';

beforeEach(() => {
  openExternal.mockClear();
});

describe('openExternalLink', () => {
  it('hands an https Google search URL to openExternal unchanged', () => {
    const href = 'https://www.google.com/search?q=AT%26T%2BCo';
    openExternalLink(href);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(href);
    // Not a Uri object: the whole point is that it goes out as this string.
    expect(typeof openExternal.mock.calls[0][0]).toBe('string');
  });

  it('allows a mailto link', () => {
    const href = 'mailto:person@example.com';
    openExternalLink(href);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(href);
  });

  it('rejects a vscode: link', () => {
    openExternalLink('vscode:extension/foo.bar');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects a javascript: link', () => {
    openExternalLink('javascript:alert(1)');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects a file: link', () => {
    openExternalLink('file:///etc/passwd');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects a scheme-less string', () => {
    openExternalLink('not a url');
    expect(openExternal).not.toHaveBeenCalled();
  });
});
