import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['validation-suite/integration/**/*.spec.ts'],
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
