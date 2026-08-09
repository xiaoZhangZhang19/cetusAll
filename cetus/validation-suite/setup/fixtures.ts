import { chromium, test as base, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { env } from '@/config/env.js';
import { createWalletController } from '@/wallet/factory.js';
import { buildWalletScript } from '@/wallet/injected-wallet-script.js';
import { INJECTED_WALLET_NAME, setupSigningBridge } from '@/wallet/injected-controller.js';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { createSuiClient, destroySuiClient } from '@/chain/client.js';

/**
 * 复用 launchPersistentContext() 自带的初始空白页，避免多出一个 about:blank 标签。
 *
 * 只复用真正的空白页：钱包扩展安装后可能自行打开引导页（chrome-extension:// URL），
 * 那些页面不能拿来跑测试，此时新开一个页面。
 */
async function reuseBlankPage(context: BrowserContext): Promise<Page> {
  const blank = context.pages().find((candidate) => {
    const url = candidate.url();
    return url === '' || url === 'about:blank';
  });

  return blank ?? context.newPage();
}

export const test = base.extend<{
  context: BrowserContext;
  page: Page;
  walletController: ReturnType<typeof createWalletController>;
  /**
   * 惰性获取 Playwright 托管的 Browser 实例。
   *
   * 只有 injected / fallback 模式需要它；extension 模式自己
   * launchPersistentContext，调用本工厂即可完全避免多余的浏览器进程。
   */
  browserFactory: () => Promise<Browser>;
}, {
  workerSuiClient: SuiJsonRpcClient;
}>({
  browserFactory: async ({ playwright }, use) => {
    let browser: Browser | undefined;

    await use(async () => {
      browser ??= await playwright.chromium.launch({ headless: env.headless });
      return browser;
    });

    await browser?.close();
  },

  // NOTE: 这里刻意不把 `browser` 声明为 fixture 依赖。
  //
  // 只要声明了 `{ browser }`，Playwright 就会在测试开始前启动一个它托管的浏览器；
  // 而 extension 模式走 chromium.launchPersistentContext() 又会启动第二个，
  // 于是每次跑测试都能看到两个 "Google Chrome for Testing" 进程（第一个全程闲置）。
  // 改用 browserFactory 惰性启动：只有真正需要它的分支（injected / fallback）才启动。
  context: async ({ browserFactory }, use) => {
    // ── Injected wallet mode ───────────────────────────────────────────────
    // No browser extension required. A fake Sui wallet is injected into every
    // page via addInitScript(); signing is bridged to the Node.js process.
    if (env.walletMode === 'injected') {
      const browser = await browserFactory();
      const context = await browser.newContext({
        viewport: { width: 1440, height: 960 }
      });
      await context.addInitScript({
        content: buildWalletScript(env.testWalletAddress, INJECTED_WALLET_NAME)
      });
      await use(context);
      await context.close();
      return;
    }

    // ── Extension wallet mode ──────────────────────────────────────────────
    if (env.walletMode === 'extension' && env.walletExtensionPath) {
      const context = await chromium.launchPersistentContext(env.walletUserDataDir, {
        headless: env.headless,
        args: [
          `--disable-extensions-except=${env.walletExtensionPath}`,
          `--load-extension=${env.walletExtensionPath}`
        ],
        viewport: { width: 1440, height: 960 }
      });
      await use(context);
      await context.close();
      return;
    }

    // ── Fallback: plain browser context ───────────────────────────────────
    const browser = await browserFactory();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 }
    });
    await use(context);
    await context.close();
  },

  page: async ({ context }, use) => {
    // launchPersistentContext() 会自带一个 about:blank 初始页；若再 newPage()
    // 那个空白标签页会一直留在浏览器里。这里复用它而不是新开。
    const page = await reuseBlankPage(context);

    // In injected mode, expose the Node.js signing bridge before the page loads.
    if (env.walletMode === 'injected') {
      await setupSigningBridge(page);
      
      // Forward browser console logs to Node.js console for debugging wallet injection.
      page.on('console', (msg) => {
        const text = msg.text();
        if (text.includes('[Playwright Wallet]')) {
          console.log(`[browser] ${text}`);
        }
      });
    }
    
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
