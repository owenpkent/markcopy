// @vitest-environment node
//
// What happens when the file behind a preview changes many times quickly: an
// executable being rebuilt while its info page is open, a package still
// downloading, a workbook saved by a script in a loop.
//
// Every change event used to start a draw of its own, with nothing to stop
// them overlapping. For the file-information previews one draw reads the file
// and hashes all of it (up to 256 MB), so a few hundred events in a second
// meant a few hundred simultaneous reads and hashes of the same file, each
// holding its own buffers. Now one draw runs at a time, a burst of events
// while it runs costs exactly one more, and events with nothing running are
// gathered for a moment first.
//
// vscode is mocked, as in tests/ooxmlEditor.test.ts, with one difference: the
// file watcher keeps the callbacks it is given, so the test can fire them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const watcher = vi.hoisted(() => ({
  change: [] as (() => void)[],
  create: [] as (() => void)[],
  config: [] as ((e: { affectsConfiguration: () => boolean }) => void)[],
}));

vi.mock('vscode', () => {
  class RelativePattern {
    constructor(
      public base: unknown,
      public pattern: string,
    ) {}
  }
  return {
    Uri: {
      joinPath: (base: { path: string }, ...segments: string[]) => ({
        path: `${base.path}/${segments.join('/')}`,
        fsPath: `${base.path}/${segments.join('/')}`,
      }),
    },
    env: { openExternal: vi.fn() },
    workspace: {
      getConfiguration: vi.fn(() => ({ get: (_key: string, fallback: unknown) => fallback })),
      createFileSystemWatcher: vi.fn(() => ({
        onDidChange: (cb: () => void) => {
          watcher.change.push(cb);
          return { dispose: () => undefined };
        },
        onDidCreate: (cb: () => void) => {
          watcher.create.push(cb);
          return { dispose: () => undefined };
        },
        dispose: () => undefined,
      })),
      onDidChangeConfiguration: (cb: (e: { affectsConfiguration: () => boolean }) => void) => {
        watcher.config.push(cb);
        return { dispose: () => undefined };
      },
    },
    RelativePattern,
    commands: { executeCommand: vi.fn() },
    window: { setStatusBarMessage: vi.fn() },
  };
});

import { OoxmlEditorProvider, REDRAW_DELAY_MS, type OoxmlSession } from '../src/ooxmlEditor';
import type * as vscode from 'vscode';

/** A provider whose render the test holds open and releases by hand. */
class SlowProvider extends OoxmlEditorProvider {
  protected readonly viewType = 'markcopy.testPreview';
  protected readonly kind = 'test';
  protected readonly redrawSettings = ['markcopy.test'];
  public started = 0;
  public active = 0;
  public mostAtOnce = 0;
  public failNext = false;
  private waiting: (() => void)[] = [];

  protected createSession(): OoxmlSession {
    return {
      render: async () => {
        const mine = ++this.started;
        this.active++;
        this.mostAtOnce = Math.max(this.mostAtOnce, this.active);
        await new Promise<void>((resolve) => this.waiting.push(resolve));
        this.active--;
        if (this.failNext) {
          this.failNext = false;
          throw new Error('boom');
        }
        return { html: `render ${mine}` };
      },
    };
  }

  protected errorHtml(): string {
    return 'error';
  }

  /** Let the oldest render still running finish, and let what follows it start. */
  async finishOne(): Promise<void> {
    this.waiting.shift()?.();
    await flush();
  }
}

// Enough turns of the microtask queue for a finished draw to post its message
// and for the next one to begin.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

async function open(): Promise<{
  provider: SlowProvider;
  posted: () => { type: string; html?: string }[];
  ready: () => Promise<void>;
  dispose: () => void;
}> {
  const provider = new SlowProvider(
    { extensionUri: { path: '/ext', fsPath: '/ext' } } as unknown as vscode.ExtensionContext,
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );
  let handler: ((msg: unknown) => unknown) | undefined;
  let disposer: (() => void) | undefined;
  const postMessage = vi.fn();
  const panel = {
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage,
      onDidReceiveMessage: (cb: (msg: unknown) => unknown) => {
        handler = cb;
        return { dispose: () => undefined };
      },
    },
    onDidDispose: (cb: () => void) => {
      disposer = cb;
      return { dispose: () => undefined };
    },
  } as unknown as vscode.WebviewPanel;
  const document = {
    uri: { path: '/w/tool.exe', fsPath: '/w/tool.exe', toString: () => 'file:///w/tool.exe' },
    dispose: () => undefined,
  } as unknown as vscode.CustomDocument;
  await provider.resolveCustomEditor(document, panel);
  return {
    provider,
    posted: () =>
      postMessage.mock.calls
        .map(([msg]) => msg as { type: string; html?: string })
        .filter((msg) => msg.type === 'render'),
    // Not awaited to completion: the render is held open by the test.
    ready: async () => {
      void handler?.({ type: 'ready' });
      await flush();
    },
    dispose: () => disposer?.(),
  };
}

const fireChanges = (count: number): void => {
  for (let i = 0; i < count; i++) {
    for (const cb of watcher.change) {
      cb();
    }
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  watcher.change.length = 0;
  watcher.create.length = 0;
  watcher.config.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('redraws when the file changes', () => {
  it('runs one draw at a time however many change events arrive', async () => {
    const { provider, ready } = await open();
    await ready();
    expect(provider.started).toBe(1);

    fireChanges(300);
    await vi.advanceTimersByTimeAsync(REDRAW_DELAY_MS * 4);
    await flush();
    // The first draw is still running: nothing may start beside it.
    expect(provider.started).toBe(1);
    expect(provider.mostAtOnce).toBe(1);
  });

  it('turns a burst during a draw into exactly one more draw', async () => {
    const { provider, ready, posted } = await open();
    await ready();
    fireChanges(300);
    await vi.advanceTimersByTimeAsync(REDRAW_DELAY_MS * 4);

    await provider.finishOne();
    expect(provider.started).toBe(2);
    await provider.finishOne();
    await vi.advanceTimersByTimeAsync(REDRAW_DELAY_MS * 4);
    await flush();

    expect(provider.started).toBe(2);
    expect(provider.mostAtOnce).toBe(1);
    // Both draws reached the page, the later one last: the page ends on the
    // file's newest state.
    expect(posted().map((m) => m.html)).toEqual(['render 1', 'render 2']);
  });

  it('gathers events that arrive with nothing running into one draw', async () => {
    const { provider, ready } = await open();
    await ready();
    await provider.finishOne();
    expect(provider.started).toBe(1);

    fireChanges(50);
    // Nothing yet: a file being written fires many events, and reading it
    // between two of them reads half a file.
    expect(provider.started).toBe(1);
    await vi.advanceTimersByTimeAsync(REDRAW_DELAY_MS - 1);
    expect(provider.started).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    await flush();
    expect(provider.started).toBe(2);
  });

  it('waits for the events to stop, not for the first one', async () => {
    const { provider, ready } = await open();
    await ready();
    await provider.finishOne();

    for (let i = 0; i < 10; i++) {
      fireChanges(1);
      await vi.advanceTimersByTimeAsync(REDRAW_DELAY_MS - 10);
    }
    expect(provider.started).toBe(1);
    await vi.advanceTimersByTimeAsync(REDRAW_DELAY_MS);
    await flush();
    expect(provider.started).toBe(2);
  });

  it('treats a save by rename (delete then create) as a change', async () => {
    const { provider, ready } = await open();
    await ready();
    await provider.finishOne();
    for (const cb of watcher.create) {
      cb();
    }
    await vi.advanceTimersByTimeAsync(REDRAW_DELAY_MS + 1);
    await flush();
    expect(provider.started).toBe(2);
  });

  it('keeps drawing after a draw that failed', async () => {
    const { provider, ready, posted } = await open();
    await ready();
    provider.failNext = true;
    await provider.finishOne();
    expect(posted().map((m) => m.html)).toEqual(['error']);

    fireChanges(1);
    await vi.advanceTimersByTimeAsync(REDRAW_DELAY_MS + 1);
    await flush();
    await provider.finishOne();
    expect(posted().map((m) => m.html)).toEqual(['error', 'render 2']);
  });

  it('starts nothing, and posts nothing, once the panel is closed', async () => {
    const { provider, ready, posted, dispose } = await open();
    await ready();
    fireChanges(5);
    dispose();
    // The draw in flight when the tab closed finishes, and its result is dropped.
    await provider.finishOne();
    await vi.advanceTimersByTimeAsync(REDRAW_DELAY_MS * 4);
    await flush();
    fireChanges(5);
    await vi.advanceTimersByTimeAsync(REDRAW_DELAY_MS * 4);
    await flush();

    expect(provider.started).toBe(1);
    expect(posted()).toEqual([]);
  });
});
