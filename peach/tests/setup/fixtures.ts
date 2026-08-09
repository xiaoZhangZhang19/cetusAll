import { chromium, test as base, type BrowserContext, type Page } from '@playwright/test';
import { env } from '../../src/config/env.js';
import { MetaMaskController } from '../../src/wallet/metamask-controller.js';
import { BalanceChecker, createBalanceChecker } from '../../src/utils/balance-checker.js';

/**
 * Worker-scoped fixtures for MetaMask E2E tests.
 *
 * All three fixtures are worker-scoped: a single Chrome instance (with MetaMask loaded)
 * is launched once per worker process and shared across all tests in that worker.
 * This avoids the heavy cost of starting/stopping Chrome + MetaMask on every test.
 *
 * Note: Playwright's built-in `context` and `page` names are reserved as test-scoped.
 * We use `workerContext`, `workerPage`, and `workerMetamask` to avoid type conflicts.
 *
 * Fixtures:
 *   - workerContext: BrowserContext with MetaMask extension loaded (worker-scoped)
 *   - workerPage:    a single Page reused across tests in the worker (worker-scoped)
 *   - workerMetamask: MetaMaskController for wallet operations (worker-scoped)
 *
 * In your test files, destructure from the fixture object:
 *   test('name', async ({ workerPage: page, workerMetamask: metamask }) => { ... });
 *
 * Usage in tests:
 *   import { test, expect } from '../setup/fixtures.js';
 */

/**
 * 复用 launchPersistentContext() 自带的初始空白页，避免多出一个 about:blank 标签。
 *
 * 只复用真正的空白页：MetaMask 安装后会自行打开引导页（chrome-extension:// URL），
 * 那些页面不能拿来跑测试，此时新开一个页面。
 */
async function reuseBlankPage(context: BrowserContext): Promise<Page> {
  const blank = context.pages().find((candidate) => {
    const url = candidate.url();
    return url === '' || url === 'about:blank';
  });

  return blank ?? context.newPage();
}

type WorkerFixtures = {
  workerContext: BrowserContext;
  workerPage: Page;
  workerMetamask: MetaMaskController;
  workerBalanceChecker: BalanceChecker;
};

export const test = base.extend<{}, WorkerFixtures>({
  /**
   * Launch persistent context with MetaMask extension.
   * Runs once per worker; all tests in the worker share this context.
   */
  workerContext: [async ({}, use) => {
    if (!env.walletExtensionPath) {
      throw new Error(
        '[fixtures] WALLET_EXTENSION_PATH not set. ' +
        'Download MetaMask from Chrome Web Store and extract the .crx file.'
      );
    }

    // Chrome extensions (MetaMask) do NOT work with headless: true.
    // When env.headless is true we move the window off-screen and strip the GPU pipeline
    // to reduce resource consumption without using headless mode.
    // Note: --disable-background-timer-throttling / --disable-renderer-backgrounding
    // are intentionally omitted — they prevent the CPU throttle that saves resources.
    const backgroundArgs = env.headless ? [
      '--window-position=-10000,-10000',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--mute-audio',
    ] : [];

    const context = await chromium.launchPersistentContext(env.walletUserDataDir, {
      headless: false,   // must be false for Chrome extensions to work
      args: [
        `--disable-extensions-except=${env.walletExtensionPath}`,
        `--load-extension=${env.walletExtensionPath}`,
        ...backgroundArgs,
      ],
      viewport: { width: 1440, height: 960 },
    });

    console.log('[fixtures] Persistent context launched with MetaMask extension (worker-scoped)');

    await use(context);
    await context.close();
  }, { scope: 'worker' }],

  /**
   * A single page shared across all tests in the worker.
   * Tests navigate to the URL they need rather than receiving a fresh page.
   */
  workerPage: [async ({ workerContext }, use) => {
    // launchPersistentContext() 会自带一个 about:blank 初始页；若再 newPage()
    // 那个空白标签页会一直留在浏览器里。这里复用它而不是新开。
    const page = await reuseBlankPage(workerContext);
    await use(page);
    await page.close();
  }, { scope: 'worker' }],

  /**
   * MetaMask controller shared across all tests in the worker.
   */
  workerMetamask: [async ({}, use) => {
    await use(new MetaMaskController());
  }, { scope: 'worker' }],

  /**
   * BalanceChecker (ethers.JsonRpcProvider) shared across all tests in the worker.
   * Destroyed on worker teardown to release the internal connection pool and
   * polling loops, which are a primary source of memory growth in long runs.
   */
  workerBalanceChecker: [async ({}, use) => {
    const bscRpcUrl = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/';
    const checker = createBalanceChecker(bscRpcUrl);
    await use(checker);
    checker.destroy();
    console.log('[fixtures] BalanceChecker destroyed (provider connection pool released)');
  }, { scope: 'worker' }],
});

export { expect } from '@playwright/test';
