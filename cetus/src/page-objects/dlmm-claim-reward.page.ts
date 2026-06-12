import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { ClmmClaimRewardPage } from './clmm-claim-reward.page.js';



/**
 * Page object for the DLMM "Claim Reward" flow.
 *
 * Extends ClmmClaimRewardPage: all steps after navigating to the position
 * detail page (openClaimModal → readClaimableAmountsFromModal → clickClaimInModal
 * → expectSuccess → readDigest) are identical.
 *
 * The only difference is how we locate and click the position row:
 *   DLMM cards have "bps" (bin step) text which CLMM cards do not.
 *   We use that to scope the click to within the DLMM card only.
 */
export class DlmmClaimRewardPage extends ClmmClaimRewardPage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * Navigates to My Positions, then clicks the "DLMM N" filter tab
   * so only DLMM positions are shown (CLMM card hidden).
   *
   * The filter tab text is "DLMM 1" (space + digit), which distinguishes it
   * from the card badge that reads just "DLMM" (no digit).
   */
  async openSuiUsdcDlmmPool(baseSymbol = 'SUI', quoteSymbol = 'USDC') {
    // Click "My Positions" tab if present
    const positionsTab = this.page
      .locator('button, [role="button"], div')
      .filter({ hasText: /^my positions$/i })
      .first();
    if (await positionsTab.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await positionsTab.click().catch(() => undefined);
      await this.page.waitForTimeout(1_200);
    }

    // The My Positions filter bar has "All N | CLMM N | DLMM N | Collapse".
    // "Collapse" only appears in this filter bar (not in the main nav), so we use it
    // to scope our search and avoid hitting the main "DLMM 29" navigation tab.
    const collapseEl = this.page.getByText(/collapse/i).first();
    await collapseEl.waitFor({ state: 'visible', timeout: 10_000 });

    // Find the filter bar container: the innermost div that has both Collapse and CLMM type tabs
    const filterBar = this.page
      .locator('div')
      .filter({ has: this.page.getByText(/collapse/i) })
      .filter({ has: this.page.locator('p', { hasText: /^clmm$/i }) })
      .last();

    // Within the filter bar, find the DLMM tab via the user-provided XPath pattern
    const dlmmFilterTab = filterBar
      .locator('p', { hasText: 'DLMM' })
      .locator('xpath=ancestor::div[@data-active][1]');

    await expect(dlmmFilterTab).toBeVisible({ timeout: 5_000 });
    await dlmmFilterTab.click();
    console.log('[DlmmClaimReward] Clicked DLMM filter tab — only DLMM positions now visible');
    await this.page.waitForTimeout(800);

    // Wait for a DLMM price range cell (leaf-level, anchored regex like the base class uses)
    await this.page
      .locator('div, span')
      .filter({ hasText: /^\d+\.\d+\s*-\s*\d+\.\d+$/ })
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });

    await this.page.waitForTimeout(400);
    console.log(`[DlmmClaimReward] ${baseSymbol}-${quoteSymbol} DLMM positions visible`);
  }

  // openFirstActivePositionClaimDialog is inherited from ClmmClaimRewardPage.
  // After the DLMM filter tab is clicked, only DLMM positions are visible,
  // so the base class implementation correctly finds and clicks the DLMM position row.
}
