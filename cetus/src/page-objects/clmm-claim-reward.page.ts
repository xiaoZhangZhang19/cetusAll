import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Claimable reward amounts read from the claim modal (Standard tab).
 * Values are in human-readable float form (e.g., 0.00770675).
 */
export interface ClaimableAmounts {
  cetus: number;
  sui: number;
  usdc: number;
}

/**
 * Page object for the CLMM "Claim Reward" flow.
 *
 * Flow (from codegen recording):
 *   1. /pools?tab=positions → click "My Positions" if needed
 *   2. Click the SUI-USDC CLMM pool card (e.g., "SUI - USDCCLMM0.05%Current")
 *   3. Click the active position row to open the claim modal
 *   4. Read claimable amounts (CETUS, SUI, USDC) from Standard tab
 *   5. Click "Claim" → wallet approves
 *   6. Wait for success, read digest
 */
export class ClmmClaimRewardPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto('/pools?tab=positions', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
  }

  // ─── Step 1: Navigate to My Positions and open pool ─────────────────────────

  /**
   * Mirrors codegen:
   *   page.getByText('My Positions').click()
   *   page.getByText('SUI - USDCCLMM0.05%Current').click()
   */
  async openSuiUsdcClmmPool(baseSymbol = 'SUI', quoteSymbol = 'USDC') {
    // Click "My Positions" tab if present (sometimes already active via URL)
    const positionsTab = this.page
      .locator('button, [role="button"], div')
      .filter({ hasText: /^my positions$/i })
      .first();
    if (await positionsTab.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await positionsTab.click().catch(() => undefined);
      await this.page.waitForTimeout(1_200);
    }

    // The My Positions filter bar has "All N | CLMM N | DLMM N | Collapse".
    // "Collapse" is unique to this filter bar (not in the main nav), so use it
    // to scope the search and avoid hitting the main "CLMM" navigation tab.
    const collapseEl = this.page.getByText(/collapse/i).first();
    await collapseEl.waitFor({ state: 'visible', timeout: 10_000 });

    // Find the filter bar container: innermost div with both Collapse and DLMM tabs
    const filterBar = this.page
      .locator('div')
      .filter({ has: this.page.getByText(/collapse/i) })
      .filter({ has: this.page.locator('p', { hasText: /^dlmm$/i }) })
      .last();

    // Within the filter bar, click the CLMM tab via XPath ancestor pattern
    const clmmFilterTab = filterBar
      .locator('p', { hasText: 'CLMM' })
      .locator('xpath=ancestor::div[@data-active][1]');

    await expect(clmmFilterTab).toBeVisible({ timeout: 5_000 });
    await clmmFilterTab.click();
    console.log('[ClmmClaimReward] Clicked CLMM filter tab — only CLMM positions now visible');
    await this.page.waitForTimeout(800);

    // Wait for a CLMM price range cell (leaf-level, anchored regex)
    await this.page
      .locator('div, span')
      .filter({ hasText: /^\d+\.\d+\s*-\s*\d+\.\d+$/ })
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });

    await this.page.waitForTimeout(400);
    console.log(`[ClmmClaimReward] ${baseSymbol}-${quoteSymbol} CLMM positions visible`);
  }

  // ─── Step 2: Open active position's claim dialog ─────────────────────────────

  /**
   * Clicks the CLMM position row to open the position detail page.
   * 
   * Based on user screenshots:
   * - After clicking pool card, we see a list of positions
   * - Each position row displays: Price Range (e.g., "0.6764 - 1.3841"), Status (Active), APR, Liquidity, etc.
   * - Clicking anywhere on the position row should open the detail page
   * 
   * Strategy: Find the price range text element and click its parent row
   */
  async openFirstActivePositionClaimDialog() {
    console.log('[ClmmClaimReward] Searching for active position row to click...');

    // Wait for positions to be visible
    await this.page.waitForTimeout(1_500);

    // Strategy 1: Look for price range text pattern (e.g., "0.6764 - 1.3841")
    // This is the most distinctive feature of a position row
    const priceRangePattern = /^\d+\.\d+\s*-\s*\d+\.\d+$/;
    
    // Find all elements with price range text
    const priceRangeElements = this.page.locator('div, span').filter({ hasText: priceRangePattern });
    const priceRangeCount = await priceRangeElements.count();
    console.log(`[ClmmClaimReward] Found ${priceRangeCount} price range elements`);

    if (priceRangeCount > 0) {
      // For each price range element, find its closest clickable parent row
      for (let i = 0; i < Math.min(priceRangeCount, 3); i++) {
        const priceElement = priceRangeElements.nth(i);
        const priceText = await priceElement.innerText().catch(() => '');
        console.log(`[ClmmClaimReward] Trying price range ${i}: "${priceText}"`);

        // Try clicking the price element itself
        try {
          await priceElement.click({ timeout: 2_000 });
          await this.page.waitForTimeout(2_500);

          if (await this.isClaimModalOpen()) {
            console.log(`[ClmmClaimReward] ✓ Position detail page opened by clicking price element ${i}`);
            return;
          }
        } catch (err) {
          console.log(`[ClmmClaimReward] Failed to click price element ${i}, trying parent...`);
        }

        // If clicking the price element didn't work, try finding and clicking the row
        // Look for a parent that also contains "Active" text
        const parentRow = this.page
          .locator('div, [role="row"], [class*="row"]')
          .filter({ has: priceElement })
          .filter({ hasText: /active/i })
          .first();

        if (await parentRow.isVisible({ timeout: 1_000 }).catch(() => false)) {
          console.log(`[ClmmClaimReward] Clicking parent row containing price "${priceText}"`);
          await parentRow.click();
          await this.page.waitForTimeout(2_500);

          if (await this.isClaimModalOpen()) {
            console.log(`[ClmmClaimReward] ✓ Position detail page opened by clicking parent row ${i}`);
            return;
          }
        }
      }
    }

    // Strategy 2: Use codegen's approach - find divs with combined pattern
    console.log('[ClmmClaimReward] Price range strategy failed, trying codegen pattern...');
    const fullRowPattern = /\d+\.\d+\s*-\s*\d+\.\d+.*active.*\d+\.\d+\s*%/is;
    const clickableRows = this.page.locator('div').filter({ hasText: fullRowPattern });
    const rowCount = await clickableRows.count();
    console.log(`[ClmmClaimReward] Found ${rowCount} divs matching full row pattern`);

    for (const nthIdx of [0, 1, 2]) {
      if (nthIdx >= rowCount) continue;

      const row = clickableRows.nth(nthIdx);
      if (!(await row.isVisible({ timeout: 1_500 }).catch(() => false))) continue;

      console.log(`[ClmmClaimReward] Clicking full row pattern nth(${nthIdx})`);
      await row.click();
      await this.page.waitForTimeout(2_500);

      if (await this.isClaimModalOpen()) {
        console.log(`[ClmmClaimReward] ✓ Position detail page opened (nth=${nthIdx})`);
        return;
      }
    }

    // Debug output
    const visibleText = await this.page.locator('body').innerText().catch(() => '');
    const hasMyPosition = visibleText.includes('My Position') || visibleText.includes('my position');
    const hasClaimBtn = visibleText.includes('Claim') && !visibleText.includes('Claimable');
    console.log(
      `[ClmmClaimReward] Debug - Page contains: MyPosition=${hasMyPosition}, Claim=${hasClaimBtn}`
    );

    throw new Error(
      '[ClmmClaimReward] Failed to open position detail page. ' +
        'Ensure an active CLMM position exists for SUI-USDC pool.'
    );
  }

  // ─── Step 3: Open claim modal ────────────────────────────────────────────────

  /**
   * Clicks the Claim button on position detail page to open the claim modal.
   * Waits for modal to load.
   */
  async openClaimModal() {
    console.log('[ClmmClaimReward] Clicking Claim button to open modal...');
    
    const claimBtn = this.page.getByRole('button', { name: /^claim$/i }).first();
    await expect(claimBtn).toBeVisible({ timeout: 10_000 });
    await expect(claimBtn).toBeEnabled({ timeout: 10_000 });
    await claimBtn.click();
    console.log('[ClmmClaimReward] Clicked Claim button');

    // Wait for modal to appear and render
    await this.page.waitForTimeout(3_000);
    console.log('[ClmmClaimReward] Waited for modal to load');
  }

  // ─── Step 4: Read amounts from modal ─────────────────────────────────────────

  /**
   * Reads CETUS, SUI, USDC amounts from the claim modal's right panel.
   *
   * The modal's right panel ("Standard" tab) shows:
   *   "The following tokens will be claimed to your wallet"
   *   SUI       0.00000079
   *   CETUS     0.000024374
   *   [Claim button]
   *
   * Only tokens with non-zero amounts appear in this panel.
   * We scope reading to this panel only to avoid contamination from the
   * background position-detail page (which contains price ranges like "0.6764").
   */
  async readClaimableAmountsFromModal(): Promise<ClaimableAmounts> {
    console.log('[ClmmClaimReward] Reading claimable amounts from modal right panel...');

    // Scope to the Chakra modal: aria-modal="true" distinguishes it from popovers
    const dialog = this.page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Within the dialog, find the right panel: the div that contains
    // "The following tokens will be claimed to your wallet"
    const panelHeader = dialog.getByText(/the following tokens will be claimed to your wallet/i);
    await expect(panelHeader).toBeVisible({ timeout: 5_000 });

    // Walk up to a parent that contains the token list AND the Claim button
    // (go up 2-3 levels from the header text)
    let panelText = '';
    for (const depth of [2, 3, 4]) {
      const ancestor = panelHeader.locator(`xpath=${'/..'
        .repeat(depth)}`);
      const t = await ancestor.innerText().catch(() => '');
      if (t.length > 20) {
        panelText = t;
        console.log(`[ClmmClaimReward] Got panel text at depth ${depth}, length: ${t.length}`);
        break;
      }
    }

    if (!panelText) {
      // Fallback: get all dialog text
      panelText = await dialog.innerText().catch(() => '');
      console.log(`[ClmmClaimReward] Fallback: using full dialog text, length: ${panelText.length}`);
    }

    console.log('[ClmmClaimReward] Panel text:\n' + panelText);

    const readAmount = (symbol: string): number => {
      // Match token symbol at start of a word boundary, followed by whitespace, then the amount.
      // Use multiline mode so ^ anchors to line start, preventing price-range numbers bleeding in.
      const pattern = new RegExp(`^${symbol}[\\s\\t]+([0-9][\\d.]*)`, 'mi');
      const match = pattern.exec(panelText);
      if (match) {
        const val = parseFloat(match[1]);
        if (!isNaN(val) && val > 0) {
          console.log(`[ClmmClaimReward] ✓ Read ${symbol}: ${val}`);
          return val;
        }
      }
      console.log(`[ClmmClaimReward] ${symbol} not found in modal panel (likely 0 or absent)`);
      return 0;
    };

    const cetus = readAmount('CETUS');
    const sui = readAmount('SUI');
    const usdc = readAmount('USDC');

    console.log(`[ClmmClaimReward] Claimable: CETUS=${cetus} SUI=${sui} USDC=${usdc}`);
    return { cetus, sui, usdc };
  }

  // ─── Step 5: Click Claim in modal ────────────────────────────────────────────

  /**
   * Clicks the Claim button inside the modal to trigger wallet confirmation.
   */
  async clickClaimInModal() {
    console.log('[ClmmClaimReward] Clicking Claim button in modal...');
    
    // The Claim button in the modal
    const modalClaimBtn = this.page.getByRole('button', { name: /^claim$/i }).last();
    
    await expect(modalClaimBtn).toBeVisible({ timeout: 10_000 });
    await expect(modalClaimBtn).toBeEnabled({ timeout: 10_000 });
    await modalClaimBtn.click();
    
    console.log('[ClmmClaimReward] Clicked Claim button in modal — wallet should open');
  }

  // ─── Step 6: Wait for success ────────────────────────────────────────────────

  async expectSuccess() {
    const successText = this.page
      .getByText(/success|claimed|transaction submitted|view in explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
    console.log('[ClmmClaimReward] Success message visible');
  }

  /**
   * Reads the transaction digest from the success notification or Explorer link.
   */
  async readDigest(): Promise<string | null> {
    const explorerLink = this.page
      .locator('a[href*="suiscan"], a[href*="suivision"], a[href*="explorer"]')
      .first();
    if (await explorerLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const href = (await explorerLink.getAttribute('href')) ?? '';
      const digestMatch = href.match(/\/tx\/([1-9A-HJ-NP-Za-km-z]{40,90})/);
      if (digestMatch) return digestMatch[1];
    }

    const bodyText = await this.page.locator('body').innerText().catch(() => '');
    const digestMatch = bodyText.match(/[1-9A-HJ-NP-Za-km-z]{43,90}/);
    return digestMatch ? digestMatch[0] : null;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Returns true only if the position detail page/panel is open.
   * The detail page shows "My Position" tab and has a "Claim" button.
   * This is NOT a modal dialog - it's an expanded view or page navigation.
   */
  protected async isClaimModalOpen(): Promise<boolean> {
    // Check for "My Position" tab (indicates we're in the position detail view)
    const myPositionTab = this.page
      .locator('button, div, [role="tab"]')
      .filter({ hasText: /^my position$/i });

    const hasMyPositionTab = await myPositionTab.isVisible({ timeout: 1_000 }).catch(() => false);

    // Check for "Claim" button in the page (be more specific - look for button role)
    const claimButtons = await this.page.getByRole('button').filter({ hasText: /claim/i }).all();
    const claimButtonTexts = await Promise.all(
      claimButtons.slice(0, 5).map((b) => b.innerText().catch(() => ''))
    );

    console.log(`[ClmmClaimReward] DEBUG - My Position tab visible: ${hasMyPositionTab}`);
    console.log(`[ClmmClaimReward] DEBUG - Found ${claimButtons.length} buttons with "claim" text: [${claimButtonTexts.join(', ')}]`);

    // Look for button with exact "Claim" text (not "Claimable")
    const exactClaimButton = await this.page
      .getByRole('button', { name: /^claim$/i })
      .isVisible({ timeout: 1_000 })
      .catch(() => false);

    console.log(`[ClmmClaimReward] DEBUG - Exact "Claim" button visible: ${exactClaimButton}`);

    if (hasMyPositionTab && exactClaimButton) {
      console.log('[ClmmClaimReward] Position detail page detected (My Position + Claim button)');
      return true;
    }

    // Fallback: just check for exact Claim button
    if (exactClaimButton) {
      console.log('[ClmmClaimReward] Position detail detected (Claim button found)');
      return true;
    }

    return false;
  }
}

