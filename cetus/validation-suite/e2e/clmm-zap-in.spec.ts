import { clmmZapInScenario } from '@/fixtures/scenarios.js';
import { ClmmZapInPage } from '@/page-objects/clmm-zap-in.page.js';

import { test } from '../setup/fixtures.js';

/**
 * CLMM Zap In — 单 Token 开仓
 *
 * 与普通 CLMM 开仓 (clmm-open-position) 的区别：
 *   - 开启 "Zap In" 开关后，只需输入一种 Token
 *   - 协议自动完成换算和比例分配
 *   - 提交按钮变为 "Zap In"（而非 "Add Liquidity"）
 *
 * 步骤：
 *   1. 进入 /pools（CLMM 列表）
 *   2. 找到目标池子 → 点击 Deposit
 *   3. 开启 Zap In 开关
 *   4. 选择 Token 标签（SUI / USDC）
 *   5. 输入金额
 *   6. 点击 "Zap In" → 钱包批准
 *   7. 验证交易成功
 */
test.describe('Cetus Mainnet CLMM – Zap In', () => {
  test(
    `zap in ${clmmZapInScenario.inputAmountUi} ${clmmZapInScenario.zapTokenSymbol} ` +
      `to ${clmmZapInScenario.baseSymbol}-${clmmZapInScenario.quoteSymbol} CLMM pool`,
    async ({ page, walletController }) => {
      const zapPage = new ClmmZapInPage(page);

      // ── Step 1: Navigate ────────────────────────────────────────────────────
      await zapPage.goto();
      await walletController.connect(page);

      // ── Step 2: Open deposit form for the pair ──────────────────────────────
      await zapPage.openDepositForPair(
        clmmZapInScenario.baseSymbol,
        clmmZapInScenario.quoteSymbol
      );
      console.log(`[clmm-zap-in] Deposit form opened for ${clmmZapInScenario.baseSymbol}-${clmmZapInScenario.quoteSymbol}`);

      // ── Step 3: Enable Zap In mode ──────────────────────────────────────────
      await zapPage.enableZapIn();

      // ── Step 4: Select the token to zap with ───────────────────────────────
      await zapPage.selectZapToken(clmmZapInScenario.zapTokenSymbol);

      // ── Step 5: Fill the amount ─────────────────────────────────────────────
      await zapPage.fillZapAmount(clmmZapInScenario.inputAmountUi);
      console.log(`[clmm-zap-in] Amount filled: ${clmmZapInScenario.inputAmountUi} ${clmmZapInScenario.zapTokenSymbol}`);

      // ── Step 6: Submit + wallet approval ───────────────────────────────────
      await walletController.approveTransactionForAction(page, () => zapPage.submitZapIn());

      // ── Step 7: Verify success ──────────────────────────────────────────────
      await zapPage.expectZapInSuccess();
      console.log('[clmm-zap-in] ✓ Zap In transaction completed successfully');
    }
  );
});
