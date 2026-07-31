import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Page Object for the Cetus Farm "Stake" flow.
 *
 * The Farms page is at /earn/farms (Earn → Farms in the nav).
 * Each farm row shows the pool pair, TVL, APR, rewards, etc.
 * Clicking the ▼ chevron on the right of a row expands the position list,
 * where each position has a "Stake" button.
 *
 * Flow:
 *   1. goto()                    → /earn/farms
 *   2. expandFarmRow(pair)       → click the ▼ chevron on the target pair row
 *   3. clickStake()              → click the "Stake" button in the expanded panel
 *   4. (wallet approval externally)
 *   5. expectStakeSuccess()      → verify success notification
 */
export class FarmStakePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  async goto() {
    await this.page.goto('/farms', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('load').catch(() => undefined);
    await this.page
      .locator('[class*="pool"], [class*="farm"], [class*="Pool"], [class*="Farm"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => undefined);
    console.log('[FarmStake] Navigated to /farms');
  }

  // ─── Step 1: Expand the target farm row ─────────────────────────────────────

  /**
   * Finds the farm row matching the given pair label (e.g. "haSUI - SUI")
   * and clicks its expand chevron (▼ / ↓ button on the right side).
   *
   * The row stays collapsed by default; only after expanding does the
   * position list with the "Stake" button appear.
   *
   * @param pairLabel  Display text of the pool pair, e.g. "haSUI - SUI"
   */
  async expandFarmRow(pairLabel: string) {
    console.log(`[FarmStake] Looking for farm row: "${pairLabel}"`);

    // After wallet connect, rows may re-render — give the list time to settle
    await this.page.waitForTimeout(1_500);

    // Strategy: each farm row has a "Claim" button + a "▼" chevron button next to it.
    // Find the row whose pair text matches, locate its Claim button,
    // then click the button immediately after it (the expand chevron).
    const firstToken = pairLabel.split(/[\s\-–]+/)[0].trim();

    // Find all "Claim" buttons on the page, pick the one closest to the pair text
    const claimButtons = this.page.getByRole('button', { name: /^claim$/i });
    const claimCount = await claimButtons.count();
    console.log(`[FarmStake] Found ${claimCount} Claim button(s) on page`);

    let targetClaimBox: { x: number; y: number; width: number; height: number } | null = null;
    let targetRowY = -1;

    // Find the pair label element and get its Y coordinate
    const pairEl = this.page
      .locator('div, span, p')
      .filter({ hasText: new RegExp(firstToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
      .first();
    await expect(pairEl).toBeVisible({ timeout: 20_000 });
    const pairBox = await pairEl.boundingBox();
    if (pairBox) targetRowY = pairBox.y + pairBox.height / 2;

    // Among all Claim buttons, find the one on the same row as the pair label
    for (let i = 0; i < claimCount; i++) {
      const btn = claimButtons.nth(i);
      const box = await btn.boundingBox();
      if (box && targetRowY > 0 && Math.abs(box.y + box.height / 2 - targetRowY) < 60) {
        targetClaimBox = box;
        console.log(`[FarmStake] Matched Claim button at index ${i}, y=${box.y}`);
        break;
      }
    }

    if (targetClaimBox) {
      // The ▼ chevron button is to the right of Claim — click just to the right of it
      const chevronX = targetClaimBox.x + targetClaimBox.width + 20;
      const chevronY = targetClaimBox.y + targetClaimBox.height / 2;
      await this.page.mouse.click(chevronX, chevronY);
      await this.page.waitForTimeout(1_500);
      console.log(`[FarmStake] Clicked expand chevron at (${chevronX.toFixed(0)}, ${chevronY.toFixed(0)})`);
      await this.waitForStakeButtonVisible();
      return;
    }

    // Final fallback: click the rightmost small button in the entire page
    // that is on the same row as the pair label
    if (targetRowY > 0) {
      const fallbackBtn = await this.page.evaluate((rowY: number) => {
        const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
        const candidates = buttons.filter((btn) => {
          const rect = btn.getBoundingClientRect();
          return (
            Math.abs(rect.top + rect.height / 2 - rowY) < 60 &&
            rect.width < 60 && rect.height < 60 && rect.width > 0 &&
            (btn.textContent ?? '').trim().toLowerCase() !== 'claim'
          );
        });
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        const rect = candidates[0].getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, targetRowY);

      if (fallbackBtn) {
        await this.page.mouse.click(fallbackBtn.x, fallbackBtn.y);
        await this.page.waitForTimeout(1_500);
        console.log('[FarmStake] Clicked chevron via final coordinate fallback');
        await this.waitForStakeButtonVisible();
        return;
      }
    }

    throw new Error(`[FarmStake] Cannot find expand chevron for farm row: "${pairLabel}"`);
  }

  // ─── Step 2: Click Stake ─────────────────────────────────────────────────────

  /**
   * Clicks the "Stake" button in the expanded farm position row.
   * Assumes expandFarmRow() has already been called.
   */
  async clickStake() {
    const stakeBtn = this.page
      .getByRole('button', { name: /^stake$/i })
      .first();

    await expect(stakeBtn).toBeVisible({ timeout: 10_000 });
    await expect(stakeBtn).toBeEnabled({ timeout: 10_000 });
    await stakeBtn.click();
    console.log('[FarmStake] Clicked Stake button');
  }

  // ─── Step 2b: Click Unstake ──────────────────────────────────────────────────

  async clickUnstake() {
    const unstakeBtn = this.page
      .getByRole('button', { name: /^unstake$/i })
      .first();

    await expect(unstakeBtn).toBeVisible({ timeout: 10_000 });
    await expect(unstakeBtn).toBeEnabled({ timeout: 10_000 });
    await unstakeBtn.click();
    console.log('[FarmStake] Clicked Unstake button');
  }

  // ─── Step 2c: Click Claim (row-level, no expand needed) ──────────────────────

  /**
   * Finds the highlighted "Claim" button on the target farm row and clicks it.
   * No need to expand the row — the Claim button is always visible in the row.
   *
   * The active/highlighted Claim button differs from disabled ones visually
   * (brighter color). We identify the correct one by matching the row Y position
   * of the pair label, then picking the enabled Claim button on that row.
   *
   * @param pairLabel  Display text of the pool pair, e.g. "haSUI - SUI"
   */
  async clickClaimForRow(pairLabel: string) {
    console.log(`[FarmStake] Looking for Claim button on row: "${pairLabel}"`);

    await this.page.waitForTimeout(1_000);

    const firstToken = pairLabel.split(/[\s\-–]+/)[0].trim();
    const pairEl = this.page
      .locator('div, span, p')
      .filter({ hasText: new RegExp(firstToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
      .first();

    await expect(pairEl).toBeVisible({ timeout: 20_000 });
    const pairBox = await pairEl.boundingBox();
    if (!pairBox) throw new Error(`[FarmStake] Cannot get bounding box for pair: "${pairLabel}"`);

    const rowY = pairBox.y + pairBox.height / 2;

    // Find all Claim buttons, pick the enabled one on the same row
    const claimButtons = this.page.getByRole('button', { name: /^claim$/i });
    const count = await claimButtons.count();

    for (let i = 0; i < count; i++) {
      const btn = claimButtons.nth(i);
      const box = await btn.boundingBox();
      if (!box) continue;
      const btnY = box.y + box.height / 2;
      if (Math.abs(btnY - rowY) < 80) {
        const isEnabled = await btn.isEnabled();
        if (!isEnabled) {
          throw new Error(`[FarmStake] Claim button for "${pairLabel}" is disabled — no rewards to claim`);
        }
        await btn.click();
        console.log(`[FarmStake] Clicked Claim button on row "${pairLabel}"`);
        return;
      }
    }

    throw new Error(`[FarmStake] Cannot find Claim button for row: "${pairLabel}"`);
  }

  // ─── Step 3: Assert success ──────────────────────────────────────────────────

  async expectStakeSuccess() {
    const successText = this.page
      .getByText(/success|staked|transaction completed|submitted|view in explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
    console.log('[FarmStake] ✓ Stake transaction successful');
  }

  async expectUnstakeSuccess() {
    const successText = this.page
      .getByText(/success|unstaked|transaction completed|submitted|view in explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
    console.log('[FarmStake] ✓ Unstake transaction successful');
  }

  async expectClaimSuccess() {
    const successText = this.page
      .getByText(/success|claimed|transaction completed|submitted|view in explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
    console.log('[FarmStake] ✓ Claim transaction successful');
  }

  /**
   * Reads the transaction digest from the success notification or explorer link.
   */
  async readDigest(): Promise<string | undefined> {
    const explorerLink = this.page
      .locator('a[href*="suiscan"], a[href*="suivision"], a[href*="explorer"]')
      .first();

    if (await explorerLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const href = (await explorerLink.getAttribute('href')) ?? '';
      const match =
        href.match(/\/tx(?:block)?\/([1-9A-HJ-NP-Za-km-z]{40,90})/)?.[1] ??
        href.match(/transaction\/([1-9A-HJ-NP-Za-km-z]{40,90})/)?.[1];
      if (match) return match;
    }

    const bodyText = await this.page.locator('body').innerText().catch(() => '');
    return bodyText.match(/[1-9A-HJ-NP-Za-km-z]{43,90}/)?.[0];
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Waits for a "Stake" button to become visible after expanding a farm row.
   * If no button appears within the timeout, logs a warning (position may not exist).
   */
  private async waitForStakeButtonVisible() {
    const stakeBtn = this.page.getByRole('button', { name: /^stake$/i }).first();
    const visible = await stakeBtn.isVisible({ timeout: 8_000 }).catch(() => false);
    if (!visible) {
      console.warn('[FarmStake] No Stake button found after expanding row — wallet may have no eligible position');
    }
  }
}
