import { DlmmCreatePoolPage } from '@/page-objects/dlmm-create-pool.page.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P1: DLMM Create Pool — wallet-reach smoke test
 *
 * 目标：验证"创建 DLMM 新池"的完整操作流程能够走到最后一步（钱包确认弹窗）。
 * 不执行链上交易，钱包拒签即视为测试通过。
 *
 * 步骤（来自 codegen 录制）：
 *   1.  进入 /pools → 点击 "Create a new pool"
 *   2.  点击 "Edit" → 选择 DLMM Pools → Continue
 *   3.  Base token: 搜索 USDC → 选择 Native USDC
 *   4.  Quote token: 搜索 HASUI → 选择 haSUI
 *   5.  Select base fee → 4%
 *   6.  Select bin step → 200 bps Not Created
 *   7.  Continue
 *   8.  Use Market Price
 *   9.  Create → Create（确认弹窗）
 *  10.  钱包弹窗出现 → 拒签
 *  11.  验证页面出现拒签提示
 */
test.describe('Cetus DLMM Create Pool', () => {
  test(
    'reaches wallet confirmation step when creating USDC-haSUI DLMM pool',
    async ({ page, walletController }) => {
      test.setTimeout(120_000);

      const createPoolPage = new DlmmCreatePoolPage(page);

      // ── Step 1: Navigate and connect wallet ─────────────────────────────────
      await createPoolPage.goto();
      await walletController.connect(page);
      console.log('[dlmm-create-pool] Wallet connected');

      // ── Step 2: Open create pool wizard ─────────────────────────────────────
      await createPoolPage.clickCreateNewPool();

      // ── Step 3: Switch to DLMM and continue ─────────────────────────────────
      // codegen: Edit → select DLMM Pools card → Continue
      await createPoolPage.selectDlmmPoolType();

      // ── Step 4: Select base token = USDC (Native USDC) ──────────────────────
      // codegen: locator('div').filter({ hasText: /^USDCNative USDC$/ }).first().click()
      await createPoolPage.selectBaseToken('USDC', /^USDCNative USDC$/);
      console.log('[dlmm-create-pool] Base token: USDC');

      // ── Step 5: Select quote token = haSUI ──────────────────────────────────
      // codegen: getByText('haSUIHaedal staked SUI').click()
      await createPoolPage.selectQuoteToken('HASUI', 'haSUIHaedal staked SUI');
      console.log('[dlmm-create-pool] Quote token: haSUI');

      // ── Step 6: Select base fee = 4% ────────────────────────────────────────
      // codegen: getByRole('button', { name: '4%', exact: true }).click()
      await createPoolPage.selectBaseFee('4%');

      // ── Step 7: Select bin step = 200 bps ───────────────────────────────────
      // codegen: getByRole('button', { name: '200 bps Not Created' }).click()
      await createPoolPage.selectBinStep('200 bps Not Created');

      // ── Step 8: Continue to price step ──────────────────────────────────────
      await createPoolPage.clickContinue();

      // ── Step 9: Use market price ─────────────────────────────────────────────
      await createPoolPage.useMarketPrice();

      // ── Step 10: Create → Create (confirmation modal) ────────────────────────
      await createPoolPage.clickCreate();
      console.log('[dlmm-create-pool] Submitted — waiting for wallet popup');

      // ── Step 11: Reject in wallet ────────────────────────────────────────────
      await walletController.rejectTransaction(page);
      console.log('[dlmm-create-pool] Transaction rejected in wallet');

      await page.waitForTimeout(2_000);

      // ── Step 12: Verify rejection feedback on Cetus page ────────────────────
      const rejectionVisible = await createPoolPage.expectWalletRejectionVisible();

      console.log(`[dlmm-create-pool] Rejection message visible: ${rejectionVisible}`);
      expect(
        rejectionVisible,
        'Cetus page should show a rejection/failure message after wallet rejects'
      ).toBe(true);

      console.log('[dlmm-create-pool] ✓ DLMM Create Pool flow successfully reached wallet confirmation step');
      console.log('[dlmm-create-pool] ✓ Wallet rejection correctly handled and displayed');
    }
  );
});
