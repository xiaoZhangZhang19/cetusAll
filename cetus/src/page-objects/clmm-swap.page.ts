import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Page Object for the CLMM pool page's embedded Swap widget.
 *
 * The Swap widget is accessed via a floating button at the bottom-left of
 * the pools page (the robot/avatar icon). Clicking it opens an inline Swap
 * panel (not a full-page navigation).
 *
 * Flow:
 *   1. goto()              → /pools (CLMM tab)
 *   2. openSwapPanel()     → click floating Swap entry button
 *   3. fillAmount(amount)  → enter amount in the "You Pay" input
 *   4. submitSwap()        → click "Swap" → optional "Confirm Swap" dialog
 *   5. expectSuccess()     → verify success notification
 */
export class ClmmSwapPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  async goto() {
    await this.page.goto('/pools', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
  }

  // ─── Step 1: Open the floating Swap panel ───────────────────────────────────

  /**
   * Clicks the floating Swap entry button at the bottom-left of the pools page.
   *
   * The button renders as a small avatar/robot icon anchored to the page corner.
   * It has no visible text label — we locate it by position and icon characteristics.
   *
   * Strategies (tried in order):
   *   1. aria-label or title containing "swap"
   *   2. Fixed-position button near the bottom-left corner
   *   3. Button containing an <img> or <svg> near bottom-left
   */
  async openSwapPanel() {
    // Strategy 1: aria-label / title
    const byAriaLabel = this.page
      .locator('button, [role="button"]')
      .filter({ has: this.page.locator('[aria-label*="swap" i], [title*="swap" i]') })
      .first();

    if (await byAriaLabel.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await byAriaLabel.click();
      await this.waitForSwapPanelReady();
      console.log('[ClmmSwap] Opened Swap panel via aria-label');
      return;
    }

    // Strategy 2: Fixed bottom-left button with image/avatar
    // Cetus renders the widget trigger as a fixed element with low z-index coords.
    // Use evaluate to find elements positioned near the bottom-left.
    const bottomLeftBtn = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
      for (const btn of buttons) {
        const rect = btn.getBoundingClientRect();
        // Bottom-left quadrant: x < 120px, y > 60% of viewport height
        if (rect.x < 120 && rect.y > window.innerHeight * 0.6 && rect.width > 0) {
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      }
      return null;
    });

    if (bottomLeftBtn) {
      await this.page.mouse.click(bottomLeftBtn.x, bottomLeftBtn.y);
      await this.waitForSwapPanelReady();
      console.log('[ClmmSwap] Opened Swap panel via bottom-left position');
      return;
    }

    // Strategy 3: Any fixed/absolute button with an img child near bottom-left
    const fixedBtns = await this.page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
      return candidates
        .filter((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            (style.position === 'fixed' || style.position === 'absolute') &&
            rect.x < 200 && rect.y > 300 && rect.width > 0 && rect.height > 0
          );
        })
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
    });

    if (fixedBtns.length > 0) {
      await this.page.mouse.click(fixedBtns[0].x, fixedBtns[0].y);
      await this.waitForSwapPanelReady();
      console.log('[ClmmSwap] Opened Swap panel via fixed position button');
      return;
    }

    throw new Error('[ClmmSwap] Cannot locate the floating Swap entry button');
  }

  // ─── Step 2: Fill amount ─────────────────────────────────────────────────────

  /**
   * Types the swap input amount into the "You Pay" field of the Swap panel.
   * Waits for the output quote to calculate (spinner disappears).
   */
  async fillAmount(amount: string) {
    const swapPanel = await this.getSwapPanel();

    const input = swapPanel
      .locator('input[inputmode="decimal"], input[placeholder="0"], input[placeholder="0.0"], input[type="text"]')
      .first();

    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.click();
    await input.fill(amount);

    // Wait for quote calculation
    const spinner = this.page.locator('.chakra-spinner, [class*="spinner"], svg[class*="animate-spin"]');
    await spinner.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    await spinner.first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);

    console.log(`[ClmmSwap] Filled amount: ${amount}`);
  }

  // ─── Step 3: Submit swap ─────────────────────────────────────────────────────

  /**
   * Clicks the "Swap" button and handles any "Confirm Swap" confirmation dialog.
   */
  async submitSwap() {
    const swapPanel = await this.getSwapPanel();

    const swapBtn = swapPanel
      .locator('button, [role="button"]')
      .filter({ hasText: /^swap!?$/i })
      .first();

    await expect(swapBtn).toBeVisible({ timeout: 15_000 });
    await expect(swapBtn).toBeEnabled({ timeout: 15_000 });
    await swapBtn.click();
    console.log('[ClmmSwap] Clicked Swap button');

    // Handle optional "Confirm Swap" dialog
    const confirmBtn = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^confirm(?: swap)?$/i })
      .first();

    const hasConfirm = await confirmBtn.isVisible({ timeout: 8_000 }).catch(() => false);
    if (hasConfirm) {
      await expect(confirmBtn).toBeEnabled({ timeout: 10_000 });
      await confirmBtn.click();
      console.log('[ClmmSwap] Clicked Confirm Swap in dialog');
    }
  }

  // ─── Step 4: Assert success ──────────────────────────────────────────────────

  async expectSuccess() {
    const successText = this.page
      .getByText(/success|transaction completed|submitted|view in explorer|view on explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
    console.log('[ClmmSwap] ✓ Swap transaction successful');
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
   * Waits for the Swap panel to become ready after opening.
   * The panel is ready when an amount input is visible.
   */
  private async waitForSwapPanelReady() {
    // Wait for the swap panel's input to appear
    const panelInput = this.page
      .locator('input[inputmode="decimal"], input[placeholder="0"], input[placeholder="0.0"]')
      .first();
    await expect(panelInput).toBeVisible({ timeout: 15_000 });
    await this.page.waitForTimeout(500);
  }

  /**
   * Locates the Swap panel container.
   *
   * The panel is identified by containing the "Swap" title/heading and an
   * amount input. Falls back to the whole page if the panel cannot be scoped.
   */
  private async getSwapPanel() {
    // Try to scope to the panel by its "Swap" heading
    const panelByTitle = this.page
      .locator('div, section, [role="dialog"]')
      .filter({ has: this.page.getByText(/^swap$/i) })
      .filter({ has: this.page.locator('input[inputmode="decimal"], input[placeholder="0"]') })
      .last();

    if (await panelByTitle.isVisible({ timeout: 2_000 }).catch(() => false)) {
      return panelByTitle;
    }

    // Fallback: return the full page scope
    return this.page.locator('body');
  }
}
