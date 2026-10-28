// src/videoReview.ts imports 'vscode', which only exists inside VS Code. The
// parsing code under test never touches it, so resolve it to an empty module.
// Import this file before anything that pulls in videoReview.
import Module from 'node:module';

const loader = Module as unknown as {
  _load: (request: string, ...rest: unknown[]) => unknown;
};
const realLoad = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? {} : realLoad.call(this, request, ...rest);
};
