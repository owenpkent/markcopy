// @vitest-environment node
//
// runInWorker, against real worker threads. The point of src/isolate.ts is that
// a reader which allocates without bound or never returns is ended in its own
// thread while the host carries on, and a mock cannot show that: only a worker
// that really runs away can. The scripts are tiny CommonJS files written to a
// temp folder, and every limit is small so the whole file runs in a few seconds
// and holds little memory.
import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadError } from '../src/binary/reader';
import { DEFAULT_ISOLATION, runInWorker } from '../src/isolate';

let dir: string;
const script = (name: string): string => join(dir, `${name}.js`);

const SCRIPTS: Record<string, string> = {
  // Answers with what it was started with.
  echo: `const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage({ echoed: workerData });`,
  // Allocates until the heap limit ends it.
  hog: `const keep = [];
for (;;) keep.push(new Array(1e6).fill({}));`,
  // Never returns.
  spin: `for (;;) {}`,
  // Ends without saying anything.
  silent: ``,
  // Fails before answering.
  throws: `throw new Error('bad reader');`,
  // Answers, then fails in the same turn.
  late: `const { parentPort } = require('node:worker_threads');
parentPort.postMessage('first');
throw new Error('too late');`,
  // Answers, then would run forever if it were allowed to: it leaves a mark on
  // disk every few milliseconds, which is how the test sees whether it ended.
  lingers: `const { parentPort, workerData } = require('node:worker_threads');
const { appendFileSync } = require('node:fs');
setInterval(() => appendFileSync(workerData.beat, 'x'), 5);
// Answer only after it has been beating for a while, so the test can tell stopped from not started.
setTimeout(() => parentPort.postMessage('done'), 60);`,
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'markcopy-isolate-test-'));
  for (const [name, source] of Object.entries(SCRIPTS)) {
    writeFileSync(script(name), source);
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('runInWorker', () => {
  it('has limits well under what the host could not survive and well over a real read', () => {
    expect(DEFAULT_ISOLATION).toEqual({ maxHeapMb: 256, timeoutMs: 15_000 });
  });

  it('resolves with the first message the worker posts, and hands it workerData', async () => {
    const data = { kind: 'exe', bytes: Uint8Array.of(1, 2, 3) };

    const answer = await runInWorker<{ echoed: typeof data }>(script('echo'), data);

    expect(answer.echoed.kind).toBe('exe');
    expect(Array.from(answer.echoed.bytes)).toEqual([1, 2, 3]);
  });

  it('rejects with the heap limit when the worker allocates without bound, and the host heap stays put', async () => {
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;

    const error = await runInWorker(script('hog'), {}, { maxHeapMb: 32 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReadError);
    expect((error as ReadError).message).toContain('more than the 32 MB');
    globalThis.gc?.();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
  });

  it('rejects with the time limit, in seconds, when the worker never returns', async () => {
    const started = Date.now();

    const error = await runInWorker(script('spin'), {}, { timeoutMs: 300 }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ReadError);
    expect((error as ReadError).message).toMatch(/longer than \d+ seconds/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('rejects when the worker ends without posting anything', async () => {
    const error = await runInWorker(script('silent'), {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReadError);
    expect((error as ReadError).message).toContain('without an answer');
  });

  it('rejects when the script does not exist', async () => {
    const missing = script('not-there');
    expect(existsSync(missing)).toBe(false);

    const error = await runInWorker(missing, {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReadError);
  });

  it('rejects, with the worker error, when the worker throws', async () => {
    const error = await runInWorker(script('throws'), {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReadError);
    expect((error as ReadError).message).toContain('bad reader');
  });

  it('settles once when a worker posts and then throws, and leaves nothing unhandled', async () => {
    const unhandled: unknown[] = [];
    const note = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', note);
    try {
      let settlements = 0;
      const outcome = await runInWorker<string>(script('late'), {}).then(
        (value) => {
          settlements++;
          return value;
        },
        () => {
          settlements++;
          return 'rejected';
        },
      );
      // Give a second settlement, and the worker's own error event, time to land.
      await sleep(100);

      expect(settlements).toBe(1);
      expect(outcome).toBe('first');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', note);
    }
  });

  it('ends the worker once it has answered, so it cannot keep running or hold the process', async () => {
    const beat = join(dir, 'beat.txt');
    appendFileSync(beat, '');

    await expect(runInWorker<string>(script('lingers'), { beat })).resolves.toBe('done');
    // Termination is asked for at once and completes a moment later.
    await sleep(150);
    const settled = statSync(beat).size;
    await sleep(250);

    expect(settled).toBeGreaterThan(0);
    expect(statSync(beat).size).toBe(settled);
  });
});
