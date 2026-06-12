import { chromium, test as base, type BrowserContext, type Page } from '@playwright/test';
import { env } from '../../src/config/env.js';
import { MetaMaskController } from '../../src/wallet/metamask-controller.js';

/**
 * Extended Playwright test with MetaMask support.
 * 
 * Provides:
 *   - context: BrowserContext with MetaMask extension loaded
 *   - page: Page instance
 *   - metamask: MetaMaskController for wallet operations
 * 
 * Usage in tests:
 *   import { test, expect } from '../validation-suite/setup/fixtures.js';
 */
export const test = base.extend<{
  context: BrowserContext;
  page: Page;
  metamask: MetaMaskController;
}>({
  /**
   * Launch persistent context with MetaMask extension.
   * Uses launchPersistentContext (like cetus) instead of default browser.newContext.
   */
  context: async ({ browser }, use) => {
    if (!env.walletExtensionPath) {
      throw new Error(
        '[fixtures] WALLET_EXTENSION_PATH not set. ' +
        'Download MetaMask from Chrome Web Store and extract the .crx file.'
      );
    }
    
    // Launch persistent context with MetaMask loaded
    const context = await chromium.launchPersistentContext(env.walletUserDataDir, {
      headless: env.headless,
      args: [
        `--disable-extensions-except=${env.walletExtensionPath}`,
        `--load-extension=${env.walletExtensionPath}`,
      ],
      viewport: { width: 1440, height: 960 },
    });
    
    console.log('[fixtures] Persistent context launched with MetaMask extension');
    
    await use(context);
    await context.close();
  },

  /**
   * Create a new page in the extension-enabled context.
   */
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    await page.close();
  },

  /**
   * MetaMask controller instance.
   */
  metamask: async ({}, use) => {
    await use(new MetaMaskController());
  },
});

export { expect } from '@playwright/test';
