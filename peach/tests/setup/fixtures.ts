import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, test as base, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { env } from '../../src/config/env.js';
import { createWalletBridge, type WalletBridge } from '../../src/wallet/bridge.js';
import { E2EWalletController } from '../../src/wallet/e2e-wallet-controller.js';
import { BalanceChecker, createBalanceChecker } from '../../src/utils/balance-checker.js';

/**
 * Worker-scoped fixtures for E2E Wallet tests.
 *
 * 钱包方案：页面加载前注入一个假的 EIP-1193 + EIP-6963 provider，
 * 需要私钥的请求通过 exposeBinding 交给 Node 侧的 ethers 签名。
 *
 * 这个方案的特点：
 *   - 不装浏览器扩展，不需要助记词/解锁密码，没有审批弹窗和风险提示对话框
 *   - headless: true 真正可用
 *   - 无需持久化 profile：provider 对 eth_accounts 返回非空数组即代表已授权，
 *     每个全新 context 都是干净起点，不会互相污染
 *   - 交易成功与否可以直接查链上回执，不必相信前端的成功提示
 *
 * Fixtures：
 *   - workerContext:       注入了 E2E Wallet 的 BrowserContext
 *   - workerPage:          worker 内共享的 Page
 *   - workerWallet:        E2EWalletController，测试里操作钱包的入口
 *   - workerWalletBridge:  WalletBridge，需要直接查 txHash / 回执时使用
 *   - workerBalanceChecker: 链上余额查询
 *
 * 用法：
 *   test('name', async ({ workerPage: page, workerWallet: wallet }) => { ... });
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVIDER_SCRIPT = resolve(__dirname, '../../src/wallet/inject/provider.js');

type WorkerFixtures = {
  workerBrowser: Browser;
  workerWalletBridge: WalletBridge;
  workerContext: BrowserContext;
  workerPage: Page;
  workerWallet: E2EWalletController;
  workerBalanceChecker: BalanceChecker;
};

export const test = base.extend<{}, WorkerFixtures>({
  /** 一个 worker 一个浏览器进程。扩展没了，headless 就能真正生效。 */
  workerBrowser: [async ({}, use) => {
    const browser = await chromium.launch({ headless: env.headless });
    console.log(`[fixtures] Chromium launched (headless=${env.headless})`);
    await use(browser);
    await browser.close();
  }, { scope: 'worker' }],

  /** Node 侧钱包。私钥只存在于这里，页面永远拿不到。 */
  workerWalletBridge: [async ({}, use) => {
    if (!env.e2ePrivateKey) {
      throw new Error(
        '[fixtures] E2E_PRIVATE_KEY 未配置。请在 .env 里填测试钱包私钥（0x + 64 位十六进制）。' +
        '⚠️ 仅使用测试专用钱包 —— 注入钱包会无人工确认地直接广播交易。',
      );
    }
    if (!env.e2eRpcUrl) {
      throw new Error('[fixtures] E2E_RPC_URL 未配置，bridge 需要它来透传读链请求和广播交易。');
    }

    const bridge = createWalletBridge({
      privateKey: env.e2ePrivateKey,
      rpcUrl: env.e2eRpcUrl,
      chainId: env.e2eChainId,
    });
    console.log(`[fixtures] E2E Wallet ready: ${bridge.address} (chainId=${env.e2eChainId})`);

    // 余额为 0 时交易必然失败，提前提示比事后猜测有用
    const balance = await bridge.provider.getBalance(bridge.address).catch(() => null);
    if (balance === null) {
      console.warn(`[fixtures] ⚠ 无法从 ${env.e2eRpcUrl} 读取余额，请确认 RPC 可用`);
    } else {
      console.log(`[fixtures] Native balance: ${balance.toString()} wei`);
      if (balance === 0n) console.warn('[fixtures] ⚠ 余额为 0，任何真实交易都会失败');
    }

    await use(bridge);
    bridge.destroy();
  }, { scope: 'worker' }],

  /** 注入 provider 并接上 bridge 的 context。 */
  workerContext: [async ({ workerBrowser, workerWalletBridge }, use) => {
    const context = await workerBrowser.newContext({
      viewport: { width: 1440, height: 960 },
    });

    // 页面 → Node 的通道。provider.js 里通过 window.__walletBridge 调用。
    await context.exposeBinding('__walletBridge', workerWalletBridge.handle);

    const script = await readFile(PROVIDER_SCRIPT, 'utf8');
    await context.addInitScript({
      content:
        `window.__WALLET_CONFIG__=${JSON.stringify({
          address: workerWalletBridge.address,
          chainId: env.e2eChainId,
          chainIdHex: `0x${env.e2eChainId.toString(16)}`,
          uuid: randomUUID(),
        })};\n${script}`,
    });

    context.on('page', (page) => {
      page.on('pageerror', (err) => console.log(`[page error] ${err.message.slice(0, 160)}`));
    });

    console.log('[fixtures] Context ready with E2E Wallet injected (worker-scoped)');
    await use(context);
    await context.close();
  }, { scope: 'worker' }],

  /** worker 内共享的 Page，各 spec 自行导航到需要的 URL。 */
  workerPage: [async ({ workerContext }, use) => {
    const page = await workerContext.newPage();
    await use(page);
    await page.close();
  }, { scope: 'worker' }],

  /** 钱包控制器：连接、等待签名/交易、查回执。 */
  workerWallet: [async ({ workerWalletBridge }, use) => {
    await use(new E2EWalletController(workerWalletBridge));
  }, { scope: 'worker' }],

  /**
   * BalanceChecker (ethers.JsonRpcProvider) shared across all tests in the worker.
   * Destroyed on worker teardown to release the internal connection pool and
   * polling loops, which are a primary source of memory growth in long runs.
   */
  workerBalanceChecker: [async ({}, use) => {
    const checker = createBalanceChecker(env.e2eRpcUrl || undefined);
    await use(checker);
    checker.destroy();
    console.log('[fixtures] BalanceChecker destroyed (provider connection pool released)');
  }, { scope: 'worker' }],
});

export { expect } from '@playwright/test';
