import { chromium, test as base, type BrowserContext, type Page } from '@playwright/test';

import { env } from '@/config/env.js';
import { createWalletController } from '@/wallet/factory.js';
import { buildWalletScript } from '@/wallet/injected-wallet-script.js';
import { INJECTED_WALLET_NAME, setupSigningBridge } from '@/wallet/injected-controller.js';

export const test = base.extend<{
  context: BrowserContext;
  page: Page;
  walletController: ReturnType<typeof createWalletController>;
}>({
  context: async ({ browser }, use) => {
    // ── Injected wallet mode ───────────────────────────────────────────────
    // No browser extension required. A fake Sui wallet is injected into every
    // page via addInitScript(); signing is bridged to the Node.js process.
    if (env.walletMode === 'injected') {
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
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 }
    });
    await use(context);
    await context.close();
  },

  page: async ({ context }, use) => {
    const page = await context.newPage();
    
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
  }
});

export { expect } from '@playwright/test';
