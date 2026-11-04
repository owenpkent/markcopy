// The PDF webview (src/webview/pdf.ts) against a fake pdf.js and a jsdom body
// that mirrors src/pdfEditor.ts's html(). jsdom has no layout or canvas, and the
// IntersectionObserver is stubbed to never fire, so no page is ever rasterised:
// that is exactly the state "All Text" has to cope with.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BODY = `
  <div id="pdf-root"></div>
  <div id="mc-menu" hidden></div>
  <div id="mc-toast" hidden></div>`;

let posted: Array<Record<string, unknown>> = [];
let copied: string[] = [];
let textCalls: number[] = [];

const PAGES = 5;

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  OPS: {},
  getDocument: () => ({
    destroy: () => Promise.resolve(),
    promise: Promise.resolve({
      numPages: PAGES,
      getPage: (n: number) =>
        Promise.resolve({
          getViewport: () => ({ width: 100, height: 100 }),
          getTextContent: () => {
            textCalls.push(n);
            return Promise.resolve({ items: [{ str: `text of page ${n}`, hasEOL: false }] });
          },
        }),
    }),
  }),
}));

beforeEach(async () => {
  vi.resetModules();
  posted = [];
  copied = [];
  textCalls = [];
  document.body.innerHTML = BODY;
  const mine = posted;
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: (msg: Record<string, unknown>) => mine.push(msg),
    getState: () => undefined,
    setState: vi.fn(),
  }));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ text: () => Promise.resolve('') })),
  );
  vi.stubGlobal(
    'Worker',
    class {
      terminate(): void {}
    },
  );
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  document.execCommand = vi.fn(() => {
    const ev = new Event('copy', { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', {
      value: { setData: (_t: string, v: string) => copied.push(v) },
    });
    document.dispatchEvent(ev);
    return true;
  });
  await import('../src/webview/pdf');
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelectorAll('.mc-note').forEach((n) => n.remove());
});

const tick = () => new Promise((r) => setTimeout(r, 0));

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await tick();
}

async function loadDoc(comments: unknown[] = []): Promise<void> {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'load', data: btoa('x'), workerSrc: 'w.js', comments },
    }),
  );
  await settle();
}

function rightClick(el: Element): void {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

function menuItem(label: string): HTMLElement {
  const items = Array.from(document.querySelectorAll<HTMLElement>('.mc-menu-item'));
  const hit = items.find((i) => i.textContent?.startsWith(label));
  if (!hit) throw new Error(`no menu item ${label}`);
  return hit;
}

describe('PDF All Text', () => {
  it('copies every page even when none has been rendered', async () => {
    await loadDoc();
    rightClick(document.querySelector('.mc-page')!);
    menuItem('Copy as').click();
    menuItem('All Text').click();
    await settle();
    expect(copied).toHaveLength(1);
    for (let n = 1; n <= PAGES; n++) {
      expect(copied[0]).toContain(`text of page ${n}`);
    }
  });
});

describe('PDF comment draft across a reload', () => {
  it('saves the draft, not the original text, after the document reloads', async () => {
    await loadDoc();
    // Create and save a comment through the real menu and note editor.
    const page = document.querySelector<HTMLElement>('.mc-page')!;
    rightClick(page);
    menuItem('Add Comment Here').click();
    let area = document.querySelector<HTMLTextAreaElement>('.mc-note-text')!;
    area.value = 'original';
    document.querySelector<HTMLElement>('.mc-note-save')!.click();
    const saved = posted.filter((m) => m.type === 'saveComments').pop()!;
    const [c] = saved.comments as Array<{ id: string; page: number; text: string }>;
    expect(c.text).toBe('original');

    // Reopen it from its pin, then type a draft.
    document.querySelector<HTMLElement>(`.mc-pin[data-id="${c.id}"]`)!.click();
    area = document.querySelector<HTMLTextAreaElement>('.mc-note-text')!;
    area.value = 'my draft';

    // A LaTeX recompile reloads the PDF with freshly deserialised comments.
    await loadDoc([{ ...c }]);
    area = document.querySelector<HTMLTextAreaElement>('.mc-note-text')!;
    expect(area.value).toBe('my draft');
    document.querySelector<HTMLElement>('.mc-note-save')!.click();

    const last = posted.filter((m) => m.type === 'saveComments').pop()!;
    expect(last.comments).toEqual([expect.objectContaining({ id: c.id, text: 'my draft' })]);
  });
});
