import { defineConfig } from '@vscode/test-cli';

// Runs the compiled integration tests (out/**/*.test.js) in a downloaded VS
// Code instance, with this repo loaded as the extension under test.
export default defineConfig({
  files: 'out/**/*.test.js',
  mocha: {
    ui: 'tdd',
    timeout: 60000,
  },
});
