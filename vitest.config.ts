import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom gives the table/Turndown tests a real DOM to work against.
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
