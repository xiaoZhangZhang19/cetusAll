/**
 * Test: Limit order with rate = 0.
 *
 * Scenario: When the rate input is set to 0, "You Receive" becomes 0.0 and the
 * "Place Limit Order" button is replaced by a disabled "Enter an amount" button.
 * The test verifies that order submission is blocked and no transaction is sent.
 */

import { limitScenario } from '@/fixtures/scenarios.js';
import { LimitPage } from '@/page-objects/limit.page.js';
import { calcSuiAmountForFiveDollars, getSuiPriceUsd } from '@/chain/price.js';

import { expect, test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet Limit Order (Zero Rate)', () => {
  test('blocks order submission when rate is 0', async ({ page, walletController }) => {
    const limitPage = new LimitPage(page);
    await limitPage.goto();

    await walletController.connect(page);

    // ── Compute input amount dynamically: ceil($5 / SUI price) ───────────────
    const suiPrice = await getSuiPriceUsd();
    const inputAmount = await calcSuiAmountForFiveDollars();
    console.log(`[limit-zero:e2e] SUI price (Pyth): $${suiPrice.toFixed(4)}`);
    console.log(`[limit-zero:e2e] input amount     : ${inputAmount} SUI`);

    // ── Token selection ───────────────────────────────────────────────────────
    await limitPage.selectFromToken(limitScenario.inputCoinType);
    await limitPage.selectToToken(limitScenario.outputCoinType);

    // ── Fill amount then set rate to 0 ────────────────────────────────────────
    await limitPage.fillAmount(inputAmount);
    await expect(limitPage.inputAmount).toHaveValue(inputAmount);

    await limitPage.setRatePrice('0');
    console.log('[limit-zero:e2e] rate input        : set to 0');

    // ── Assert submit button is disabled ──────────────────────────────────────
    // When rate = 0 the UI shows a greyed-out "Enter an amount" button instead of
    // "Place Limit Order", preventing any transaction from being submitted.
    const placeOrderButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /^place(?: limit)? order$|^submit order$/i })
      .first();

    const disabledButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /enter an amount/i })
      .first();

    // "Place Limit Order" must NOT be enabled
    const placeOrderEnabled =
      (await placeOrderButton.isVisible({ timeout: 3_000 }).catch(() => false)) &&
      (await placeOrderButton.isEnabled().catch(() => false));
    expect(placeOrderEnabled, '"Place Limit Order" should not be enabled when rate = 0').toBe(false);

    // "Enter an amount" must be visible and disabled
    await expect(disabledButton).toBeVisible({ timeout: 5_000 });
    await expect(disabledButton).toBeDisabled();

    console.log('[limit-zero:e2e] result            : submit button is correctly disabled (rate = 0)');
  });
});
