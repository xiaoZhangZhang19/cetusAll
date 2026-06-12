import { clmmZapInScenario } from '@/fixtures/scenarios.js';
import { type TokenAmounts } from '@/page-objects/add-liquidity-base.page.js';
import { ClmmZapIncreasePage } from '@/page-objects/clmm-zap-increase.page.js';

import { test, expect } from '../setup/fixtures.js';

/**
 * CLMM Zap In Increase — 单 Token 追加流动性
 *
 * 与 clmm:add 的区别：
 *   - 在 increase 页面开启 "Zap In" 开关
 *   - 只需输入一种 Token（SUI），协议自动完成换算
 *   - 提交按钮为 "Zap In"（不是 "Add More Liquidity"）
 *   - 点击后直接触发钱包批准（无中间确认弹窗）
 *
 * 校验逻辑：
 *   - 填入 0.01 SUI 后，Liquidity 表格会出现 "X SUI After" / "X USDC After" 预估值
 *   - 交易完成后刷新页面，读取实际仓位值
 *   - 实际值应与预估值接近（容差 5%，允许价格波动）
 *
 * 完整流程：
 *   1. /pools?tab=positions → 筛选 CLMM
 *   2. 找到 SUI-USDC 仓位 → 点击 "+"
 *   3. 记录 BEFORE 数量
 *   4. 开启 Zap In 开关 → 选 SUI tab → 输入 0.01
 *   5. 读取 UI 预估的 "After" 值
 *   6. 点击 Zap In → 钱包批准
 *   7. 等待 Transaction Completed
 *   8. 刷新页面 → 记录实际 AFTER 数量
 *   9. 验证实际值与预估值相符（容差 5%）
 */
test.describe('Cetus Mainnet CLMM – Zap In Increase', () => {
  test(
    `zap increase ${clmmZapInScenario.inputAmountUi} ${clmmZapInScenario.zapTokenSymbol} ` +
      `into existing ${clmmZapInScenario.baseSymbol}-${clmmZapInScenario.quoteSymbol} CLMM position`,
    async ({ page, walletController }) => {
      const zapPage = new ClmmZapIncreasePage(page);

      // ── Step 1-3: Navigate to position increase page ──────────────────────
      await zapPage.goto();
      await walletController.connect(page);
      await zapPage.filterByClmm();
      await zapPage.openAddLiquidityForPair(
        clmmZapInScenario.baseSymbol,
        clmmZapInScenario.quoteSymbol
      );
      await zapPage.waitForIncreasePageReady();

      // ── Step 4: Record BEFORE amounts ────────────────────────────────────
      const before: TokenAmounts = await zapPage.readPositionAmounts();
      console.log(`[BEFORE]    SUI=${before.sui.toFixed(6)}  USDC=${before.usdc.toFixed(6)}`);
      expect(before.sui, 'Could not read SUI amount from position table').toBeGreaterThan(0);

      // ── Step 5: Enable Zap In, select token, fill amount ─────────────────
      await zapPage.enableZapIn();
      await zapPage.selectZapToken(clmmZapInScenario.zapTokenSymbol);
      await zapPage.fillZapAmount(clmmZapInScenario.inputAmountUi);
      console.log(`[ZAP INPUT] ${clmmZapInScenario.inputAmountUi} ${clmmZapInScenario.zapTokenSymbol}`);

      // ── Step 6: Read predicted "After" amounts from Liquidity table ───────
      // After entering the amount, the UI shows "0.01844 SUI After" / "0.02557 USDC After"
      // which are the expected position values post-transaction.
      const predicted = await zapPage.readPredictedAfterAmounts(before);
      console.log(`[PREDICTED] SUI=${predicted.sui.toFixed(6)}  USDC=${predicted.usdc.toFixed(6)}`);

      // ── Step 7: Submit + wallet approval ─────────────────────────────────
      // Use approveTransactionForAction so the wallet popup listener is set up
      // BEFORE clicking "Zap In" — otherwise the popup opens during submitZapIn()
      // and the listener in approveTransaction() misses it.
      await walletController.approveTransactionForAction(page, () => zapPage.submitZapIn());

      // ── Step 8: Wait for "Transaction Completed" modal, then close it ────
      const txModal = page
        .locator('[role="dialog"], .chakra-modal__content, [class*="modal"]')
        .filter({ hasText: /transaction completed/i })
        .first();
      await expect(txModal).toBeVisible({ timeout: 60_000 });
      console.log('[SUCCESS]   Transaction completed');

      // Click the × close button (Chakra UI: aria-label="Close")
      await page.locator('button[aria-label="Close"]').last().click();
      console.log('[INFO]      Modal closed');

      // ── Step 9: Read actual AFTER amounts directly from page (no reload) ──
      // After closing the modal, the Liquidity table shows the updated values.
      const after: TokenAmounts = await zapPage.readPositionAmounts();
      console.log(`[ACTUAL]    SUI=${after.sui.toFixed(6)}  USDC=${after.usdc.toFixed(6)}`);

      // ── Step 10: Validate actual vs predicted (5% tolerance) ─────────────
      const TOLERANCE = 0.05;
      console.log('\n[VALIDATION]');
      console.log(`  SUI:  before=${before.sui.toFixed(6)}  predicted=${predicted.sui.toFixed(6)}  actual=${after.sui.toFixed(6)}`);
      console.log(`  USDC: before=${before.usdc.toFixed(6)}  predicted=${predicted.usdc.toFixed(6)}  actual=${after.usdc.toFixed(6)}`);

      // Predicted values must be non-zero — if they are 0, the UI parsing failed.
      expect(
        predicted.sui,
        'Could not read predicted SUI "After" amount from Liquidity table. Check if the UI shows "X SUI After" text after filling the amount.'
      ).toBeGreaterThan(0);
      expect(
        predicted.usdc,
        'Could not read predicted USDC "After" amount from Liquidity table. Check if the UI shows "X USDC After" text after filling the amount.'
      ).toBeGreaterThan(0);

      // Actual values should match predicted within ±5% tolerance
      expect(
        after.sui,
        `SUI actual=${after.sui.toFixed(6)} deviates from predicted=${predicted.sui.toFixed(6)} by more than ${TOLERANCE * 100}%`
      ).toBeGreaterThanOrEqual(predicted.sui * (1 - TOLERANCE));
      expect(
        after.sui,
        `SUI actual=${after.sui.toFixed(6)} is unexpectedly much higher than predicted=${predicted.sui.toFixed(6)}`
      ).toBeLessThanOrEqual(predicted.sui * (1 + TOLERANCE));

      expect(
        after.usdc,
        `USDC actual=${after.usdc.toFixed(6)} deviates from predicted=${predicted.usdc.toFixed(6)} by more than ${TOLERANCE * 100}%`
      ).toBeGreaterThanOrEqual(predicted.usdc * (1 - TOLERANCE));
      expect(
        after.usdc,
        `USDC actual=${after.usdc.toFixed(6)} is unexpectedly much higher than predicted=${predicted.usdc.toFixed(6)}`
      ).toBeLessThanOrEqual(predicted.usdc * (1 + TOLERANCE));

      console.log('[VALIDATION] ✓ Passed');
    }
  );
});
