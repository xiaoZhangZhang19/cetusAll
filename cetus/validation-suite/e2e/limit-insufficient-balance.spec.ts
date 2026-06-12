/**
 * Test: Limit order blocked by insufficient balance.
 *
 * Scenario: Entering an amount (10,000 SUI) that far exceeds the wallet balance.
 * Expected: The "Place Limit Order" button is replaced by a greyed-out
 * "Insufficient SUI balance" button and no transaction can be submitted.
 */

import { limitScenario } from '@/fixtures/scenarios.js';
import { LimitPage } from '@/page-objects/limit.page.js';

import { expect, test } from '../setup/fixtures.js';

const LARGE_AMOUNT = '10000';

test.describe('Cetus Mainnet Limit Order (Insufficient Balance)', () => {
  test('blocks order submission when amount exceeds wallet balance', async ({
    page,
    walletController,
  }) => {
    const limitPage = new LimitPage(page);
    await limitPage.goto();

    await walletController.connect(page);

    // ── Token selection ───────────────────────────────────────────────────────
    await limitPage.selectFromToken(limitScenario.inputCoinType);
    await limitPage.selectToToken(limitScenario.outputCoinType);

    // ── Enter a large amount that exceeds wallet balance ──────────────────────
    await limitPage.fillAmount(LARGE_AMOUNT);
    // UI formats large numbers with commas (e.g. "10,000"), so match either form
    await expect(limitPage.inputAmount).toHaveValue(/^10[,.]?000$/);
    console.log(`[limit-insufficient:e2e] amount entered  : ${LARGE_AMOUNT} SUI`);

    // ── Assert "Insufficient balance" button is visible and disabled ──────────
    const insufficientButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /insufficient.*balance/i })
      .first();

    await expect(
      insufficientButton,
      '"Insufficient SUI balance" button must be visible'
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      insufficientButton,
      '"Insufficient SUI balance" button must be disabled'
    ).toBeDisabled();

    const buttonText = (await insufficientButton.innerText()).trim();
    console.log(`[limit-insufficient:e2e] button text     : "${buttonText}"`);

    // ── Assert "Place Limit Order" button is NOT enabled ─────────────────────
    const placeOrderButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /^place(?: limit)? order$|^submit order$/i })
      .first();

    const placeEnabled =
      (await placeOrderButton.isVisible({ timeout: 2_000 }).catch(() => false)) &&
      (await placeOrderButton.isEnabled().catch(() => false));

    expect(
      placeEnabled,
      '"Place Limit Order" must not be enabled when balance is insufficient'
    ).toBe(false);

    console.log('[limit-insufficient:e2e] result          : submit correctly blocked (insufficient balance)');
  });
});
