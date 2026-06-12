import { ClmmCreatePoolPage } from '@/page-objects/clmm-create-pool.page.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P1: CLMM Create Pool — wallet-reach smoke test
 *
 * 目标：验证"创建新池"的完整操作流程能够走到最后一步（钱包确认弹窗）。
 * 不执行链上交易，钱包拒签即视为测试通过。
 *
 * 步骤（来自 codegen 录制）：
 *   1. 进入 /pools → 点击 "Create a new pool"
 *   2. Base token: 搜索 hasui → 选择 haSUI
 *   3. Quote token: 搜索 sui → 选择 SUI
 *   4. Fee tier: 选择 4%
 *   5. Continue → Use Market Price → Continue
 *   6. 填写初始流动性金额 0.1
 *   7. Create → Create and Add Liquidity
 *   8. 钱包弹窗出现 → 拒签
 *   9. 验证页面出现拒签提示
 */
test.describe('Cetus CLMM Create Pool', () => {
  test(
    'reaches wallet confirmation step when creating haSUI-SUI 4% pool',
    async ({ page, walletController }) => {
      test.setTimeout(120_000);

      const createPoolPage = new ClmmCreatePoolPage(page);

      // ── Step 1: Navigate and connect wallet ─────────────────────────────────
      await createPoolPage.goto();
      await walletController.connect(page);
      console.log('[clmm-create-pool] Wallet connected, navigating to pools page');

      // ── Step 2: Open create pool wizard ─────────────────────────────────────
      await createPoolPage.clickCreateNewPool();

      // ── Step 3: Select base token = haSUI ───────────────────────────────────
      await createPoolPage.selectBaseToken('hasui', 'haSUIHaedal staked SUI');
      console.log('[clmm-create-pool] Base token: haSUI');

      // ── Step 4: Select quote token = SUI ────────────────────────────────────
      await createPoolPage.selectQuoteToken('sui', /^SUI$/);
      console.log('[clmm-create-pool] Quote token: SUI');

      // ── Step 5: Select fee tier (auto-select first "Not Created") ──────────────
      // Try 4% first, but if it already exists, pick the first available "Not Created" tier
      await createPoolPage.selectFeeTier('4%');

      // ── Step 6: Continue to price step ──────────────────────────────────────
      await createPoolPage.clickContinue();

      // ── Step 7: Use market price ─────────────────────────────────────────────
      await createPoolPage.useMarketPrice();

      // ── Step 8: Continue to liquidity step ──────────────────────────────────
      await createPoolPage.clickContinue();

      // ── Step 9: Fill initial liquidity ──────────────────────────────────────
      await createPoolPage.fillInitialLiquidity('0.1');
      console.log('[clmm-create-pool] Initial liquidity: 0.1');

      // ── Step 10: Click Create ────────────────────────────────────────────────
      await createPoolPage.clickCreate();

      // ── Step 11: Click Create and Add Liquidity ──────────────────────────────
      await createPoolPage.clickCreateAndAddLiquidity();
      console.log('[clmm-create-pool] Submitted — waiting for wallet popup');

      // ── Step 12: Reject in wallet ────────────────────────────────────────────
      await walletController.rejectTransaction(page);
      console.log('[clmm-create-pool] Transaction rejected in wallet');

      // Wait for the UI to process the rejection
      await page.waitForTimeout(2_000);

      // ── Step 13: Verify rejection feedback on Cetus page ────────────────────
      const rejectionVisible = await createPoolPage.expectWalletRejectionVisible();

      console.log(`[clmm-create-pool] Rejection message visible: ${rejectionVisible}`);
      expect(
        rejectionVisible,
        'Cetus page should show a rejection/failure message after wallet rejects'
      ).toBe(true);

      console.log('[clmm-create-pool] ✓ Create Pool flow successfully reached wallet confirmation step');
      console.log('[clmm-create-pool] ✓ Wallet rejection correctly handled and displayed');
    }
  );
});
