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

describe('open in default app row', () => {
  it('is offered above Reveal and posts a payload-free message', async () => {
    const menu = h.rightClick(h.find('p'));
    const labels = menu.labels();
    expect(labels.indexOf('Open in Default App')).toBe(labels.indexOf(revealLabel()) - 1);
    await menu.click('Open in Default App');
    expect(h.posted.at(-1)).toEqual({ type: 'openExternal' });
  });
});

// The default app for an executable is the executable, so its preview must not
// offer a row that would launch it. The host refuses the message as well
// (tests/exeEditor.test.ts); this pins the webview half.
describe('open in default app row on an executable preview', () => {
  it('is absent for the exe kind, while Reveal stays', async () => {
    await h.render({ html: '<p>Contoso Tool</p>', kind: 'exe' });
    const labels = h.rightClick(h.find('p')).labels();
    expect(labels).not.toContain('Open in Default App');
    expect(labels).toContain(revealLabel());
  });

  it('comes back when the same preview shows another kind', async () => {
    await h.render({ html: '<p>Contoso Tool</p>', kind: 'exe' });
    await h.render({ html: '<p>Hello</p>', kind: 'markdown' });
    expect(h.rightClick(h.find('p')).labels()).toContain('Open in Default App');
  });
});
