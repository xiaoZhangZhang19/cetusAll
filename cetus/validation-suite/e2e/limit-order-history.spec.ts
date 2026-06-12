/**
 * Test: Order History records display.
 *
 * Scenario: After creating cancelled and completed limit orders, switch to
 * "Order History" tab and verify each record shows correct fields.
 *
 * Flow:
 *   Part 1 — Cancelled record
 *     Place a limit order at 50% of market price (won't fill) → cancel it
 *     → Order History must show a "Cancelled" record with correct fields
 *
 *   Part 2 — Completed record
 *     Check if Order History already contains a "Completed" record.
 *     If not, place an order at 101% of market price and poll until it fills.
 *     → Order History must show a "Completed" record with filled size = 100%
 *
 * Assertions (per record):
 *   - Pair text contains "→" and both token symbols are non-empty
 *   - Limit Price contains a valid positive number
 *   - Expiry is a valid UTC timestamp
 *   - Filled Size contains a percentage
 *   - Status text matches expected value
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

/** Assert all required fields of a single Order History card. */
function assertOrderRecord(
  record: { pair: string; limitPrice: string; expiry: string; filledSize: string; filledPercent: number; status: string },
  expectedStatus: 'completed' | 'cancelled',
  label: string
) {
  console.log(`[limit-history:e2e] ${label}:`);
  console.log(`  pair         : ${record.pair}`);
  console.log(`  limit price  : ${record.limitPrice}`);
  console.log(`  expiry       : ${record.expiry}`);
  console.log(`  filled size  : ${record.filledSize}`);
  console.log(`  status       : ${record.status}`);

  // Pair: must contain "→" with non-empty token names on both sides
  expect(record.pair, `${label}: pair must contain "→"`).toContain('→');
  const [fromPart, toPart] = record.pair.split('→').map((s) => s.trim());
  expect(fromPart, `${label}: from-token part must not be empty`).toBeTruthy();
  expect(toPart, `${label}: to-token part must not be empty`).toBeTruthy();

  // Limit Price: must contain a parseable positive number
  const priceNum = parseFloat(record.limitPrice.replace(/,/g, ''));
  expect(isNaN(priceNum), `${label}: Limit Price must be a number`).toBe(false);
  expect(priceNum, `${label}: Limit Price must be positive`).toBeGreaterThan(0);

  // Expiry: must be a valid date string
  const expiryMs = Date.parse(
    record.expiry.replace(/\s*\(UTC\)\s*$/, 'Z').replace(' ', 'T')
  );
  expect(isNaN(expiryMs), `${label}: Expiry must be a valid date`).toBe(false);

  // Filled Size: must contain a percentage
  expect(record.filledSize, `${label}: Filled Size must contain '%'`).toContain('%');
  expect(record.filledPercent, `${label}: filledPercent must be 0–100`).toBeGreaterThanOrEqual(0);
  expect(record.filledPercent, `${label}: filledPercent must be 0–100`).toBeLessThanOrEqual(100);

  // Status text
  const statusPattern = expectedStatus === 'completed' ? /completed/i : /cancelled/i;
  expect(record.status, `${label}: Status must match ${expectedStatus}`).toMatch(statusPattern);

  // Completed orders must be 100% filled
  if (expectedStatus === 'completed') {
    expect(record.filledPercent, `${label}: Completed order must be 100% filled`).toBe(100);
  }
}

test.describe('Cetus Mainnet Limit Order History', () => {
  test('shows correct fields for cancelled and completed records', async ({
    page,
    walletController,
  }) => {
    // Allow up to 5 minutes: wallet approval + keeper filling order + history indexing lag
    test.setTimeout(300_000);
    
    const limitPage = new LimitPage(page);
    await limitPage.goto();
    await walletController.connect(page);

    // ── Compute input amount: ceil($5 / SUI price) ────────────────────────────
    const suiPrice = await getSuiPriceUsd();
    const inputAmount = await calcSuiAmountForFiveDollars();
    console.log(`[limit-history:e2e] SUI price (Pyth) : $${suiPrice.toFixed(4)}`);
    console.log(`[limit-history:e2e] input amount      : ${inputAmount} SUI`);

    const balanceBefore = await getBalanceSnapshot(env.testWalletAddress, limitScenario.inputCoinType);
    console.log(`[limit-history:e2e] balance before    : ${fmtBalance(balanceBefore.totalBalance)}`);

    // ════════════════════════════════════════════════════════════════════════
    // Part 1: Create a CANCELLED record
    //   Place an order at 50% of market price → it won't fill → cancel it
    // ════════════════════════════════════════════════════════════════════════
    console.log('[limit-history:e2e] ── Part 1: Creating cancelled order ──');

    await limitPage.selectFromToken(limitScenario.inputCoinType);
    await limitPage.selectToToken(limitScenario.outputCoinType);
    await limitPage.setLimitPriceAtPercent(50);
    await limitPage.fillAmount(inputAmount);
    await expect(limitPage.inputAmount).toHaveValue(inputAmount);

    await limitPage.submitLimitOrder();
    await walletController.approveTransaction(page);
    await limitPage.expectOrderSubmitted();
    console.log('[limit-history:e2e] low-rate order submitted');

    await limitPage.openOrdersPanel();
    await limitPage.cancelFirstOpenOrder();
    await walletController.approveTransaction(page);
    await limitPage.expectOrderCancelled();
    console.log('[limit-history:e2e] order cancelled successfully');

    // ════════════════════════════════════════════════════════════════════════
    // Part 2: Ensure a COMPLETED record exists
    //   First check existing history. If none found, place a 101% market
    //   order and wait up to 2 minutes for the keeper to fill it.
    // ════════════════════════════════════════════════════════════════════════
    console.log('[limit-history:e2e] ── Part 2: Checking for completed order ──');

    await limitPage.openOrderHistoryTab();
    const existingCompleted = await limitPage.readFirstOrderHistoryRecord('completed').catch(() => null);

    if (!existingCompleted) {
      console.log('[limit-history:e2e] no completed order found — placing 101% order');

      // Dismiss the history panel first, then place a new order
      await page.keyboard.press('Escape').catch(() => undefined);
      await limitPage.goto();

      await limitPage.selectFromToken(limitScenario.inputCoinType);
      await limitPage.selectToToken(limitScenario.outputCoinType);
      await limitPage.setLimitPriceAtPercent(101); // slightly above market → fills quickly
      await limitPage.fillAmount(inputAmount);
      await expect(limitPage.inputAmount).toHaveValue(inputAmount);

      await limitPage.submitLimitOrder();
      await walletController.approveTransaction(page);
      await limitPage.expectOrderSubmitted();
      console.log('[limit-history:e2e] 101% order submitted — waiting for keeper to fill (up to 4 min)');

      await limitPage.openOrderHistoryTab();
      await limitPage.waitForOrderHistoryStatus('completed', 240_000); // 4 minutes for keeper to fill
      console.log('[limit-history:e2e] completed order appeared in history');
    } else {
      console.log('[limit-history:e2e] existing completed order found — skipping creation');
    }

    // ════════════════════════════════════════════════════════════════════════
    // Part 3: Verify both record types
    // ════════════════════════════════════════════════════════════════════════
    console.log('[limit-history:e2e] ── Part 3: Verifying record fields ──');

    // Ensure we're on Order History tab
    await limitPage.openOrderHistoryTab();

    // Verify CANCELLED record
    const cancelledRecord = await limitPage.readFirstOrderHistoryRecord('cancelled');
    assertOrderRecord(cancelledRecord, 'cancelled', 'Cancelled record');

    // Verify COMPLETED record
    const completedRecord = await limitPage.readFirstOrderHistoryRecord('completed');
    assertOrderRecord(completedRecord, 'completed', 'Completed record');

    console.log('[limit-history:e2e] ── All assertions passed ──');
  });
});
