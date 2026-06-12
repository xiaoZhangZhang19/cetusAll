import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { ClmmAddLiquidityPage } from './clmm-add-liquidity.page.js';

/**
 * Page Object for CLMM Zap In "Increase" flow.
 *
 * Extends ClmmAddLiquidityPage, reusing all navigation / position-reading logic.
 * The only difference from a normal "Add More Liquidity":
 *   - On the increase page, enable the "Zap In" toggle
 *   - Switch to single-token mode (select SUI or USDC tab)
 *   - Fill a single amount
 *   - Submit via "Zap In" button  (NOT "Add More Liquidity")
 *   - Confirm in the "Add Liquidity" dialog that appears
 *
 * Full flow:
 *   1. goto()                            → /pools?tab=positions
 *   2. filterByClmm()                    → CLMM sub-filter chip
 *   3. openAddLiquidityForPair(b, q)     → "+" → /position-detail/{id}/increase
 *   4. waitForIncreasePageReady()
 *   5. readPositionAmounts()             → BEFORE amounts
 *   6. enableZapIn()                     → toggle ON
 *   7. selectZapToken(symbol)            → SUI / USDC tab
 *   8. fillZapAmount(amount)             → single-token input
 *   9. submitZapIn()                     → "Zap In" → dialog "Add Liquidity"
 *  10. (wallet approval externally)
 *  11. waitForTransactionCompletedModal()
 *  12. closeTransactionModal()
 *  13. reloadAndWaitForPositionData()
 *  14. readPositionAmounts()             → AFTER amounts
 *  15. assertAmountsIncreased(...)
 */
export class ClmmZapIncreasePage extends ClmmAddLiquidityPage {
  constructor(page: Page) {
    super(page);
  }

  // ─── Step: Enable Zap In toggle ──────────────────────────────────────────────

  /**
   * Toggle the "Zap In" switch ON in the Deposit Amounts panel.
   *
   * Cetus uses a Chakra UI Switch as a sibling of the "Zap In" text:
   *   <label class="chakra-switch" role="checkbox" aria-checked="false">
   *     <input type="checkbox" class="chakra-switch__input" />
   *     <span class="chakra-switch__track"> ... </span>
   *   </label>
   *
   * The "Zap In" text is a *sibling* span, so we locate the toggle
   * relative to the "Deposit Amounts" header row.
   */
  async enableZapIn() {
    const depositTitle = this.page.getByText(/^deposit amounts$/i).first();
    await expect(depositTitle).toBeVisible({ timeout: 15_000 });

    // Strategy 1: Chakra switch in the same header row as "Deposit Amounts"
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
      console.log('[ClmmZapIncrease] Zap In toggle enabled (strategy 1)');
      return;
    }

    // Strategy 2: "Zap In" text → walk up to find wrapper containing checkbox
    const zapText = this.page
      .locator('span, div, p')
      .filter({ hasText: /^zap\s*in$/i })
      .first();

    if (await zapText.isVisible({ timeout: 3_000 }).catch(() => false)) {
      for (const depth of [1, 2, 3]) {
        const wrapper = zapText.locator(`xpath=ancestor::div[${depth}]`);
        const inner = wrapper.locator(
          '.chakra-switch, [role="switch"], input[type="checkbox"], [class*="toggle"], [class*="switch"]'
        );
        if ((await inner.count().catch(() => 0)) > 0) {
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
          console.log(`[ClmmZapIncrease] Zap In toggle enabled (strategy 2: depth=${depth})`);
          return;
        }
      }
      await zapText.locator('xpath=ancestor::div[1]').click();
      await this.page.waitForTimeout(1_500);
      console.log('[ClmmZapIncrease] Zap In toggle enabled (strategy 2 fallback)');
      return;
    }

    // Strategy 3: any switch on page
    const anySwitch = this.page.locator('.chakra-switch, [role="switch"]').first();
    await expect(anySwitch).toBeVisible({ timeout: 8_000 });
    await anySwitch.click();
    await this.page.waitForTimeout(1_500);
    console.log('[ClmmZapIncrease] Zap In toggle enabled (strategy 3)');
  }

  // ─── Step: Select token tab ───────────────────────────────────────────────────

  /**
   * After Zap In is ON, the form shows SUI / USDC tabs.
   * Select the desired token by clicking its tab inside the Deposit Amounts panel.
   */
  async selectZapToken(tokenSymbol: string) {
    const tokenPattern = new RegExp(`^${tokenSymbol}$`, 'i');

    // Scope to Deposit Amounts panel to avoid clicking the pool header tokens
    const depositPanel = this.page
      .getByText(/^deposit amounts$/i)
      .first()
      .locator('xpath=ancestor::*[self::div or self::section][2]');

    const tokenTab = depositPanel
      .locator('div, span, button, [role="tab"], [role="button"]')
      .filter({ hasText: tokenPattern })
      .first();

    await expect(tokenTab).toBeVisible({ timeout: 12_000 });
    await tokenTab.click();
    await this.page.waitForTimeout(500);
    console.log(`[ClmmZapIncrease] Selected zap token: ${tokenSymbol}`);
  }

  // ─── Step: Fill single-token amount ──────────────────────────────────────────

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

    // Wait for Zap Route API call to complete (most reliable signal)
    await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    console.log(`[ClmmZapIncrease] Filled zap amount: ${amount}`);
  }

  // ─── Step: Read predicted "After" amounts ────────────────────────────────────

  /**
   * After filling the Zap In amount, the Liquidity table shows predicted values:
   *   SUI  | 0.01383  [0.01844 SUI After]
   *   USDC | 0.01918  [0.02557 USDC After]
   *
   * This method reads those "X SUI After" / "X USDC After" texts and returns them
   * as the expected post-transaction amounts to validate against.
   *
   * Must be called AFTER fillZapAmount() and BEFORE submitZapIn().
   */
  /**
   * @param before  - current position amounts (BEFORE the zap).
   *   The page initially shows these same values as "After" placeholders.
   *   We poll until the "After" values differ from `before`, which signals
   *   that the Zap Route calculation has completed and updated the UI.
   */
  /**
   * @param before  - current position amounts (BEFORE the zap).
   *   The page initially shows these same values as "After" placeholders.
   *   We poll until the "After" chip values differ from `before`.
   *
   * The "After" values are rendered as individual chip elements, e.g.:
   *   <span>0.1167 SUI After</span>
   * We read each chip's own textContent to avoid concatenation issues when
   * using body.textContent() (adjacent DOM nodes merge without whitespace).
   */
  /**
   * Reads "X SUI After" / "X USDC After" predicted values from the Liquidity table.
   * Uses the same innerText()+split('\n') strategy as readPositionAmounts() —
   * innerText places each block element on its own line, so "0.1021" and
   * "0.1023 SUI After" are separate lines rather than being concatenated.
   *
   * Polls until at least one value differs from `before` (the placeholder shows
   * the same value as the current position until Zap Route calculation completes).
   */
  async readPredictedAfterAmounts(before: { sui: number; usdc: number }): Promise<{ sui: number; usdc: number }> {
    const deadline = Date.now() + 15_000;
    let sui = 0;
    let usdc = 0;

    const tokenHeader = this.page.getByText(/^token$/i).first();
    await tokenHeader.waitFor({ state: 'visible', timeout: 10_000 });
    const tableContainer = tokenHeader.locator('xpath=ancestor::*[self::div or self::section or self::table][3]');

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

    console.log(`[ClmmZapIncrease] Predicted After — SUI=${sui.toFixed(6)}  USDC=${usdc.toFixed(6)}`);
    return { sui, usdc };
  }

  // ─── Step: Submit ─────────────────────────────────────────────────────────────

  /**
   * Click the "Zap In" button.
   * For Increase flow, clicking Zap In directly triggers wallet approval (no confirmation dialog).
   */
  async submitZapIn() {
    const zapBtn = this.page.getByRole('button', { name: /^zap\s*in$/i }).first();
    await expect(zapBtn).toBeVisible({ timeout: 15_000 });
    await expect(zapBtn).toBeEnabled({ timeout: 15_000 });
    await zapBtn.click();
    console.log('[ClmmZapIncrease] Clicked Zap In button');
  }
}
