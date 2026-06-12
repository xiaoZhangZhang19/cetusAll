import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { DlmmRemovePage } from './dlmm-remove.page.js';

export interface TokenAmounts {
  sui: number;
  usdc: number;
}

/**
 * Page Object for DLMM Zap Out — single-token liquidity removal.
 *
 * Extends DlmmRemovePage, reusing navigation + position-selection logic.
 *
 * Key difference from normal DLMM remove:
 *   - Enable the "Zap Out" toggle in the Remove Amounts panel
 *   - Single-token output: HALF (50%) for Phase 1, MAX for Phase 2
 *   - Submit via "Zap Out" button
 *
 * Full flow (two phases):
 *   Phase 1 — 50% reduction + data validation:
 *     1. goto() / filterByDlmm() / openDlmmPositionsForPair()
 *     2. openFirstPositionRemovePanel() + switchToRemoveTab()
 *     3. readPositionAmounts()               → BEFORE
 *     4. enableZapOut()
 *     5. clickHalfForToken()
 *     6. readPredictedAfterAmounts(before)   → predicted After
 *     7. submitZapOut()  (wallet approval externally)
 *     8. Close Transaction Completed modal
 *     9. readPositionAmounts()               → AFTER, validate vs predicted (5%)
 *
 *   Phase 2 — MAX close:
 *    10. clickMaxForToken() directly in current panel
 *    11. submitZapOut()  (wallet approval externally)
 *    12. Wait for Transaction Completed
 */
export class DlmmZapOutPage extends DlmmRemovePage {
  constructor(page: Page) {
    super(page);
  }

  // ─── Step: Enable Zap Out toggle ─────────────────────────────────────────────

  /**
   * Toggle the "Zap Out" switch ON in the Remove Amounts panel.
   * Same Chakra UI switch strategy as ClmmZapOutPage.
   */
  async enableZapOut() {
    const removeTitle = this.page.getByText(/^remove amounts?$/i).first();
    await expect(removeTitle).toBeVisible({ timeout: 15_000 });

    // Strategy 1: Chakra switch in the same header row as "Remove Amounts"
    const headerRow = removeTitle.locator('xpath=ancestor::div[2]');
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
      console.log('[DlmmZapOut] Zap Out toggle enabled (strategy 1)');
      return;
    }

    // Strategy 2: "Zap Out" text → walk up to find wrapper containing checkbox
    const zapText = this.page
      .locator('span, div, p')
      .filter({ hasText: /^zap\s*out$/i })
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
          console.log(`[DlmmZapOut] Zap Out toggle enabled (strategy 2: depth=${depth})`);
          return;
        }
      }
      await zapText.locator('xpath=ancestor::div[1]').click();
      await this.page.waitForTimeout(1_500);
      console.log('[DlmmZapOut] Zap Out toggle enabled (strategy 2 fallback)');
      return;
    }

    // Strategy 3: any switch on page
    const anySwitch = this.page.locator('.chakra-switch, [role="switch"]').first();
    await expect(anySwitch).toBeVisible({ timeout: 8_000 });
    await anySwitch.click();
    await this.page.waitForTimeout(1_500);
    console.log('[DlmmZapOut] Zap Out toggle enabled (strategy 3)');
  }

  // ─── Step: Click HALF button ──────────────────────────────────────────────────

  /**
   * Click "HALF" quick-fill button in the Remove Amounts panel (50% reduction).
   */
  async clickHalfForToken() {
    const removePanel = this.page
      .locator('section, div')
      .filter({ hasText: /remove amounts/i })
      .first();
    await expect(removePanel).toBeVisible({ timeout: 10_000 });

    const halfBtn = removePanel
      .locator('button, [role="button"]')
      .filter({ hasText: /^half$/i })
      .first();
    await expect(halfBtn).toBeVisible({ timeout: 10_000 });
    await halfBtn.click();
    console.log('[DlmmZapOut] Clicked HALF button');
  }

  // ─── Step: Read position amounts (Liquidity table) ────────────────────────────

  /**
   * Reads current SUI / USDC amounts from the Liquidity table on the left panel.
   */
  async readPositionAmounts(): Promise<TokenAmounts> {
    const tokenHeader = this.page.getByText(/^token$/i).first();
    await tokenHeader.waitFor({ state: 'visible', timeout: 10_000 });
    await this.page.waitForTimeout(1_000);

    const tableContainer = tokenHeader.locator('xpath=ancestor::*[self::div or self::section or self::table][3]');
    const tableText = await tableContainer.innerText().catch(() => '');
    const lines = tableText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

    let sui = 0;
    let usdc = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] === 'SUI'  && /^[\d.]+$/.test(lines[i + 1])) sui  = parseFloat(lines[i + 1]);
      if (lines[i] === 'USDC' && /^[\d.]+$/.test(lines[i + 1])) usdc = parseFloat(lines[i + 1]);
    }
    return { sui, usdc };
  }

  // ─── Step: Read predicted "After" amounts ────────────────────────────────────

  /**
   * After clicking HALF/MAX, the Liquidity table shows predicted "After" values.
   * Uses innerText()+split('\n') to read chip lines without concatenation issues.
   * Polls until values differ from `before` (placeholder = current amounts).
   */
  async readPredictedAfterAmounts(before: TokenAmounts): Promise<TokenAmounts> {
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

    console.log(`[DlmmZapOut] Predicted After — SUI=${sui.toFixed(6)}  USDC=${usdc.toFixed(6)}`);
    return { sui, usdc };
  }

  // ─── Step: Submit ─────────────────────────────────────────────────────────────

  /**
   * Click the "Zap Out" button. Directly triggers wallet approval (no confirmation dialog).
   */
  async submitZapOut() {
    const removePanel = this.page
      .locator('section, div')
      .filter({ hasText: /remove amounts|remove amount/i })
      .first();

    const zapOutBtn = removePanel.getByRole('button', { name: /^remove$/i }).last();
    await expect(zapOutBtn).toBeVisible({ timeout: 10_000 });
    await expect(zapOutBtn).toBeEnabled({ timeout: 10_000 });
    await zapOutBtn.click();
    console.log('[DlmmZapOut] Clicked "Remove" button');
  }
}
