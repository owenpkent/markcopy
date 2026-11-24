import { expect, it } from 'vitest';
import { boot } from '../webview/harness';

it('offers settings after a remote image is blocked and clears the notice in a new document', async () => {
  const h = await boot();
  await h.render({ html: '<p>First document</p>', docKey: 'file:///first.md' });
  const notice = document.getElementById('mc-remote-images')!;
  expect(notice.hidden).toBe(true);

  // jsdom does not enforce CSP. Deliver the browser notification to exercise
  // the preview's response without fetching a resource.
  document.dispatchEvent(
    Object.assign(new Event('securitypolicyviolation'), {
      effectiveDirective: 'img-src',
      blockedURI: 'https://example.invalid',
    }),
  );

  expect(notice.hidden).toBe(false);
  expect(notice.querySelector('[role="alert"]')?.textContent).toContain(
    'A remote image was blocked',
  );
  const button = notice.querySelector('button')!;
  expect(button.textContent).toBe('Open MarkCopy Settings');
  button.click();
  expect(h.posted.at(-1)).toEqual({ type: 'openSettings' });

  await h.render({ html: '<p>Next document</p>', docKey: 'file:///next.md' });
  expect(notice.hidden).toBe(true);
});

it('does not offer the setting for a blocked http image, which it would not allow', async () => {
  const h = await boot();
  await h.render({ html: '<p>Document</p>', docKey: 'file:///http.md' });
  const notice = document.getElementById('mc-remote-images')!;
  document.dispatchEvent(
    Object.assign(new Event('securitypolicyviolation'), {
      effectiveDirective: 'img-src',
      blockedURI: 'http://example.invalid/a.png',
    }),
  );
  expect(notice.hidden).toBe(true);
});
