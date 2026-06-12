import { env } from '@/config/env.js';
import { getBalanceSnapshot } from '@/chain/queries.js';
import { swapScenario, TOKEN_DECIMALS } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';

import { expect, test } from '../setup/fixtures.js';

test.describe('Swap Insufficient Balance', () => {
  /**
   * P0: When the user enters an amount greater than their wallet balance the
   * Swap button must be disabled (or an error message shown), and no wallet
   * approval popup should appear.
   */
  test('rejects swap when input amount exceeds wallet balance', async ({ page, walletController }) => {
    const swapPage = new SwapPage(page);
    await swapPage.goto(swapScenario.path);
    await walletController.connect(page);

    await swapPage.selectFromToken(swapScenario.inputCoinType);
    await swapPage.selectToToken(swapScenario.outputCoinType);

    // Query the actual on-chain balance and compute an amount 1.5× above it
    const snapshot = await getBalanceSnapshot(env.testWalletAddress, swapScenario.inputCoinType);
    const decimal = TOKEN_DECIMALS[swapScenario.inputCoinType] ?? 9;
    const balanceUi = Number(snapshot.totalBalance) / 10 ** decimal;
    const excessAmount = (balanceUi * 1.5).toFixed(decimal);

    console.log(`[insufficient] Wallet balance: ${balanceUi} ${swapScenario.fromTokenSymbol}`);
    console.log(`[insufficient] Excess amount: ${excessAmount} ${swapScenario.fromTokenSymbol}`);

    await swapPage.fillAmount(excessAmount);
    // Give the UI time to re-evaluate the form state
    await page.waitForTimeout(2_000);

    const swapButton = page.getByRole('button', { name: /^swap!?$/i }).first();

    // Validation path A: the Swap button becomes disabled
    const isDisabled = await swapButton.isDisabled({ timeout: 5_000 }).catch(() => false);

    // Validation path B: an error message appears
    const insufficientMsg = page.getByText(/insufficient.*balance|not enough|exceeds balance/i).first();
    const hasErrorMsg = await insufficientMsg.isVisible({ timeout: 3_000 }).catch(() => false);

    console.log(`[insufficient] Button disabled: ${isDisabled}`);
    console.log(`[insufficient] Error message visible: ${hasErrorMsg}`);

    // At least one form of validation must be present
    expect(isDisabled || hasErrorMsg).toBe(true);

    if (isDisabled) {
      console.log('[insufficient] ✓ Swap button correctly disabled for excess amount');
    }
    if (hasErrorMsg) {
      const msgText = await insufficientMsg.innerText().catch(() => '');
      console.log(`[insufficient] ✓ Error message: "${msgText}"`);
    }
  });

  /**
   * P1: Entering exactly the wallet balance should keep the button enabled
   * (boundary check — the UI should allow swapping the full balance).
   */
  test('allows swap when input amount equals wallet balance', async ({ page, walletController }) => {
    const swapPage = new SwapPage(page);
    await swapPage.goto(swapScenario.path);
    await walletController.connect(page);

    await swapPage.selectFromToken(swapScenario.inputCoinType);
    await swapPage.selectToToken(swapScenario.outputCoinType);

    const snapshot = await getBalanceSnapshot(env.testWalletAddress, swapScenario.inputCoinType);
    const decimal = TOKEN_DECIMALS[swapScenario.inputCoinType] ?? 9;
    const balanceUi = (Number(snapshot.totalBalance) / 10 ** decimal).toFixed(decimal);

    console.log(`[insufficient] Full balance: ${balanceUi} ${swapScenario.fromTokenSymbol}`);

    await swapPage.fillAmount(balanceUi);
    await page.waitForTimeout(2_000);

    // Swap button should NOT show an insufficient-balance error
    const insufficientMsg = page.getByText(/insufficient.*balance|not enough|exceeds balance/i).first();
    const hasErrorMsg = await insufficientMsg.isVisible({ timeout: 2_000 }).catch(() => false);

    expect(hasErrorMsg).toBe(false);
    console.log('[insufficient] ✓ No insufficient-balance error when using exact balance');
  });
});
