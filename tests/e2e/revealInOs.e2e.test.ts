// The "reveal in the OS file manager" row, driven through the real Markdown
// preview bundle. The row must post a bare message: the host resolves the file
// from its own document, so nothing path-like may come from the webview.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { boot, type Harness } from '../webview/harness';
import { revealLabel } from '../../src/webview/menu';

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

beforeEach(async () => {
  h.reset();
  await h.render({ html: '<p>Hello</p>', source: 'Hello\n', kind: 'markdown' });
});

describe('reveal in OS row', () => {
  it('is offered on the preview menu and posts a payload-free message', async () => {
    const menu = h.rightClick(h.find('p'));
    expect(menu.labels()).toContain(revealLabel());
    await menu.click(revealLabel());
    expect(h.posted.at(-1)).toEqual({ type: 'revealInOS' });
  });
});
