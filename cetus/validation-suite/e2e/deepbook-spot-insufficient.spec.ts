import { DeepbookSpotPage } from '@/page-objects/deepbook-spot.page.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P0: DeepBook Spot 资金不足提示测试
 *
 * 在一次测试中连续验证 Buy 和 Sell 两种场景：
 *   1. Buy  模式输入 1,000,000 USDC → 页面显示 "Insufficient USDC balance"
 *   2. Sell 模式输入 1,000,000 SUI  → 页面显示 "Insufficient SUI balance"
 *
 * 无需钱包确认，纯 UI 校验。
 */

const DEEPBOOK_POOL_PATH =
  '/deepbook/0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';

const LARGE_AMOUNT = '1000000';

test.describe('Cetus Mainnet DeepBook Spot — Insufficient Balance', () => {
  test(
    'shows insufficient balance error for both Buy (USDC) and Sell (SUI)',
    async ({ page, walletController }) => {
      test.setTimeout(60_000);

      const spotPage = new DeepbookSpotPage(page);
      await spotPage.goto(DEEPBOOK_POOL_PATH);
      await walletController.connect(page);
      console.log('[deepbook-insufficient:e2e] Wallet connected');

      // ── Part 1: Buy — Insufficient USDC balance ───────────────────────────────
      console.log('[deepbook-insufficient:e2e] === Part 1: Buy mode ===');
      await spotPage.ensureSpotMarketBuy();
      await spotPage.fillAmount(LARGE_AMOUNT, 'USDC');

      const insufficientUsdc = page
        .locator('button, [role="button"], div, span')
        .filter({ hasText: /insufficient\s+usdc\s+balance/i })
        .first();

      await expect(insufficientUsdc).toBeVisible({ timeout: 8_000 });
      console.log('[deepbook-insufficient:e2e] ✓ Buy: "Insufficient USDC balance" visible');

      // ── Part 2: Sell — Insufficient SUI balance ───────────────────────────────
      console.log('[deepbook-insufficient:e2e] === Part 2: Sell mode ===');
      await spotPage.ensureSpotMarketSell();
      await spotPage.fillAmount(LARGE_AMOUNT, 'SUI');

      const insufficientSui = page
        .locator('button, [role="button"], div, span')
        .filter({ hasText: /insufficient\s+sui\s+balance/i })
        .first();

      await expect(insufficientSui).toBeVisible({ timeout: 8_000 });
      console.log('[deepbook-insufficient:e2e] ✓ Sell: "Insufficient SUI balance" visible');

      console.log('[deepbook-insufficient:e2e] ✓ All insufficient balance checks passed');
    }
  );
});
