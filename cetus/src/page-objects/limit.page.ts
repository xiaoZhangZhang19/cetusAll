import { expect } from '@playwright/test';

import { SwapPage } from './swap.page.js';

export class LimitPage extends SwapPage {
  /** widget 头部标签，订单图标坐标扫描失败时用于兜底定位。 */
  private static readonly WIDGET_LABEL = /^Limit$/i;

  async goto() {
    await this.page.goto('/limit', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
    await this.dismissTermsModalIfPresent();
    await expect(this.inputAmount).toBeVisible();
  }

  async submitLimitOrder() {
    await this.dismissTermsModalIfPresent();
    const placeOrderButton = this.getPlaceLimitOrderButton();
    if (!(await placeOrderButton.isVisible({ timeout: 3_000 }).catch(() => false))) {
      const insufficientButton = this.page
        .locator('button, [role="button"]')
        .filter({ hasText: /insufficient .* balance/i })
        .first();
      if (await insufficientButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const halfButton = this.page.getByRole('button', { name: /^half$/i }).first();
        if (await halfButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await halfButton.click();
        }
      }
    }
    await expect(placeOrderButton).toBeVisible({ timeout: 20_000 });
    await expect(placeOrderButton).toBeEnabled({ timeout: 20_000 });
    await placeOrderButton.click();

    const reviewDialog = this.page
      .locator('[role="dialog"], .chakra-modal__content')
      .filter({ hasText: /review your order/i })
      .last();
    const reviewButton = reviewDialog
      .locator('button, [role="button"]')
      .filter({ hasText: /^place order$/i })
      .first();
    const hasReviewStep = await reviewButton.isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasReviewStep) {
      await expect(reviewButton).toBeEnabled({ timeout: 10_000 });
      await reviewButton.click();
    }
  }

  async expectOrderSubmitted() {
    const successText = this.page
      .getByText(/success|completed|submitted|order placed|order created|view in explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
  }

  /**
   * Returns true when at least one open order row is visible in the orders panel.
   * Call this after openOrdersPanel() has resolved.
   */
  async expectOpenOrderCreated() {
    const cancelButton = this.page.getByRole('button', { name: /^cancel$/i }).last();
    await expect(cancelButton).toBeVisible({ timeout: 20_000 });
  }

  /**
   * Reads the expiry date/time of the first open order row in the orders panel.
   * Returns a compact string such as "2026-06-01 06:55:55 (UTC)".
   * Throws if no expiry value can be located.
   */
  async readFirstOpenOrderExpiry(): Promise<string> {
    // Strategy 1: find the "Expiry" label, then get the immediately-following
    // sibling element (the value cell) via DOM evaluation — avoids matching
    // the label's own broad ancestor container.
    const expiryLabel = this.page
      .locator('th, td, span, div')
      .filter({ hasText: /^expiry$|^expiration$/i })
      .first();

    if (await expiryLabel.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const siblingText = await expiryLabel
        .evaluate((el) => {
          // Try direct next sibling
          const next = el.nextElementSibling;
          if (next?.textContent?.trim()) return next.textContent.trim();
          // Try parent's next sibling (label + value in adjacent divs)
          const parentNext = el.parentElement?.nextElementSibling;
          if (parentNext?.textContent?.trim()) return parentNext.textContent.trim();
          return '';
        })
        .catch(() => '');

      if (siblingText && siblingText.length > 2 && !/^expir/i.test(siblingText)) {
        return siblingText;
      }
    }

    // Strategy 2: find any element whose text is exactly a UTC timestamp pattern,
    // e.g. "2026-06-01 06:55:55 (UTC)" — short, purely date/time content.
    const datePattern = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/;
    const dateEls = this.page
      .locator('td, span, div')
      .filter({ hasText: /\d{4}-\d{2}-\d{2}/ });
    const dateCount = await dateEls.count();
    for (let i = 0; i < dateCount; i++) {
      const el = dateEls.nth(i);
      if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) continue;
      const text = (await el.innerText().catch(() => '')).trim();
      if (datePattern.test(text) && text.length < 40) return text;
    }

    throw new Error('Cannot read expiry time from open orders panel');
  }

  async openOrdersPanel() {
    await this.dismissSuccessDialogIfPresent();

    const panelTitle = this.page.getByText(/^Open Orders$/i).first();

    // 下单成功后 widget 会重新挂载，头部图标可能尚未渲染；点击前先等它出现。
    // 面板是 popover，点击外部即关闭，因此失败时重试要重新点而不是干等。
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.waitForOrderIcon();
      await this.clickOrderIcon(LimitPage.WIDGET_LABEL);
      await this.dismissSuccessDialogIfPresent();

      if (await panelTitle.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await this.waitForOpenOrdersLoaded();
        return;
      }
      console.warn(`[LimitPage] Open Orders panel not open (attempt ${attempt + 1}/3), retrying...`);
      await this.page.waitForTimeout(1_500);
    }

    await expect(panelTitle).toBeVisible({ timeout: 20_000 });
    await this.waitForOpenOrdersLoaded();
  }

  /**
   * Waits until the Open Orders list finishes loading.
   *
   * While the orders are being fetched Cetus fills the panel with
   * `chakra-skeleton` placeholders, so neither the order cards nor the empty-state
   * text exist yet. Reading the panel during that window makes a wallet with
   * existing orders look empty.
   *
   * @returns true when at least one order is present, false for the empty state
   */
  async waitForOpenOrdersLoaded(timeoutMs = 20_000): Promise<boolean> {
    const cancelButton = this.page.getByRole('button', { name: /^cancel$/i }).first();
    const emptyText = this.page.getByText(/you don't have any open orders yet/i).first();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await cancelButton.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log('[LimitPage] Open Orders loaded: has existing orders');
        return true;
      }
      if (await emptyText.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log('[LimitPage] Open Orders loaded: empty state');
        return false;
      }
      await this.page.waitForTimeout(500);
    }

    console.warn(`[LimitPage] Open Orders list did not settle within ${timeoutMs}ms`);
    return false;
  }

  async cancelFirstOpenOrder() {
    const cancelButton = this.page.getByRole('button', { name: /^cancel$/i }).last();
    await expect(cancelButton).toBeVisible({ timeout: 20_000 });
    await expect(cancelButton).toBeEnabled({ timeout: 20_000 });
    await cancelButton.click();
  }

  async hasOpenOrderToCancel() {
    const cancelButton = this.page.getByRole('button', { name: /^cancel$/i }).last();
    const emptyText = this.page.getByText(/you don't have any open orders yet/i).first();

    for (let attempt = 0; attempt < 3; attempt++) {
      if (await cancelButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
        return true;
      }
      if (await emptyText.isVisible({ timeout: 1_000 }).catch(() => false)) {
        return false;
      }

      await this.page.waitForTimeout(3_000);

      if (await cancelButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
        return true;
      }
      if (await emptyText.isVisible({ timeout: 1_000 }).catch(() => false)) {
        return false;
      }

      if (attempt < 2) {
        await this.page.reload({ waitUntil: 'domcontentloaded' });
        await this.page.waitForLoadState('networkidle').catch(() => undefined);
        await this.dismissTermsModalIfPresent();
        await this.openOrdersPanel();
      }
    }

    return false;
  }

  /**
   * Sets a custom expiry period on the limit order form.
   *
   * Flow: click the "Expires in" dropdown → click "Custom" → fill the
   * Minutes (and optionally Hours) inputs → click "Set Period".
   */
  async setCustomExpiry(minutes: number, hours: number = 0): Promise<void> {
    // The current expiry value is shown as a dropdown trigger (e.g. "7 Days ▼")
    // Find it by its proximity to the "Expires in" label.
    const expiresLabel = this.page.getByText(/^expires in$/i).first();
    const expiryDropdown = expiresLabel
      .locator('xpath=ancestor::*[self::div][2]')
      .locator('button, [role="button"], div')
      .filter({ hasText: /days?|minutes?|hours?|month/i })
      .first();

    if (!(await expiryDropdown.isVisible({ timeout: 3_000 }).catch(() => false))) {
      // Fallback: click the section container that shows the current duration text
      const fallback = this.page
        .locator('button, div, [role="button"]')
        .filter({ hasText: /\d+\s*(days?|minutes?|hours?|month)/i })
        .last();
      await fallback.click();
    } else {
      await expiryDropdown.click();
    }

    await this.page.waitForTimeout(400);

    // Click "Custom" option in the dropdown list
    const customOption = this.page
      .locator('li, div, button, [role="option"]')
      .filter({ hasText: /^custom$/i })
      .first();
    await expect(customOption).toBeVisible({ timeout: 5_000 });
    await customOption.click();
    await this.page.waitForTimeout(400);

    // "Custom Expiry Period" dialog — fill Hours and Minutes
    const dialog = this.page
      .locator('[role="dialog"], .chakra-modal__content')
      .filter({ hasText: /custom expiry period/i })
      .last();
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Hours input (clear then fill; keep 0 if not needed)
    const hoursInput = dialog
      .locator('input')
      .filter({ has: this.page.locator('xpath=following-sibling::*[contains(text(),"Hours")] | ancestor::*/*[contains(text(),"Hours")]') })
      .first();
    // Simpler: inputs are ordered — first = Hours, second = Minutes
    const inputs = dialog.locator('input');
    const hoursField = inputs.nth(0);
    const minutesField = inputs.nth(1);

    await hoursField.click({ clickCount: 3 });
    await hoursField.fill(String(hours));

    await minutesField.click({ clickCount: 3 });
    await minutesField.fill(String(minutes));

    // Click "Set Period"
    const setPeriodBtn = dialog
      .locator('button, [role="button"]')
      .filter({ hasText: /^set period$/i })
      .first();
    await expect(setPeriodBtn).toBeVisible({ timeout: 3_000 });
    await setPeriodBtn.click();
    await this.page.waitForTimeout(400);

    console.log(`[LimitPage] custom expiry set: ${hours}h ${minutes}m`);
  }

  /**
   * Reads the first card in the Open Orders panel and returns its key fields.
   * Call after openOrdersPanel() has resolved.
   */
  async readFirstOpenOrderInfo(): Promise<{ pair: string; expiry: string; price: string }> {
    // Each open-order card has: pair header, Price, Filled Size, Expiry
    const cancelButton = this.page.getByRole('button', { name: /^cancel$/i }).last();
    await expect(cancelButton).toBeVisible({ timeout: 10_000 });

    // Walk up from the cancel button to find the card container
    for (const depth of [3, 4, 5, 6]) {
      const card = cancelButton.locator(`xpath=ancestor::*[self::div][${depth}]`);
      const cardText = await card.innerText().catch(() => '');

      if (!cardText.includes('Expiry') && !cardText.includes('Filled Size')) continue;

      const fields = await card.evaluate((cardEl) => {
        const allText = (cardEl as HTMLElement).innerText;

        // Pair: everything before the first known field label
        const firstLabelPos = Math.min(
          ...[/price/i, /filled size/i, /expiry/i].map((r) => {
            const m = allText.search(r);
            return m >= 0 ? m : Infinity;
          })
        );
        const pair = allText
          .slice(0, firstLabelPos)
          .replace(/\s*\n\s*/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();

        // Price value (label is "Price", not "Limit Price" in Open Orders)
        const priceMatch = allText.match(/price\s*([\d,.]+ \w+ per \w+[^\n]*)/i);
        const price = priceMatch?.[1]?.trim() ?? '';

        // Expiry value
        const expiryMatch = allText.match(/expiry\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\s*\(UTC\))?)/i);
        const expiry = expiryMatch?.[1]?.trim() ?? '';

        return { pair, price, expiry };
      }).catch(() => ({ pair: '', price: '', expiry: '' }));

      if (fields.expiry) return fields;
    }

    throw new Error('Cannot read Open Order card info');
  }

  async expectOrderCancelled() {
    const successText = this.page
      .getByText(/transaction completed|order cancelled successfully|order canceled successfully|view on explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
  }

  /**
   * Opens the orders panel (if not already open) and switches to the
   * "Order History" tab.
   */
  async openOrderHistoryTab(): Promise<void> {
    await this.dismissSuccessDialogIfPresent();

    const panelTitle = this.page.getByText(/^Open Orders|^Order History/i).first();
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.waitForOrderIcon();
      await this.clickOrderIcon(LimitPage.WIDGET_LABEL);
      await this.dismissSuccessDialogIfPresent();
      if (await panelTitle.isVisible({ timeout: 5_000 }).catch(() => false)) break;
      console.warn(`[LimitPage] orders panel not open (attempt ${attempt + 1}/3), retrying...`);
      await this.page.waitForTimeout(1_500);
    }

    // Click the "Order History" tab (may include a badge count, e.g. "Order History 22")
    const historyTab = this.page
      .locator('button, div, span')
      .filter({ hasText: /^Order History/i })
      .first();
    await expect(historyTab).toBeVisible({ timeout: 10_000 });
    await historyTab.click();
    await this.page.waitForTimeout(800);
  }

  /**
   * Reads the first visible Order History card whose Status matches `status`.
   *
   * Parsing notes (Cetus DOM quirks):
   *  - The pair header is split across several text nodes: "5" / "SUI → 10.30 USDC"
   *  - Filled Size is also split: "0" / "/5 SUI" / "(0%)"
   *  - The "Status" row's innerText includes both the label and the badge value
   *
   * Strategy: use DOM evaluate to read each field directly from its element so
   * we are not dependent on line-break positions in innerText().
   */
  async readFirstOrderHistoryRecord(status: 'completed' | 'cancelled'): Promise<{
    pair: string;
    limitPrice: string;
    expiry: string;
    filledSize: string;
    filledPercent: number;
    status: string;
  }> {
    const statusPattern = status === 'completed' ? /completed/i : /cancelled/i;

    // Scan all elements that carry only the status text (no nested labels)
    const allEls = this.page.locator('span, div, button, p');
    const count = await allEls.count();

    for (let i = 0; i < count; i++) {
      const el = allEls.nth(i);
      if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;

      // Use evaluate to get just the direct text content (excluding child nodes)
      const directText = await el
        .evaluate((node) => {
          let text = '';
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
          }
          return text.trim();
        })
        .catch(() => '');

      if (!statusPattern.test(directText) || directText.length > 20) continue;

      // Found a status badge — now walk up to find the card container
      for (const depth of [3, 4, 5, 6]) {
        const card = el.locator(`xpath=ancestor::*[self::div][${depth}]`);
        const cardText = await card.innerText().catch(() => '');
        if (
          !cardText.includes('Limit Price') ||
          !cardText.includes('Expiry') ||
          !cardText.includes('Filled Size')
        )
          continue;

        // ── Extract fields via DOM evaluation ─────────────────────────────────
        const fields = await card
          .evaluate((cardEl) => {
            /**
             * For a given label text, find the label node inside the card and
             * return the text content of the NEXT sibling element (the value cell).
             */
            const getValueAfterLabel = (labelPattern: RegExp): string => {
              const walker = document.createTreeWalker(cardEl, NodeFilter.SHOW_TEXT);
              let node: Text | null;
              while ((node = walker.nextNode() as Text | null)) {
                const t = node.textContent?.trim() ?? '';
                if (labelPattern.test(t) && t.length < 20) {
                  // Value is typically the next sibling element of the label's parent
                  const parent = node.parentElement;
                  if (!parent) continue;
                  const next = parent.nextElementSibling ?? parent.parentElement?.nextElementSibling;
                  if (next) return (next as HTMLElement).innerText.trim();
                }
              }
              return '';
            };

            // Pair: the full header text of the card (first non-label child)
            // Collect all text before the "Limit Price" row
            const allText = (cardEl as HTMLElement).innerText;
            const lpPos = allText.search(/limit price/i);
            const headerRaw = lpPos > 0 ? allText.slice(0, lpPos) : '';
            // Collapse whitespace and newlines into a single line, keep "→"
            const pair = headerRaw.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();

            const limitPrice = getValueAfterLabel(/^limit price$/i);
            const expiry = getValueAfterLabel(/^expiry$/i);

            // Filled Size: join lines between "Filled Size" and "Status" labels
            const fsPos = allText.search(/filled size/i);
            const stPos = allText.search(/\bstatus\b/i);
            const filledSizeRaw =
              fsPos >= 0 && stPos > fsPos
                ? allText.slice(fsPos + 'Filled Size'.length, stPos)
                : '';
            const filledSize = filledSizeRaw.replace(/\s+/g, '').trim();

            // Status badge: direct text of the status element
            const statusEl = Array.from(cardEl.querySelectorAll('span, div, button')).find(
              (el) => /^(completed|cancelled)$/i.test((el as HTMLElement).innerText.trim())
            );
            const statusText = statusEl ? (statusEl as HTMLElement).innerText.trim() : '';

            return { pair, limitPrice, expiry, filledSize, statusText };
          })
          .catch(() => null);

        if (!fields) continue;
        if (!fields.pair.includes('→') && !fields.pair.includes('→')) continue;

        const pctMatch = fields.filledSize.match(/\((\d+)%\)/);
        const filledPercent = pctMatch ? parseInt(pctMatch[1], 10) : -1;

        return {
          pair: fields.pair,
          limitPrice: fields.limitPrice,
          expiry: fields.expiry,
          filledSize: fields.filledSize,
          filledPercent,
          status: fields.statusText || directText,
        };
      }
    }

    throw new Error(`No Order History record with status "${status}" found on page`);
  }

  /**
   * Polls Order History (max `maxWaitMs`) until a record with the given status
   * appears, reloading the list periodically.
   */
  async waitForOrderHistoryStatus(
    status: 'completed' | 'cancelled',
    maxWaitMs = 120_000
  ): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    let attempts = 0;
    
    while (Date.now() < deadline) {
      attempts++;
      const elapsed = Math.round((Date.now() - (deadline - maxWaitMs)) / 1000);
      console.log(`[LimitPage] Polling for ${status} order (attempt ${attempts}, ${elapsed}s elapsed)...`);
      
      const found = await this.readFirstOrderHistoryRecord(status).catch(() => null);
      if (found) {
        console.log(`[LimitPage] ✓ Found ${status} order after ${attempts} attempts`);
        return;
      }
      
      // Try multiple refresh strategies
      // 1. Look for refresh/reload icon
      const refreshBtn = this.page.locator('svg[class*="refresh"], svg[class*="reload"], button[aria-label*="refresh" i]').first();
      if (await refreshBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log(`[LimitPage] Clicking refresh button...`);
        await refreshBtn.click().catch(() => undefined);
        await this.page.waitForTimeout(2_000);
      } else {
        // 2. If no refresh button, close and reopen the history panel to force refresh
        console.log(`[LimitPage] No refresh button found, reopening history panel...`);
        await this.page.keyboard.press('Escape').catch(() => undefined);
        await this.page.waitForTimeout(1_000);
        await this.openOrderHistoryTab();
        await this.page.waitForTimeout(2_000);
      }
      
      // Wait before next attempt
      await this.page.waitForTimeout(3_000);
    }
    
    console.log(`[LimitPage] ✗ Order History record with status "${status}" did not appear after ${attempts} attempts (${maxWaitMs}ms)`);
    throw new Error(`Order History record with status "${status}" did not appear within ${maxWaitMs}ms`);
  }

  /**
   * Reads the current value from the "Buy X at rate" price input (which defaults
   * to the market price), computes `marketPrice * percent / 100`, and fills the
   * input with the result.
   *
   * Call this after token selection so the market price is already populated.
   */
  /**
   * Directly sets the "Buy X at rate" price input to the given value string.
   * Use this to test edge-case prices (e.g. "0", very large numbers).
   */
  async setRatePrice(value: string): Promise<void> {
    await this.page.waitForTimeout(800);
    const rateInput = await this.findRatePriceInput();
    await rateInput.click({ clickCount: 3 });
    await rateInput.fill(value);
    await this.page.waitForTimeout(600);
  }

  async setLimitPriceAtPercent(percent: number): Promise<void> {
    // Wait for the market price to populate after token selection
    await this.page.waitForTimeout(1_000);

    const rateInput = await this.findRatePriceInput();

    const rawValue = await rateInput.inputValue();
    const marketPrice = parseFloat(rawValue.replace(/,/g, ''));
    if (isNaN(marketPrice) || marketPrice <= 0) {
      throw new Error(`Cannot read market price from rate input (got: "${rawValue}")`);
    }

    const targetPrice = (marketPrice * percent) / 100;
    // Keep 4 decimal places, matching the UI's typical precision
    const targetPriceStr = targetPrice.toFixed(4);

    console.log(`[LimitPage] market price: ${marketPrice}, ${percent}% → ${targetPriceStr}`);

    // Select-all then fill so the existing value is fully replaced
    await rateInput.click({ clickCount: 3 });
    await rateInput.fill(targetPriceStr);
    // Allow the UI to recalculate receive-amount / button state
    await this.page.waitForTimeout(600);
  }

  /**
   * Locates the editable price-rate input in the "Buy X at rate" section.
   *
   * The Cetus limit page renders a row like:
   *   [Buy USDC at rate]  [Market]
   *   [0.96015          ] [SUI ⇌ ]
   * We find the narrowest ancestor div that contains "at rate" text AND an input,
   * then confirm the input has a numeric value (the live market price).
   */
  async findRatePriceInput() {
    // Strategy 1: walk up from the "Buy X at rate" label until we hit a container
    //             that also owns an input with a numeric value.
    const buyAtRateLabel = this.page.getByText(/buy\s+\w+\s+at\s+rate/i).first();
    if (await buyAtRateLabel.isVisible({ timeout: 5_000 }).catch(() => false)) {
      for (const depth of [2, 3, 4, 5]) {
        const container = buyAtRateLabel.locator(
          `xpath=ancestor::*[self::div or self::section][${depth}]`
        );
        const input = container.locator('input').first();
        if (await input.isVisible({ timeout: 1_000 }).catch(() => false)) {
          const val = await input.inputValue().catch(() => '');
          if (/\d/.test(val)) return input;
        }
      }
    }

    // Strategy 2: find the "Market" element (may be a div/span, not a <button>)
    //             and walk up until we find a container that also has an input.
    const marketEl = this.page
      .locator('button, div, span')
      .filter({ hasText: /^market$/i })
      .first();
    if (await marketEl.isVisible({ timeout: 3_000 }).catch(() => false)) {
      for (const depth of [2, 3, 4, 5]) {
        const container = marketEl.locator(
          `xpath=ancestor::*[self::div or self::section][${depth}]`
        );
        const input = container.locator('input').first();
        if (await input.isVisible({ timeout: 1_000 }).catch(() => false)) {
          const val = await input.inputValue().catch(() => '');
          if (/\d/.test(val)) return input;
        }
      }
    }

    // Strategy 3: the rate input is the last visible editable (non-readonly) input on
    //             the page that holds a number, after the two amount-panel inputs.
    const allInputs = this.page.locator('input:not([readonly]):not([disabled])');
    const count = await allInputs.count();
    // Collect all numeric, visible, editable inputs and return the last one
    // (amount inputs come first; rate input is the last numeric one).
    let lastNumericInput = null;
    for (let i = 0; i < count; i++) {
      const inp = allInputs.nth(i);
      if (!(await inp.isVisible({ timeout: 500 }).catch(() => false))) continue;
      const val = await inp.inputValue().catch(() => '');
      if (/^\d/.test(val)) lastNumericInput = inp;
    }
    if (lastNumericInput) return lastNumericInput;

    throw new Error('Cannot find rate price input on limit order page');
  }

  private getPlaceLimitOrderButton() {
    return this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^place(?: limit)? order$|^place limit order$|^submit order$/i })
      .first();
  }

}
