import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/components/**', 'src/views/**'],
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
