// The "Read this file" button of the file-information pages (executables and
// packages), driven through the real preview bundle. The page it sits on has
// read nothing of the file: the click is the reader saying to. So the button
// has to survive the webview's sanitizing with its action attribute, post
// exactly `readFile` (no path or anything else the host would have to trust),
// post it once however often it is pressed, and be the only thing on the page
// that does.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { boot, type Harness } from '../webview/harness';

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

// The markup src/fileInfoEditor.ts builds, around the button.
const WAITING =
  '<div class="mc-exe mc-info-waiting"><div class="mc-info-head"><div class="mc-info-title">' +
  '<h1>tool.exe</h1><p>Windows executable, 12.1 KB</p></div></div>' +
  '<p><strong>MarkCopy has not read this file.</strong> Reading it shows its details.</p>' +
  '<p><button type="button" class="mc-info-read" data-mc-action="read-file">Read this file</button></p>' +
  '<p class="mc-exe-note">The same from the keyboard.</p></div>';

const readMessages = (): unknown[] => h.posted.filter((m) => m.type === 'readFile');

beforeEach(async () => {
  h.reset();
  await h.render({ html: WAITING, kind: 'exe' });
});

describe('the Read this file button', () => {
  it('survives sanitizing, with its action attribute, still a plain button', () => {
    const button = h.find('button.mc-info-read');
    expect(button.getAttribute('data-mc-action')).toBe('read-file');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.textContent).toBe('Read this file');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('posts exactly a readFile message when clicked', async () => {
    h.find('button.mc-info-read').click();
    await h.settle();

    expect(readMessages()).toEqual([{ type: 'readFile' }]);
  });

  it('disables itself and changes its label at once', async () => {
    const button = h.find('button.mc-info-read') as HTMLButtonElement;

    button.click();

    expect(button.disabled).toBe(true);
    expect(button.textContent).not.toBe('Read this file');
    expect(button.textContent).toBeTruthy();
  });

  it('posts nothing for a second click', async () => {
    const button = h.find('button.mc-info-read') as HTMLButtonElement;
    button.click();
    await h.settle();
    h.reset();

    button.click();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await h.settle();

    expect(h.posted).toEqual([]);
  });

  it('is the only thing on the page that asks for a read', async () => {
    h.find('h1').click();
    h.find('p').click();
    h.find('.mc-exe-note').click();
    h.find('strong').click();
    await h.settle();

    expect(readMessages()).toEqual([]);
  });

  it('is offered again on the next waiting page, enabled', async () => {
    h.find('button.mc-info-read').click();
    await h.settle();

    await h.render({ html: WAITING, kind: 'exe' });

    const button = h.find('button.mc-info-read') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Read this file');
  });
});
