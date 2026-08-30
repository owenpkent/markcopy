import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'out',
      '.vscode-test',
      'node_modules',
      'media/webview.js',
      'media/chunk-*.js',
      'media/pdf.js',
      'media/pdf.worker.js',
      'media/stl.js',
      'media/video.js',
      '**/*.map',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
    },
    rules: {
      // markdown-it and pdf.js expose loosely-typed boundaries; allow explicit any there.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // Webview code runs in the browser/iframe context.
    files: ['src/webview/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Extension host code runs in Node.
    files: [
      'src/extension.ts',
      'src/render.ts',
      'src/pdfEditor.ts',
      'src/stlEditor.ts',
      'src/videoEditor.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Tests run under vitest + jsdom (Node globals plus a DOM).
    files: ['tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Integration tests run in VS Code under Mocha (tdd interface).
    files: ['test-integration/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.mocha } },
  },
  {
    // Build and config scripts are CommonJS run directly by Node.
    files: ['*.js', 'scripts/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
