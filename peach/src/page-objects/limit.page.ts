import { type Page, expect } from '@playwright/test';
import type { MetaMaskController } from '../wallet/metamask-controller.js';

/**
 * LimitPage – Peach Protocol Limit Order page object
 *
 * Covers the full P0 flow:
 *   1. Navigate to /limit and connect wallet
 *   2. Enter BNB pay amount (validated against current BNB price, min $5 USD)
 *   3. Set rate premium to +5%
 *   4. Click "Place Limit Order" → handle "Review your order" dialog
 *   5. Approve 3 MetaMask popups (Wrap BNB, Enable WBNB, Place Limit Order)
 *   6. Open the Orders panel and verify the new open order exists
 */
export class LimitPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ── Navigation ──────────────────────────────────────────────────────────────

  /**
   * Navigate to the Limit page and wait for it to load.
   * Retries once on transient network errors.
   */
  async goto() {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.page.goto('/limit', { waitUntil: 'domcontentloaded', timeout: 30_000 });
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        console.log(`[LimitPage] goto failed (attempt ${attempt}), retrying in 3s…`);
        await this.page.waitForTimeout(3_000);
      }
    }
    await this.page.waitForLoadState('networkidle');
    // The Limit page shows "You Pay" input or "Enter an amount" placeholder
    await this.page.waitForSelector('text=/You Pay|Enter an amount/i', { timeout: 20_000 });
    console.log('[LimitPage] Limit page loaded');
    await this.dismissTermsDialogIfPresent();
  }

  /** Accept the Terms & Policies consent dialog on first visit. */
  private async dismissTermsDialogIfPresent() {
    const dialog = this.page.locator('role=dialog[name="Terms & Policies"]');
    const visible = await dialog.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!visible) return;

    console.log('[LimitPage] Terms & Policies dialog – accepting');
    const checkbox = dialog.locator('role=checkbox');
    await checkbox.check();
    const confirmBtn = dialog.locator('role=button', { hasText: /^Confirm$/i });
    await expect(confirmBtn).toBeEnabled({ timeout: 5_000 });
    await confirmBtn.click();
    await expect(dialog).toBeHidden({ timeout: 8_000 });
    console.log('[LimitPage] Terms & Policies accepted');
  }

  // ── BNB price ───────────────────────────────────────────────────────────────

  /**
   * Read the current BNB/USDT price from the "Sell BNB at rate" section.
   * Returns null when the market price element is not found.
   */
  async getBnbMarketPrice(): Promise<number | null> {
    try {
      // "Market: 590.559 USDT per BNB"
      const el = this.page.locator('text=/Market:.*USDT per BNB/i').first();
      const text = await el.textContent({ timeout: 10_000 }).catch(() => null);
      if (!text) return null;
      const m = text.match(/[\d,]+\.?\d*/);
      if (!m) return null;
      const price = parseFloat(m[0].replace(/,/g, ''));
      console.log(`[LimitPage] BNB market price: ${price} USDT`);
      return price;
    } catch {
      return null;
    }
  }

  /**
   * Compute a BNB pay amount whose USD value is at least `minUsd`.
   * Returns the amount as a string with 6 decimal places.
   *
   * @param bnbPrice   – current BNB price in USDT (from getBnbMarketPrice)
   * @param minUsd     – minimum USD value threshold (default 5)
   * @param bufferMultiplier – overshoot buffer so $5 check passes (default 1.1)
   */
  computeMinBnbAmount(bnbPrice: number, minUsd = 5, bufferMultiplier = 1.1): string {
    const raw = (minUsd * bufferMultiplier) / bnbPrice;
    // 向上取整到第 6 位小数，确保 amount × bnbPrice ≥ minUsd * bufferMultiplier
    const factor = 1_000_000;
    const ceiled = Math.ceil(raw * factor) / factor;
    return ceiled.toFixed(6);
  }

  // ── Input helpers ───────────────────────────────────────────────────────────

  /**
   * Enter a BNB amount in the "You Pay" input field.
   * Validates that the entered amount × bnbPrice ≥ minUsd; throws otherwise.
   *
   * @param amount   – BNB amount string, e.g. "0.010688"
   * @param bnbPrice – current BNB price in USDT (used for validation log)
   * @param minUsd   – USD threshold (default 5)
   */
  async enterPayAmount(amount: string, bnbPrice: number, minUsd = 5) {
    const usdValue = parseFloat(amount) * bnbPrice;
    if (usdValue < minUsd) {
      throw new Error(
        `[LimitPage] Pay amount ${amount} BNB (≈$${usdValue.toFixed(2)}) is below minimum $${minUsd} USD`
      );
    }

    // The "You Pay" amount input is the first numeric input on the page
    const payInput = this.page
      .locator('input[placeholder="0.0"], input[inputmode="decimal"], input[type="number"]')
      .first();
    await expect(payInput).toBeVisible({ timeout: 10_000 });
    await payInput.click({ clickCount: 3 });
    await payInput.fill(amount);
    console.log(`[LimitPage] Entered pay amount: ${amount} BNB (≈$${usdValue.toFixed(2)})`);

    // Wait for the UI to recalculate receive amount & rate
    await this.page.waitForTimeout(1_500);
  }

  /**
   * Click the "+5%" rate button.
   * The button label is "+5%" and is located in the "Sell BNB at rate" section.
   */
  async selectPlusFivePercent() {
    // Try role button with exact text first
    const btn = this.page
      .locator('button, span, div')
      .filter({ hasText: /^\+5\s*%$/ })
      .first();

    const visible = await btn.isVisible({ timeout: 5_000 }).catch(() => false);
    if (visible) {
      await btn.click();
      console.log('[LimitPage] Clicked +5% rate button');
      await this.page.waitForTimeout(800);
      return;
    }

    // Fallback: look for a text node "+5%" anywhere on the page
    const fallback = this.page.getByText(/\+5\s*%/).first();
    await expect(fallback).toBeVisible({ timeout: 5_000 });
    await fallback.click();
    console.log('[LimitPage] Clicked +5% rate button (fallback)');
    await this.page.waitForTimeout(800);
  }

  // ── Order placement ─────────────────────────────────────────────────────────

  /**
   * Click "Place Limit Order" to open the review dialog.
   */
  async clickPlaceLimitOrder() {
    const btn = this.page
      .locator('button')
      .filter({ hasText: /Place Limit Order/i })
      .first();
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await btn.click();
    console.log('[LimitPage] "Place Limit Order" clicked');
    // Wait for the review dialog to appear
    await this.page.waitForSelector(
      'text=/Review your order|Wrap BNB|Place Limit Order/i',
      { timeout: 15_000 }
    );
    console.log('[LimitPage] Review dialog appeared');
  }

  /**
   * In the "Review your order" dialog, click "Wrap BNB & Place Limit Order".
   */
  async confirmReviewDialog() {
    const dialog = this.page.locator('[role="dialog"]').first();
    const confirmBtn = dialog
      .locator('button')
      .filter({ hasText: /Wrap BNB & Place Limit Order|Place Limit Order/i })
      .first();
    await expect(confirmBtn).toBeVisible({ timeout: 10_000 });
    await expect(confirmBtn).toBeEnabled({ timeout: 5_000 });
    await confirmBtn.click();
    console.log('[LimitPage] Review dialog confirmed');
  }

  /**
   * Full order placement flow:
   *   1. Click "Place Limit Order"
   *   2. Confirm the review dialog
   *   3. Approve MetaMask popup(s) — up to 3 times (wrap + enable + place)
   */
  async placeOrder(metamask: MetaMaskController) {
    await this.clickPlaceLimitOrder();
    await this.confirmReviewDialog();

    // MetaMask may show up to 3 consecutive sign/confirm popups:
    //   1. Wrap BNB to WBNB
    //   2. Enable WBNB (ERC-20 approval)
    //   3. Place Limit Order (intent signature)
    console.log('[LimitPage] Approving MetaMask popup(s)…');
    for (let i = 0; i < 3; i++) {
      await metamask.approveTransaction(this.page);
      console.log(`[LimitPage] MetaMask popup ${i + 1} approved (or none found)`);

      // 检查 dApp 内是否还在等待钱包交互（说明还有后续弹框）
      const stillWaiting = await this.page
        .locator('text=/Placing order|Continue in your wallet|Wrap BNB to WBNB/i')
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false);

      if (!stillWaiting) {
        console.log('[LimitPage] dApp no longer waiting for wallet — order placement complete');
        break;
      }

      // 还在等待中：等下一个 MetaMask 弹框出现或等待状态消失（最多 8s）
      console.log(`[LimitPage] dApp still waiting for wallet, pausing before next approval…`);
      await Promise.race([
        this.page.context().waitForEvent('page', { timeout: 8_000 }).catch(() => null),
        this.page
          .locator('text=/Placing order|Continue in your wallet|Wrap BNB to WBNB/i')
          .first()
          .waitFor({ state: 'hidden', timeout: 8_000 })
          .catch(() => null),
      ]);
    }

    console.log('[LimitPage] Order placement flow finished');
    await this.page.bringToFront().catch(() => undefined);
    await this.dismissLimitOrderSuccessDialog();
  }

  /**
   * After order submission, detect the "Limit Order – Success" confirmation
   * dialog and click its "Close" button right away.
   * If the dialog never appears (e.g. already dismissed) this is a no-op.
   */
  async dismissLimitOrderSuccessDialog() {
    // The dialog title is "Limit Order" and body contains "Success"
    const dialog = this.page.locator('[role="dialog"]').filter({ hasText: /Success/i }).first();

    try {
      // Wait up to 8 s for the success dialog to appear (appears quickly after last MM approval)
      await dialog.waitFor({ state: 'visible', timeout: 8_000 });
      console.log('[LimitPage] Success dialog detected – clicking Close');

      const closeBtn = dialog.locator('button').filter({ hasText: /^Close$/i }).first();
      await closeBtn.click();

      // Confirm the dialog is gone
      await dialog.waitFor({ state: 'hidden', timeout: 8_000 });
      console.log('[LimitPage] Success dialog closed');
    } catch {
      // Dialog did not appear or was already gone – that is fine
      console.log('[LimitPage] Success dialog not detected, continuing');
    }
  }

  // ── Open Orders panel ───────────────────────────────────────────────────────

  /**
   * Open the "Orders" / "Show Orders" panel by clicking the clipboard icon button.
   * This is the button highlighted with a red border in the screenshot (4th image).
   */
  async openOrdersPanel() {
    // Failsafe: if the success dialog is still open, close it first
    await this.dismissLimitOrderSuccessDialog();

    let clicked = false;

    // Strategy 1: button with aria-label or title containing "Orders"
    const ordersBtn = this.page
      .locator('button[aria-label*="Order" i], button[title*="Order" i]')
      .first();
    if (await ordersBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await ordersBtn.click({ force: true });
      clicked = true;
    }

    // Strategy 2: "Show Orders" text link/button that appears after placing an order
    if (!clicked) {
      const showOrdersBtn = this.page.getByText(/Show Orders/i).first();
      if (await showOrdersBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await showOrdersBtn.click();
        clicked = true;
      }
    }

    // Strategy 3: find the clipboard/list icon button in the toolbar
    if (!clicked) {
      // The toolbar has: chart icon | clipboard icon | settings icon
      // Clipboard button is the 2nd button in the row of 3 icon buttons
      const toolbarBtns = this.page
        .locator('[aria-label="Swap tools"], [aria-label="Limit tools"], [class*="toolbar"], [class*="tools"]')
        .locator('button')
        .or(this.page.locator('svg[class*="clipboard"], svg[class*="list"]').locator('xpath=ancestor::button[1]'));

      const count = await toolbarBtns.count().catch(() => 0);
      if (count >= 2) {
        await toolbarBtns.nth(1).click();
        clicked = true;
      }
    }

    if (!clicked) {
      console.log('[LimitPage] ⚠ Could not find Orders panel button, skipping open');
      return;
    }

    console.log('[LimitPage] Orders panel opened');
    // Wait for the panel to render
    await this.page.waitForTimeout(2_000);
  }

  /**
   * Read all rows in the Open Orders list.
   * Returns an array of raw text content strings (one per row).
   */
  async getOpenOrders(): Promise<string[]> {
    try {
      // The open orders panel typically has a header "Open Orders" and rows below
      const rows = this.page.locator(
        '[class*="order"], [class*="Order"], [data-testid*="order"]'
      );
      const count = await rows.count().catch(() => 0);
      const texts: string[] = [];
      for (let i = 0; i < count; i++) {
        const t = await rows.nth(i).textContent().catch(() => '');
        if (t?.trim()) texts.push(t.trim());
      }

      if (texts.length === 0) {
        // Fallback: look for BNB → USDT rows in the orders section
        const section = this.page.locator('text=/Open Orders/i').first();
        const parent = section.locator('xpath=ancestor::div[3]');
        const fallbackRows = parent.locator('div, li').filter({ hasText: /BNB|WBNB/i });
        const fc = await fallbackRows.count().catch(() => 0);
        for (let i = 0; i < fc; i++) {
          const t = await fallbackRows.nth(i).textContent().catch(() => '');
          if (t?.trim()) texts.push(t.trim());
        }
      }

      console.log(`[LimitPage] Found ${texts.length} open order(s)`);
      return texts;
    } catch {
      return [];
    }
  }

  /**
   * Verify that at least one open order exists that matches the given criteria.
   *
   * @param criteria.sellToken  – e.g. "BNB" or "WBNB"
   * @param criteria.buyToken   – e.g. "USDT"
   * @param criteria.minUsd     – minimum USD order size (used to loosely validate amount)
   * @returns true if a matching order is found
   */
  async verifyOpenOrderExists(criteria: {
    sellToken?: string;
    buyToken?: string;
    minUsd?: number;
  }): Promise<boolean> {
    const orders = await this.getOpenOrders();

    for (const row of orders) {
      const lower = row.toLowerCase();
      let matches = true;

      if (criteria.sellToken && !lower.includes(criteria.sellToken.toLowerCase())) {
        matches = false;
      }
      if (criteria.buyToken && !lower.includes(criteria.buyToken.toLowerCase())) {
        matches = false;
      }

      if (matches) {
        console.log(`[LimitPage] ✓ Matching open order found: "${row.slice(0, 120)}"`);
        return true;
      }
    }

    // Broader fallback: just confirm there is at least 1 open order visible
    const openOrderSection = await this.page
      .locator('text=/Open Orders/i')
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false);

    if (openOrderSection) {
      // Check for any non-empty content beneath the "Open Orders" heading
      const anyOrder = await this.page
        .locator('text=/WBNB|BNB.*USDT|sell.*BNB/i')
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false);
      if (anyOrder) {
        console.log('[LimitPage] ✓ Open order found (broad match)');
        return true;
      }
    }

    console.log('[LimitPage] ✗ No matching open order found');
    return false;
  }

  /**
   * Wait for the open orders panel to show at least one order.
   * Polls up to `timeoutMs` milliseconds.
   */
  async waitForOpenOrder(criteria: {
    sellToken?: string;
    buyToken?: string;
  }, timeoutMs = 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      const found = await this.verifyOpenOrderExists(criteria);
      if (found) {
        console.log(`[LimitPage] Open order confirmed after ${attempt} attempt(s)`);
        return true;
      }
      console.log(`[LimitPage] Waiting for open order… (${remaining}s remaining)`);
      await this.page.waitForTimeout(3_000);
    }

    console.log('[LimitPage] ✗ Timed out waiting for open order');
    return false;
  }

  // ── Rate price input ────────────────────────────────────────────────────────

  /**
   * Enter a custom price into the "Sell BNB at rate" input field.
   *
   * Locating strategy: find "Market:" text → rate input is directly above it (~30px up).
   * Clearing strategy: triple-click to select all, then type the new value.
   * For React controlled inputs, we also dispatch a native input event to ensure
   * React's onChange fires correctly.
   *
   * @param price       – price string to type, e.g. "562.34"
   * @param marketPrice – unused, kept for API compatibility
   */
  async enterRatePrice(price: string, marketPrice?: number) {
    const marketLabel = this.page.locator('text=/Market:/i').first();
    await expect(marketLabel).toBeVisible({ timeout: 8_000 });
    const marketBox = await marketLabel.boundingBox();
    if (!marketBox) {
      throw new Error('[LimitPage] Could not get bounding box for "Market:" label');
    }

    // Rate input center is ~30px above the "Market:" text
    const clickX = marketBox.x + 80;
    const clickY = marketBox.y - 30;
    console.log(`[LimitPage] Market label at y=${marketBox.y.toFixed(0)}, clicking rate input at (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`);

    // Triple-click to select all existing content in the input
    await this.page.mouse.click(clickX, clickY, { clickCount: 3 });
    await this.page.waitForTimeout(300);

    // Verify we focused a real input
    const focused = await this.page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | null;
      return el?.tagName === 'INPUT' ? el.value : null;
    });
    if (focused === null) {
      console.log('[LimitPage] ⚠ Triple-click did not focus an input, trying locator approach');
      // Fallback: find the input that sits above the market label via locator
      const rateSection = marketLabel.locator('xpath=ancestor::div[5]');
      const inputs = rateSection.locator('input');
      const count = await inputs.count();
      for (let i = 0; i < count; i++) {
        const v = await inputs.nth(i).inputValue().catch(() => '');
        const n = parseFloat(v.replace(/,/g, ''));
        if (!isNaN(n) && n > 50) {
          await inputs.nth(i).click({ clickCount: 3 });
          await this.page.waitForTimeout(300);
          break;
        }
      }
    }

    // Type the new value — select-all + type replaces existing content
    await this.page.keyboard.press('ControlOrMeta+a');
    await this.page.waitForTimeout(100);
    await this.page.keyboard.type(price, { delay: 50 });
    await this.page.keyboard.press('Enter');

    // Trigger React's synthetic onChange by dispatching input event if value didn't change
    await this.page.evaluate((val) => {
      const el = document.activeElement as HTMLInputElement | null;
      if (el && el.tagName === 'INPUT' && el.value !== val) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set;
        nativeInputValueSetter?.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, price);

    console.log(`[LimitPage] Entered rate price: ${price} USDT`);
    await this.page.waitForTimeout(1_500);
  }

  /**
   * Return the current state of the main action button on the Limit page.
   * Detects whether the button is disabled and what text it shows.
   *
   * The bottom CTA button changes text depending on state:
   *   - "Enter an amount"         – no amount entered yet
   *   - "Place Limit Order"       – ready to submit
   *   - "Adjust price to continue" – rate price is out of acceptable range
   */
  async getActionButtonState(): Promise<{
    text: string;
    disabled: boolean;
  }> {
    // Wait for UI to settle
    await this.page.waitForTimeout(500);

    // The CTA is the last full-width button at the bottom of the form.
    // On Peach Limit page, it's the only button without a fixed width icon.
    // Use innerText which collapses whitespace and reads rendered text (unlike textContent).
    const allBtns = this.page.locator('button');
    const count = await allBtns.count().catch(() => 0);

    const ctaPattern = /Place Limit Order|Enter an amount|Adjust price|Connect Wallet|Wrap BNB/i;

    // Scan all buttons, prefer the one whose innerText matches known CTA phrases
    for (let i = 0; i < count; i++) {
      const btn = allBtns.nth(i);
      // Use evaluate to get innerText (renders text from shadow DOM and CSS)
      const t = await btn.evaluate((el) => (el as HTMLElement).innerText ?? '').catch(() => '');
      if (ctaPattern.test(t.trim())) {
        const disabled = !(await btn.isEnabled({ timeout: 1_000 }).catch(() => false));
        console.log(`[LimitPage] Action button [${i}] innerText: "${t.trim()}" | disabled=${disabled}`);
        return { text: t.trim(), disabled };
      }
    }

    // If no CTA match found, look specifically for a button whose innerText contains "Adjust"
    // — this handles cases where the disabled button text is only partially rendered
    const adjustBtn = this.page.getByRole('button', { name: /Adjust price/i }).first();
    const adjustVisible = await adjustBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    if (adjustVisible) {
      const t = await adjustBtn.evaluate((el) => (el as HTMLElement).innerText ?? '').catch(() => '');
      const disabled = !(await adjustBtn.isEnabled({ timeout: 1_000 }).catch(() => false));
      console.log(`[LimitPage] Action button (getByRole): "${t.trim()}" | disabled=${disabled}`);
      return { text: t.trim(), disabled };
    }

    // Last resort: look for ANY disabled button with text
    for (let i = 0; i < count; i++) {
      const btn = allBtns.nth(i);
      const isDisabled = !(await btn.isEnabled({ timeout: 500 }).catch(() => false));
      if (!isDisabled) continue;
      const t = await btn.evaluate((el) => (el as HTMLElement).innerText ?? '').catch(() => '');
      if (t.trim().length > 3) {
        console.log(`[LimitPage] Action button (disabled scan) [${i}]: "${t.trim()}" | disabled=true`);
        return { text: t.trim(), disabled: true };
      }
    }

    console.log('[LimitPage] Action button: not found');
    return { text: '', disabled: false };
  }

  // ── USD value helper ────────────────────────────────────────────────────────

  /**
   * Read the BNB wallet balance shown below the "You Pay" input (e.g. "0.0116936").
   * Returns null if not found.
   */
  async getWalletBnbBalance(): Promise<number | null> {
    try {
      // The balance is shown as a small number near the wallet icon below "You Pay"
      // e.g. "□ 0.0116936"
      const el = this.page
        .locator('text=/^[\\d]+\\.\\d+$/')
        .first();
      // More reliable: look for the balance text that is near "You Pay" section
      const paySection = this.page.locator('text=/You Pay/i').locator('xpath=ancestor::div[3]');
      const balanceEl = paySection.locator('text=/[0-9]+\\.[0-9]+/').last();
      const text = await balanceEl.textContent({ timeout: 3_000 }).catch(() => null);
      if (!text) {
        // Fallback: any text matching a small BNB-sized decimal near the top of the page
        const fallback = el.nth(0);
        const ft = await fallback.textContent({ timeout: 2_000 }).catch(() => null);
        if (!ft) return null;
        const num = parseFloat(ft.replace(/,/g, ''));
        return isNaN(num) ? null : num;
      }
      const m = text.match(/[\d,]+\.[\d]+/);
      if (!m) return null;
      const balance = parseFloat(m[0].replace(/,/g, ''));
      console.log(`[LimitPage] Wallet BNB balance: ${balance}`);
      return isNaN(balance) ? null : balance;
    } catch {
      return null;
    }
  }

  /**
   * Read the USD equivalent shown next to the pay input (e.g. "$6.30").
   * Returns null if not found.
   */
  async getPayUsdValue(): Promise<number | null> {
    try {
      const el = this.page.locator('text=/\\$\\d+\\.\\d+/').first();
      const text = await el.textContent({ timeout: 3_000 }).catch(() => null);
      if (!text) return null;
      const m = text.match(/\$([\d.]+)/);
      return m ? parseFloat(m[1]) : null;
    } catch {
      return null;
    }
  }
}
