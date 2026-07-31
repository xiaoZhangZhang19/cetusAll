import { clmmRemoveScenario } from '@/fixtures/scenarios.js';
import { type TokenAmounts } from '@/page-objects/clmm-zap-out.page.js';
import { ClmmZapOutPage } from '@/page-objects/clmm-zap-out.page.js';

import { test, expect } from '../setup/fixtures.js';

/**
 * CLMM Zap Out — 单 Token 减仓（两阶段）
 *
 * Phase 1 — 50% 减仓并验证数据：
 *   1. 记录 BEFORE 仓位量
 *   2. 开启 Zap Out → 选 token → 点击 HALF
 *   3. 读取 UI 预估的 "After" 值
 *   4. 提交 Zap Out → 钱包批准
 *   5. 等待 Transaction Completed → 关闭弹窗
 *   6. 读取实际 AFTER 量，与预估值比对（容差 5%）
 *
 * Phase 2 — MAX 关仓（无需重新导航，直接在当前面板操作）：
 *   7. 在当前 Remove 面板直接点击 MAX
 *   8. 提交 Zap Out → 钱包批准
 *   9. 等待 Transaction Completed
 */
test.describe('Cetus Mainnet CLMM – Zap Out', () => {
  test(
    `zap out ${clmmRemoveScenario.removeTokenSymbol} from ${clmmRemoveScenario.baseSymbol}-${clmmRemoveScenario.quoteSymbol} CLMM position`,
    async ({ page, walletController }) => {
      const zapOutPage = new ClmmZapOutPage(page);
      const TOLERANCE = 0.05;

      // ── Navigate to position ───────────────────────────────────────────────
      await zapOutPage.goto();
      await walletController.connect(page);
      await zapOutPage.filterByClmm();

      // Skip early if there are no CLMM positions to operate on.
      // test.skip() with no arguments throws Playwright's internal SkipError,
      // which is the only reliable way to truly interrupt an async test body.
      if (await zapOutPage.hasNoLiquidityPositions()) {
        console.log('[无仓位] 当前账户没有可操作的 CLMM 流动性仓位，跳过本次测试');
        test.skip();
      }

      await zapOutPage.openClmmPositionsForPair(
        clmmRemoveScenario.baseSymbol,
        clmmRemoveScenario.quoteSymbol
      );
      console.log(`[INFO] Navigated to ${clmmRemoveScenario.baseSymbol}-${clmmRemoveScenario.quoteSymbol} position`);

      // ══════════════════════════════════════════════════════════════════════
      // Phase 1: 50% Zap Out + data validation
      // ══════════════════════════════════════════════════════════════════════

      // ── Step 1: Open Remove panel, record BEFORE ──────────────────────────
      await zapOutPage.openFirstPositionRemovePanel();
      await zapOutPage.switchToRemoveTab();

      const before: TokenAmounts = await zapOutPage.readPositionAmounts();
      console.log(`[BEFORE]    SUI=${before.sui.toFixed(6)}  USDC=${before.usdc.toFixed(6)}`);
      expect(before.sui, 'Could not read SUI amount from position table').toBeGreaterThan(0);

      // ── Step 2: Enable Zap Out, select token, click HALF ─────────────────
      await zapOutPage.enableZapOut();
      await zapOutPage.selectZapToken(clmmRemoveScenario.removeTokenSymbol);
      await zapOutPage.clickHalfForToken();
      console.log(`[ZAP OUT] HALF ${clmmRemoveScenario.removeTokenSymbol}`);

      // ── Step 3: Read predicted "After" amounts ────────────────────────────
      const predicted: TokenAmounts = await zapOutPage.readPredictedAfterAmounts(before);
      console.log(`[PREDICTED] SUI=${predicted.sui.toFixed(6)}  USDC=${predicted.usdc.toFixed(6)}`);

      expect(
        predicted.sui,
        'Could not read predicted SUI "After" amount. Check if the UI shows "X SUI After" text.'
      ).toBeGreaterThan(0);
      expect(
        predicted.usdc,
        'Could not read predicted USDC "After" amount. Check if the UI shows "X USDC After" text.'
      ).toBeGreaterThan(0);

      // ── Step 4: Submit + wallet approval ─────────────────────────────────
      await walletController.approveTransactionForAction(page, () => zapOutPage.submitZapOut());

      // ── Step 5: Wait for Transaction Completed, then close modal ─────────
      const txModal = page
        .locator('[role="dialog"], .chakra-modal__content, [class*="modal"]')
        .filter({ hasText: /transaction completed/i })
        .first();
      await expect(txModal).toBeVisible({ timeout: 60_000 });
      console.log('[SUCCESS] Phase 1 transaction completed');

      await page.locator('button[aria-label="Close"]').last().click();

      // ── Step 6: Read actual AFTER, validate vs predicted ──────────────────
      const after: TokenAmounts = await zapOutPage.readPositionAmounts();
      console.log(`[ACTUAL]    SUI=${after.sui.toFixed(6)}  USDC=${after.usdc.toFixed(6)}`);

      console.log('\n[VALIDATION Phase 1]');
      console.log(`  SUI:  before=${before.sui.toFixed(6)}  predicted=${predicted.sui.toFixed(6)}  actual=${after.sui.toFixed(6)}`);
      console.log(`  USDC: before=${before.usdc.toFixed(6)}  predicted=${predicted.usdc.toFixed(6)}  actual=${after.usdc.toFixed(6)}`);

      expect(after.sui).toBeGreaterThanOrEqual(predicted.sui * (1 - TOLERANCE));
      expect(after.sui).toBeLessThanOrEqual(predicted.sui * (1 + TOLERANCE));
      expect(after.usdc).toBeGreaterThanOrEqual(predicted.usdc * (1 - TOLERANCE));
      expect(after.usdc).toBeLessThanOrEqual(predicted.usdc * (1 + TOLERANCE));
      console.log('[VALIDATION Phase 1] ✓ Passed');

      // ══════════════════════════════════════════════════════════════════════
      // Phase 2: MAX Zap Out — close the position entirely
      // Remove panel is still open on the current page; no navigation needed.
      // ══════════════════════════════════════════════════════════════════════

      // ── Step 7: Click MAX directly in the current Remove panel ───────────
      await zapOutPage.clickMaxForToken(clmmRemoveScenario.removeTokenSymbol);
      console.log(`[ZAP OUT] MAX ${clmmRemoveScenario.removeTokenSymbol}`);

      // ── Step 8: Submit + wallet approval ─────────────────────────────────
      await walletController.approveTransactionForAction(page, () => zapOutPage.submitZapOut());

      // ── Step 9: Wait for transaction success ──────────────────────────────
      const successText2 = page.getByText(/transaction completed|success|view in explorer/i).first();
      await expect(successText2).toBeVisible({ timeout: 60_000 });
      console.log('[SUCCESS] Phase 2 (MAX) Zap Out completed — position closed');
    }
  );
});
