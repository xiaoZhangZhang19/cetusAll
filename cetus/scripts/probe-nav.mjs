// 临时探测脚本：用 Chromium 访问 app.cetus.zone/swap，打印导航响应状态与失败原因。
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'https://app.cetus.zone/swap';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();

page.on('requestfailed', (req) => {
  if (req.isNavigationRequest()) {
    console.log(`[requestfailed] ${req.url()} → ${req.failure()?.errorText}`);
  }
});
page.on('response', (res) => {
  if (res.request().isNavigationRequest()) {
    console.log(`[response] ${res.status()} ${res.url()}`);
  }
});

for (let i = 1; i <= 3; i++) {
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    console.log(`attempt ${i}: ok status=${res?.status()} title="${await page.title()}"`);
  } catch (err) {
    console.log(`attempt ${i}: FAILED ${err.message.split('\n')[0]}`);
  }
}

await browser.close();
