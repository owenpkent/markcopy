// What the harness assumes about the host, checked against the host.
//
// tests/webview/harness.ts stands in for two things the extension supplies at
// runtime: the shell HTML the webview is served, and the echo window the bundle
// mutes scroll sync for. Both are copies, and a copy that drifts turns every
// suite built on it green for the wrong reason. A renamed `#content` would leave
// the bundle rendering into an element no test looks at; a longer echo window
// would have the sync tests asserting inside the mute and reading silence as
// correct behavior.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (file: string): string => readFileSync(resolve(__dirname, '..', '..', file), 'utf8');

const HARNESS = read('tests/webview/harness.ts');

describe('the harness shell matches the one the host serves', () => {
  const shell = read('src/previewShell.ts');

  // Every id the bundle captures at module scope. Missing one is a TypeError on
  // import, so these fail loudly rather than subtly, but they fail in whichever
  // suite happens to boot first rather than here.
  it.each(['content', 'mc-menu', 'mc-toast'])('serves #%s', (id) => {
    expect(shell).toContain(`id="${id}"`);
    expect(HARNESS).toContain(`id="${id}"`);
  });

  it('has no element the harness leaves out', () => {
    const ids = (source: string): string[] =>
      [...source.matchAll(/id="([^"]+)"/g)].map((match) => match[1]).sort();
    expect(ids(HARNESS)).toEqual(ids(shell));
  });
});

describe('the harness echo window matches the bundle', () => {
  it('waits for the same SYNC_ECHO_MS the bundle mutes for', () => {
    const declared = /const SYNC_ECHO_MS = (\d+);/.exec(read('src/webview/main.ts'));
    const copied = /const ECHO_WINDOW_MS = (\d+);/.exec(HARNESS);
    expect(declared?.[1], 'SYNC_ECHO_MS moved or was renamed in main.ts').toBeDefined();
    expect(copied?.[1]).toBe(declared?.[1]);
  });
});
