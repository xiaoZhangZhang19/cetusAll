import { dlmmZapIncreaseScenario } from '@/fixtures/scenarios.js';
import { DlmmZapIncreasePage, type TokenAmounts } from '@/page-objects/dlmm-zap-increase.page.js';

import { test, expect } from '../setup/fixtures.js';

/**
 * DLMM Zap In Increase — 单 Token 追加流动性
 *
 * 与 dlmm:add 的区别：
 *   - 点击 "Zap In" 标签页（Default | Zap In），切换到单 Token 模式
 *   - 只需输入一种 Token（SUI），协议自动完成换算
 *   - 提交按钮为 "Add More Liquidity"（Zap In 模式下同名但内部走 zap 路由）
 *   - 点击后直接触发钱包批准（无中间确认弹窗）
 *
 * 校验逻辑（与 clmm:zap:increase 一致）：
 *   - 填入 0.01 SUI 后，Liquidity 表格会出现 "X SUI After" / "X USDC After" 预估值
 *   - 交易完成后，关闭弹窗，从当前页面读取实际仓位值
 *   - 实际值应与预估值接近（容差 5%，允许价格波动）
 *
 * 完整流程：
 *   1. /pools?tab=positions → 筛选 DLMM
 *   2. 找到 SUI-USDC 仓位 → 点击 "+"
 *   3. 记录 BEFORE 数量
 *   4. 点击 Zap In 标签 → 输入 0.01
 *   5. 读取 UI 预估的 "After" 值
 *   6. 点击 Add More Liquidity → 钱包批准
 *   7. 等待 Transaction Completed → 关闭弹窗
 *   8. 记录实际 AFTER 数量
 *   9. 验证实际值与预估值相符（容差 5%）
 */
test.describe('Cetus Mainnet DLMM – Zap In Increase', () => {
  test(
    `zap increase ${dlmmZapIncreaseScenario.inputAmountUi} ${dlmmZapIncreaseScenario.zapTokenSymbol} ` +
      `into existing ${dlmmZapIncreaseScenario.baseSymbol}-${dlmmZapIncreaseScenario.quoteSymbol} DLMM position`,
    async ({ page, walletController }) => {
      const zapPage = new DlmmZapIncreasePage(page);
      const TOLERANCE = 0.05;

      // ── Step 1-2: Navigate to position increase page ──────────────────────
      await zapPage.goto();
      await walletController.connect(page);
      await zapPage.filterByDlmm();
      await zapPage.openAddLiquidityForPair(
        dlmmZapIncreaseScenario.baseSymbol,
        dlmmZapIncreaseScenario.quoteSymbol
      );
      await zapPage.waitForIncreasePageReady();

      // ── Step 3: Record BEFORE amounts ─────────────────────────────────────
      const before: TokenAmounts = await zapPage.readPositionAmounts();
      console.log(`[BEFORE]    SUI=${before.sui.toFixed(6)}  USDC=${before.usdc.toFixed(6)}`);
      expect(before.sui, 'Could not read SUI amount from position table').toBeGreaterThan(0);

      // ── Step 4: Switch to Zap In tab, fill amount ─────────────────────────
      await zapPage.clickZapInTab();
      await zapPage.fillZapAmount(dlmmZapIncreaseScenario.inputAmountUi);
      console.log(`[ZAP INPUT] ${dlmmZapIncreaseScenario.inputAmountUi} ${dlmmZapIncreaseScenario.zapTokenSymbol}`);

      // ── Step 5: Read predicted "After" amounts ────────────────────────────
      const predicted: TokenAmounts = await zapPage.readPredictedAfterAmounts(before);
      console.log(`[PREDICTED] SUI=${predicted.sui.toFixed(6)}  USDC=${predicted.usdc.toFixed(6)}`);

      expect(
        predicted.sui,
        'Could not read predicted SUI "After" amount. Check if the UI shows "X SUI After" text after filling the amount.'
      ).toBeGreaterThan(0);
      expect(
        predicted.usdc,
        'Could not read predicted USDC "After" amount. Check if the UI shows "X USDC After" text after filling the amount.'
      ).toBeGreaterThan(0);

      // ── Step 6: Submit + wallet approval ─────────────────────────────────
      // approveTransactionForAction ensures listener is set up BEFORE clicking,
      // so the wallet popup is not missed.
      await walletController.approveTransactionForAction(page, () => zapPage.submitZapIn());

      // ── Step 7: Wait for Transaction Completed, close modal ───────────────
      const txModal = page
        .locator('[role="dialog"], .chakra-modal__content, [class*="modal"]')
        .filter({ hasText: /transaction completed/i })
        .first();
      await expect(txModal).toBeVisible({ timeout: 60_000 });
      console.log('[SUCCESS]   Transaction completed');

      await page.locator('button[aria-label="Close"]').last().click();

      // ── Step 8: Read actual AFTER amounts directly from page ──────────────
      const after: TokenAmounts = await zapPage.readPositionAmounts();
      console.log(`[ACTUAL]    SUI=${after.sui.toFixed(6)}  USDC=${after.usdc.toFixed(6)}`);

      // ── Step 9: Validate actual vs predicted (5% tolerance) ───────────────
      console.log('\n[VALIDATION]');
      console.log(`  SUI:  before=${before.sui.toFixed(6)}  predicted=${predicted.sui.toFixed(6)}  actual=${after.sui.toFixed(6)}`);
      console.log(`  USDC: before=${before.usdc.toFixed(6)}  predicted=${predicted.usdc.toFixed(6)}  actual=${after.usdc.toFixed(6)}`);

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
