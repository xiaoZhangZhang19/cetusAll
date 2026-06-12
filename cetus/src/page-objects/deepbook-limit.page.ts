import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { env } from '@/config/env.js';
import { getReferencePriceFromAggregator } from '@/protocol/quotes.js';
import { DeepbookSpotPage } from './deepbook-spot.page.js';

/**
 * Page object for the DeepBook Limit order trading page.
 * URL: /deepbook/<pool_id>
 *
 * Buy flow:  Spot → Limit → Buy  → fill Price (USDC) → fill Amount (SUI) → Place Buy Order  → wallet approve
 * Sell flow: Spot → Limit → Sell → fill Price (USDC) → fill Amount (SUI) → Place Sell Order → wallet approve
 *
 * After both orders are placed, switch to the "Open Orders" tab at the bottom
 * to verify the orders are listed.
 */
export class DeepbookLimitPage extends DeepbookSpotPage {
  constructor(page: Page) {
    super(page);
  }

  // ─── Tab setup ────────────────────────────────────────────────────────────────

  /**
   * Clicks the "Limit" sub-tab to switch from Market to Limit mode.
   * The "Market / Limit" tabs in the DeepBook UI are plain text elements
   * (not necessarily button or div[role="tab"]), so we try multiple strategies.
   */
  async clickLimitTab() {
    const strategies = [
      // Common: button or role="tab"
      this.page
        .locator('button, [role="button"], div[role="tab"], a[role="tab"]')
        .filter({ hasText: /^limit$/i })
        .first(),
      // Fallback: any styled element (div, span, a) with exact text "Limit"
      this.page
        .locator('div, span, a')
        .filter({ hasText: /^limit$/i })
        .first(),
      // Last resort: getByText scans the entire DOM
      this.page.getByText(/^limit$/i).first(),
    ];

    for (const el of strategies) {
      if (await el.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await el.click();
        await this.page.waitForTimeout(500);
        console.log('[DeepbookLimit] Clicked "Limit" tab');
        return;
      }
    }

    throw new Error('[DeepbookLimit] Cannot find the "Limit" tab on this page');
  }

  /**
   * Ensures Spot / Limit / Buy is active.
   * Waits until the "Place Buy Order" button is visible.
   */
  async ensureSpotLimitBuy() {
    await this._ensureSpotTab();
    await this._ensureSide('buy');
    await this.clickLimitTab();
    await this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /place buy order/i })
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    console.log('[DeepbookLimit] Tabs configured: Spot / Limit / Buy');
  }

  /**
   * Ensures Spot / Limit / Sell is active.
   * Waits until the "Place Sell Order" button is visible.
   */
  async ensureSpotLimitSell() {
    await this._ensureSpotTab();
    await this._ensureSide('sell');
    // After switching side, click Limit tab again (some UIs reset back to Market)
    await this.clickLimitTab();
    await this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /place sell order/i })
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    console.log('[DeepbookLimit] Tabs configured: Spot / Limit / Sell');
  }

  // ─── Price input ──────────────────────────────────────────────────────────────

  /**
   * Fills the "Price" input field in Limit mode.
   * In the form, Price is the first input; Amount is the second.
   */
  async fillPrice(price: string) {
    const input = await this._getPriceInput();
    await expect(input).toBeVisible({ timeout: 8_000 });
    await input.click({ clickCount: 3 });
    await input.fill(price);
    await this.page.waitForTimeout(600);
    console.log(`[DeepbookLimit] Filled price: ${price} USDC`);
  }

  /**
   * Fills the "Amount" input field in Limit mode (SUI quantity).
   */
  async fillLimitAmount(amount: string) {
    const input = await this._getLimitAmountInput();
    await expect(input).toBeVisible({ timeout: 8_000 });
    await input.click({ clickCount: 3 });
    await input.fill(amount);
    await this.page.waitForTimeout(600);
    console.log(`[DeepbookLimit] Filled amount: ${amount} SUI`);
  }

  // ─── Order submission ─────────────────────────────────────────────────────────

  /**
   * Clicks "Place Buy Order" in Limit mode.
   */
  async placeLimitBuyOrder() {
    const btn = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /place buy order/i })
      .first();
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await expect(btn).toBeEnabled({ timeout: 15_000 });
    await btn.click();
    console.log('[DeepbookLimit] Clicked "Place Buy Order"');
  }

  /**
   * Clicks "Place Sell Order" in Limit mode.
   */
  async placeLimitSellOrder() {
    const btn = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /place sell order/i })
      .first();
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await expect(btn).toBeEnabled({ timeout: 15_000 });
    await btn.click();
    console.log('[DeepbookLimit] Clicked "Place Sell Order"');
  }

  // ─── Balance reading ──────────────────────────────────────────────────────────

  /**
   * Reads the "Available: X <unit>" value shown in the limit order form.
   * Returns the numeric value (e.g. 0.706148 for USDC, or 5.46 for SUI).
   * Returns null if not found.
   */
  async readAvailableBalance(unit: 'USDC' | 'SUI'): Promise<number | null> {
    try {
      // Find the row that shows "Available" and extract the number before the unit
      const allText = await this.page
        .locator('#root, body')
        .first()
        .innerText({ timeout: 5_000 })
        .catch(() => '');

      const re = new RegExp(`Available[\\s\\S]{0,40}?([\\d,]+\\.\\d+)\\s*${unit}`, 'i');
      const match = allText.match(re);
      if (match) {
        const value = parseFloat(match[1].replace(/,/g, ''));
        console.log(`[DeepbookLimit] Available ${unit}: ${value}`);
        return value;
      }

      // Fallback: find the locator with "Available" label and read the sibling text
      const row = this.page.locator('div, p, span').filter({ hasText: /^available$/i }).first();
      const parent = row.locator('xpath=ancestor::div[1]');
      const text = await parent.innerText({ timeout: 3_000 }).catch(() => '');
      const re2 = new RegExp(`([\\d,]+\\.\\d+)\\s*${unit}`, 'i');
      const m2 = text.match(re2);
      if (m2) return parseFloat(m2[1].replace(/,/g, ''));

      return null;
    } catch {
      return null;
    }
  }

  // ─── Dialog management ────────────────────────────────────────────────────────

  /**
   * Closes the "Transaction Completed" / success Chakra modal if it is visible.
   * Must be called after `expectSuccess()` before interacting with the trading form again.
   */
  async dismissTransactionDialogIfPresent() {
    const dialog = this.page
      .locator('[role="dialog"], .chakra-modal__content')
      .filter({ hasText: /transaction completed|order placed|order created|creating order/i })
      .last();

    if (!(await dialog.isVisible({ timeout: 3_000 }).catch(() => false))) {
      return;
    }

    // Try the × close button (exclude explorer-link buttons)
    const closeBtn = dialog
      .locator('button, [role="button"]')
      .filter({ hasNotText: /view on explorer|view in explorer|suivision|suiscan/i })
      .last();

    if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await closeBtn.click({ force: true }).catch(() => undefined);
    }

    // Fallback: press Escape
    if (await dialog.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await this.page.keyboard.press('Escape').catch(() => undefined);
    }

    // Fallback: click outside the dialog (top-left corner)
    if (await dialog.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await this.page.mouse.click(40, 40);
    }

    await dialog.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined);
    // Wait for the Chakra modal fade-out animation to fully complete before
    // interacting with the trading form again (avoids overlay intercept issues).
    await this.page.waitForTimeout(1_000);
    console.log('[DeepbookLimit] Transaction dialog dismissed');
  }

  // ─── Open Orders table parsing ────────────────────────────────────────────────

  /**
   * Reads every row in the Open Orders table and returns structured data.
   *
   * Columns (0-indexed): Market | Instrument | Side | Price | Filled% | Filled/Quantity | Cancel
   *
   * For each row we extract:
   *   side            – 'Buy' | 'Sell'
   *   price           – the limit price in USDC (e.g. 0.82494)
   *   totalQuantity   – total order size in SUI
   *   filledQuantity  – already-filled amount
   *   lockedQuantity  – totalQuantity − filledQuantity  (still locked in DeepBook)
   */
  async readOpenOrderRows(): Promise<
    Array<{
      side: 'Buy' | 'Sell';
      price: number;
      totalQuantity: number;
      filledQuantity: number;
      lockedQuantity: number;
    }>
  > {
    const rows = this.page.locator('table tbody tr');
    const count = await rows.count();
    const result: Array<{
      side: 'Buy' | 'Sell';
      price: number;
      totalQuantity: number;
      filledQuantity: number;
      lockedQuantity: number;
    }> = [];

    for (let i = 0; i < count; i++) {
      const text = await rows.nth(i).innerText().catch(() => '');
      if (!text.trim()) continue;

      // Side
      const sideM = text.match(/\b(Buy|Sell)\b/i);
      if (!sideM) continue;
      const side = (sideM[1][0].toUpperCase() + sideM[1].slice(1).toLowerCase()) as 'Buy' | 'Sell';

      // Price – first decimal number before "USDC"
      const priceM = text.match(/([\d,]+\.\d+)\s*USDC/i);
      if (!priceM) continue;
      const price = parseFloat(priceM[1].replace(/,/g, ''));

      // Filled/Quantity – last "X / Y" or "X | Y" pattern in the row
      const pairs = [...text.matchAll(/(\d+(?:\.\d+)?)\s*[/|]\s*(\d+(?:\.\d+)?)/g)];
      const last = pairs.at(-1);
      const filledQuantity = last ? parseFloat(last[1]) : 0;
      const totalQuantity = last ? parseFloat(last[2]) : 1;

      result.push({ side, price, totalQuantity, filledQuantity, lockedQuantity: totalQuantity - filledQuantity });
    }

    console.log(`[DeepbookLimit] readOpenOrderRows → ${result.length} row(s):`, JSON.stringify(result));
    return result;
  }

  // ─── Account Portfolio – DeepBook Balance hover / wallet balance ───────────

  /**
   * Locates the "DeepBook Balance" row for the given token (SUI or USDC) in the
   * Account Portfolio panel, hovers over the info [?] icon (or the label itself),
   * and extracts the locked amount from the resulting tooltip.
   *
   * Identification strategy:
   *   1. Enumerate all "DeepBook Balance" labels.
   *   2. For each label, walk up ancestor divs 1→5 levels to find the tightest
   *      container that contains ONLY the target token name (SUI or USDC) and not
   *      the other — this is the token-specific block.
   *   3. Fallback: compare screen Y-positions — the DeepBook Balance label that
   *      sits below the target token's header (and above the next token's header)
   *      is the correct one.
   *
   * Falls back to reading the displayed value when no tooltip appears.
   * Returns null when the field cannot be found or parsed.
   */
  async hoverDeepbookBalanceAndGetLockedAmount(token: 'SUI' | 'USDC'): Promise<number | null> {
    const dbLabels = this.page.locator('div, span, p').filter({ hasText: /^deepbook balance$/i });
    const count = await dbLabels.count();
    if (count === 0) return null;

    // ── Strategy 1: find tightest ancestor that contains only the target token ──
    for (let i = 0; i < count; i++) {
      const label = dbLabels.nth(i);

      for (let levels = 1; levels <= 5; levels++) {
        const ancestor = label.locator(`xpath=ancestor::div[${levels}]`).first();
        const text = await ancestor.innerText({ timeout: 1_500 }).catch(() => '');

        const hasSUI  = /(?<!\w)SUI(?!\w)/.test(text);
        const hasUSDC = /USDC/i.test(text);

        if (token === 'SUI'  && hasSUI  && !hasUSDC) {
          return await this._hoverLabelAndReadValue(label, token, text);
        }
        if (token === 'USDC' && hasUSDC && !hasSUI) {
          return await this._hoverLabelAndReadValue(label, token, text);
        }
        // If both present, container is still too large — go up one more level
      }
    }

    // ── Strategy 2: Y-position — the label immediately below the token header ──
    // Collect all token headers (elements whose entire text is "SUI" or "USDC")
    const tokenHeaders = this.page
      .locator('div, span')
      .filter({ hasText: token === 'SUI' ? /^SUI$/ : /^USDC$/ });

    const headerCount = await tokenHeaders.count();
    let tokenHeaderY: number | null = null;
    let nextTokenHeaderY = Infinity;

    for (let j = 0; j < headerCount; j++) {
      const box = await tokenHeaders.nth(j).boundingBox().catch(() => null);
      if (box) {
        if (tokenHeaderY === null || box.y < tokenHeaderY) tokenHeaderY = box.y;
      }
    }

    // Also find the next token's header Y to bound the search
    const otherToken = token === 'SUI' ? 'USDC' : 'SUI';
    const otherHeaders = this.page
      .locator('div, span')
      .filter({ hasText: otherToken === 'SUI' ? /^SUI$/ : /^USDC$/ });
    const otherCount = await otherHeaders.count();
    for (let j = 0; j < otherCount; j++) {
      const box = await otherHeaders.nth(j).boundingBox().catch(() => null);
      if (box && tokenHeaderY !== null && box.y > tokenHeaderY) {
        if (box.y < nextTokenHeaderY) nextTokenHeaderY = box.y;
      }
    }

    if (tokenHeaderY !== null) {
      let bestIdx = -1;
      let bestY = Infinity;

      for (let i = 0; i < count; i++) {
        const box = await dbLabels.nth(i).boundingBox().catch(() => null);
        if (!box) continue;
        // Label must be below the token header and above the next token's header
        if (box.y > tokenHeaderY && box.y < nextTokenHeaderY && box.y < bestY) {
          bestY = box.y;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        const label = dbLabels.nth(bestIdx);
        const containerText = await label
          .locator('xpath=ancestor::div[3]')
          .first()
          .innerText({ timeout: 2_000 })
          .catch(() => '');
        return await this._hoverLabelAndReadValue(label, token, containerText);
      }
    }

    console.warn(`[DeepbookLimit] hoverDeepbookBalanceAndGetLockedAmount: no "${token}" row found`);
    return null;
  }

  /**
   * Shared helper: hovers the [?] icon (or label) in a DeepBook Balance row,
   * reads the tooltip text, and parses the numeric locked amount.
   * Falls back to reading the value from the container text.
   */
  private async _hoverLabelAndReadValue(
    label: ReturnType<ReturnType<typeof this.page.locator>['nth']>,
    token: string,
    containerText: string
  ): Promise<number | null> {
    // Try hovering the info icon in the same row
    const rowDiv = label.locator('xpath=ancestor::div[1]').first();
    const infoIcon = rowDiv.locator('svg, [class*="info"], [aria-label*="info"]').first();

    if (await infoIcon.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await infoIcon.hover({ force: true });
    } else {
      await label.hover({ force: true });
    }
    await this.page.waitForTimeout(700);

    // Read tooltip
    const tooltip = this.page
      .locator('[role="tooltip"], .chakra-tooltip__label, [data-popper-content], [class*="tooltip"]')
      .last();

    if (await tooltip.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const tipText = await tooltip.innerText().catch(() => '');
      console.log(`[DeepbookLimit] ${token} DeepBook Balance tooltip: "${tipText}"`);
      const numM = tipText.match(/([\d,]+(?:\.\d+)?)/);
      if (numM) return parseFloat(numM[1].replace(/,/g, ''));
    }

    // Fallback: parse value from container text
    const re = /deepbook\s*balance\s*[\r\n\t ]*([\d,]+(?:\.\d+)?)/i;
    const m = containerText.match(re);
    if (m) {
      const value = parseFloat(m[1].replace(/,/g, ''));
      console.log(`[DeepbookLimit] ${token} DeepBook Balance (direct read): ${value}`);
      return value;
    }

    return null;
  }

  /**
   * Reads the "Wallet Balance" value for the given token from the Account
   * Portfolio section.
   *
   * Uses the same multi-level ancestor strategy as
   * `hoverDeepbookBalanceAndGetLockedAmount`: walks up ancestor divs 1→5
   * until finding a container that uniquely belongs to the target token.
   * Falls back to Y-position comparison when no unique container is found.
   *
   * Returns null if the value cannot be determined.
   */
  async readWalletBalance(token: 'SUI' | 'USDC'): Promise<number | null> {
    try {
      const wbLabels = this.page
        .locator('div, span, p')
        .filter({ hasText: /^wallet balance$/i });
      const count = await wbLabels.count();
      if (count === 0) return null;

      // ── Strategy 1: tightest ancestor containing only the target token ──────
      for (let i = 0; i < count; i++) {
        const label = wbLabels.nth(i);

        for (let levels = 1; levels <= 5; levels++) {
          const ancestor = label.locator(`xpath=ancestor::div[${levels}]`).first();
          const text = await ancestor.innerText({ timeout: 1_500 }).catch(() => '');

          const hasSUI  = /(?<!\w)SUI(?!\w)/.test(text);
          const hasUSDC = /USDC/i.test(text);

          if (token === 'SUI'  && hasSUI  && !hasUSDC) {
            const re = /wallet\s*balance\s*[\r\n\t ]*([\d,]+(?:\.\d+)?)/i;
            const m = text.match(re);
            if (m) {
              const value = parseFloat(m[1].replace(/,/g, ''));
              console.log(`[DeepbookLimit] ${token} Wallet Balance (DOM lv${levels}): ${value}`);
              return value;
            }
            break;
          }
          if (token === 'USDC' && hasUSDC && !hasSUI) {
            const re = /wallet\s*balance\s*[\r\n\t ]*([\d,]+(?:\.\d+)?)/i;
            const m = text.match(re);
            if (m) {
              const value = parseFloat(m[1].replace(/,/g, ''));
              console.log(`[DeepbookLimit] ${token} Wallet Balance (DOM lv${levels}): ${value}`);
              return value;
            }
            break;
          }
        }
      }

      // ── Strategy 2: Y-position (same as hover method) ────────────────────
      const tokenHeaders = this.page
        .locator('div, span')
        .filter({ hasText: token === 'SUI' ? /^SUI$/ : /^USDC$/ });
      const headerCount = await tokenHeaders.count();
      let tokenHeaderY: number | null = null;
      let nextTokenHeaderY = Infinity;

      for (let j = 0; j < headerCount; j++) {
        const box = await tokenHeaders.nth(j).boundingBox().catch(() => null);
        if (box && (tokenHeaderY === null || box.y < tokenHeaderY)) tokenHeaderY = box.y;
      }

      const otherToken = token === 'SUI' ? 'USDC' : 'SUI';
      const otherHeaders = this.page
        .locator('div, span')
        .filter({ hasText: otherToken === 'SUI' ? /^SUI$/ : /^USDC$/ });
      const otherCount = await otherHeaders.count();
      for (let j = 0; j < otherCount; j++) {
        const box = await otherHeaders.nth(j).boundingBox().catch(() => null);
        if (box && tokenHeaderY !== null && box.y > tokenHeaderY && box.y < nextTokenHeaderY)
          nextTokenHeaderY = box.y;
      }

      if (tokenHeaderY !== null) {
        let bestIdx = -1;
        let bestY = Infinity;
        for (let i = 0; i < count; i++) {
          const box = await wbLabels.nth(i).boundingBox().catch(() => null);
          if (box && box.y > tokenHeaderY && box.y < nextTokenHeaderY && box.y < bestY) {
            bestY = box.y;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0) {
          const label = wbLabels.nth(bestIdx);
          const text = await label
            .locator('xpath=ancestor::div[3]')
            .first()
            .innerText({ timeout: 2_000 })
            .catch(() => '');
          const re = /wallet\s*balance\s*[\r\n\t ]*([\d,]+(?:\.\d+)?)/i;
          const m = text.match(re);
          if (m) {
            const value = parseFloat(m[1].replace(/,/g, ''));
            console.log(`[DeepbookLimit] ${token} Wallet Balance (Y-pos): ${value}`);
            return value;
          }
        }
      }

      console.warn(`[DeepbookLimit] readWalletBalance: cannot find ${token} Wallet Balance`);
      return null;
    } catch (err) {
      console.warn(`[DeepbookLimit] readWalletBalance(${token}) error:`, err);
      return null;
    }
  }

  // ─── Account Portfolio token hover popup (Locked / Free Balance) ─────────────

  /**
   * Hovers over the DeepBook Balance VALUE (the dotted-underlined number)
   * in the Account Portfolio panel and reads the "Locked" / "Free Balance" popup.
   *
   * Popup structure (when hovering the DeepBook Balance number):
   *   Locked
   *     SUI    1 ($0.9601)
   *   Free Balance
   *     SUI    0.0₁25 ($0.0₁24)
   *
   * Implementation:
   *   1. Find the "DeepBook Balance" label belonging to target token.
   *   2. In browser context, find the NEXT SIBLING (the number element).
   *   3. Return that element's center coordinates.
   *   4. Hover there with page.mouse.move().
   */
  async hoverTokenAndReadLockedFreeBalance(
    token: 'SUI' | 'USDC'
  ): Promise<{ locked: number; freeBalance: number } | null> {
    // ── Step 1: locate the correct "DeepBook Balance" label ──────────────────
    const dbLabels = this.page.locator('div, span, p').filter({ hasText: /^deepbook balance$/i });
    const count = await dbLabels.count();

    let targetLabel: ReturnType<ReturnType<typeof this.page.locator>['nth']> | null = null;

    for (let i = 0; i < count; i++) {
      const label = dbLabels.nth(i);
      for (let levels = 1; levels <= 5; levels++) {
        const ancestor = label.locator(`xpath=ancestor::div[${levels}]`).first();
        const text = await ancestor.innerText({ timeout: 1_500 }).catch(() => '');
        const hasSUI  = /(?<!\w)SUI(?!\w)/.test(text);
        const hasUSDC = /USDC/i.test(text);

        if (token === 'SUI'  && hasSUI  && !hasUSDC) { targetLabel = label; break; }
        if (token === 'USDC' && hasUSDC && !hasSUI)  { targetLabel = label; break; }
      }
      if (targetLabel) break;
    }

    // Y-position fallback
    if (!targetLabel) {
      const tokenExact = this.page
        .locator('div, span')
        .filter({ hasText: token === 'SUI' ? /^SUI$/ : /^USDC$/ });
      const nameCount = await tokenExact.count();
      let bestIdx = -1, bestDiff = Infinity;
      for (let i = 0; i < count; i++) {
        const dbBox = await dbLabels.nth(i).boundingBox().catch(() => null);
        if (!dbBox) continue;
        for (let j = 0; j < nameCount; j++) {
          const nBox = await tokenExact.nth(j).boundingBox().catch(() => null);
          if (!nBox) continue;
          const diff = dbBox.y - nBox.y;
          if (diff > 0 && diff < bestDiff) { bestDiff = diff; bestIdx = j; }
        }
      }
      if (bestIdx >= 0) targetLabel = dbLabels.nth(bestIdx) as any;
    }

    if (!targetLabel) {
      console.warn(`[DeepbookLimit] hoverTokenAndReadLockedFreeBalance: no "${token}" DB label found`);
      return null;
    }

    // ── Step 2: Find the DeepBook Balance NUMBER element (next sibling or parent's next sibling) ─
    // The layout is usually:
    //   <div class="row">
    //     <span>DeepBook Balance</span>
    //     <span class="number">1.23 ($1.23)</span> ← hover target
    //   </div>
    const hoverPos = await targetLabel.evaluate(
      (labelEl: Element) => {
        // Strategy 1: look at immediate next sibling
        let target: Element | null = labelEl.nextElementSibling;
        if (target) {
          const r = target.getBoundingClientRect();
          if (r.width > 20 && r.height > 10) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, found: true };
          }
        }

        // Strategy 2: walk up parent and look for the sibling after the parent
        let parent = labelEl.parentElement;
        for (let i = 0; i < 3 && parent; i++) {
          target = parent.nextElementSibling;
          if (target) {
            const txt = (target as HTMLElement).innerText || '';
            // Check if it contains numbers/parentheses (balance format)
            if (/[\d\(\$]/.test(txt)) {
              const r = target.getBoundingClientRect();
              if (r.width > 20 && r.height > 10) {
                return { x: r.left + r.width / 2, y: r.top + r.height / 2, found: true };
              }
            }
          }
          parent = parent.parentElement;
        }

        // Strategy 3: look at all siblings of the label's parent row
        parent = labelEl.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          for (const sib of siblings) {
            if (sib === labelEl) continue;
            const txt = (sib as HTMLElement).innerText || '';
            if (/[\d\.\$\(\)]/.test(txt) && txt.length < 30) {
              const r = sib.getBoundingClientRect();
              if (r.width > 20 && r.height > 10) {
                return { x: r.left + r.width / 2, y: r.top + r.height / 2, found: true };
              }
            }
          }
        }

        // Fallback: hover to the right of the label
        const r = labelEl.getBoundingClientRect();
        return { x: r.right + 80, y: r.top + r.height / 2, found: false };
      }
    ) as { x: number; y: number; found: boolean };

    if (!hoverPos.found) {
      console.warn(
        `[DeepbookLimit] hoverTokenAndReadLockedFreeBalance: ` +
        `"${token}" value element not found — using fallback (${hoverPos.x.toFixed(0)}, ${hoverPos.y.toFixed(0)})`
      );
    } else {
      console.log(
        `[DeepbookLimit] "${token}" DeepBook Balance value coords: (${hoverPos.x.toFixed(0)}, ${hoverPos.y.toFixed(0)})`
      );
    }

    // ── Step 3: move mouse to the token header ────────────────────────────────
    await this.page.mouse.move(hoverPos.x, hoverPos.y);
    await this.page.waitForTimeout(1500); // 增加等待时间让弹窗完全显示

    // Debug screenshot AFTER hover to see the popup
    const screenshotPath = `quality-artifacts/debug-hover-${token}-after-${Date.now()}.png`;
    await this.page.screenshot({ path: screenshotPath }).catch(() => undefined);
    console.log(`[DeepbookLimit] "${token}" hover screenshot: ${screenshotPath}`);

    // ── Step 4: read the popup ────────────────────────────────────────────────
    const popupSelectors = [
      '[role="tooltip"]',
      '[data-popper-placement]',
      '.chakra-popover__content',
      '[class*="popover"]',
      '[class*="tooltip"]',
      'div:has-text("Locked")', // 直接找包含 "Locked" 文本的 div
      'div:has-text("Free Balance")', // 直接找包含 "Free Balance" 文本的 div
    ];

    // 先尝试用 evaluate 直接在页面找所有新出现的包含 "Locked" 的元素
    const visibleTexts = await this.page.evaluate(() => {
      const allDivs = Array.from(document.querySelectorAll('div, [role="tooltip"]'));
      return allDivs
        .filter(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        })
        .map(el => {
          const text = (el as HTMLElement).innerText || '';
          if (text.includes('Locked') || text.includes('Free Balance')) {
            return {
              text: text.slice(0, 200),
              className: el.className,
              role: el.getAttribute('role'),
            };
          }
          return null;
        })
        .filter(x => x !== null);
    });
    
    console.log(`[DeepbookLimit] "${token}" found ${visibleTexts.length} elements with "Locked" or "Free Balance":`);
    visibleTexts.forEach((info, i) => {
      console.log(`  [${i}] class="${info!.className}" role="${info!.role}" text="${info!.text.replace(/\n/g, ' | ')}"`);
    });

    for (const sel of popupSelectors) {
      const popup = this.page.locator(sel).last();
      const isVis = await popup.isVisible({ timeout: 1_000 }).catch(() => false);
      console.log(`[DeepbookLimit] "${token}" popup selector "${sel}" → visible=${isVis}`);
      
      if (!isVis) continue;

      const popupText = await popup.innerText({ timeout: 2_000 }).catch(() => '');
      console.log(
        `[DeepbookLimit] "${token}" popup (${sel}): "${popupText.replace(/\n/g, ' | ').slice(0, 150)}"`
      );

      const result = this._parseLockedFreeBalance(popupText, token);
      if (result) return result;
    }

    console.warn(
      `[DeepbookLimit] hoverTokenAndReadLockedFreeBalance: popup not readable for "${token}"`
    );
    return null;
  }

  /**
   * Parses "Locked … <amount> … Free Balance … <amount>" from text.
   * Returns null if parsing fails.
   */
  private _parseLockedFreeBalance(
    text: string,
    token: string
  ): { locked: number; freeBalance: number } | null {
    // The popup text looks like:
    //   "Locked\nSUI\n0 ($0)\nFree Balance\nSUI\n1.0002 ($0.9604)"
    // Extract the number that appears after "Locked" (before Free Balance),
    // and after "Free Balance".

    const lockedSection  = text.match(/locked([\s\S]*?)(?=free\s*balance|$)/i)?.[1] ?? '';
    const freeSection    = text.match(/free\s*balance([\s\S]*?)$/i)?.[1] ?? '';

    // Within each section find the first standalone decimal number
    const numRe = /([\d,]+(?:\.\d+)?)/;
    const lockedM = lockedSection.match(numRe);
    const freeM   = freeSection.match(numRe);

    if (!lockedM || !freeM) return null;

    const locked      = parseFloat(lockedM[1].replace(/,/g, ''));
    const freeBalance = parseFloat(freeM[1].replace(/,/g, ''));

    if (!Number.isFinite(locked) || !Number.isFinite(freeBalance)) return null;

    console.log(`[DeepbookLimit] ${token} locked=${locked} freeBalance=${freeBalance}`);
    return { locked, freeBalance };
  }

  // ─── Cancel All ───────────────────────────────────────────────────────────────

  /**
   * Clicks the "Cancel All" button in the Open Orders section.
   * After clicking, the caller should call walletController.approveTransaction()
   * to confirm the transaction in the wallet popup.
   */
  async clickCancelAllOrders() {
    const candidates = [
      this.page.getByRole('button', { name: /cancel all/i }).first(),
      this.page.locator('button, [role="button"]').filter({ hasText: /cancel all/i }).first(),
      this.page.getByText(/cancel all/i).first(),
    ];

    for (const el of candidates) {
      if (await el.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await el.click();
        await this.page.waitForTimeout(500);
        console.log('[DeepbookLimit] Clicked "Cancel All" button');
        return;
      }
    }

    throw new Error('[DeepbookLimit] Cannot find "Cancel All" button in Open Orders section');
  }

  // ─── Portfolio balance ─────────────────────────────────────────────────────

  /**
   * Reads the "DeepBook Balance" value for the given token (SUI or USDC) from
   * the Account Portfolio section on the right side of the page.
   *
   * The section renders one block per token, each with two sub-rows:
   *   DeepBook Balance   X.XXX
   *   Wallet Balance     Y.YYY
   *
   * Strategy:
   *   1. Locate DOM elements labelled "DeepBook Balance" and find the one that
   *      lives inside the SUI (or USDC) token block.
   *   2. Fallback: scan the full page innerText, slice to the relevant token
   *      section, and extract the first number after "DeepBook Balance".
   *
   * Returns null if the value cannot be determined.
   */
  async readDeepbookBalance(token: 'SUI' | 'USDC'): Promise<number | null> {
    try {
      // ── Strategy 1: DOM walk ───────────────────────────────────────────────
      // Find every element whose text is exactly "DeepBook Balance", then walk
      // up 3 ancestor div levels to get the token-block container and verify
      // it belongs to the right token.
      const labelEls = this.page
        .locator('div, span, p')
        .filter({ hasText: /^deepbook balance$/i });

      const count = await labelEls.count();
      for (let i = 0; i < count; i++) {
        const el = labelEls.nth(i);
        const container = el.locator('xpath=ancestor::div[3]').first();
        const containerText = await container.innerText({ timeout: 2_000 }).catch(() => '');

        const hasToken =
          token === 'SUI'
            ? /(?<!\w)SUI(?!\w)/.test(containerText)
            : /USDC/i.test(containerText);

        // For SUI block, make sure we haven't drifted into the USDC block.
        if (!hasToken) continue;
        if (token === 'SUI' && /USDC/i.test(containerText.split(/(?<!\w)SUI(?!\w)/)[0] ?? ''))
          continue;

        // The sibling element right after the label usually holds the value.
        // Try reading the number from the container text.
        const numRe = /DeepBook\s*Balance\s*[\r\n\t ]*([\d,]+(?:\.\d+)?)/i;
        const m = containerText.match(numRe);
        if (m) {
          const value = parseFloat(m[1].replace(/,/g, ''));
          console.log(`[DeepbookLimit] ${token} DeepBook Balance (DOM): ${value}`);
          return value;
        }
      }

      // ── Strategy 2: full page innerText scan ──────────────────────────────
      const allText = await this.page
        .locator('#root, body')
        .first()
        .innerText({ timeout: 5_000 })
        .catch(() => '');

      // Determine which section to scan
      let slice: string;
      if (token === 'SUI') {
        const suiIdx = allText.search(/(?<!\w)SUI(?!\w)/);
        if (suiIdx < 0) return null;
        // Only up to the USDC section (or 500 chars)
        const usdcIdx = allText.indexOf('USDC', suiIdx);
        slice = usdcIdx > suiIdx
          ? allText.slice(suiIdx, usdcIdx)
          : allText.slice(suiIdx, suiIdx + 500);
      } else {
        const usdcIdx = allText.indexOf('USDC');
        if (usdcIdx < 0) return null;
        slice = allText.slice(usdcIdx, usdcIdx + 500);
      }

      const re = /DeepBook\s*Balance\s*[\r\n\t ]*([\d,]+(?:\.\d+)?)/i;
      const match = slice.match(re);
      if (match) {
        const value = parseFloat(match[1].replace(/,/g, ''));
        console.log(`[DeepbookLimit] ${token} DeepBook Balance (text-scan): ${value}`);
        return value;
      }

      console.warn(`[DeepbookLimit] Could not locate ${token} DeepBook Balance in Account Portfolio`);
      return null;
    } catch (err) {
      console.warn(`[DeepbookLimit] readDeepbookBalance(${token}) error:`, err);
      return null;
    }
  }

  // ─── Open Orders ──────────────────────────────────────────────────────────────

  /**
   * Clicks the "Open Orders" tab in the bottom panel.
   */
  async openOpenOrdersTab() {
    // Try to find and click the "Open Orders" tab at the bottom of the page.
    // Different versions of the UI may use button, tab, or div elements.
    const candidates = [
      this.page.getByRole('tab', { name: /open orders/i }).first(),
      this.page.locator('button, [role="button"], div[role="tab"]').filter({ hasText: /open orders/i }).first(),
      this.page.getByText(/open orders/i).first(),
    ];

    for (const el of candidates) {
      if (await el.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await el.click();
        await this.page.waitForTimeout(1_000);
        console.log('[DeepbookLimit] Clicked "Open Orders" tab');
        return;
      }
    }

    throw new Error('[DeepbookLimit] Cannot find "Open Orders" tab');
  }

  /**
   * Verifies that the Open Orders list contains a specific limit order.
   *
   * @param side        'Buy' or 'Sell'
   * @param priceStr    The price string that was filled into the form (e.g. "0.813008")
   * @param timeoutMs   How long to poll for the order to appear (chain/indexer lag)
   *
   * Matching strategy: look for a row that simultaneously contains:
   *   - a "Buy" or "Sell" badge with the expected side
   *   - a price value whose leading digits match the filled price
   *     (we compare the first 4 significant digits to tolerate minor display rounding)
   */
  async expectOrderInOpenOrders(
    side: 'Buy' | 'Sell',
    priceStr: string,
    timeoutMs = 30_000
  ) {
    // Build a loose price prefix to match (first 4 significant digits)
    // e.g. "0.813008" → prefix "0.813"  "1.219512" → prefix "1.219"
    const pricePrefix = priceStr.replace(/0+$/, '').slice(0, priceStr.indexOf('.') + 4);

    console.log(
      `[DeepbookLimit] Waiting for ${side} order at price ~${priceStr} (prefix: ${pricePrefix})…`
    );

    const deadline = Date.now() + timeoutMs;
    let found = false;

    while (Date.now() < deadline) {
      found = await this._hasOrderRow(side, pricePrefix);
      if (found) {
        console.log(`[DeepbookLimit] ✓ Found ${side} order at price ~${priceStr} in Open Orders`);
        return;
      }
      console.log(`[DeepbookLimit] ${side} order not yet visible, polling…`);
      await this.page.waitForTimeout(3_000);
    }

    throw new Error(
      `[DeepbookLimit] ${side} order at price ~${priceStr} not found in Open Orders after ${timeoutMs}ms`
    );
  }

  /**
   * Fetches the current SUI/USDC market price via the Cetus Aggregator SDK.
   *
   * Simulates a 1-SUI → USDC route through the aggregator (no UI interaction,
   * no form input required).  Uses `env.limitInputType` / `env.limitOutputType`
   * so the pool matches the one under test.
   *
   * SUI decimals: 9   USDC decimals: 6
   */
  async readSuiMarketPrice(): Promise<number> {
    const price = await getReferencePriceFromAggregator({
      fromCoinType:    env.limitInputType,   // 0x2::sui::SUI
      targetCoinType:  env.limitOutputType,  // USDC
      fromDecimals:    9,
      targetDecimals:  6,
      inputAmountUi:   '1',
    });
    console.log(`[DeepbookLimit] Market SUI price (SDK): ${price.toFixed(6)} USDC`);
    return price;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private async _ensureSpotTab() {
    const spotTab = this.page
      .locator('button, [role="button"], div[role="tab"]')
      .filter({ hasText: /^spot$/i })
      .first();
    if (await spotTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await spotTab.click().catch(() => undefined);
      await this.page.waitForTimeout(300);
    }
  }

  private async _ensureSide(side: 'buy' | 'sell') {
    const text = side === 'buy' ? 'Buy' : 'Sell';
    const exactRe = new RegExp(`^${text}$`, 'i');
    const confirmPattern = side === 'buy' ? /place buy order/i : /place sell order/i;

    // The trading form's Buy/Sell tabs are in the top-right panel (small Y coordinate).
    // The Open Orders table's Buy/Sell badges are near the bottom (large Y coordinate).
    // Pick the matching element with the smallest Y (highest on page) to reliably
    // target the trading form tab rather than any Open Orders badge.
    const allMatches = this.page
      .locator('button, p, span, [role="button"]')
      .filter({ hasText: exactRe });

    let bestIdx = -1;
    let minY = Infinity;
    const count = await allMatches.count();

    for (let i = 0; i < count; i++) {
      const box = await allMatches.nth(i).boundingBox().catch(() => null);
      if (box && box.y < minY) {
        minY = box.y;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      await allMatches.nth(bestIdx).click();
      await this.page.waitForTimeout(500);
      console.log(`[DeepbookLimit] Clicked ${text} side (topmost at y=${minY.toFixed(0)})`);

      // Verify the form actually switched (Market mode shows the correct submit button)
      const switched = await this.page
        .locator('button, [role="button"]')
        .filter({ hasText: confirmPattern })
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false);

      if (switched) return;

      // If not confirmed, the click likely landed on the wrong element (e.g. an Open
      // Orders badge). Try once more with the second-highest element.
      console.log(`[DeepbookLimit] ${text} mode not confirmed, retrying with next candidate`);
      let secondMinY = Infinity;
      let secondIdx = -1;
      for (let i = 0; i < count; i++) {
        if (i === bestIdx) continue;
        const box = await allMatches.nth(i).boundingBox().catch(() => null);
        if (box && box.y < secondMinY) {
          secondMinY = box.y;
          secondIdx = i;
        }
      }
      if (secondIdx >= 0) {
        await allMatches.nth(secondIdx).click();
        await this.page.waitForTimeout(500);
        console.log(`[DeepbookLimit] Clicked ${text} side (retry at y=${secondMinY.toFixed(0)})`);
        return;
      }
    }

    throw new Error(`[DeepbookLimit] Cannot find the ${text} tab on the page`);
  }

  private async _clickMarketTabInternal() {
    const marketTab = this.page
      .locator('button, [role="button"], div[role="tab"]')
      .filter({ hasText: /^market$/i })
      .first();
    if (await marketTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await marketTab.click().catch(() => undefined);
      await this.page.waitForTimeout(500);
    }
  }

  /**
   * Returns the "Price" input element in the limit order form.
   * Strategy: find the input associated with the "Price" label.
   */
  private async _getPriceInput() {
    // Strategy 1: find input nearest to a "Price" label
    const byPriceLabel = this.page
      .getByText(/^price$/i)
      .locator('xpath=ancestor::div[.//input][1]//input')
      .first();

    if (await byPriceLabel.isVisible({ timeout: 3_000 }).catch(() => false)) {
      return byPriceLabel;
    }

    // Strategy 2: the form panel in Limit/Buy mode has two inputs; Price is first
    const formPanel = this.page
      .locator('div')
      .filter({ has: this.page.getByRole('button', { name: /place buy order/i }) })
      .last();
    const firstInput = formPanel.locator('input').first();

    if (await firstInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      return firstInput;
    }

    // Strategy 3: same for Sell mode
    const formPanelSell = this.page
      .locator('div')
      .filter({ has: this.page.getByRole('button', { name: /place sell order/i }) })
      .last();
    return formPanelSell.locator('input').first();
  }

  /**
   * Returns the "Amount" input element in the limit order form.
   * Strategy: find the input associated with the "Amount" label,
   * or the second input in the form panel.
   */
  private async _getLimitAmountInput() {
    // Strategy 1: find input nearest to an "Amount" label
    const byAmountLabel = this.page
      .getByText(/^amount$/i)
      .locator('xpath=ancestor::div[.//input][1]//input')
      .first();

    if (await byAmountLabel.isVisible({ timeout: 3_000 }).catch(() => false)) {
      return byAmountLabel;
    }

    // Strategy 2: second input in the buy form panel
    const formPanel = this.page
      .locator('div')
      .filter({ has: this.page.getByRole('button', { name: /place buy order/i }) })
      .last();
    const secondInput = formPanel.locator('input').nth(1);

    if (await secondInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      return secondInput;
    }

    // Strategy 3: same for sell form panel
    const formPanelSell = this.page
      .locator('div')
      .filter({ has: this.page.getByRole('button', { name: /place sell order/i }) })
      .last();
    return formPanelSell.locator('input').nth(1);
  }

  /**
   * Returns true if the Open Orders table contains a row matching the given
   * side ('Buy' | 'Sell') and price prefix (first 4 significant digits).
   *
   * Looks at each <tr> in the orders table and checks whether its text
   * content includes both the side badge and the price prefix.
   */
  private async _hasOrderRow(side: 'Buy' | 'Sell', pricePrefix: string): Promise<boolean> {
    // Strategy 1: scan <tbody tr> rows
    const rows = this.page.locator('table tbody tr');
    const rowCount = await rows.count();

    for (let i = 0; i < rowCount; i++) {
      const text = await rows.nth(i).innerText().catch(() => '');
      const hasSide = new RegExp(`\\b${side}\\b`, 'i').test(text);
      const hasPrice = text.includes(pricePrefix);
      if (hasSide && hasPrice) return true;
    }

    // Strategy 2: rows identified by "Cancel" button — each Cancel belongs to one order row
    if (rowCount === 0) {
      const cancelBtns = this.page
        .locator('button, [role="button"]')
        .filter({ hasText: /^cancel$/i });
      const cancelCount = await cancelBtns.count();

      for (let i = 0; i < cancelCount; i++) {
        // Walk up to the row-level ancestor and read its text
        const rowAncestor = cancelBtns
          .nth(i)
          .locator('xpath=ancestor::tr[1] | ancestor::div[contains(@class,"row")][1]')
          .first();
        const text = await rowAncestor.innerText().catch(() => '');
        const hasSide = new RegExp(`\\b${side}\\b`, 'i').test(text);
        const hasPrice = text.includes(pricePrefix);
        if (hasSide && hasPrice) return true;
      }
    }

    return false;
  }
}
