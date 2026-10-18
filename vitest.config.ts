import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/**/*.test.{ts,tsx}',
      'tools/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
    ],
    testTimeout: 15000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
