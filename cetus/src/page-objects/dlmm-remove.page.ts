import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { buildPairPattern, clickFirstActionButtonInActionsColumn, clickMaxForTokenInRemovePanel } from './pools-shared.js';

export class DlmmRemovePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto('/pools?tab=positions', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Click the "DLMM" sub-filter chip inside My Positions filter row.
   * This ensures we're viewing DLMM positions only, not CLMM.
   */
  async filterByDlmm() {
    await this.clickSubFilterChip('dlmm');
    // Wait for filter to take effect and positions to reload
    await this.page.waitForTimeout(1_500);
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  }

  /**
   * Click the CLMM or DLMM sub-filter chip inside the My Positions filter row.
   *
   * UI layout:
   *   Top navigation tabs : [CLMM]  [DLMM]  [My Positions 2]
   *   Filter row (target) : [All 2] [CLMM 1] [DLMM 1]
   *
   * Key insight: sub-filter chips include a position count (e.g. "DLMM 1"),
   * while top-level tabs are plain text ("DLMM") or "DLMM 30" without just a single digit.
   * Adapted from add-liquidity-base.page.ts implementation.
   */
  private async clickSubFilterChip(poolType: 'clmm' | 'dlmm') {
    const typeText = poolType.toUpperCase(); // "CLMM" or "DLMM"

    // ── Strategy 1: chip text = "<TYPE> <digits>", e.g. "DLMM 1" ─────────────
    // Top-level tabs never have a trailing count, so this uniquely identifies the chip.
    const chipWithCount = this.page
      .locator('*')
      .filter({ hasText: new RegExp(`^${typeText}\\s+\\d+$`) })
      .first();

    if (await chipWithCount.isVisible({ timeout: 8_000 }).catch(() => false)) {
      await chipWithCount.click();
      await this.page.waitForTimeout(500);
      return;
    }

    // ── Strategy 2: same Y-row as the "All N" chip (any element type) ─────────
    const allChip = this.page
      .locator('*')
      .filter({ hasText: /^All\s*\d*$/ })
      .first();

    if (await allChip.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const allBox = await allChip.boundingBox().catch(() => null);
      if (allBox) {
        const clicked = await this.page.evaluate(
          ({ typeText, refY }) => {
            const pattern = new RegExp(`^${typeText}(\\s+\\d+)?$`, 'i');
            const candidates = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((el) => {
              const text = (el.textContent ?? '').trim();
              if (!pattern.test(text)) return false;
              const childMatches = Array.from(el.children).some((c) =>
                pattern.test((c.textContent ?? '').trim())
              );
              if (childMatches) return false;
              const rect = el.getBoundingClientRect();
              if (rect.width < 20 || rect.height < 8) return false;
              return Math.abs(rect.top + rect.height / 2 - refY) < 30;
            });
            if (candidates.length === 0) return false;
            (candidates[0] as HTMLElement).click();
            return true;
          },
          { typeText, refY: allBox.y + allBox.height / 2 }
        );

        if (clicked) {
          await this.page.waitForTimeout(500);
          return;
        }
      }
    }

    // ── Strategy 3: plain text match, pick second occurrence ──────────────────
    const allMatches = this.page.locator('*').filter({ hasText: new RegExp(`^${typeText}$`, 'i') });
    const total = await allMatches.count().catch(() => 0);
    if (total >= 2) {
      await allMatches.nth(1).click();
      await this.page.waitForTimeout(500);
      return;
    }
    if (total === 1) {
      await allMatches.first().click();
      await this.page.waitForTimeout(500);
    }
  }

  async openDlmmPositionsForPair(baseSymbol: string, quoteSymbol: string) {
    const pairPattern = buildPairPattern(baseSymbol, quoteSymbol);

    // Note: Don't click "My Positions" tab here because goto() already navigates to
    // /pools?tab=positions, and clicking the tab may reset the DLMM filter chip selection.
    // The page is already on My Positions, and filterByDlmm() has already been called.

    const filterInput = this.page
      .locator('input[placeholder*="filter" i], input[placeholder*="token" i], input[type="search"]')
      .first();
    if (await filterInput.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await filterInput.fill(`${baseSymbol}-${quoteSymbol}`.toLowerCase());
      await this.page.waitForTimeout(400);
    }

    await expect(this.page.getByText(pairPattern).first()).toBeVisible({ timeout: 15_000 });
  }

  async openFirstPositionRemovePanel() {
    // Same strategy as CLMM remove.
    const byTextMinus = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^\s*-\s*$/ })
      .first();
    if (await byTextMinus.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await byTextMinus.click();
      return;
    }

    const iconMinus = this.page
      .locator(
        'button:has(svg[class*="minus" i]), button:has(i[class*="minus" i]), button[aria-label*="minus" i], button[title*="minus" i]'
      )
      .first();
    if (await iconMinus.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await iconMinus.click();
      return;
    }

    const clicked = await this.clickFirstRemoveButtonInActionsColumn();
    if (clicked) return;

    throw new Error('Cannot find clickable remove (-) button in DLMM positions list');
  }

  async switchToRemoveTab() {
    // Some DLMM positions may show the remove panel directly without tabs.
    // First check if we're already on a remove view by looking for remove-specific elements.
    const removePanel = this.page
      .locator('section, div')
      .filter({ hasText: /remove amounts|remove amount/i })
      .first();
    
    if (await removePanel.isVisible({ timeout: 2_000 }).catch(() => false)) {
      // Already on remove view, no tab switch needed
      return;
    }

    // Try to click the Remove tab
    const removeTab = this.page.getByRole('button', { name: /^remove$/i }).first();
    if (await removeTab.isVisible({ timeout: 6_000 }).catch(() => false)) {
      await removeTab.click();
      await this.page.waitForTimeout(500);
      return;
    }

    const removeText = this.page
      .locator('button, [role="button"], div')
      .filter({ hasText: /^remove$/i })
      .first();
    
    if (await removeText.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await removeText.click();
      await this.page.waitForTimeout(500);
      return;
    }

    // If no tab found, assume we're already in the correct view
    console.log('[DLMM Remove] No Remove tab found, assuming already in remove view');
  }

  async clickMaxForToken(tokenSymbol?: string) {
    await clickMaxForTokenInRemovePanel(this.page, tokenSymbol);
  }

  async submitRemove() {
    const removePanel = this.page
      .locator('section, div')
      .filter({ hasText: /remove amounts|remove amount/i })
      .first();

    const submitButton = removePanel.getByRole('button', { name: /^remove$/i }).last();
    await expect(submitButton).toBeVisible({ timeout: 10_000 });
    await expect(submitButton).toBeEnabled({ timeout: 10_000 });
    await submitButton.click();

    const confirmDialog = this.page.locator('[role="dialog"], .chakra-modal__content').last();
    const hasDialog = await confirmDialog.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasDialog) return;

    const confirmButton = confirmDialog
      .locator('button, [role="button"]')
      .filter({ hasText: /^remove$|^confirm$|^approve$/i })
      .first();
    const hasConfirmButton = await confirmButton.isVisible({ timeout: 4_000 }).catch(() => false);
    if (!hasConfirmButton) return;
    if (!(await confirmButton.isEnabled().catch(() => false))) return;
    await confirmButton.click();
  }

  async expectSuccess() {
    const successText = this.page.getByText(/success|completed|submitted|view in explorer/i).first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
  }

  private async clickFirstRemoveButtonInActionsColumn(): Promise<boolean> {
    const clicked = await clickFirstActionButtonInActionsColumn(this.page);

    if (clicked) {
      await this.page.waitForTimeout(400);
    }
    return clicked;
  }
}
