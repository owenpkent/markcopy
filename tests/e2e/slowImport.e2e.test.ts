// What the harness does when a copy action is slow to get going.
//
// This exists because of a real flake. `Copy as > Markdown` failed on CI with
// `expected '' to contain 'Widget'` while two other runs of the same commit
// passed, and an empty clipboard is the single most misleading way this layer
// can fail: it looks exactly like a copy action that stopped being wired to its
// menu row, which is the bug the whole suite is built to catch.
//
// The cause was that `settle()` counts ticks, and `markdownConvert.ts` awaits
// `Promise.all([import('turndown'), import('turndown-plugin-gfm')])` before it
// writes anything. Those imports post no message, write no clipboard flavor, and
// touch no DOM while they resolve, so a loaded runner produces several silent
// ticks and tick counting calls that "finished". `MenuDriver.click()` now waits
// for the action's actual effect.
//
// Mocking the imports with a delay reproduces on demand what CI hit by chance:
// with the wait removed, this test fails with that same assertion.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type * as Turndown from 'turndown';
import type * as TurndownGfm from 'turndown-plugin-gfm';
import { boot, type Harness } from '../webview/harness';

// Comfortably longer than the tick budget `settle()` would ever spend, so this
// does not become a race of its own on a fast machine.
const IMPORT_DELAY_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

vi.mock('turndown', async () => {
  await sleep(IMPORT_DELAY_MS);
  return await vi.importActual<typeof Turndown>('turndown');
});

vi.mock('turndown-plugin-gfm', async () => {
  await sleep(IMPORT_DELAY_MS);
  return await vi.importActual<typeof TurndownGfm>('turndown-plugin-gfm');
});

const TABLE =
  '<table data-source-line="0"><thead><tr><th>product</th><th>qty</th></tr></thead>' +
  '<tbody><tr><td>Widget</td><td>3</td></tr></tbody></table>';

describe('a copy action whose dynamic import is slow', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await boot();
  });

  it('still lands on the clipboard rather than reading as empty', async () => {
    await h.render({ html: TABLE, source: '| product | qty |\n| --- | --- |\n| Widget | 3 |\n' });

    const menu = h.rightClick(h.find('table'));
    await menu.click('Copy as', 'Markdown');

    const plain = h.lastClip()?.plain ?? '';
    expect(plain).toContain('Widget');
    expect(plain).toMatch(/\|\s*-+/);
  });
});
