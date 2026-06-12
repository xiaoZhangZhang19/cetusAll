/**
 * Test: Limit order with rate set 10% BELOW current market price (buy direction).
 *
 * Scenario: Because the set price is below market, the order should be placed
 * successfully but NOT execute immediately — it remains pending in Open Orders
 * until the market reaches the target price.
 *
 * Steps:
 *   1. Input rate = market price × 0.9
 *   2. Fill amount and place the limit order
 *   3. Verify order appears in Open Orders (status = open / pending)
 *   4. Verify expiry is ~7 days from now
 *   5. Verify input-token balance decreased by ~$5 worth of SUI (order amount locked on-chain)
 */

import { env } from '@/config/env.js';
import { limitScenario } from '@/fixtures/scenarios.js';
import { LimitPage } from '@/page-objects/limit.page.js';
import { getBalanceSnapshot } from '@/chain/queries.js';
import { calcSuiAmountForFiveDollars, getSuiPriceUsd } from '@/chain/price.js';

import { expect, test } from '../setup/fixtures.js';

// Use 9 decimals for SUI, 6 for USDC/other tokens
const decimals = limitScenario.inputCoinType.toLowerCase().includes('::sui::sui') ? 9 : 6;

/** Format a raw on-chain balance (MIST / base unit) as a human-readable string. */
function fmtBalance(raw: bigint): string {
  const units = Number(raw) / 10 ** decimals;
  return `${units.toFixed(4)} ${decimals === 9 ? 'SUI' : 'token'}`;
}

test.describe('Cetus Mainnet Limit Order (Rate Below Market)', () => {
  test('places a limit order at 90% of market price and verifies it is pending', async ({
    page,
    walletController,
  }) => {
    const limitPage = new LimitPage(page);
    await limitPage.goto();

    await walletController.connect(page);

    // ── Compute input amount dynamically: ceil($5 / SUI price) ───────────────
    const suiPrice = await getSuiPriceUsd();
    const inputAmount = await calcSuiAmountForFiveDollars();
    console.log(`[limit-above:e2e] SUI price (Pyth): $${suiPrice.toFixed(4)}`);
    console.log(`[limit-above:e2e] input amount     : ${inputAmount} SUI`);

    // ── Balance snapshot (before) ─────────────────────────────────────────────
    const balanceBefore = await getBalanceSnapshot(env.testWalletAddress, limitScenario.inputCoinType);
    console.log(`[limit-above:e2e] balance before   : ${fmtBalance(balanceBefore.totalBalance)}`);

    // ── Token selection ───────────────────────────────────────────────────────
    await limitPage.selectFromToken(limitScenario.inputCoinType);
    await limitPage.selectToToken(limitScenario.outputCoinType);

    // Set limit price to 90% of market — order hangs below market, won't fill immediately
    await limitPage.setLimitPriceAtPercent(90);

    // ── Amount & submit ───────────────────────────────────────────────────────
    await limitPage.fillAmount(inputAmount);
    await expect(limitPage.inputAmount).toHaveValue(inputAmount);

    await limitPage.submitLimitOrder();
    await walletController.approveTransaction(page);
    await limitPage.expectOrderSubmitted();

    const digest = await limitPage.readDigest();
    if (digest) {
      console.log(`[limit-above:e2e] tx digest      : ${digest}`);
      expect(digest.length).toBeGreaterThan(10);
    } else {
      console.log('[limit-above:e2e] tx digest      : <not found in UI>');
    }

    // ── Open Orders verification ──────────────────────────────────────────────
    await limitPage.openOrdersPanel();

    // 1. Order must exist in Open Orders (= not immediately executed)
    await limitPage.expectOpenOrderCreated();
    console.log('[limit-above:e2e] open order     : confirmed pending in orders panel');

    // 2. Verify expiry is ~7 days from now
    const expiry = await limitPage.readFirstOpenOrderExpiry();
    console.log(`[limit-above:e2e] order expiry   : ${expiry}`);

    const expiryMs = Date.parse(expiry.replace(/\s*\(UTC\)\s*$/, 'Z').replace(' ', 'T'));
    if (!isNaN(expiryMs)) {
      const sevenDaysMs = Date.now() + 7 * 24 * 60 * 60 * 1_000;
      const diffHours = Math.abs(expiryMs - sevenDaysMs) / (60 * 60 * 1_000);
      console.log(`[limit-above:e2e] expiry offset  : ${diffHours.toFixed(2)} h from 7-day mark`);
      expect(diffHours, 'order expiry should be within 2 h of 7 days from now').toBeLessThan(2);
    }

    // ── Balance verification (after) ──────────────────────────────────────────
    // The locked amount leaves the wallet when the order is placed
    const balanceAfter = await getBalanceSnapshot(env.testWalletAddress, limitScenario.inputCoinType);
    const decrease = balanceBefore.totalBalance - balanceAfter.totalBalance;

    console.log(`[limit-above:e2e] balance after    : ${fmtBalance(balanceAfter.totalBalance)}`);
    console.log(`[limit-above:e2e] balance drop     : ${fmtBalance(decrease)}`);

    const inputAmountFloat = parseFloat(inputAmount);
    const expectedDecrease = BigInt(Math.round(inputAmountFloat * 10 ** decimals));
    // Allow up to 0.05 SUI (or equivalent) tolerance for gas fees
    const gasTolerance = BigInt(Math.round(0.05 * 10 ** decimals));

    expect(decrease).toBeGreaterThanOrEqual(expectedDecrease);
    expect(decrease).toBeLessThanOrEqual(expectedDecrease + gasTolerance);
  });
});
