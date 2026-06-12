// scripts/codegen-with-extension.ts
import { chromium } from '@playwright/test';

const EXTENSION_PATH =
  '/Users/xiaojian/Library/Application Support/Google/Chrome/Default/Extensions/opcgpfmipidbgpenhmajoajpbobppdil/26.13.5_0';

const context = await chromium.launchPersistentContext('.playwright-wallet-profile', {
  headless: false,
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
  ],
});

const page = await context.newPage();
await page.goto('https://app.cetus.zone/swap');

// 打开 Playwright Inspector，点击左上角红色 Record 按钮开始录制
await page.pause();

await context.close();
