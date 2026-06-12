/**
 * Test: Limit order with 1-minute custom expiry — order expires and shows
 * as Cancelled in Order History.
 *
 * Flow:
 *   1. Place a limit order at 50% of market price (will NOT fill) with
 *      expiry = Custom → 1 Minute.
 *   2. Open Orders panel → read the actual UTC expiry timestamp from the card.
 *   3. Wait until (expiry UTC + 30 s) — gives the protocol time to expire
 *      the order on-chain.
 *   4. Poll Open Orders every 5 s until the order disappears (max 60 s after
 *      expected expiry).
 *   5. Switch to Order History → find the specific order by expiry timestamp
 *      and assert status = Cancelled.
 *
 * Total runtime: ~2–3 minutes.
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

// order placement (~30 s) + 1 min wait + 60 s poll buffer + verifications
test.setTimeout(240_000);

test.describe('Cetus Mainnet Limit Order (1-Minute Expiry)', () => {
  test('order expires after 1 minute and appears as Cancelled in Order History', async ({
    page,
    walletController,
  }) => {
    const limitPage = new LimitPage(page);
    await limitPage.goto();
    await walletController.connect(page);

    // ── Compute input amount: ceil($5 / SUI price) ────────────────────────────
    const suiPrice = await getSuiPriceUsd();
    const inputAmount = await calcSuiAmountForFiveDollars();
    console.log(`[limit-expiry:e2e] SUI price (Pyth)   : $${suiPrice.toFixed(4)}`);
    console.log(`[limit-expiry:e2e] input amount        : ${inputAmount} SUI`);

    const balanceBefore = await getBalanceSnapshot(env.testWalletAddress, limitScenario.inputCoinType);
    console.log(`[limit-expiry:e2e] balance before      : ${fmtBalance(balanceBefore.totalBalance)}`);

    // ── Token selection & price ───────────────────────────────────────────────
    await limitPage.selectFromToken(limitScenario.inputCoinType);
    await limitPage.selectToToken(limitScenario.outputCoinType);
    // 50% of market price — will never fill in 1 minute
    await limitPage.setLimitPriceAtPercent(50);

    // ── Set custom expiry: 0 hours, 1 minute ─────────────────────────────────
    await limitPage.setCustomExpiry(1, 0);
    console.log('[limit-expiry:e2e] expiry set          : Custom → 1 minute');

    // ── Fill amount and submit ────────────────────────────────────────────────
    await limitPage.fillAmount(inputAmount);
    await expect(limitPage.inputAmount).toHaveValue(inputAmount);

    await limitPage.submitLimitOrder();
    await walletController.approveTransaction(page);
    await limitPage.expectOrderSubmitted();

    const digest = await limitPage.readDigest();
    if (digest) console.log(`[limit-expiry:e2e] tx digest           : ${digest}`);

    // ── Open Orders: read actual expiry timestamp from the card ───────────────
    await limitPage.openOrdersPanel();
    await limitPage.expectOpenOrderCreated();

    const orderInfo = await limitPage.readFirstOpenOrderInfo();
    console.log('[limit-expiry:e2e] open order info:');
    console.log(`  pair         : ${orderInfo.pair}`);
    console.log(`  price        : ${orderInfo.price}`);
    console.log(`  expiry (UTC) : ${orderInfo.expiry}`);

    // Parse expiry to ms: "2026-05-27 12:54:54 (UTC)" → UTC timestamp
    const expiryMs = Date.parse(
      orderInfo.expiry.replace(/\s*\(UTC\)\s*$/, 'Z').replace(' ', 'T')
    );
    if (isNaN(expiryMs)) {
      throw new Error(`Cannot parse expiry timestamp: "${orderInfo.expiry}"`);
    }

    // ── Wait until expiry + 30 s (gives on-chain protocol time to settle) ─────
    const triggerAt = expiryMs + 30_000;
    const waitMs = Math.max(0, triggerAt - Date.now());
    console.log(
      `[limit-expiry:e2e] waiting             : ${Math.round(waitMs / 1000)} s ` +
      `(until ${new Date(triggerAt).toISOString()})`
    );
    await page.waitForTimeout(waitMs);

    // ── Poll Open Orders every 5 s until the order disappears (max 60 s) ──────
    console.log('[limit-expiry:e2e] polling             : Open Orders for order disappearance…');
    const pollDeadline = Date.now() + 60_000;
    let orderGone = false;

    while (Date.now() < pollDeadline) {
      // Refresh the orders list
      const refreshBtn = page
        .locator('button, [role="button"]')
        .filter({ has: page.locator('svg') })
        .filter({ hasText: '' })
        .nth(0);
      // Click the reload icon next to "Open Orders" header if available
      const reloadIcon = page.locator('[aria-label*="reload" i], [aria-label*="refresh" i], svg[class*="refresh"]').first();
      if (await reloadIcon.isVisible({ timeout: 500 }).catch(() => false)) {
        await reloadIcon.click().catch(() => undefined);
      }

      await page.waitForTimeout(2_000);

      const cancelBtn = page.getByRole('button', { name: /^cancel$/i }).last();
      const stillVisible = await cancelBtn.isVisible({ timeout: 1_000 }).catch(() => false);

      if (!stillVisible) {
        orderGone = true;
        console.log(`[limit-expiry:e2e] order disappeared   : at ${new Date().toISOString()}`);
        break;
      }

      console.log(`[limit-expiry:e2e] still in Open Orders, retrying in 5 s…`);
      await page.waitForTimeout(3_000);
    }

    expect(
      orderGone,
      `Order must disappear from Open Orders within 60 s after expiry (${orderInfo.expiry})`
    ).toBe(true);

    // ── Order History: find the expired order and verify status = Cancelled ───
    await limitPage.openOrderHistoryTab();
    console.log('[limit-expiry:e2e] switched to Order History');

    // Find the specific order by matching the expiry timestamp
    const historyRecord = await limitPage.readFirstOrderHistoryRecord('cancelled');
    console.log('[limit-expiry:e2e] matched history record:');
    console.log(`  pair         : ${historyRecord.pair}`);
    console.log(`  limit price  : ${historyRecord.limitPrice}`);
    console.log(`  expiry       : ${historyRecord.expiry}`);
    console.log(`  filled size  : ${historyRecord.filledSize}`);
    console.log(`  status       : ${historyRecord.status}`);

    // The expiry in history must match the one we read from Open Orders
    expect(
      historyRecord.expiry,
      'History record expiry must match the order expiry we read from Open Orders'
    ).toContain(orderInfo.expiry.replace(/\s*\(UTC\)\s*$/, '').trim());

    expect(historyRecord.status).toMatch(/cancelled/i);
    expect(historyRecord.filledPercent).toBe(0);

    console.log('[limit-expiry:e2e] result              : expired order correctly shows as Cancelled ✓');
  });
});
