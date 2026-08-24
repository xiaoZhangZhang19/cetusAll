import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { waitForRejectionMessage, watchForRejectionMessage } from '@/utils/rejection-watcher.js';

/**
 * Page object for the CLMM "Create a new pool" flow.
 *
 * Flow (from codegen recording):
 *   1. /pools → click "Create a new pool"
 *   2. Select base token (search + pick)
 *   3. Select quote token (search + pick)
 *   4. Select fee tier (e.g. 4%)
 *   5. Continue → Use Market Price → Continue
 *   6. Fill initial liquidity amount
 *   7. Create → Create and Add Liquidity
 *   8. Wallet confirmation popup appears
 */
export class ClmmCreatePoolPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto('/pools', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
    await this.dismissTermsIfPresent();
  }

  // ─── Step 1: Open the create pool dialog ────────────────────────────────────

  async clickCreateNewPool() {
    const btn = this.page.getByRole('button', { name: /create a new pool/i }).first();
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await btn.click();
    // Wait for the first step of the wizard to appear
    await this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /base token|select token/i })
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    console.log('[ClmmCreatePool] Create pool wizard opened');
  }

  // ─── Step 2 & 3: Token selection ────────────────────────────────────────────

  /**
   * Selects the base token.
   * Mirrors codegen:
   *   page.getByRole('button', { name: 'Base token Select token' }).click()
   *   page.getByRole('textbox', { name: 'Search by token or address' }).fill('usdc')
   *   page.locator('div').filter({ hasText: /^USDCNative USDC$/ }).first().click()
   */
  async selectBaseToken(searchText: string, exactDivText: RegExp) {
    // Click the base token selector button
    const baseBtn = this.page.getByRole('button', { name: /base token/i }).first();
    await expect(baseBtn).toBeVisible({ timeout: 10_000 });
    await baseBtn.click();

    // Fill search box
    const searchBox = this.page
      .getByRole('textbox', { name: /search by token or address/i })
      .first();
    await expect(searchBox).toBeVisible({ timeout: 8_000 });
    await searchBox.fill(searchText);
    await this.page.waitForTimeout(1_200);

    // Pick by exact concatenated div text (symbol+name fused, same as codegen)
    const tokenRow = this.page.locator('div').filter({ hasText: exactDivText }).first();
    await expect(tokenRow).toBeVisible({ timeout: 8_000 });
    await tokenRow.click();
    await this.page.waitForTimeout(600);

    console.log(`[ClmmCreatePool] Base token selected: ${searchText}`);
  }

  /**
   * Selects the quote token.
   * Mirrors codegen:
   *   page.getByRole('button', { name: 'Quote token SUI' }).click()
   *   page.getByRole('textbox', { name: 'Search by token or address' }).fill('hasui')
   *   page.getByText('haSUIHaedal staked SUI').click()
   */
  async selectQuoteToken(searchText: string, exactText: string) {
    // The quote token button displays whatever token is currently selected (default: SUI)
    const quoteBtn = this.page.getByRole('button', { name: /quote token/i }).first();
    await expect(quoteBtn).toBeVisible({ timeout: 10_000 });
    await quoteBtn.click();

    // Fill search box
    const searchBox = this.page
      .getByRole('textbox', { name: /search by token or address/i })
      .first();
    await expect(searchBox).toBeVisible({ timeout: 8_000 });
    await searchBox.fill(searchText);
    await this.page.waitForTimeout(1_200);

    // Pick by exact text string (symbol+name fused, same as codegen)
    const tokenRow = this.page.getByText(exactText).first();
    await expect(tokenRow).toBeVisible({ timeout: 8_000 });
    await tokenRow.click();
    await this.page.waitForTimeout(600);

    console.log(`[ClmmCreatePool] Quote token selected: ${searchText}`);
  }

  // ─── Step 4: Fee tier ───────────────────────────────────────────────────────

  /**
   * Dismiss the "pool already exists" alert if present.
   */
  private async dismissPoolExistsAlertIfPresent() {
    // Look for common alert/modal close buttons or "OK" buttons
    const modalCloseSelectors = [
      'button[aria-label*="close" i]',
      '[class*="modal"] button:has-text("OK")',
      '[class*="modal"] button:has-text("确定")',
      '[class*="alert"] button:has-text("OK")',
      '[class*="alert"] button:has-text("确定")',
      '[role="dialog"] button:has-text("OK")',
      '[role="dialog"] button:has-text("确定")',
      'button:has-text("Got it")',
      'button:has-text("Close")'
    ];

    for (const selector of modalCloseSelectors) {
      const btn = this.page.locator(selector).first();
      if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await btn.click().catch(() => undefined);
        await this.page.waitForTimeout(500);
        console.log('[ClmmCreatePool] Dismissed pool exists alert');
        return;
      }
    }

    // Alternative: press Escape key
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.page.waitForTimeout(300);
  }

  /**
   * Selects the first available "Not Created" fee tier from the dropdown.
   * If a specific tierLabel is provided, tries to select it; if it's already created,
   * dismisses the alert and picks the first "Not Created" tier instead.
   */
  async selectFeeTier(preferredTierLabel?: string) {
    // Step 1: Dismiss any existing "pool exists" alert
    await this.dismissPoolExistsAlertIfPresent();

    // Step 2: Click the fee tier dropdown trigger
    // It may say "X% Not Created", "X% Created", or just "Select Fee Tier"
    const dropdownTrigger = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /%|fee tier/i })
      .first();
    
    await expect(dropdownTrigger).toBeVisible({ timeout: 10_000 });
    await dropdownTrigger.click();
    await this.page.waitForTimeout(800);
    console.log('[ClmmCreatePool] Fee tier dropdown opened');

    // Step 3: Find all "Not Created" options in the dropdown
    const notCreatedOptions = this.page
      .locator('button, [role="button"], [role="option"], li, div')
      .filter({ hasText: /not created/i });

    const count = await notCreatedOptions.count();
    console.log(`[ClmmCreatePool] Found ${count} "Not Created" fee tier options`);

    if (count === 0) {
      throw new Error('[ClmmCreatePool] No "Not Created" fee tiers available in dropdown');
    }

    // Step 4: Try to select the preferred tier if specified
    if (preferredTierLabel) {
      const preferredPattern = new RegExp(`^${preferredTierLabel}\\s*Not Created`, 'i');
      for (let i = 0; i < count; i++) {
        const option = notCreatedOptions.nth(i);
        const text = await option.innerText().catch(() => '');
        if (preferredPattern.test(text.trim())) {
          await option.click();
          await this.page.waitForTimeout(500);
          console.log(`[ClmmCreatePool] Selected preferred fee tier: ${text.trim()}`);
          
          // Check if "pool exists" alert appears
          await this.page.waitForTimeout(1_000);
          const alertVisible = await this.page
            .getByText(/pool.*already exists|already.*created/i)
            .first()
            .isVisible({ timeout: 2_000 })
            .catch(() => false);
          
          if (!alertVisible) {
            // Success! Preferred tier is available
            return;
          }
          
          // Pool exists, dismiss and try next
          console.log(`[ClmmCreatePool] ${preferredTierLabel} already exists, trying another...`);
          await this.dismissPoolExistsAlertIfPresent();
          // Re-open dropdown
          await dropdownTrigger.click();
          await this.page.waitForTimeout(800);
          break; // Exit the preferred search, fall through to pick first available
        }
      }
    }

    // Step 5: Select the first "Not Created" option
    const firstOption = notCreatedOptions.first();
    const firstText = await firstOption.innerText().catch(() => 'Unknown');
    await firstOption.click();
    await this.page.waitForTimeout(500);
    console.log(`[ClmmCreatePool] Selected first available fee tier: ${firstText.trim()}`);
  }

  // ─── Step 5: Continue + Use Market Price + Continue ─────────────────────────

  async clickContinue() {
    const btn = this.page.getByRole('button', { name: /^continue$/i }).first();
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await btn.click();
    await this.page.waitForTimeout(500);
    console.log('[ClmmCreatePool] Clicked Continue');
  }

  async useMarketPrice() {
    const btn = this.page.getByText(/use market price/i).first();
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();
    await this.page.waitForTimeout(500);
    console.log('[ClmmCreatePool] Clicked Use Market Price');
  }

  // ─── Step 6: Fill initial liquidity ─────────────────────────────────────────

  async fillInitialLiquidity(amount: string) {
    const input = this.page.getByRole('textbox', { name: /0\.0|0/i }).first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(amount);
    await this.page.waitForTimeout(500);
    console.log(`[ClmmCreatePool] Filled initial liquidity: ${amount}`);
  }

  // ─── Step 7: Create → Create and Add Liquidity ─────────────────────────────

  async clickCreate() {
    const btn = this.page.getByRole('button', { name: /^create$/i }).first();
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await btn.click();
    await this.page.waitForTimeout(800);
    console.log('[ClmmCreatePool] Clicked Create');
  }

  async clickCreateAndAddLiquidity() {
    // 提交前挂上 toast 监听，理由同 DLMM：拒签提示会自动消失。
    await watchForRejectionMessage(this.page);

    const btn = this.page
      .getByRole('button', { name: /create and add liquidity/i })
      .first();
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await btn.click();
    console.log('[ClmmCreatePool] Clicked Create and Add Liquidity — wallet should open');
  }

  // ─── Assertions ──────────────────────────────────────────────────────────────

  /**
   * Verifies that the wallet rejection message is displayed on the Cetus page.
   * This confirms the flow reached the wallet signing step.
   */
  async expectWalletRejectionVisible() {
    const text = await waitForRejectionMessage(this.page);
    if (text) {
      console.log(`[ClmmCreatePool] Rejection message detected: "${text}"`);
    } else {
      console.warn('[ClmmCreatePool] No rejection message was observed');
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
