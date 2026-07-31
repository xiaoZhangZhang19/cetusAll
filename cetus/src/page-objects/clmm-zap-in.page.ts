import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import {
  buildPairPattern,
  ensureTokenCheckedInFilter,
  findFirstPoolRowByPair,
  openTokenFilterPanel,
  resolveTokenFilterTrigger
} from './pools-shared.js';

/**
 * Page Object for the CLMM Zap In flow.
 *
 * Zap In allows opening a position using only a single token (SUI or USDC),
 * which is automatically swapped and split by the protocol.
 *
 * Flow:
 *   1. goto()                          → /pools (CLMM tab)
 *   2. openDepositForPair(b, q)        → find pool row → click Deposit
 *   3. enableZapIn()                   → toggle "Zap In" switch ON
 *   4. selectZapToken(symbol)          → click SUI or USDC tab
 *   5. fillZapAmount(amount)           → enter amount
 *   6. submitZapIn()                   → click "Zap In" button
 *                                        → auto-clicks "Add Liquidity" confirmation modal
 *   7. (wallet approval handled externally)
 *   8. expectZapInSuccess()            → verify success
 */
export class ClmmZapInPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  async goto() {
    await this.page.goto('/pools', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
  }

  // ─── Step 1: Open deposit form for the target pair ───────────────────────────

  async openDepositForPair(baseSymbol: string, quoteSymbol: string) {
    const filterTrigger = await resolveTokenFilterTrigger(this.page);

    await openTokenFilterPanel(this.page, filterTrigger);
    await ensureTokenCheckedInFilter(this.page, baseSymbol, filterTrigger);
    await ensureTokenCheckedInFilter(this.page, quoteSymbol, filterTrigger);

    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.page.waitForTimeout(400);

    const pairRow = await findFirstPoolRowByPair(
      this.page,
      buildPairPattern(baseSymbol, quoteSymbol),
      filterTrigger
    );

    const rowDepositButton = pairRow.getByRole('button', { name: /deposit/i }).first();
    if (await rowDepositButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await rowDepositButton.click();
    } else {
      await pairRow.click({ force: true }).catch(async () => {
        const box = await pairRow.boundingBox();
        if (!box) throw new Error(`Pool row for ${baseSymbol}-${quoteSymbol} is not clickable`);
        await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      await this.page.waitForTimeout(500);
      const depositBtn = this.page.getByRole('button', { name: /deposit/i }).first();
      await expect(depositBtn).toBeVisible({ timeout: 15_000 });
      await depositBtn.click();
    }

    await this.waitForDepositFormReady();
  }

  // ─── Step 2: Enable Zap In mode ──────────────────────────────────────────────

  /**
   * Toggle the "Zap In" switch ON in the Deposit Amounts panel.
   *
   * Cetus uses a Chakra UI Switch which renders as:
   *   <label class="chakra-switch" role="checkbox" aria-checked="false">
   *     <input type="checkbox" class="chakra-switch__input" />  ← hidden
   *     <span class="chakra-switch__track">
   *       <span class="chakra-switch__thumb" />
   *     </span>
   *   </label>
   *
   * The "Zap In" text is a *sibling* span, NOT inside the label —
   * so `filter({ hasText })` won't match the label. We must locate the
   * toggle relative to the text node, not by text content of the toggle itself.
   */
  async enableZapIn() {
    const depositTitle = this.page.getByText(/^deposit amounts$/i).first();
    await expect(depositTitle).toBeVisible({ timeout: 15_000 });

    // ── Strategy 1: Chakra switch in the same header row as "Deposit Amounts"
    // The header row is a shared ancestor two levels up from the title text.
    const headerRow = depositTitle.locator('xpath=ancestor::div[2]');
    const chakraSwitch = headerRow
      .locator('.chakra-switch, [role="switch"], [role="checkbox"][class*="switch"]')
      .first();

    if (await chakraSwitch.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const isOn =
        (await chakraSwitch.getAttribute('aria-checked').catch(() => null)) === 'true' ||
        (await chakraSwitch.getAttribute('data-checked').catch(() => null)) !== null;
      if (!isOn) {
        await chakraSwitch.click();
        await this.page.waitForTimeout(1_500);
      }
      console.log('[ClmmZapIn] Zap In toggle enabled (strategy 1: chakra-switch in header row)');
      return;
    }

    // ── Strategy 2: Locate "Zap In" text → walk up to its container → click
    // The toggle + label are wrapped together in a container div.
    // Clicking the container triggers the toggle regardless of exact child hierarchy.
    const zapText = this.page
      .locator('span, div, p')
      .filter({ hasText: /^zap\s*in$/i })
      .first();

    if (await zapText.isVisible({ timeout: 3_000 }).catch(() => false)) {
      // Walk up 1–3 levels to find the nearest ancestor that also contains
      // a switch/checkbox (i.e. the full "Zap In + toggle" wrapper).
      for (const depth of [1, 2, 3]) {
        const wrapper = zapText.locator(`xpath=ancestor::div[${depth}]`);
        const inner = wrapper.locator(
          '.chakra-switch, [role="switch"], input[type="checkbox"], [class*="toggle"], [class*="switch"]'
        );
        if ((await inner.count().catch(() => 0)) > 0) {
          // If the inner element is a hidden checkbox, force-check it;
          // otherwise click the wrapper so the visual component handles it.
          const checkboxInput = wrapper.locator('input[type="checkbox"]').first();
          if ((await checkboxInput.count().catch(() => 0)) > 0) {
            const isChecked = await checkboxInput.isChecked().catch(() => false);
            if (!isChecked) {
              await checkboxInput.check({ force: true });
              await this.page.waitForTimeout(1_500);
            }
          } else {
            await wrapper.click();
            await this.page.waitForTimeout(1_500);
          }
          console.log(`[ClmmZapIn] Zap In toggle enabled (strategy 2: wrapper depth=${depth})`);
          return;
        }
      }

      // No inner toggle found — click the wrapper at depth 1 directly.
      await zapText.locator('xpath=ancestor::div[1]').click();
      await this.page.waitForTimeout(1_500);
      console.log('[ClmmZapIn] Zap In toggle enabled (strategy 2 fallback: clicked parent div)');
      return;
    }

    // ── Strategy 3: Any Chakra switch anywhere on the page (last resort)
    const anySwitch = this.page
      .locator('.chakra-switch, [role="switch"]')
      .first();
    await expect(anySwitch).toBeVisible({ timeout: 8_000 });
    await anySwitch.click();
    await this.page.waitForTimeout(1_500);
    console.log('[ClmmZapIn] Zap In toggle enabled (strategy 3: first switch on page)');
  }

  // ─── Step 3: Select which token to Zap with ─────────────────────────────────

  /**
   * In Zap In mode, wait for the SUI/USDC tab bar to appear then click the target token.
   * The tab bar only shows AFTER the Zap In toggle is ON.
   *
   * CRITICAL: Must restrict search scope to the right-side "Deposit Amounts" panel.
   * Otherwise it will accidentally click the pool name "SUI - USDC" in the top-left header.
   */
  async selectZapToken(tokenSymbol: string) {
    const tokenPattern = new RegExp(`^${tokenSymbol}$`, 'i');

    // Step 1: Locate the Deposit Amounts panel
    const depositPanel = this.page
      .getByText(/^deposit amounts$/i)
      .first()
      .locator('xpath=ancestor::*[self::div or self::section][2]');

    // Step 2: Find the token selector row (usually contains both SUI and USDC)
    // These are NOT always buttons — can be styled divs/spans acting as tabs
    // Look for clickable elements near the top of the deposit panel
    const tokenSelectorRow = depositPanel
      .locator('div, span, button, [role="tab"], [role="button"]')
      .filter({ hasText: tokenPattern })
      .first();

    await expect(tokenSelectorRow).toBeVisible({ timeout: 12_000 });
    await tokenSelectorRow.click();
    await this.page.waitForTimeout(500);
    console.log(`[ClmmZapIn] Selected zap token: ${tokenSymbol}`);
  }

  // ─── Step 4: Fill amount ─────────────────────────────────────────────────────

  async fillZapAmount(amount: string) {
    const amountInputSelector =
      'input[inputmode="decimal"], input[type="number"], input[type="text"], [contenteditable="true"]';

    const depositPanel = this.page
      .getByText(/^deposit amounts$/i)
      .first()
      .locator('xpath=ancestor::*[self::div or self::section][2]');

    const input = depositPanel
      .locator(amountInputSelector)
      .filter({ hasNotText: /min|max|price/i })
      .first();

    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(amount);
    // Wait for Zap Route calculation spinner
    const spinner = this.page.locator('.chakra-spinner, [class*="spinner"], svg[class*="animate-spin"]');
    await spinner.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    await spinner.first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    console.log(`[ClmmZapIn] Filled zap amount: ${amount}`);
  }

  // ─── Step 5: Submit ──────────────────────────────────────────────────────────

  async submitZapIn() {
    const zapBtn = this.page.getByRole('button', { name: /^zap\s*in$/i }).first();
    await expect(zapBtn).toBeVisible({ timeout: 15_000 });
    await expect(zapBtn).toBeEnabled({ timeout: 15_000 });
    await zapBtn.click();
    console.log('[ClmmZapIn] Clicked Zap In button');

    // After clicking "Zap In", a confirmation modal appears with an "Add Liquidity" button.
    // Wait for the modal to appear and click the confirmation button.
    await this.confirmAddLiquidityModal();
  }

  /**
   * Handles the "Add Liquidity" confirmation modal that appears after clicking "Zap In".
   * The modal contains a summary of the position and a final "Add Liquidity" button.
   */
  async confirmAddLiquidityModal() {
    const addLiqBtn = this.page.getByRole('button', { name: /^add\s*liquidity$/i }).first();
    const isVisible = await addLiqBtn.isVisible({ timeout: 8_000 }).catch(() => false);
    if (!isVisible) {
      console.log('[ClmmZapIn] No Add Liquidity modal appeared, skipping confirmation step');
      return;
    }
    await expect(addLiqBtn).toBeEnabled({ timeout: 10_000 });
    await addLiqBtn.click();
    console.log('[ClmmZapIn] Clicked Add Liquidity confirmation button');
  }

  // ─── Step 6: Assert success ──────────────────────────────────────────────────

  async expectZapInSuccess() {
    const successText = this.page
      .getByText(/success|transaction completed|liquidity added|view in explorer|submitted/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
    console.log('[ClmmZapIn] Zap In transaction successful');
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async waitForDepositFormReady() {
    const loadingIndicators = this.page.locator(
      '.chakra-spinner, [class*="spinner"], [class*="loading"], svg[class*="animate-spin"]'
    );
    await loadingIndicators.first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => undefined);

    const formReady = this.page
      .locator(
        'input[inputmode="decimal"], input[type="number"], input[placeholder="0"], input[placeholder="0.0"]'
      )
      .first();
    await expect(formReady).toBeVisible({ timeout: 45_000 });
  }
}
