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
   * Route calculation is awaited in submitZapIn() via the button enabled state,
   * so no wait is needed here.
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
    console.log(`[DlmmZapIn] Filled zap amount: ${amount}`);
  }

  /**
   * Zap Route quote is async. Waits for the spinner inside the Zap Route row
   * to clear.
   *
   * Scoped to the Zap Route row on purpose: the page keeps a global top-level
   * progressbar in the DOM permanently, so a page-wide spinner query never
   * settles. Uses `hidden` state (not count()) since count() also matches
   * elements that are present but invisible.
   */
  private async waitForZapRouteReady(timeout = 20_000) {
    const routeRow = this.page
      .getByText(/^zap route$/i)
      .first()
      .locator('xpath=ancestor::*[self::div or self::section][1]');

    const spinner = routeRow.locator('[role="progressbar"], .chakra-spinner, svg[class*="animate-spin"]').first();
    await spinner.waitFor({ state: 'hidden', timeout }).catch(() => undefined);
  }

  // ─── Step 5: Submit ───────────────────────────────────────────────────────────

  /**
   * The page contains two "zap in" buttons: the mode tab ("Zap In") and the
   * submit button ("Zap in"). A case-insensitive `.first()` match resolves to
   * the tab, which silently re-clicks the tab instead of submitting.
   *
   * Prefer the case-sensitive "Zap in" label; fall back to the last match,
   * since the submit button always follows the tab in DOM order.
   */
  private async resolveSubmitButton() {
    const exact = this.page.getByRole('button', { name: 'Zap in', exact: true });
    if ((await exact.count().catch(() => 0)) > 0) return exact.last();
    return this.page.getByRole('button', { name: /^zap\s*in$/i }).last();
  }

  /**
   * Click the "Zap in" submit button, then confirm the "Add Liquidity" dialog
   * that appears (same confirmation modal as normal DLMM open position).
   */
  async submitZapIn() {
    const zapBtn = await this.resolveSubmitButton();
    await expect(zapBtn).toBeVisible({ timeout: 15_000 });

    // The button stays disabled while the route quote is pending, so its
    // enabled state is the readiness signal. toBeEnabled polls and returns as
    // soon as the quote resolves.
    await expect(zapBtn).toBeEnabled({ timeout: 30_000 });
    await this.waitForZapRouteReady(5_000);
    await zapBtn.click();
    console.log('[DlmmZapIn] Clicked "Zap in" submit button');

    // Confirmation dialog: "Add Liquidity" → click "Add Liquidity" button
    const confirmDialog = this.page
      .locator('[role="dialog"], .chakra-modal__content')
      .filter({ hasText: /add liquidity/i })
      .last();
    // isVisible() ignores its timeout option, so wait explicitly instead.
    const hasDialog = await confirmDialog
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasDialog) {
      console.log('[DlmmZapIn] No "Add Liquidity" dialog appeared, proceeding to wallet');
      return;
    }

    const confirmButton = confirmDialog.getByRole('button', { name: /^add liquidity$/i }).first();
    await expect(confirmButton).toBeVisible({ timeout: 10_000 });
    await expect(confirmButton).toBeEnabled({ timeout: 10_000 });
    await confirmButton.click();
    console.log('[DlmmZapIn] Confirmed "Add Liquidity" dialog');
  }
}
