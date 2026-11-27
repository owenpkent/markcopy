import { defineConfig } from '@vscode/test-cli';

// Runs the compiled integration tests in a downloaded VS Code instance, with
// this repo loaded as the extension under test. Two runs: the main one with no
// folder open, and a trusted control with a fixture folder open (the
// counterpart of test-integration/restricted, which runs in Restricted Mode).
export default defineConfig([
  {
    label: 'main',
    files: 'out/*.test.js',
    mocha: {
      ui: 'tdd',
      timeout: 60000,
    },
  },
  {
    label: 'trusted-control',
    files: 'out/trusted/*.test.js',
    workspaceFolder: 'test-integration/trusted/fixture',
    mocha: {
      ui: 'tdd',
      timeout: 60000,
    },
  },
]);
