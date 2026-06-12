/**
 * Test: Limit order fails due to insufficient SUI for gas.
 *
 * Scenario: Enter the FULL wallet SUI balance as the order amount, leaving
 * absolutely 0 SUI for gas. The transaction cannot be executed.
 *
 * Expected (either path is acceptable):
 *   Path A — Frontend pre-check:
 *     Button shows "Insufficient gas" / "Insufficient SUI balance" (disabled)
 *   Path B — Wallet / on-chain rejection:
 *     Wallet popup shows a gas error, or the transaction fails and the UI
 *     displays a clear failure reason
 *
 * Steps:
 *   1. Read on-chain SUI balance
 *   2. Enter amount = full SUI balance (0 left for gas)
 *   3. Attempt to submit
 *   4. Assert error message is shown (frontend or post-submit)
 */

import { env } from '@/config/env.js';
import { COIN_TYPES, limitScenario } from '@/fixtures/scenarios.js';
import { LimitPage } from '@/page-objects/limit.page.js';
import { getBalanceSnapshot } from '@/chain/queries.js';

import { expect, test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet Limit Order (Insufficient Gas)', () => {
  test('shows gas error when SUI balance cannot cover transaction gas', async ({
    page,
    walletController,
  }) => {
    const limitPage = new LimitPage(page);
    await limitPage.goto();

    await walletController.connect(page);

    // ── Read on-chain SUI balance and use it as the full order amount ─────────
    const balance = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.SUI);
    const totalSui = Number(balance.totalBalance) / 1e9;
    console.log(`[limit-gas:e2e] SUI balance         : ${totalSui.toFixed(6)} SUI`);

    if (totalSui < 0.001) {
      console.log('[limit-gas:e2e] balance already near-zero — skipping');
      test.skip();
      return;
    }

    // Use the complete wallet balance as the order amount → 0 SUI left for gas
    const orderAmount = totalSui.toFixed(6);
    console.log(`[limit-gas:e2e] order amount (full balance): ${orderAmount} SUI`);
    console.log('[limit-gas:e2e] gas reserve remaining      : 0 SUI (none left)');

    // ── Token selection & amount ──────────────────────────────────────────────
    await limitPage.selectFromToken(limitScenario.inputCoinType);
    await limitPage.selectToToken(limitScenario.outputCoinType);
    await limitPage.fillAmount(orderAmount);
    console.log(`[limit-gas:e2e] amount filled              : ${orderAmount} SUI`);

    // ── Check for frontend pre-check error ────────────────────────────────────
    const frontendErrorButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /insufficient.*gas|insufficient.*sui.*balance|insufficient.*balance/i })
      .first();

    const frontendBlocked =
      await frontendErrorButton.isVisible({ timeout: 5_000 }).catch(() => false);

    if (frontendBlocked) {
      // ── Path A: Frontend detects gas issue before submission ─────────────────
      const errorText = (await frontendErrorButton.innerText()).trim();
      console.log(`[limit-gas:e2e] frontend error button  : "${errorText}"`);
      await expect(frontendErrorButton).toBeDisabled();
      console.log('[limit-gas:e2e] result                 : frontend correctly pre-detected gas issue');
      return;
    }

    // ── Path B: Frontend allows submit — observe wallet / on-chain error ──────
    console.log('[limit-gas:e2e] no frontend pre-check — submitting to observe gas error');

    await limitPage.submitLimitOrder();

    // Try to approve; the wallet may show an error instead of an approval prompt
    await walletController.approveTransaction(page).catch(() => {
      console.log('[limit-gas:e2e] wallet approval threw (expected for gas error)');
    });

    // Cetus shows gas errors in a small modal dialog:
    //   "Transaction failed / Insufficient gas for this transaction."
    // Also handle toast / alert variants from other wallet implementations.
    const gasErrorNotice = page
      .locator(
        '[role="dialog"], [role="alert"], [role="status"], ' +
        '.chakra-modal__content, .chakra-toast, ' +
        '[class*="toast"], [class*="Toast"], ' +
        '[class*="notification"], [class*="Notification"]'
      )
      .filter({ hasText: /transaction failed|insufficient gas|insufficient.*balance|failed|error|reject/i })
      .first();

    const errorVisible = await gasErrorNotice.isVisible({ timeout: 30_000 }).catch(() => false);

    if (errorVisible) {
      // Collapse whitespace / newlines so the log stays on one readable line
      const raw = (await gasErrorNotice.innerText().catch(() => '')).trim();
      const msg = raw.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 100);
      console.log(`[limit-gas:e2e] error message          : "${msg}"`);
    } else {
      console.log('[limit-gas:e2e] error message          : <no error dialog visible>');
    }

    expect(
      errorVisible || frontendBlocked,
      'A gas/insufficient-funds error must be shown (frontend pre-check OR post-submit failure)'
    ).toBe(true);

    console.log('[limit-gas:e2e] result                 : gas error correctly surfaced to the user');
  });
});
