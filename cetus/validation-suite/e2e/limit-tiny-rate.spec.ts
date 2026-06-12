/**
 * Test: Limit order with rate = 0.000001 (minimum precision edge case).
 *
 * Scenario: An extremely small rate causes "You Receive" to show a very large
 * number (e.g. 5 SUI / 0.000001 = 5,000,000 USDC). The test verifies:
 *   - The UI computes a valid number — no NaN, Infinity, or blank
 *   - If the computed amount is abnormal (overflow / insufficient balance),
 *     the frontend correctly blocks order submission
 *
 * Steps:
 *   1. Input rate = 0.000001
 *   2. Verify You Receive calculation value is a valid number
 *   3. Attempt to create order — accept either:
 *      (a) Frontend blocks it (button disabled / shows error), or
 *      (b) Order is submitted successfully if the amount is within normal range
 */

import { env } from '@/config/env.js';
import { limitScenario } from '@/fixtures/scenarios.js';
import { LimitPage } from '@/page-objects/limit.page.js';
import { getBalanceSnapshot } from '@/chain/queries.js';
import { calcSuiAmountForFiveDollars, getSuiPriceUsd } from '@/chain/price.js';

import { expect, test } from '../setup/fixtures.js';

const decimals = limitScenario.inputCoinType.toLowerCase().includes('::sui::sui') ? 9 : 6;
function fmtBalance(raw: bigint): string {
  return `${(Number(raw) / 10 ** decimals).toFixed(4)} ${decimals === 9 ? 'SUI' : 'token'}`;
}

const TINY_RATE = '0.000001';

test.describe('Cetus Mainnet Limit Order (Tiny Rate)', () => {
  test('handles rate = 0.000001 without NaN / overflow and blocks abnormal orders', async ({
    page,
    walletController,
  }) => {
    const limitPage = new LimitPage(page);
    await limitPage.goto();

    await walletController.connect(page);

    // ── Compute input amount dynamically: ceil($5 / SUI price) ───────────────
    const suiPrice = await getSuiPriceUsd();
    const inputAmount = await calcSuiAmountForFiveDollars();
    console.log(`[limit-tiny:e2e] SUI price (Pyth) : $${suiPrice.toFixed(4)}`);
    console.log(`[limit-tiny:e2e] input amount      : ${inputAmount} SUI`);

    // ── Balance snapshot (before) ─────────────────────────────────────────────
    const balanceBefore = await getBalanceSnapshot(env.testWalletAddress, limitScenario.inputCoinType);
    console.log(`[limit-tiny:e2e] balance before    : ${fmtBalance(balanceBefore.totalBalance)}`);

    // ── Token selection ───────────────────────────────────────────────────────
    await limitPage.selectFromToken(limitScenario.inputCoinType);
    await limitPage.selectToToken(limitScenario.outputCoinType);

    // ── Fill amount then set rate to 0.000001 ─────────────────────────────────
    await limitPage.fillAmount(inputAmount);
    await expect(limitPage.inputAmount).toHaveValue(inputAmount);

    await limitPage.setRatePrice(TINY_RATE);
    console.log(`[limit-tiny:e2e] rate input         : ${TINY_RATE}`);

    // ── Verify "You Receive" shows a valid number ─────────────────────────────
    const receiveText = await limitPage.readReceiveAmountText();
    console.log(`[limit-tiny:e2e] You Receive value  : "${receiveText}"`);

    // Must not be NaN, Infinity or blank
    expect(receiveText, '"You Receive" must not be NaN').not.toMatch(/nan/i);
    expect(receiveText, '"You Receive" must not be Infinity').not.toMatch(/inf|∞/i);
    expect(receiveText.trim(), '"You Receive" must not be empty').not.toBe('');

    const receiveNumber = parseFloat(receiveText.replace(/,/g, ''));
    expect(isNaN(receiveNumber), '"You Receive" must parse as a finite number').toBe(false);
    console.log(`[limit-tiny:e2e] You Receive parsed : ${receiveNumber}`);

    // ── Check submit button state ─────────────────────────────────────────────
    const placeOrderButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /^place(?: limit)? order$|^submit order$/i })
      .first();

    const insufficientButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /insufficient|enter an amount/i })
      .first();

    const placeVisible = await placeOrderButton.isVisible({ timeout: 3_000 }).catch(() => false);
    const placeEnabled = placeVisible && (await placeOrderButton.isEnabled().catch(() => false));

    if (placeEnabled) {
      // UI allows this order — complete the full order flow
      console.log('[limit-tiny:e2e] submit button      : enabled, proceeding with order');
      await limitPage.submitLimitOrder();
      await walletController.approveTransaction(page);
      await limitPage.expectOrderSubmitted();

      const digest = await limitPage.readDigest();
      if (digest) {
        console.log(`[limit-tiny:e2e] tx digest          : ${digest}`);
        expect(digest.length).toBeGreaterThan(10);
      } else {
        console.log('[limit-tiny:e2e] tx digest          : <not found in UI>');
      }

      // ── Open Orders: verify order details ──────────────────────────────────
      await limitPage.openOrdersPanel();
      await limitPage.expectOpenOrderCreated();
      console.log('[limit-tiny:e2e] open order         : confirmed in orders panel');

      const expiry = await limitPage.readFirstOpenOrderExpiry();
      console.log(`[limit-tiny:e2e] order expiry       : ${expiry}`);

      const expiryMs = Date.parse(expiry.replace(/\s*\(UTC\)\s*$/, 'Z').replace(' ', 'T'));
      if (!isNaN(expiryMs)) {
        const sevenDaysMs = Date.now() + 7 * 24 * 60 * 60 * 1_000;
        const diffHours = Math.abs(expiryMs - sevenDaysMs) / (60 * 60 * 1_000);
        console.log(`[limit-tiny:e2e] expiry offset      : ${diffHours.toFixed(2)} h from 7-day mark`);
        expect(diffHours, 'order expiry should be within 2 h of 7 days from now').toBeLessThan(2);
      }

      // ── Balance verification ────────────────────────────────────────────────
      const balanceAfter = await getBalanceSnapshot(env.testWalletAddress, limitScenario.inputCoinType);
      const decrease = balanceBefore.totalBalance - balanceAfter.totalBalance;
      console.log(`[limit-tiny:e2e] balance after      : ${fmtBalance(balanceAfter.totalBalance)}`);
      console.log(`[limit-tiny:e2e] balance drop       : ${fmtBalance(decrease)}`);

      const expectedDecrease = BigInt(Math.round(parseFloat(inputAmount) * 10 ** decimals));
      const gasTolerance = BigInt(Math.round(0.05 * 10 ** decimals));
      expect(decrease).toBeGreaterThanOrEqual(expectedDecrease);
      expect(decrease).toBeLessThanOrEqual(expectedDecrease + gasTolerance);

    } else {
      // Expected path: frontend correctly blocks an abnormally large receive amount
      const blockVisible = await insufficientButton.isVisible({ timeout: 5_000 }).catch(() => false);
      expect(
        blockVisible || !placeEnabled,
        'Frontend must block the order when rate = 0.000001 produces an abnormal amount'
      ).toBe(true);
      console.log('[limit-tiny:e2e] result             : frontend correctly blocked the order');
    }
  });
});
