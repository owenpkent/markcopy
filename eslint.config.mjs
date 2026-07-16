import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'media/webview.js',
      'media/pdf.js',
      'media/pdf.worker.js',
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
    files: ['src/extension.ts', 'src/render.ts', 'src/pdfEditor.ts'],
    languageOptions: { globals: { ...globals.node } },
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
