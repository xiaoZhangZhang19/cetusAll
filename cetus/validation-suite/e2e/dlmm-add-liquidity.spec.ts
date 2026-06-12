import { dlmmAddMoreScenario } from '@/fixtures/scenarios.js';
import { DlmmAddLiquidityPage, type TokenAmounts } from '@/page-objects/dlmm-add-liquidity.page.js';

import { test, expect } from '../setup/fixtures.js';

/**
 * DLMM Add More Liquidity — P0
 *
 * 测试流程（与 CLMM 完全一致，区别是筛选 DLMM 标签）：
 *   1. 打开 /pools → 点击 My Positions → /pools?tab=positions
 *   2. 点击 DLMM 子筛选
 *   3. 找到 SUI-USDC 持仓行 → 点击 "+" → /position-detail/{id}/increase
 *   4. 记录执行前的 SUI 和 USDC 数量（从 Liquidity 表格读取）
 *   5. 输入 0.01 SUI → USDC 自动填充
 *   6. 记录表单中将要添加的 SUI 和 USDC 数量
 *   7. 点击 "Add More Liquidity" → 在 Slush 钱包中批准
 *   8. 等待 "Transaction Completed" 弹窗 → 读取实际添加的金额
 *   9. 关闭弹窗
 *  10. 重新加载页面 → 记录执行后的 SUI 和 USDC 数量
 *  11. 验证数量确实增加（容差 100%）
 */
test.describe('Cetus Mainnet DLMM – Add More Liquidity', () => {
  test(
    `adds ${dlmmAddMoreScenario.inputAmountUi} ${dlmmAddMoreScenario.inputTokenSymbol} ` +
      `to existing ${dlmmAddMoreScenario.baseSymbol}-${dlmmAddMoreScenario.quoteSymbol} DLMM position`,
    async ({ page, walletController }) => {
      const addPage = new DlmmAddLiquidityPage(page);

      // ── Step 1-3: Navigate to increase page ───────────────────────────────
      await addPage.goto();
      await walletController.connect(page);
      await addPage.filterByDlmm();
      await addPage.openAddLiquidityForPair(
        dlmmAddMoreScenario.baseSymbol,
        dlmmAddMoreScenario.quoteSymbol
      );
      await addPage.waitForIncreasePageReady();

      // ── Step 4: Record BEFORE amounts ─────────────────────────────────────
      const before: TokenAmounts = await addPage.readPositionAmounts();
      console.log(`[BEFORE] SUI=${before.sui.toFixed(6)}  USDC=${before.usdc.toFixed(6)}`);

      expect(before.sui, 'Could not read SUI amount from position table').toBeGreaterThan(0);
      expect(before.usdc, 'Could not read USDC amount from position table').toBeGreaterThan(0);

      // ── Step 5: Enter deposit amount ──────────────────────────────────────
      await addPage.fillTokenAmount(
        dlmmAddMoreScenario.inputTokenSymbol,
        dlmmAddMoreScenario.inputAmountUi
      );

      // ── Step 6: Record deposit form values (USDC auto-filled) ─────────────
      const deposit: TokenAmounts = await addPage.readDepositFormAmounts();
      console.log(`[DEPOSIT FORM] SUI=${deposit.sui.toFixed(6)}  USDC=${deposit.usdc.toFixed(6)}`);

      expect(deposit.sui, 'Deposit form SUI should match the entered amount').toBeCloseTo(
        parseFloat(dlmmAddMoreScenario.inputAmountUi),
        2
      );
      // DLMM calculates USDC asynchronously based on Spot strategy and bin distribution.
      // USDC may be 0 if the position range only requires SUI at current price.
      expect(deposit.usdc, 'Deposit form USDC should be non-negative').toBeGreaterThanOrEqual(0);

      // ── Step 7: Submit + wallet approval ──────────────────────────────────
      await addPage.submitAddMoreLiquidity();
      await walletController.approveTransaction(page);

      // ── Step 8: Wait for "Transaction Completed" modal, parse added amounts
      const added: TokenAmounts = await addPage.waitForTransactionCompletedModal();
      console.log(`[MODAL - ACTUAL ADDED] SUI=${added.sui.toFixed(6)}  USDC=${added.usdc.toFixed(6)}`);

      // ── Step 9: Close the success modal ───────────────────────────────────
      await addPage.closeTransactionModal();

      // ── Step 10: Reload page and read AFTER amounts ────────────────────────
      await addPage.reloadAndWaitForPositionData();
      const after: TokenAmounts = await addPage.readPositionAmounts();
      console.log(`[AFTER]  SUI=${after.sui.toFixed(6)}  USDC=${after.usdc.toFixed(6)}`);

      // ── Step 11: Assert amounts increased within 100% tolerance ────────────
      const authoritative: TokenAmounts = {
        sui: added.sui > 0 ? added.sui : deposit.sui,
        usdc: added.usdc > 0 ? added.usdc : deposit.usdc
      };

      const suiIncrease = after.sui - before.sui;
      const usdcIncrease = after.usdc - before.usdc;
      const suiIncreasePercent = ((suiIncrease / before.sui) * 100).toFixed(2);
      const usdcIncreasePercent = ((usdcIncrease / before.usdc) * 100).toFixed(2);

      console.log(`\n[INCREASES]`);
      console.log(`  SUI:  ${before.sui.toFixed(6)} → ${after.sui.toFixed(6)}  (+${suiIncrease.toFixed(6)}, +${suiIncreasePercent}%)`);
      console.log(`  USDC: ${before.usdc.toFixed(6)} → ${after.usdc.toFixed(6)}  (+${usdcIncrease.toFixed(6)}, +${usdcIncreasePercent}%)`);
      console.log(`  Expected added: SUI=${authoritative.sui.toFixed(6)}, USDC=${authoritative.usdc.toFixed(6)}\n`);

      addPage.assertAmountsIncreased(before, authoritative, after, 1.0);
    }
  );
});
