import { dlmmZapInScenario } from '@/fixtures/scenarios.js';
import { DlmmZapInPage } from '@/page-objects/dlmm-zap-in.page.js';

import { test } from '../setup/fixtures.js';

/**
 * DLMM Zap In — 单 Token 开仓
 *
 * 与普通 DLMM 开仓 (dlmm:open) 的区别：
 *   - 点击 "Zap In" 标签页（Default | Zap In），切换到单 Token 模式
 *   - 只需输入一种 Token（SUI），协议自动完成换算和分配
 *   - 提交按钮为 "Zap in"（不是 "Add Liquidity"）
 *   - 点击 "Zap in" 后出现确认弹窗，需再次点击 "Add Liquidity"
 *
 * 完整流程：
 *   1. 进入 /pools?tab=dlmm_pools
 *   2. 找到目标池子 → 点击 Deposit
 *   3. 点击 "Zap In" 标签页
 *   4. 输入金额
 *   5. 点击 "Zap in" → 确认 "Add Liquidity" 弹窗
 *   6. 钱包批准
 *   7. 验证交易成功
 */
test.describe('Cetus Mainnet DLMM – Zap In', () => {
  test(
    `zap in ${dlmmZapInScenario.inputAmountUi} ${dlmmZapInScenario.zapTokenSymbol} ` +
      `to ${dlmmZapInScenario.baseSymbol}-${dlmmZapInScenario.quoteSymbol} DLMM pool`,
    async ({ page, walletController }) => {
      const zapPage = new DlmmZapInPage(page);

      // ── Step 1: Navigate ───────────────────────────────────────────────────
      await zapPage.goto();
      await walletController.connect(page);

      // ── Step 2: Open deposit form for the pair ─────────────────────────────
      await zapPage.openDepositForPair(
        dlmmZapInScenario.baseSymbol,
        dlmmZapInScenario.quoteSymbol
      );
      console.log(`[dlmm-zap-in] Deposit form opened for ${dlmmZapInScenario.baseSymbol}-${dlmmZapInScenario.quoteSymbol}`);

      // ── Step 3: Switch to Zap In tab ───────────────────────────────────────
      await zapPage.clickZapInTab();

      // ── Step 4: Fill the amount ────────────────────────────────────────────
      await zapPage.fillZapAmount(dlmmZapInScenario.inputAmountUi);
      console.log(`[dlmm-zap-in] Amount filled: ${dlmmZapInScenario.inputAmountUi} ${dlmmZapInScenario.zapTokenSymbol}`);

      // ── Step 5-6: Submit + confirm dialog + wallet approval ────────────────
      // approveTransactionForAction ensures the wallet popup listener is set up
      // BEFORE submitZapIn() clicks the button, so the popup is not missed.
      await walletController.approveTransactionForAction(page, () => zapPage.submitZapIn());

      // ── Step 7: Verify success ─────────────────────────────────────────────
      await zapPage.expectSuccess();
      console.log('[dlmm-zap-in] ✓ Zap In transaction completed successfully');
    }
  );
});
