/**
 * 打开一个已注入测试钱包的浏览器用于录制用例。
 *
 * 与直接跑 `playwright codegen` 的区别：这里预先注入了钱包，
 * 所以录制时可以真实走完连接和交易流程。
 *
 * 用法: npm run codegen
 */
import { chromium } from '@playwright/test';

import { env } from '../src/config/env.js';
import { buildWalletScript } from '../src/wallet/injected-wallet-script.js';
import { INJECTED_WALLET_NAME, setupSigningBridge } from '../src/wallet/injected-controller.js';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });

await context.addInitScript({
  content: buildWalletScript(env.testWalletAddress, INJECTED_WALLET_NAME),
});

const page = await context.newPage();
await setupSigningBridge(page);

console.log(`钱包已注入，在连接弹窗里选 "${INJECTED_WALLET_NAME}"`);
console.log(`地址: ${env.testWalletAddress}`);
console.log(`dryRun: ${env.walletDryRun}（true 时交易不会真的广播）`);

await page.goto(`${env.appUrl}/swap`);

// 打开 Playwright Inspector，点击左上角红色 Record 按钮开始录制
await page.pause();

await context.close();
await browser.close();
