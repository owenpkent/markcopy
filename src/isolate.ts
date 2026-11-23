// Running a piece of work where it cannot take the extension host down.
//
// The file-information readers parse untrusted bytes. They cap what they read
// and what they keep, and an audit still found files of a few hundred bytes
// that took the process past 4 GB: the caps were all there and they
// multiplied. Those are fixed, and the next one has not been found yet. So
// the reading is not done in the extension host at all. It is done in a worker
// thread with its own heap, a limit on that heap, and a limit on how long it
// may run. A file that defeats a reader's caps ends the worker; the host shows
// a notice and every other extension in it carries on.
//
// What this does not bound: memory a reader allocates outside the JavaScript
// heap (typed arrays, a WebAssembly memory). The readers' own caps on buffers,
// windows and dictionaries are what bound those, which is why they stay.
//
// Free of the `vscode` module so it can be tested by starting real workers.
import { Worker } from 'node:worker_threads';
import { ReadError } from './binary/reader';

export interface IsolationLimits {
  /** The worker's old-generation heap, in megabytes. Past it the worker is ended. */
  maxHeapMb: number;
  /** How long the worker may run, in milliseconds. Past it the worker is ended. */
  timeoutMs: number;
}

// A real 900 MB installer reads in 25 ms and a few megabytes. These are far
// above that, so a slow disk or a busy machine does not trip them, and far
// below what would be felt in the editor.
export const DEFAULT_ISOLATION: IsolationLimits = { maxHeapMb: 256, timeoutMs: 15_000 };

/**
 * Start the worker script at `file` with `data`, and resolve with the first
 * message it posts. The worker is always ended afterwards.
 *
 * Rejects with a ReadError, whose message is written to be shown, when the
 * worker cannot be started, runs out of memory, runs out of time, or ends
 * without an answer.
 */
export function runInWorker<T>(
  file: string,
  data: unknown,
  limits: Partial<IsolationLimits> = {},
): Promise<T> {
  const { maxHeapMb, timeoutMs } = { ...DEFAULT_ISOLATION, ...limits };
  return new Promise<T>((resolve, reject) => {
    const start = (): Worker | undefined => {
      try {
        return new Worker(file, {
          workerData: data,
          resourceLimits: {
            maxOldGenerationSizeMb: maxHeapMb,
            // The young generation and the stack are bounded too, so the total
            // is a number rather than "the heap limit, plus whatever".
            maxYoungGenerationSizeMb: 32,
            stackSizeMb: 4,
          },
        });
      } catch (err) {
        reject(
          new ReadError(
            `MarkCopy could not start its isolated reader (${err instanceof Error ? err.message : String(err)}).`,
          ),
        );
        return undefined;
      }
    };
    const worker = start();
    if (!worker) {
      return;
    }
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      settle();
      // Whether it answered, failed or stalled, nothing more is wanted from it.
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new ReadError(
            `reading it took longer than ${Math.round(timeoutMs / 1000)} seconds, so MarkCopy stopped.`,
          ),
        ),
      );
    }, timeoutMs);
    worker.once('message', (message: T) => finish(() => resolve(message)));
    worker.once('error', (err: Error & { code?: string }) => {
      finish(() =>
        reject(
          err.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? new ReadError(
                `reading it needed more than the ${maxHeapMb} MB MarkCopy allows a preview, so MarkCopy stopped.`,
              )
            : new ReadError(`its reader failed (${err.message}).`),
        ),
      );
    });
    worker.once('exit', () => {
      finish(() => reject(new ReadError('its reader stopped without an answer.')));
    });
  });
}
