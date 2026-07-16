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
        // detail:false 关闭每个 step 的完整参数快照，大幅减少长测试中
        // allure reporter 在内存里累积的 step attachment 缓冲
        detail: false,
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
