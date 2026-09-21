import { test as base, type BrowserContext, type Page } from '@playwright/test';

import { env } from '@/config/env.js';
import { createWalletController } from '@/wallet/factory.js';
import { buildWalletScript } from '@/wallet/injected-wallet-script.js';
import { INJECTED_WALLET_NAME, setupSigningBridge } from '@/wallet/injected-controller.js';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { createSuiClient, destroySuiClient } from '@/chain/client.js';

export const test = base.extend<{
  context: BrowserContext;
  page: Page;
  walletController: ReturnType<typeof createWalletController>;
}, {
  workerSuiClient: SuiJsonRpcClient;
}>({
  /**
   * 注入式钱包：不需要浏览器扩展。
   *
   * 每个页面加载前注入一个符合 Sui Wallet Standard 的钱包，
   * 签名请求经 exposeFunction 桥接给 Node 侧的私钥处理。
   */
  context: async ({ playwright }, use) => {
    const browser = await playwright.chromium.launch({ headless: env.headless });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 }
    });
    await context.addInitScript({
      content: buildWalletScript(env.testWalletAddress, INJECTED_WALLET_NAME)
    });

    await use(context);

    await context.close();
    await browser.close();
  },

  page: async ({ context }, use) => {
    const page = await context.newPage();

    // 必须在任何导航之前挂上签名桥，否则注入脚本调用时函数还不存在。
    await setupSigningBridge(page);

    // 把注入钱包的日志透传到 Node 控制台，方便排查注册/连接问题。
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[Playwright Wallet]')) {
        console.log(`[browser] ${text}`);
      }
    });

    await use(page);
    await page.close();
  },

  walletController: async ({}, use) => {
    await use(createWalletController());
  },

  /**
   * SuiJsonRpcClient shared across all tests in the worker.
   * Destroyed on worker teardown to release the internal HTTP connection pool,
   * which is a primary source of memory growth in long-running test sessions.
   * Mirrors the workerBalanceChecker pattern used in the peach project.
   */
  workerSuiClient: [async ({}, use) => {
    const client = createSuiClient();
    await use(client);
    destroySuiClient(client);
    console.log('[fixtures] SuiClient destroyed (HTTP connection pool released)');
  }, { scope: 'worker' }],
});

export { expect } from '@playwright/test';
