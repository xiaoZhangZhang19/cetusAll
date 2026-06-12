import { allure } from 'allure-playwright';

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

test.describe('Cetus Mainnet Limit Order', () => {
  test('places a SUI limit order at 95% market price (~$5 worth)', async ({ page, walletController }) => {
    await allure.epic('Cetus DEX');
    await allure.feature('Limit Order');
    await allure.story('Place limit order below market price');
    await allure.severity('critical');
    await allure.tag('limit', 'mainnet', 'P0');
    await allure.description('Places a SUI→USDC limit order at 95% of the current market rate, then verifies the order appears in Open Orders and the balance decreases by the expected amount.');

    const limitPage = new LimitPage(page);
    await limitPage.goto();

    await walletController.connect(page);

    // ── Compute input amount dynamically: ceil($5 / SUI price) ───────────────
    const suiPrice = await getSuiPriceUsd();
    const inputAmount = await calcSuiAmountForFiveDollars();
    console.log(`[limit:e2e] SUI price (Pyth): $${suiPrice.toFixed(4)}`);
    console.log(`[limit:e2e] input amount     : ${inputAmount} SUI`);

    // ── Balance snapshot (before) ─────────────────────────────────────────────
    const balanceBefore = await getBalanceSnapshot(env.testWalletAddress, limitScenario.inputCoinType);
    console.log(`[limit:e2e] balance before   : ${fmtBalance(balanceBefore.totalBalance)}`);

    // ── Token selection & limit price ─────────────────────────────────────────
    await limitPage.selectFromToken(limitScenario.inputCoinType);
    await limitPage.selectToToken(limitScenario.outputCoinType);

    // Set the limit price to 95% of the current market price
    await limitPage.setLimitPriceAtPercent(95);

    // ── Amount & submit ───────────────────────────────────────────────────────
    await limitPage.fillAmount(inputAmount);
    await expect(limitPage.inputAmount).toHaveValue(inputAmount);

    await limitPage.submitLimitOrder();
    await walletController.approveTransaction(page);
    await limitPage.expectOrderSubmitted();

    const digest = await limitPage.readDigest();
    if (digest) {
      console.log(`[limit:e2e] tx digest      : ${digest}`);
      expect(digest.length).toBeGreaterThan(10);
    } else {
      console.log('[limit:e2e] tx digest      : <not found in UI>');
    }

    // ── Open Orders verification ──────────────────────────────────────────────
    await limitPage.openOrdersPanel();

    // 1. Verify the order was created
    await limitPage.expectOpenOrderCreated();
    console.log('[limit:e2e] open order     : confirmed in orders panel');

    // 2. Verify expiry is ~7 days from now (UI stores as a UTC timestamp)
    const expiry = await limitPage.readFirstOpenOrderExpiry();
    console.log(`[limit:e2e] order expiry   : ${expiry}`);

    // Parse "2026-06-01 06:55:55 (UTC)" → Date; allow ±2 h tolerance
    const expiryMs = Date.parse(expiry.replace(/\s*\(UTC\)\s*$/, 'Z').replace(' ', 'T'));
    if (!isNaN(expiryMs)) {
      const sevenDaysMs = Date.now() + 7 * 24 * 60 * 60 * 1_000;
      const diffHours = Math.abs(expiryMs - sevenDaysMs) / (60 * 60 * 1_000);
      console.log(`[limit:e2e] expiry offset  : ${diffHours.toFixed(2)} h from 7-day mark`);
      expect(diffHours, 'order expiry should be within 2 h of 7 days from now').toBeLessThan(2);
    }

    // ── Balance verification (after) ──────────────────────────────────────────
    const balanceAfter = await getBalanceSnapshot(env.testWalletAddress, limitScenario.inputCoinType);
    const decrease = balanceBefore.totalBalance - balanceAfter.totalBalance;

    console.log(`[limit:e2e] balance after    : ${fmtBalance(balanceAfter.totalBalance)}`);
    console.log(`[limit:e2e] balance drop     : ${fmtBalance(decrease)}`);

    const inputAmountFloat = parseFloat(inputAmount);
    const expectedDecrease = BigInt(Math.round(inputAmountFloat * 10 ** decimals));
    // Allow up to 0.05 SUI (or equivalent) tolerance for gas fees
    const gasTolerance = BigInt(Math.round(0.05 * 10 ** decimals));

    expect(decrease).toBeGreaterThanOrEqual(expectedDecrease);
    expect(decrease).toBeLessThanOrEqual(expectedDecrease + gasTolerance);
  });
});
