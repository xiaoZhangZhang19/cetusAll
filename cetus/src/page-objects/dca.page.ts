import { expect } from '@playwright/test';

import { SwapPage } from './swap.page.js';

function toOneDecimal(value: number) {
  return value.toFixed(1);
}

export class DcaPage extends SwapPage {
  async goto() {
    await this.page.goto('/dca', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
    await this.dismissTermsModalIfPresent();
    await expect(this.inputAmount).toBeVisible();
  }

  async readCurrentSuiPriceUsd() {
    const bodyText = await this.page.locator('body').innerText();
    const price = bodyText.match(/SUI\s*\$([0-9]+(?:\.[0-9]+)?)/i)?.[1];
    if (!price) {
      throw new Error('Unable to read current SUI price from DCA page.');
    }

    return Number(price);
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
   *   perOrder = ceil($3 / suiPrice, 1 decimal)  — enough to meet minimum per order
   *   total    = perOrder × 2                     — 2 order cycles
   * Price range: market ±10 %
   */
  async fillOrderByPrice(price: number) {
    const roundedBaseAmount = Number(toOneDecimal(3 / price));
    const totalAmount = toOneDecimal(roundedBaseAmount * 2);
    const lowerPrice = (price * 0.9).toFixed(4);
    const upperPrice = (price * 1.1).toFixed(4);
    const inputs = this.page.locator('input');

    await inputs.nth(0).fill(totalAmount);
    await inputs.nth(0).press('Tab');
    await inputs.nth(3).fill(lowerPrice);
    await inputs.nth(3).press('Tab');
    await inputs.nth(4).fill(upperPrice);
    await inputs.nth(4).press('Tab');

    return { totalAmount, lowerPrice, upperPrice };
  }

  /**
   * Fills the DCA form in **Per Order** mode.
   *
   * Amount logic:
   *   perOrderAmount = ⌈($3 / suiPrice) × 10⌉ / 10  (1-decimal ceiling)
   *   Using ceiling (not round) guarantees the per-cycle value is always ≥ $3,
   *   meeting Cetus's "Minimum $3 per order" requirement.
   * Price range: market ±10 %
   */
  async fillPerOrderByPrice(price: number) {
    // Ceiling at 1 decimal place: e.g. 3/0.9259 = 3.241 → ceil = 3.3 SUI ($3.056)
    const perOrderAmount = (Math.ceil((3 / price) * 10) / 10).toFixed(1);
    const lowerPrice = (price * 0.9).toFixed(4);
    const upperPrice = (price * 1.1).toFixed(4);
    const inputs = this.page.locator('input');

    await inputs.nth(0).fill(perOrderAmount);
    await inputs.nth(0).press('Tab');
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

  async openOrdersPanel() {
    await this.clickOrderIcon();
    await expect(this.page.getByText(/^Active DCAs$/i).first()).toBeVisible({ timeout: 20_000 });
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

  private async clickOrderIcon() {
    const orderIcon = this.getWidgetHeader().locator('div[id^="popover-trigger-"]').last();
    await expect(orderIcon).toBeVisible({ timeout: 20_000 });
    await orderIcon.click({ force: true });
  }

  private getWidgetHeader() {
    return this.page.getByText(/^DCA$/i).first().locator('xpath=ancestor::*[self::div or self::section][6]');
  }
}
