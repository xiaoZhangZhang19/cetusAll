import { expect } from '@playwright/test';

import { SwapPage } from './swap.page.js';

function toOneDecimal(value: number) {
  return value.toFixed(1);
}

/** Rounds UP to 1 decimal so the resulting USD value never falls below the target. */
function ceilToOneDecimal(value: number) {
  return Math.ceil(value * 10) / 10;
}

export class DcaPage extends SwapPage {
  /** Cetus rejects DCA orders whose per-cycle size is below this USD amount. */
  private static readonly MIN_PER_ORDER_USD = 3;

  /** Order cycles used by the Total-mode scenario (matches the widget default). */
  private static readonly ORDER_COUNT = 2;

  /** Extra headroom over the minimum to absorb price drift between fill and submit. */
  private static readonly SAFETY_FACTOR = 1.05;

  /** widget 头部标签，订单图标坐标扫描失败时用于兜底定位。 */
  private static readonly WIDGET_LABEL = /^DCA$/i;

  /** 订单面板标题，用于确认 popover 已展开。 */
  private static readonly ORDERS_PANEL_TITLE = /^Active DCAs?$/i;

  async goto() {
    await this.page.goto('/dca', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
    await this.dismissTermsModalIfPresent();
    await expect(this.inputAmount).toBeVisible();
  }

  /**
   * Reads the price used to size the order.
   *
   * Prefers the widget's own "Current Rate" (1 SUI ≈ N USDC) because that is the
   * quote Cetus applies when validating the $3 per-order minimum. The watchlist
   * ticker at the top of the page can differ from it by 20 % or more, which is
   * enough to push a freshly filled order below the minimum.
   */
  async readCurrentSuiPriceUsd() {
    const bodyText = await this.page.locator('body').innerText();

    const rate = bodyText.match(/1\s*SUI\s*[≈=~]\s*([0-9]+(?:\.[0-9]+)?)\s*USDC/i)?.[1];
    if (rate && Number(rate) > 0) {
      return Number(rate);
    }

    const ticker = bodyText.match(/SUI\s*\$([0-9]+(?:\.[0-9]+)?)/i)?.[1];
    if (ticker && Number(ticker) > 0) {
      return Number(ticker);
    }

    throw new Error('Unable to read current SUI price from DCA page.');
  }

  /**
   * Switches the "You Pay" input mode to "Total" (default).
   * In Total mode the amount entered is the overall SUI to spend across all orders.
   */
  async switchToTotalMode(): Promise<void> {
    const btn = this.page
      .locator('button, [role="button"], div, span')
      .filter({ hasText: /^total$/i })
      .first();
    if (await btn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await btn.click();
      await this.page.waitForTimeout(400);
    }
  }

  /**
   * Switches the "You Pay" input mode to "Per Order".
   * In Per Order mode the amount entered is the SUI spent per single order cycle.
   */
  async switchToPerOrderMode(): Promise<void> {
    const btn = this.page
      .locator('button, [role="button"], div, span')
      .filter({ hasText: /^per order$/i })
      .first();
    await expect(btn).toBeVisible({ timeout: 5_000 });
    await btn.click();
    await this.page.waitForTimeout(400);
  }

  /**
   * Fills the DCA form in **Total** mode.
   *
   * Amount logic:
   *   perOrder = ceil($3 × 1.05 / suiPrice, 1 decimal)  — clears the per-order minimum
   *   total    = perOrder × 2                            — 2 order cycles
   * The filled total is then verified against the widget's own USD readout and
   * raised if it still values each cycle below $3.
   * Price range: market ±10 %
   */
  async fillOrderByPrice(price: number) {
    const { MIN_PER_ORDER_USD, ORDER_COUNT, SAFETY_FACTOR } = DcaPage;
    const perOrder = ceilToOneDecimal((MIN_PER_ORDER_USD * SAFETY_FACTOR) / price);
    let totalAmount = toOneDecimal(perOrder * ORDER_COUNT);

    const lowerPrice = (price * 0.9).toFixed(4);
    const upperPrice = (price * 1.1).toFixed(4);
    const inputs = this.page.locator('input');

    await this.fillPayAmount(totalAmount);
    await inputs.nth(3).fill(lowerPrice);
    await inputs.nth(3).press('Tab');
    await inputs.nth(4).fill(upperPrice);
    await inputs.nth(4).press('Tab');

    totalAmount = await this.ensureMinimumPerOrder(totalAmount);

    return { totalAmount, lowerPrice, upperPrice };
  }

  /**
   * Re-reads the USD value the widget itself renders for the filled amount and
   * tops the total up until each cycle clears the $3 minimum.
   *
   * The computed amount can still land under the minimum when the price feed used
   * for sizing differs from the widget's own valuation, so this closes the loop on
   * the number Cetus actually validates instead of trusting the estimate.
   */
  private async ensureMinimumPerOrder(initialTotal: string): Promise<string> {
    const { MIN_PER_ORDER_USD, ORDER_COUNT, SAFETY_FACTOR } = DcaPage;
    let totalAmount = initialTotal;

    for (let attempt = 0; attempt < 4; attempt++) {
      await this.page.waitForTimeout(600);
      const payUsd = await this.readPanelUsdValue('from');
      if (payUsd === null) return totalAmount;

      const perOrderUsd = payUsd / ORDER_COUNT;
      if (perOrderUsd >= MIN_PER_ORDER_USD) return totalAmount;

      const impliedPrice = payUsd / Number(totalAmount);
      const perOrder = ceilToOneDecimal((MIN_PER_ORDER_USD * SAFETY_FACTOR) / impliedPrice);
      const next = toOneDecimal(Math.max(perOrder * ORDER_COUNT, Number(totalAmount) + 0.1));

      console.log(
        `[dca:e2e] per-order $${perOrderUsd.toFixed(3)} < $${MIN_PER_ORDER_USD}, ` +
          `raising total ${totalAmount} -> ${next} SUI`
      );

      totalAmount = next;
      await this.fillPayAmount(totalAmount);
    }

    return totalAmount;
  }

  /** Fills the "You Pay" field and blurs it so the widget re-validates the order. */
  private async fillPayAmount(amount: string): Promise<void> {
    const input = this.page.locator('input').nth(0);
    await input.fill(amount);
    await input.press('Tab');
  }

  /**
   * Fills the DCA form in **Per Order** mode.
   *
   * Amount logic:
   *   perOrderAmount = ⌈($3 × 1.05 / suiPrice) × 10⌉ / 10  (1-decimal ceiling)
   *   Using ceiling (not round) plus headroom guarantees the per-cycle value stays
   *   above Cetus's "Minimum $3 per order" requirement.
   * Price range: market ±10 %
   */
  async fillPerOrderByPrice(price: number) {
    const { MIN_PER_ORDER_USD, SAFETY_FACTOR } = DcaPage;
    // Ceiling at 1 decimal place: e.g. 3.15/0.9259 = 3.402 → ceil = 3.5 SUI
    const perOrderAmount = ceilToOneDecimal((MIN_PER_ORDER_USD * SAFETY_FACTOR) / price).toFixed(1);
    const lowerPrice = (price * 0.9).toFixed(4);
    const upperPrice = (price * 1.1).toFixed(4);
    const inputs = this.page.locator('input');

    await this.fillPayAmount(perOrderAmount);
    await inputs.nth(3).fill(lowerPrice);
    await inputs.nth(3).press('Tab');
    await inputs.nth(4).fill(upperPrice);
    await inputs.nth(4).press('Tab');

    return { perOrderAmount, lowerPrice, upperPrice };
  }

  async submitDcaOrder() {
    const createButton = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^create dca order$/i })
      .first();
    await expect(createButton).toBeVisible({ timeout: 20_000 });
    await expect(createButton).toBeEnabled({ timeout: 20_000 });
    await createButton.click();

    const reviewButton = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^(confirm|create dca order|place order)$/i })
      .last();
    const hasReviewStep = await reviewButton.isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasReviewStep) {
      await expect(reviewButton).toBeEnabled({ timeout: 10_000 });
      await reviewButton.click();
    }
  }

  async expectOrderSubmitted() {
    const successText = this.page
      .getByText(/success|completed|submitted|order created|transaction completed|view on explorer|view in explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
  }

  /**
   * 打开 DCA 订单面板（widget 头部右侧的列表图标）。
   *
   * 与 Limit 一致：图标坐标由 svg #icon-History 扫描得到，因为下单成功后
   * Cetus 会重新挂载 widget，popover 的 React id 和 DOM 层级都会变。
   * 面板是 popover，点击外部即关闭，因此失败时要重新点而不是干等。
   */
  async openOrdersPanel() {
    await this.dismissSuccessDialogIfPresent();

    const panelTitle = this.page.getByText(DcaPage.ORDERS_PANEL_TITLE).first();

    for (let attempt = 0; attempt < 3; attempt++) {
      await this.waitForOrderIcon();
      await this.clickOrderIcon(DcaPage.WIDGET_LABEL);
      await this.dismissSuccessDialogIfPresent();

      if (await panelTitle.isVisible({ timeout: 5_000 }).catch(() => false)) return;

      console.warn(`[DcaPage] DCA orders panel not open (attempt ${attempt + 1}/3), retrying...`);
      await this.page.waitForTimeout(1_500);
    }

    await expect(panelTitle).toBeVisible({ timeout: 20_000 });
  }

  async hasActiveOrderToClose() {
    const closeButton = this.page.getByRole('button', { name: /^close and withdraw$/i }).first();
    const emptyText = this.page.getByText(/you don't have any active dcas|no active dca/i).first();

    for (let attempt = 0; attempt < 3; attempt++) {
      if (await closeButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
        return true;
      }
      if (await emptyText.isVisible({ timeout: 1_000 }).catch(() => false)) {
        return false;
      }

      await this.page.waitForTimeout(3_000);
      if (await closeButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
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

  async closeFirstActiveOrder() {
    const closeButton = this.page.getByRole('button', { name: /^close and withdraw$/i }).first();
    await expect(closeButton).toBeVisible({ timeout: 20_000 });
    await expect(closeButton).toBeEnabled({ timeout: 20_000 });
    await closeButton.click();
  }

  async expectOrderClosed() {
    const successText = this.page
      .getByText(/transaction completed|order closed successfully|dca order closed|view on explorer|view in explorer/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
  }
}
