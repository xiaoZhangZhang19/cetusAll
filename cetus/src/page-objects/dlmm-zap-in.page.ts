import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { DlmmPoolsPage } from './dlmm-pools.page.js';

/**
 * Page Object for DLMM Zap In — single-token open position.
 *
 * Extends DlmmPoolsPage, reusing navigation + openDepositForPair logic.
 *
 * Key difference from normal DLMM open (dlmm:open):
 *   - Click the "Zap In" tab (Default | Zap In) instead of using Default mode
 *   - Only one token input appears — enter amount and click "Zap in" button
 *   - A confirmation dialog appears → click "Add Liquidity" to confirm
 *   - Wallet approval follows
 *
 * Full flow:
 *   1. goto()                              → /pools?tab=dlmm_pools
 *   2. openDepositForPair(base, quote)     → find pool row → click Deposit
 *   3. clickZapInTab()                     → click "Zap In" tab
 *   4. fillZapAmount(amount)               → fill single-token input, wait for route calc
 *   5. submitZapIn()                       → click "Zap in" → confirm "Add Liquidity" dialog
 *   6. (wallet approval externally via approveTransactionForAction)
 *   7. expectSuccess()
 */
export class DlmmZapInPage extends DlmmPoolsPage {
  constructor(page: Page) {
    super(page);
  }

  // ─── Step 3: Click "Zap In" tab ──────────────────────────────────────────────

  /**
   * Switch from "Default" to "Zap In" mode by clicking the "Zap In" tab
   * in the Deposit Amounts panel.
   *
   * UI: [Default]  [Zap In]  ← these are tab-style buttons, not a toggle switch
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
    console.log('[DlmmZapIn] Clicked "Zap In" tab');
  }

  // ─── Step 4: Fill amount ──────────────────────────────────────────────────────

  /**
   * Fill the single-token amount input in Zap In mode.
   * Waits for Zap Route calculation (networkidle) before returning.
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
    const spinner = this.page.locator('.chakra-spinner, [class*="spinner"], svg[class*="animate-spin"]');
    await spinner.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    await spinner.first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    console.log(`[DlmmZapIn] Filled zap amount: ${amount}`);
  }

  // ─── Step 5: Submit ───────────────────────────────────────────────────────────

  /**
   * Click the "Zap in" submit button, then confirm the "Add Liquidity" dialog
   * that appears (same confirmation modal as normal DLMM open position).
   */
  async submitZapIn() {
    const zapBtn = this.page.getByRole('button', { name: /^zap\s*in$/i }).first();
    await expect(zapBtn).toBeVisible({ timeout: 15_000 });
    await expect(zapBtn).toBeEnabled({ timeout: 15_000 });
    await zapBtn.click();
    console.log('[DlmmZapIn] Clicked "Zap in" button');

    // Confirmation dialog: "Add Liquidity" → click "Add Liquidity" button
    const confirmDialog = this.page
      .locator('[role="dialog"], .chakra-modal__content')
      .filter({ hasText: /add liquidity/i })
      .last();
    const hasDialog = await confirmDialog.isVisible({ timeout: 8_000 }).catch(() => false);
    if (!hasDialog) return;

    const confirmButton = confirmDialog.getByRole('button', { name: /^add liquidity$/i }).first();
    await expect(confirmButton).toBeVisible({ timeout: 10_000 });
    await expect(confirmButton).toBeEnabled({ timeout: 10_000 });
    await confirmButton.click();
    console.log('[DlmmZapIn] Confirmed "Add Liquidity" dialog');
  }
}
