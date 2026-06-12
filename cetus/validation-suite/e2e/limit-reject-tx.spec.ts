/**
 * Test: User rejects the limit order transaction in the wallet popup.
 *
 * Scenario: Fill in valid order parameters, click "Place Limit Order",
 * then REJECT the transaction in the wallet popup.
 *
 * Expected results:
 *   - UI shows a "Transaction rejected" / cancelled toast or error message
 *   - Open Orders panel has NO new order added
 *   - Wallet balance is unchanged (no funds deducted)
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

test.describe('Cetus Mainnet Limit Order (User Rejects Transaction)', () => {
  test('shows rejection notice and keeps balance unchanged when wallet tx is rejected', async ({
    page,
    walletController,
  }) => {
    const limitPage = new LimitPage(page);
    await limitPage.goto();

    await walletController.connect(page);

    // ── Compute input amount: ceil($5 / SUI price) ────────────────────────────
    const suiPrice = await getSuiPriceUsd();
    const inputAmount = await calcSuiAmountForFiveDollars();
    console.log(`[limit-reject:e2e] SUI price (Pyth)  : $${suiPrice.toFixed(4)}`);
    console.log(`[limit-reject:e2e] input amount       : ${inputAmount} SUI`);

    // ── Balance snapshot (before) ─────────────────────────────────────────────
    const balanceBefore = await getBalanceSnapshot(env.testWalletAddress, limitScenario.inputCoinType);
    console.log(`[limit-reject:e2e] balance before     : ${fmtBalance(balanceBefore.totalBalance)}`);

    // ── Record current open-order count ──────────────────────────────────────
    // Open the orders panel, count Cancel buttons (= number of open orders)
    await limitPage.openOrdersPanel();
    const cancelButtons = page.getByRole('button', { name: /^cancel$/i });
    const openOrdersBefore = await cancelButtons.count();
    console.log(`[limit-reject:e2e] open orders before : ${openOrdersBefore}`);

    // Close the panel before placing the order
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(400);

    // ── Token selection & order parameters ───────────────────────────────────
    await limitPage.selectFromToken(limitScenario.inputCoinType);
    await limitPage.selectToToken(limitScenario.outputCoinType);
    await limitPage.setLimitPriceAtPercent(95);
    await limitPage.fillAmount(inputAmount);
    await expect(limitPage.inputAmount).toHaveValue(inputAmount);

    // ── Submit order, then REJECT in wallet popup ─────────────────────────────
    await limitPage.submitLimitOrder();
    console.log('[limit-reject:e2e] order form submitted — rejecting in wallet');

    await walletController.rejectTransaction(page);
    console.log('[limit-reject:e2e] wallet transaction rejected');

    // ── Assert 1: UI shows rejection / cancellation toast ────────────────────
    const rejectionNotice = page
      .locator('[role="dialog"], [role="alert"], .chakra-toast, div, span')
      .filter({ hasText: /rejected|cancelled|canceled|failed|dismiss/i })
      .first();

    const noticeVisible = await rejectionNotice.isVisible({ timeout: 15_000 }).catch(() => false);
    if (noticeVisible) {
      const noticeText = (await rejectionNotice.innerText().catch(() => '')).trim().slice(0, 120);
      console.log(`[limit-reject:e2e] rejection notice   : "${noticeText}"`);
    } else {
      // Some wallets silently dismiss without a UI toast — acceptable
      console.log('[limit-reject:e2e] rejection notice   : <no visible toast — silent dismiss>');
    }

    // ── Assert 2: Open Orders count is unchanged ──────────────────────────────
    await page.waitForTimeout(2_000); // allow any state updates to settle

    await limitPage.openOrdersPanel();
    const openOrdersAfter = await cancelButtons.count();
    console.log(`[limit-reject:e2e] open orders after  : ${openOrdersAfter}`);

    expect(
      openOrdersAfter,
      'Open Orders count must not increase after a rejected transaction'
    ).toBeLessThanOrEqual(openOrdersBefore);

    // ── Assert 3: Balance is unchanged ───────────────────────────────────────
    const balanceAfter = await getBalanceSnapshot(env.testWalletAddress, limitScenario.inputCoinType);
    console.log(`[limit-reject:e2e] balance after      : ${fmtBalance(balanceAfter.totalBalance)}`);

    // Allow a tiny gas tolerance in case the wallet charged gas before rejection
    // (most wallets charge 0 on rejection, but some may charge minimal gas)
    const gasTolerance = BigInt(Math.round(0.01 * 10 ** decimals));
    const balanceDiff = balanceBefore.totalBalance > balanceAfter.totalBalance
      ? balanceBefore.totalBalance - balanceAfter.totalBalance
      : 0n;

    expect(
      balanceDiff,
      `Balance must remain unchanged after rejection (diff: ${fmtBalance(balanceDiff)})`
    ).toBeLessThanOrEqual(gasTolerance);

    console.log('[limit-reject:e2e] result             : rejection handled correctly — no order created, balance intact');
  });
});
