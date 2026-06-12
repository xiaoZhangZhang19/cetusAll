import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Page object for the DeepBook Spot market trading page.
 * URL: /deepbook/<pool_id>
 *
 * Buy flow:  Spot → Market → Buy  → fill Amount (USDC) → Place Buy Order  → wallet approve
 * Sell flow: Spot → Market → Sell → fill Amount (SUI)  → Place Sell Order → wallet approve
 */
export class DeepbookSpotPage {
  constructor(readonly page: Page) {}

  async goto(path: string) {
    await this.page.goto(path, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
    await this.dismissTermsModalIfPresent();
  }

  // ─── Tab / button setup ───────────────────────────────────────────────────────

  /**
   * Ensures the "Spot" tab, "Market" sub-tab and "Buy" button are all active.
   */
  async ensureSpotMarketBuy() {
    await this._clickSpotTab();
    await this._clickSide('buy');
    await this._clickMarketTab();
    // Confirm we're in Buy mode: "Place Buy Order" button should appear
    await this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /place buy order/i })
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 });
    console.log('[DeepbookSpot] Tabs configured: Spot / Market / Buy');
  }

  /**
   * Ensures the "Spot" tab, "Market" sub-tab and "Sell" button are all active.
   */
  async ensureSpotMarketSell() {
    await this._clickSpotTab();
    await this._clickSide('sell');
    await this._clickMarketTab();
    // Confirm we're in Sell mode: "Place Sell Order" button should appear
    await this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /place sell order/i })
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 });
    console.log('[DeepbookSpot] Tabs configured: Spot / Market / Sell');
  }

  private async _clickSpotTab() {
    const spotTab = this.page
      .locator('button, [role="button"], div[role="tab"]')
      .filter({ hasText: /^spot$/i })
      .first();
    if (await spotTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await spotTab.click().catch(() => undefined);
      await this.page.waitForTimeout(300);
    }
  }

  private async _clickSide(side: 'buy' | 'sell') {
    const text = side === 'buy' ? 'Buy' : 'Sell';
    const exactRe = new RegExp(`^${text}$`, 'i');

    // Try multiple strategies: some UIs render Buy/Sell as <button>, some as styled <div>
    const candidates = [
      this.page.getByRole('button', { name: exactRe }).first(),
      this.page.locator('button, [role="button"]').filter({ hasText: exactRe }).first(),
      this.page.getByText(exactRe).first(),                        // any element with exact text
      this.page.locator('div, span').filter({ hasText: exactRe }).first(),
    ];

    for (const btn of candidates) {
      if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await btn.click();
        await this.page.waitForTimeout(400);
        console.log(`[DeepbookSpot] Clicked ${text} side`);
        return;
      }
    }

    throw new Error(`[DeepbookSpot] Cannot find the ${text} button`);
  }

  private async _clickMarketTab() {
    const marketTab = this.page
      .locator('button, [role="button"], div[role="tab"]')
      .filter({ hasText: /^market$/i })
      .first();
    if (await marketTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await marketTab.click().catch(() => undefined);
      await this.page.waitForTimeout(500);
    }
  }

  // ─── Price reading ────────────────────────────────────────────────────────────

  /**
   * Returns the current SUI price in USDC by entering "1" USDC and reading
   * the "Est. Buy" SUI amount, then computing price = 1 / est_buy.
   *
   * This avoids having to parse the DOM price display which can vary in structure.
   */
  async getCurrentSuiPriceViaEstBuy(): Promise<number> {
    await this.fillAmount('1');
    await this.page.waitForTimeout(800);

    const estSui = await this._readEstFloat(/est\.?\s*buy/i, /SUI/i);
    if (estSui <= 0) throw new Error('[DeepbookSpot] Est. Buy returned 0 for 1 USDC input');

    const suiPrice = 1 / estSui;
    console.log(`[DeepbookSpot] SUI price estimated via Est.Buy: 1 USDC → ${estSui} SUI → price ≈ ${suiPrice.toFixed(6)} USDC/SUI`);
    return suiPrice;
  }

  // ─── Amount input ─────────────────────────────────────────────────────────────

  /**
   * Fills the Amount input field and waits for the Est. value to update.
   * For Buy mode the unit is USDC; for Sell mode the unit is SUI.
   */
  async fillAmount(amount: string, unit = 'USDC') {
    const input = this._getAmountInput();
    await expect(input).toBeVisible({ timeout: 8_000 });
    await input.click({ clickCount: 3 }); // select all
    await input.fill(amount);
    await this.page.waitForTimeout(800); // allow Est. value to recalculate
    console.log(`[DeepbookSpot] Filled amount: ${amount} ${unit}`);
  }

  // ─── Est. Buy / Est. Receive reading ─────────────────────────────────────────

  /**
   * Reads the "Est. Buy" value (buy mode) and returns it as a raw bigint.
   * Unit: SUI (9 decimals).
   */
  async readEstBuyRaw(suiDecimals = 9): Promise<bigint> {
    const value = await this._readEstFloat(/est\.?\s*buy/i, /SUI/i);
    const raw = BigInt(Math.round(value * 10 ** suiDecimals));
    console.log(`[DeepbookSpot] Est. Buy: ${value} SUI (raw: ${raw})`);
    return raw;
  }

  /**
   * Reads the "Est. Receive" value (sell mode) and returns it as a raw bigint.
   * Unit: USDC (6 decimals).
   */
  async readEstReceiveRaw(usdcDecimals = 6): Promise<bigint> {
    const value = await this._readEstFloat(/est\.?\s*receive/i, /USDC/i);
    const raw = BigInt(Math.round(value * 10 ** usdcDecimals));
    console.log(`[DeepbookSpot] Est. Receive: ${value} USDC (raw: ${raw})`);
    return raw;
  }

  // ─── Order submission ─────────────────────────────────────────────────────────

  /**
   * Clicks "Place Buy Order".
   */
  async placeBuyOrder() {
    const btn = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /place buy order/i })
      .first();
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await expect(btn).toBeEnabled({ timeout: 15_000 });
    await btn.click();
    console.log('[DeepbookSpot] Clicked "Place Buy Order"');
  }

  /**
   * Clicks "Place Sell Order".
   */
  async placeSellOrder() {
    const btn = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /place sell order/i })
      .first();
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await expect(btn).toBeEnabled({ timeout: 15_000 });
    await btn.click();
    console.log('[DeepbookSpot] Clicked "Place Sell Order"');
  }

  /**
   * Waits for a success/completion message after the order is approved.
   */
  async expectSuccess() {
    const successEl = this.page
      .getByText(/success|completed|order filled|order placed|transaction.*success/i)
      .first();
    await expect(successEl).toBeVisible({ timeout: 90_000 });
    console.log('[DeepbookSpot] ✓ Order success message visible');
  }

  /**
   * Attempts to read a transaction digest from the success notification.
   * Returns null if not found (balance-change fallback will be used).
   */
  async readDigest(): Promise<string | null> {
    const digestPattern = /[1-9A-HJ-NP-Za-km-z]{40,90}/;
    const links = this.page.getByRole('link', { name: /explorer|view|suiscan|suivision/i });
    const count = await links.count();
    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute('href').catch(() => null);
      if (href) {
        const match = href.match(digestPattern);
        if (match) return match[0];
      }
    }
    return null;
  }

  // ─── Terms modal ──────────────────────────────────────────────────────────────

  async dismissTermsModalIfPresent() {
    const agreeBtn = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /agree|accept|confirm|got it|i understand/i })
      .first();
    if (await agreeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await agreeBtn.click().catch(() => undefined);
      await this.page.waitForTimeout(300);
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private _getAmountInput() {
    // The form panel always contains either "Place Buy Order" or "Place Sell Order".
    // Find the panel by whichever submit button is currently visible, then get its input.
    const panelByBuy = this.page
      .locator('div')
      .filter({ has: this.page.getByRole('button', { name: /place buy order/i }) })
      .last();
    const panelBySell = this.page
      .locator('div')
      .filter({ has: this.page.getByRole('button', { name: /place sell order/i }) })
      .last();

    // Strategy 2: walk up from the "Amount" label text
    const inputByLabel = this.page
      .getByText(/^amount$/i)
      .locator('xpath=ancestor::div[.//input][1]//input')
      .first();

    return panelByBuy.locator('input').first()
      .or(panelBySell.locator('input').first())
      .or(inputByLabel);
  }

  /**
   * Generic helper to read an "Est. XXX" value from the trading form.
   *
   * @param labelPattern  Regex matching the label  (e.g. /est\.?\s*buy/i)
   * @param unitPattern   Regex matching the unit   (e.g. /SUI/i or /USDC/i)
   */
  private async _readEstFloat(labelPattern: RegExp, unitPattern: RegExp): Promise<number> {
    // Strategy 1: find the row element that contains the label and read its text
    const estRow = this.page
      .locator('div, p, span')
      .filter({ hasText: labelPattern })
      .first();

    const rowText = await estRow.innerText({ timeout: 5_000 }).catch(() => null);
    if (rowText) {
      const match = rowText.match(/([\d,]+\.[\d]+)\s*(?=\w)/);
      if (match) return parseFloat(match[1].replace(/,/g, ''));
    }

    // Strategy 2: scan the entire page text near the label
    const allText = await this.page.locator('#root, body').first().innerText({ timeout: 3_000 }).catch(() => '');
    const labelIdx = allText.search(labelPattern);
    if (labelIdx >= 0) {
      const slice = allText.slice(labelIdx, labelIdx + 120);
      const unitStr = unitPattern.source.replace(/[/i]/g, '');
      const re = new RegExp(`([\\d,]+\\.[\\d]+)\\s*${unitStr}`, 'i');
      const match = slice.match(re);
      if (match) return parseFloat(match[1].replace(/,/g, ''));

      // Fallback: grab first decimal number in the slice
      const fallback = slice.match(/([\d,]+\.[\d]+)/);
      if (fallback) return parseFloat(fallback[1].replace(/,/g, ''));
    }

    throw new Error(`[DeepbookSpot] Cannot read ${labelPattern} value from page`);
  }
}
