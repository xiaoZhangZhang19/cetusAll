import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { waitForRejectionMessage, watchForRejectionMessage } from '@/utils/rejection-watcher.js';

/**
 * Page object for the DLMM "Create a new pool" flow.
 *
 * Flow (from codegen recording):
 *   1. /pools → click "Create a new pool"
 *   2. Click "Edit" → select DLMM Pools → Continue
 *   3. Base token: search USDC → pick Native USDC
 *   4. Quote token: search HASUI → pick haSUI
 *   5. Select base fee → 4%
 *   6. Select bin step → 200 bps Not Created
 *   7. Continue
 *   8. Use Market Price
 *   9. Create → Create (confirmation modal)
 *  10. Wallet confirmation popup appears → reject
 */
export class DlmmCreatePoolPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto('/pools', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
    await this.dismissTermsIfPresent();
  }

  // ─── Step 1: Open create pool wizard ────────────────────────────────────────

  async clickCreateNewPool() {
    const btn = this.page.getByRole('button', { name: /create a new pool/i }).first();
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await btn.click();
    // Wait for the pool type step (Edit button or pool-type wizard step)
    await this.page
      .getByRole('button', { name: /edit/i })
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    console.log('[DlmmCreatePool] Create pool wizard opened');
  }

  // ─── Step 2: Switch to DLMM pool type ───────────────────────────────────────

  /**
   * Mirrors codegen:
   *   page.getByRole('button', { name: 'Edit' }).click()
   *   page.locator('div').filter({ hasText: /^DLMM PoolsDynamic Liquidity Market Maker$/ }).nth(1).click()
   *   page.getByRole('button', { name: 'Continue' }).click()
   */
  async selectDlmmPoolType() {
    // Click "Edit" to open pool-type selector
    const editBtn = this.page.getByRole('button', { name: /^edit$/i }).first();
    await expect(editBtn).toBeVisible({ timeout: 10_000 });
    await editBtn.click();
    await this.page.waitForTimeout(500);
    console.log('[DlmmCreatePool] Clicked Edit to open pool type selector');

    // Select DLMM Pools card
    const dlmmCard = this.page
      .locator('div')
      .filter({ hasText: /^DLMM PoolsDynamic Liquidity Market Maker$/ })
      .nth(1);
    await expect(dlmmCard).toBeVisible({ timeout: 8_000 });
    await dlmmCard.click();
    await this.page.waitForTimeout(400);
    console.log('[DlmmCreatePool] Selected DLMM Pools type');

    // Continue to the token selection step
    await this.clickContinue();
  }

  // ─── Step 3 & 4: Token selection ────────────────────────────────────────────

  /**
   * Selects the base token.
   * Mirrors codegen:
   *   page.getByRole('button', { name: 'Base token Select token' }).click()
   *   page.getByRole('textbox', { name: 'Search by token or address' }).fill('USDC')
   *   page.locator('div').filter({ hasText: /^USDCNative USDC$/ }).first().click()
   */
  async selectBaseToken(searchText: string, exactDivText: RegExp) {
    const baseBtn = this.page.getByRole('button', { name: /base token/i }).first();
    await expect(baseBtn).toBeVisible({ timeout: 10_000 });
    await baseBtn.click();

    const searchBox = this.page
      .getByRole('textbox', { name: /search by token or address/i })
      .first();
    await expect(searchBox).toBeVisible({ timeout: 8_000 });
    await searchBox.fill(searchText);
    await this.page.waitForTimeout(1_200);

    const tokenRow = this.page.locator('div').filter({ hasText: exactDivText }).first();
    await expect(tokenRow).toBeVisible({ timeout: 8_000 });
    await tokenRow.click();
    await this.page.waitForTimeout(600);

    console.log(`[DlmmCreatePool] Base token selected: ${searchText}`);
  }

  /**
   * Selects the quote token.
   * Mirrors codegen:
   *   page.getByRole('button', { name: 'Quote token SUI' }).click()
   *   page.getByRole('textbox', { name: 'Search by token or address' }).fill('HASUI')
   *   page.getByText('haSUIHaedal staked SUI').click()
   */
  async selectQuoteToken(searchText: string, exactText: string) {
    const quoteBtn = this.page.getByRole('button', { name: /quote token/i }).first();
    await expect(quoteBtn).toBeVisible({ timeout: 10_000 });
    await quoteBtn.click();

    const searchBox = this.page
      .getByRole('textbox', { name: /search by token or address/i })
      .first();
    await expect(searchBox).toBeVisible({ timeout: 8_000 });
    await searchBox.fill(searchText);
    await this.page.waitForTimeout(1_200);

    const tokenRow = this.page.getByText(exactText).first();
    await expect(tokenRow).toBeVisible({ timeout: 8_000 });
    await tokenRow.click();
    await this.page.waitForTimeout(600);

    console.log(`[DlmmCreatePool] Quote token selected: ${searchText}`);
  }

  // ─── Step 5: Select base fee ─────────────────────────────────────────────────

  /**
   * Mirrors codegen:
   *   page.getByRole('button', { name: 'Select base fee' }).click()
   *   page.getByRole('button', { name: '4%', exact: true }).click()
   */
  async selectBaseFee(feeLabel: string) {
    const selectFeeBtn = this.page.getByRole('button', { name: /select base fee/i }).first();
    await expect(selectFeeBtn).toBeVisible({ timeout: 10_000 });
    await selectFeeBtn.click();
    await this.page.waitForTimeout(500);
    console.log('[DlmmCreatePool] Opened base fee selector');

    const feeOption = this.page
      .getByRole('button', { name: feeLabel, exact: true })
      .first();
    await expect(feeOption).toBeVisible({ timeout: 8_000 });
    await feeOption.click();
    await this.page.waitForTimeout(400);
    console.log(`[DlmmCreatePool] Base fee selected: ${feeLabel}`);
  }

  // ─── Step 6: Select bin step ─────────────────────────────────────────────────

  /**
   * Mirrors codegen:
   *   page.getByRole('button', { name: 'Select bin step' }).click()
   *   page.getByRole('button', { name: '200 bps Not Created' }).click()
   */
  async selectBinStep(binStepLabel: string) {
    const selectBinBtn = this.page.getByRole('button', { name: /select bin step/i }).first();
    await expect(selectBinBtn).toBeVisible({ timeout: 10_000 });
    await selectBinBtn.click();
    await this.page.waitForTimeout(500);
    console.log('[DlmmCreatePool] Opened bin step selector');

    const binOption = this.page.getByRole('button', { name: binStepLabel }).first();
    await expect(binOption).toBeVisible({ timeout: 8_000 });
    await binOption.click();
    await this.page.waitForTimeout(400);
    console.log(`[DlmmCreatePool] Bin step selected: ${binStepLabel}`);
  }

  // ─── Step 7: Continue ────────────────────────────────────────────────────────

  async clickContinue() {
    const btn = this.page.getByRole('button', { name: /^continue$/i }).first();
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await btn.click();
    await this.page.waitForTimeout(500);
    console.log('[DlmmCreatePool] Clicked Continue');
  }

  // ─── Step 8: Use Market Price ────────────────────────────────────────────────

  async useMarketPrice() {
    const btn = this.page.getByText(/use market price/i).first();
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();
    await this.page.waitForTimeout(500);
    console.log('[DlmmCreatePool] Clicked Use Market Price');
  }

  // ─── Step 9: Create (×2) ────────────────────────────────────────────────────

  /**
   * Mirrors codegen:
   *   page.getByRole('button', { name: 'Create' }).click()   ← main button
   *   page.getByRole('button', { name: 'Create' }).click()   ← confirmation modal
   */
  async clickCreate() {
    // 提交前挂上 toast 监听：拒签提示是会自动消失的 chakra toast，
    // 等 rejectTransaction() 走完再查 DOM 可能已经错过了。
    await watchForRejectionMessage(this.page);

    const createBtn = this.page.getByRole('button', { name: /^create$/i }).first();
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await expect(createBtn).toBeEnabled({ timeout: 10_000 });
    await createBtn.click();
    await this.page.waitForTimeout(800);
    console.log('[DlmmCreatePool] Clicked Create (first)');

    // A confirmation modal may appear — click Create again if present
    const confirmCreate = this.page.getByRole('button', { name: /^create$/i }).first();
    if (await confirmCreate.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(confirmCreate).toBeEnabled({ timeout: 5_000 });
      await confirmCreate.click();
      await this.page.waitForTimeout(500);
      console.log('[DlmmCreatePool] Clicked Create (confirmation modal) — wallet should open');
    }
  }

  // ─── Assertions ──────────────────────────────────────────────────────────────

  /**
   * Verifies that the wallet rejection message is displayed on the Cetus page.
   */
  async expectWalletRejectionVisible() {
    const text = await waitForRejectionMessage(this.page);
    if (text) {
      console.log(`[DlmmCreatePool] Rejection message detected: "${text}"`);
    } else {
      console.warn('[DlmmCreatePool] No rejection message was observed');
    }
    return text !== null;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async dismissTermsIfPresent() {
    const confirmBtn = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^confirm$/i })
      .last();
    if (!(await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false))) return;

    const agreeText = this.page.getByText(/agree to the terms/i).first();
    if (await agreeText.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await agreeText.click({ force: true }).catch(() => undefined);
      await this.page.waitForTimeout(300);
    }
    if (await confirmBtn.isEnabled({ timeout: 2_000 }).catch(() => false)) {
      await confirmBtn.click({ force: true }).catch(() => undefined);
      await confirmBtn.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
    }
  }
}
