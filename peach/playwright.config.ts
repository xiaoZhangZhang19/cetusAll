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
    [
      'allure-playwright',
      {
        detail: true,
        outputFolder: 'allure-results',
        suiteTitle: false,
        links: {
          issue: { nameTemplate: 'Issue #%s', urlTemplate: 'https://github.com/your-org/peach/issues/%s' },
          tms:   { nameTemplate: 'TMS #%s',   urlTemplate: 'https://your-tms.example.com/tests/%s' }
        }
      }
    ]
  ],
  outputDir: 'quality-artifacts',
  timeout: env.playwrightTimeoutMs,
  expect: { timeout: env.actionTimeoutMs },
  use: {
    baseURL: env.appUrl,
    headless: env.headless,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: env.actionTimeoutMs,
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
