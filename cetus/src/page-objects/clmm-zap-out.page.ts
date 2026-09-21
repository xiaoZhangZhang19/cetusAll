import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { ClmmRemovePage } from './clmm-remove.page.js';
import {
  isSwitchOn,
  readLiquidityTableAmounts,
  readLiquidityTableAmountsUntilChanged
} from './pools-shared.js';

export interface TokenAmounts {
  sui: number;
  usdc: number;
}

/**
 * Page Object for CLMM Zap Out (single-token removal).
 *
 * Extends ClmmRemovePage, reusing navigation and position-selection logic.
 * The key difference from normal "Remove":
 *   - Enable the "Zap Out" toggle
 *   - Switch to single-token output mode (select SUI or USDC tab)
 *   - Click MAX for the selected token
 *   - Submit via "Zap Out" button (not "Remove")
 *
 * Full flow:
 *   1. goto()                              → /pools?tab=clmm_pools
 *   2. openMyPositions()                   → click "My Positions" → /pools?tab=positions
 *   3. filterByClmm()                      → CLMM sub-filter
 *   4. openClmmPositionsForPair(b, q)      → expand position card
 *   5. openFirstPositionRemovePanel()      → click "-" button
 *   6. switchToRemoveTab()                 → ensure we're on Remove tab
 *   7. enableZapOut()                      → toggle Zap Out ON
 *   8. selectZapToken(symbol)              → SUI / USDC tab
 *   9. clickMaxForToken()                  → MAX button
 *  10. submitZapOut()                      → "Zap Out" button
 *  11. (wallet approval externally)
 *  12. expectSuccess()
 */
export class ClmmZapOutPage extends ClmmRemovePage {
  constructor(page: Page) {
    super(page);
  }

  // ─── Step: Check for empty positions ──────────────────────────────────────────

  /**
   * Returns true if the page shows "No Liquidity Positions" (empty state).
   * Call after filterByClmm() to decide whether to skip the test.
   */
  async hasNoLiquidityPositions(): Promise<boolean> {
    const emptyText = this.page.getByText(/no liquidity positions/i).first();
    return emptyText.isVisible({ timeout: 5_000 }).catch(() => false);
  }

  // ─── Step: Enable Zap Out toggle ──────────────────────────────────────────────

  /**
   * Toggle the "Zap Out" switch ON in the Remove Amounts panel.
   *
   * Similar to Zap In toggle, the "Zap Out" text is a sibling of the switch.
   * We locate the toggle in the header row next to "Remove Amounts".
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
      if (!(await isSwitchOn(chakraSwitch))) {
        await chakraSwitch.click();
        await this.page.waitForTimeout(1_500);
      }
      console.log('[ClmmZapOut] Zap Out toggle enabled (strategy 1)');
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
          console.log(`[ClmmZapOut] Zap Out toggle enabled (strategy 2: depth=${depth})`);
          return;
        }
      }
      await zapText.locator('xpath=ancestor::div[1]').click();
      await this.page.waitForTimeout(1_500);
      console.log('[ClmmZapOut] Zap Out toggle enabled (strategy 2 fallback)');
      return;
    }

    // Strategy 3: any switch on page
    const anySwitch = this.page.locator('.chakra-switch, [role="switch"]').first();
    await expect(anySwitch).toBeVisible({ timeout: 8_000 });
    await anySwitch.click();
    await this.page.waitForTimeout(1_500);
    console.log('[ClmmZapOut] Zap Out toggle enabled (strategy 3)');
  }

  // ─── Step: Select output token tab ────────────────────────────────────────────

  /**
   * After Zap Out is ON, the form shows SUI / USDC tabs.
   * Select which token to receive by clicking its tab in the Remove Amounts panel.
   */
  async selectZapToken(tokenSymbol: string) {
    const tokenPattern = new RegExp(`^${tokenSymbol}$`, 'i');

    // Scope to Remove Amounts panel to avoid clicking unrelated elements
    const removePanel = this.page
      .getByText(/^remove amounts?$/i)
      .first()
      .locator('xpath=ancestor::*[self::div or self::section][2]');

    const tokenTab = removePanel
      .locator('div, span, button, [role="tab"], [role="button"]')
      .filter({ hasText: tokenPattern })
      .first();

    await expect(tokenTab).toBeVisible({ timeout: 12_000 });
    await tokenTab.click();
    await this.page.waitForTimeout(500);
    console.log(`[ClmmZapOut] Selected zap token: ${tokenSymbol}`);
  }

  // ─── Step: Click HALF button ──────────────────────────────────────────────────

  /**
   * Click the "HALF" quick-fill button in the Remove Amounts panel.
   * Reduces the input to 50% of available liquidity.
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
    console.log('[ClmmZapOut] Clicked HALF button');
  }

  // ─── Step: Read position amounts (Liquidity table) ────────────────────────────

  /**
   * Reads current SUI / USDC amounts from the Liquidity table on the left panel.
   * Same strategy as AddLiquidityBasePage.readPositionAmounts().
   */
  async readPositionAmounts(): Promise<TokenAmounts> {
    return readLiquidityTableAmounts(this.page);
  }

  /**
   * 交易成功后读仓位数量 —— 轮询到数据相对 `before` 真的刷新才返回。
   *
   * 直接读一次会拿到旧值（索引器同步 + 前端重拉有延迟），断言就会把
   * before 当 after 去比 predicted，报成「偏差超 5%」的假失败。
   */
  async readPositionAmountsUntilChanged(
    before: TokenAmounts,
    options: { timeout?: number } = {}
  ): Promise<TokenAmounts> {
    return readLiquidityTableAmountsUntilChanged(this.page, before, {
      ...options,
      refresh: () => this.reloadAndWaitForRemovePanel()
    });
  }

  // ─── Step: Read predicted "After" amounts ────────────────────────────────────

  /**
   * After clicking HALF / MAX, the Liquidity table shows predicted "After" values
   * e.g. "0.0610 SUI After" / "0.0840 USDC After".
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

    console.log(`[ClmmZapOut] Predicted After — SUI=${sui.toFixed(6)}  USDC=${usdc.toFixed(6)}`);
    return { sui, usdc };
  }

  // ─── Step: Submit ──────────────────────────────────────────────────────────────

  /**
   * Click the "Zap Out" button.
   * For Zap Out, clicking directly triggers wallet approval (no confirmation dialog).
   */
  async submitZapOut() {
    const removePanel = this.page
      .locator('section, div')
      .filter({ hasText: /remove amounts|remove amount/i })
      .first();

    const zapOutBtn = removePanel.getByRole('button', { name: /^zap\s*out$/i }).last();
    await expect(zapOutBtn).toBeVisible({ timeout: 10_000 });
    await expect(zapOutBtn).toBeEnabled({ timeout: 10_000 });
    await zapOutBtn.click();
    console.log('[ClmmZapOut] Clicked Zap Out button');
  }
}
