import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { DlmmAddLiquidityPage } from './dlmm-add-liquidity.page.js';

export type { TokenAmounts } from './add-liquidity-base.page.js';

/**
 * Page Object for DLMM Zap In Increase — single-token add liquidity to an existing position.
 *
 * Extends DlmmAddLiquidityPage, reusing navigation + readPositionAmounts logic.
 *
 * Key differences from normal DLMM add (dlmm:add):
 *   - Click the "Zap In" tab (Default | Zap In) in the Deposit Amounts panel
 *   - Only one token input — enter amount and click "Add More Liquidity"
 *   - No confirmation dialog; clicking "Add More Liquidity" directly triggers wallet
 *
 * Full flow:
 *   1. goto()                              → /pools?tab=positions
 *   2. filterByDlmm()
 *   3. openAddLiquidityForPair(b, q)       → click "+" → position detail page
 *   4. waitForIncreasePageReady()
 *   5. readPositionAmounts()               → BEFORE amounts
 *   6. clickZapInTab()                     → switch to Zap In tab
 *   7. fillZapAmount(amount)               → fill single-token input, wait for route calc
 *   8. readPredictedAfterAmounts(before)   → read "X SUI After" / "X USDC After"
 *   9. submitZapIn()                       → click "Add More Liquidity" → wallet
 *  10. (wallet approval externally)
 *  11. Close Transaction Completed modal
 *  12. readPositionAmounts()               → AFTER amounts
 *  13. Validate actual vs predicted (5% tolerance)
 */
export class DlmmZapIncreasePage extends DlmmAddLiquidityPage {
  constructor(page: Page) {
    super(page);
  }

  // ─── Step: Click "Zap In" tab ─────────────────────────────────────────────────

  /**
   * Switch from "Default" to "Zap In" mode by clicking the "Zap In" tab
   * in the Deposit Amounts panel. (Tab-style button, not a toggle switch.)
   */
  async clickZapInTab() {
    const depositPanel = this.page
      .getByText(/^deposit amounts$/i)
      .first()
      .locator('xpath=ancestor::*[self::div or self::section][2]');
    await expect(depositPanel).toBeVisible({ timeout: 15_000 });

    const zapInTab = depositPanel
      .locator('button, [role="tab"], [role="button"], div')
      .filter({ hasText: /^zap\s*in$/i })
      .first();
    await expect(zapInTab).toBeVisible({ timeout: 10_000 });
    await zapInTab.click();
    await this.page.waitForTimeout(500);
    console.log('[DlmmZapIncrease] Clicked "Zap In" tab');
  }

  // ─── Step: Fill single-token amount ──────────────────────────────────────────

  /**
   * Fill the single-token amount input in Zap In mode.
   * Waits for Zap Route calculation to complete (networkidle) before returning.
   */
  async fillZapAmount(amount: string) {
    const depositPanel = this.page
      .getByText(/^deposit amounts$/i)
      .first()
      .locator('xpath=ancestor::*[self::div or self::section][2]');

    const input = depositPanel
      .locator('input[inputmode="decimal"], input[type="number"], input[type="text"], [contenteditable="true"]')
      .first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(amount);

    // Wait for Zap Route calculation
    await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    console.log(`[DlmmZapIncrease] Filled zap amount: ${amount}`);
  }

  // ─── Step: Read predicted "After" amounts ────────────────────────────────────

  /**
   * After filling the Zap In amount, the Liquidity table shows predicted values:
   *   SUI  | 0.005086  [0.01017 SUI After]
   *   USDC | 0.005987  [0.01201 USDC After]
   *
   * Uses innerText()+split('\n') to read chip lines without concatenation issues.
   * Polls until values differ from `before` (placeholder = current amounts).
   */
  async readPredictedAfterAmounts(before: { sui: number; usdc: number }): Promise<{ sui: number; usdc: number }> {
    const tokenHeader = this.page.getByText(/^token$/i).first();
    await tokenHeader.waitFor({ state: 'visible', timeout: 10_000 });
    const tableContainer = tokenHeader.locator('xpath=ancestor::*[self::div or self::section or self::table][3]');

    const deadline = Date.now() + 15_000;
    let sui = 0;
    let usdc = 0;

    while (Date.now() < deadline) {
      const tableText = await tableContainer.innerText().catch(() => '');
      const lines = tableText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

      for (const line of lines) {
        const suiMatch  = line.match(/^([\d.]+)\s+SUI\s+After$/i);
        const usdcMatch = line.match(/^([\d.]+)\s+USDC\s+After$/i);
        if (suiMatch)  sui  = parseFloat(suiMatch[1]);
        if (usdcMatch) usdc = parseFloat(usdcMatch[1]);
      }

      const suiChanged  = sui  > 0 && Math.abs(sui  - before.sui)  > 0.000001;
      const usdcChanged = usdc > 0 && Math.abs(usdc - before.usdc) > 0.000001;
      if (suiChanged || usdcChanged) break;

      await this.page.waitForTimeout(500);
    }

    console.log(`[DlmmZapIncrease] Predicted After — SUI=${sui.toFixed(6)}  USDC=${usdc.toFixed(6)}`);
    return { sui, usdc };
  }

  // ─── Step: Submit ─────────────────────────────────────────────────────────────

  /**
   * Click "Add More Liquidity" to submit the Zap In.
   * For DLMM Zap In increase, clicking this button directly triggers wallet approval
   * (no intermediate confirmation dialog).
   */
  async submitZapIn() {
    const addMoreBtn = this.page
      .getByRole('button', { name: /^add more liquidity$/i })
      .first();
    await expect(addMoreBtn).toBeVisible({ timeout: 15_000 });
    await expect(addMoreBtn).toBeEnabled({ timeout: 15_000 });
    await addMoreBtn.click();
    console.log('[DlmmZapIncrease] Clicked "Add More Liquidity" button');
  }
}
