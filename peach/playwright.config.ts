import { defineConfig, devices } from '@playwright/test';
import { env } from './src/config/env.js';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
    ['junit', { outputFile: 'quality-artifacts/junit-results.xml' }],
  ],
  outputDir: 'quality-artifacts',
  timeout: env.playwrightTimeoutMs,
  expect: { timeout: env.actionTimeoutMs },
  use: {
    baseURL: env.appUrl,
    headless: env.headless,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: env.actionTimeoutMs,
    // Reduce navigation timeout to fail fast rather than hang and consume resources
    navigationTimeout: env.playwrightTimeoutMs,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 960 },
      },
    },
  ],
});
