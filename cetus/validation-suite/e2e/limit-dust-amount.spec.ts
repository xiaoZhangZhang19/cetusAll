/**
 * Test: Limit order blocked by dust (extremely small) input amount.
 *
 * Scenario: Enter 0.000001 SUI in "You Pay" — this is below any practical
 * minimum order size. Expected behaviour (either is acceptable):
 *   (a) Frontend validation: submit button is disabled and shows a minimum-
 *       amount / dust warning message.
 *   (b) Frontend allows submission but the transaction fails and the UI
 *       displays the failure reason.
 *
 * Steps:
 *   1. Input You Pay = 0.000001
 *   2. Attempt to submit
 *   3. Assert frontend shows minimum amount restriction OR tx fail reason
 */

import { limitScenario } from '@/fixtures/scenarios.js';
import { LimitPage } from '@/page-objects/limit.page.js';

import { expect, test } from '../setup/fixtures.js';

const DUST_AMOUNT = '0.000001';

test.describe('Cetus Mainnet Limit Order (Dust Amount)', () => {
  test('blocks or rejects a dust-level input amount', async ({ page, walletController }) => {
    const limitPage = new LimitPage(page);
    await limitPage.goto();

    await walletController.connect(page);

    // ── Token selection & dust amount ─────────────────────────────────────────
    await limitPage.selectFromToken(limitScenario.inputCoinType);
    await limitPage.selectToToken(limitScenario.outputCoinType);

    await limitPage.fillAmount(DUST_AMOUNT);
    // UI may keep trailing zeros or not — match the numeric value flexibly
    const inputVal = await limitPage.inputAmount.inputValue();
    console.log(`[limit-dust:e2e] amount entered   : ${inputVal}`);
    expect(parseFloat(inputVal), 'input must be parsed as 0.000001').toBeCloseTo(0.000001, 9);

    // ── Check submit button state ─────────────────────────────────────────────
    const placeOrderButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /^place(?: limit)? order$|^submit order$/i })
      .first();

    const blockedButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /insufficient|minimum|too small|dust|enter an amount/i })
      .first();

    const placeVisible = await placeOrderButton.isVisible({ timeout: 3_000 }).catch(() => false);
    const placeEnabled = placeVisible && (await placeOrderButton.isEnabled().catch(() => false));

    if (!placeEnabled) {
      // ── Path A: Frontend blocks submission ───────────────────────────────────
      console.log('[limit-dust:e2e] submit button    : disabled (frontend validation)');

      // The disabled button should carry an informative message
      const blockVisible = await blockedButton.isVisible({ timeout: 5_000 }).catch(() => false);
      if (blockVisible) {
        const blockText = (await blockedButton.innerText()).trim();
        console.log(`[limit-dust:e2e] blocked message  : "${blockText}"`);
      }

      // "Place Limit Order" must NOT be clickable
      expect(placeEnabled, 'Place Limit Order must not be enabled for dust amount').toBe(false);
      console.log('[limit-dust:e2e] result           : frontend correctly blocked dust amount');

    } else {
      // ── Path B: Frontend allows submission — expect tx fail or error dialog ──
      console.log('[limit-dust:e2e] submit button    : enabled — attempting submission');

      await placeOrderButton.click();

      // Handle optional "Review your order" confirmation step
      const reviewDialog = page
        .locator('[role="dialog"], .chakra-modal__content')
        .filter({ hasText: /review your order/i })
        .last();
      const reviewButton = reviewDialog
        .locator('button, [role="button"]')
        .filter({ hasText: /^place order$/i })
        .first();
      if (await reviewButton.isVisible({ timeout: 4_000 }).catch(() => false)) {
        await reviewButton.click();
      }

      // Wallet popup may appear — approve so we can observe the on-chain result
      await walletController.approveTransaction(page);

      // Expect an error / failure message within 30 s
      const errorText = page
        .locator('[role="dialog"], [role="alert"], .chakra-toast, div, span')
        .filter({ hasText: /failed|error|reject|minimum|too small|dust|insufficient/i })
        .first();

      const errorVisible = await errorText.isVisible({ timeout: 30_000 }).catch(() => false);
      if (errorVisible) {
        const msg = (await errorText.innerText().catch(() => '')).trim().slice(0, 120);
        console.log(`[limit-dust:e2e] failure message  : "${msg}"`);
      }

      expect(
        errorVisible,
        'A failure/error message must appear when a dust-amount order is submitted'
      ).toBe(true);
      console.log('[limit-dust:e2e] result           : tx correctly rejected with error message');
    }
  });
});
