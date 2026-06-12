import { defineConfig, devices } from '@playwright/test';

import { env } from './src/config/env.js';

export default defineConfig({
  testDir: './validation-suite/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
    // JUnit report enables CI (GitHub Checks / TestRail) integration
    ['junit', { outputFile: 'quality-artifacts/junit-results.xml' }],
    // Allure: rich HTML report with trends, categories, timeline and screenshots
    [
      'allure-playwright',
      {
        detail: true,
        outputFolder: 'allure-results',
        suiteTitle: false,
        links: {
          issue: { nameTemplate: 'Issue #%s', urlTemplate: 'https://github.com/your-org/your-repo/issues/%s' },
          tms:   { nameTemplate: 'TMS #%s',   urlTemplate: 'https://your-tms.example.com/tests/%s' }
        }
      }
    ]
  ],
  outputDir: 'quality-artifacts',
  timeout: env.playwrightTimeoutMs,
  expect: {
    timeout: env.expectTimeoutMs
  },
  use: {
    baseURL: env.appUrl,
    headless: env.headless,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: env.actionTimeoutMs
  },
  globalSetup: './validation-suite/setup/global.setup.ts',
  globalTeardown: './validation-suite/setup/global.teardown.ts',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 960 }
      }
    }
  ]
});
