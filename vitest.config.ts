import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom gives the table/Turndown tests a real DOM to work against.
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    // Half the cores, not all of them: a full run on every core starved the
    // maintainer's desktop (an on-screen keyboard and the shell crashed), and
    // the suite is fast enough either way.
    maxWorkers: '50%',
  },
});
