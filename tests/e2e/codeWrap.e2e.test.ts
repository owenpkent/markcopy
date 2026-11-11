// markcopy.wrapCode, driven through the render message and the menu a user drives.
//
// The wrapping itself is a CSS rule keyed on a body class, and jsdom does no
// layout, so what is pinned here is the wiring: the class follows the setting
// the host sends (on when an older host sends none), and the Preferences menu
// shows the current value and asks the host for the opposite.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { boot, type Harness } from '../webview/harness';
import { createMarkdownIt } from '../../src/render';

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

beforeEach(() => {
  h.reset();
});

const SOURCE = ['Some prose.', '', '```js', `const long = '${'x'.repeat(400)}';`, '```', ''].join(
  '\n',
);
const HTML = createMarkdownIt().render(SOURCE);

describe('wrapping long lines in code blocks', () => {
  it('wraps by default', async () => {
    await h.render({ html: HTML, source: SOURCE });
    expect(document.body.classList.contains('mc-wrap-code')).toBe(true);
  });

  it('wraps when the host sends no value, as an older host does', async () => {
    await h.render({ html: HTML, source: SOURCE, wrapCode: undefined });
    expect(document.body.classList.contains('mc-wrap-code')).toBe(true);
  });

  it('scrolls sideways again when the setting is off', async () => {
    await h.render({ html: HTML, source: SOURCE, wrapCode: false });
    expect(document.body.classList.contains('mc-wrap-code')).toBe(false);
    await h.render({ html: HTML, source: SOURCE, wrapCode: true });
    expect(document.body.classList.contains('mc-wrap-code')).toBe(true);
  });

  it('leaves the code block HTML alone', async () => {
    await h.render({ html: HTML, source: SOURCE, wrapCode: true });
    const on = h.find('pre').outerHTML;
    await h.render({ html: HTML, source: SOURCE, wrapCode: false });
    expect(h.find('pre').outerHTML).toBe(on);
  });

  it('offers the toggle under Preferences and writes the opposite value', async () => {
    await h.render({ html: HTML, source: SOURCE, wrapCode: true });
    const menu = h.rightClick(h.find('pre'));
    await menu.click('Preferences');
    expect(menu.labels()).toContain('Wrap code lines');
    await menu.click('Wrap code lines');
    expect(h.posted).toContainEqual({ type: 'updateSetting', key: 'wrapCode', value: false });
  });
});
