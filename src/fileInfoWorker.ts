// The worker thread the file-information previews read a file in.
//
// Bundled on its own to dist/fileInfoWorker.js (see esbuild.js) and started by
// src/isolate.ts with a heap limit and a time limit. It does one thing: run the
// task it was started with and post the result. If a file makes a reader
// allocate without bound, or loop, it is this thread that is ended, and the
// extension host, which every other extension shares, carries on.
import { parentPort, workerData } from 'node:worker_threads';
import { runFileInfoTask, type FileInfoRequest } from './fileInfoTask';

void runFileInfoTask(workerData as FileInfoRequest).then((result) => {
  parentPort?.postMessage(result);
});
