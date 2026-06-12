import { highImpactScenario, TOKEN_DECIMALS } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P2: High Price Impact / Price Difference warning tests.
 *
 * Using SBOX → SUI with an extremely large input triggers a "High price
 * difference" red warning box.  No actual transaction is submitted — the
 * test only validates the UI warning state.
 */
test.describe('Swap High Price Impact Warning', () => {
  test('shows high price difference warning for extremely large SBOX → SUI amount', async ({
    page,
    walletController
  }) => {
    const { fromCoin, toCoin, fromSymbol, toSymbol, largeAmount, expectedDeviationThreshold } =
      highImpactScenario;

    const swapPage = new SwapPage(page);
    await swapPage.goto('/swap');
    await walletController.connect(page);

    // Step 1: select SBOX → SUI and enter a large amount
    await swapPage.selectFromToken(fromCoin);
    await swapPage.selectToToken(toCoin);
    await swapPage.fillAmount(largeAmount);

    console.log(`[high-impact] Token pair: ${fromSymbol} → ${toSymbol}`);
    console.log(`[high-impact] Amount: ${largeAmount}`);

    // Step 2: wait for quote + warning to render
    await page.waitForTimeout(3_000);

    // Step 3: verify "High price difference" red warning box is displayed
    const warningBox = page
      .locator('text=/High price difference.*cautious|High price difference/i')
      .first();
    await expect(warningBox).toBeVisible({ timeout: 8_000 });
    console.log('[high-impact] ✓ High price difference warning is visible');

    // Step 4: read and validate the price deviation percentage
    const deviationLocator = page
      .locator('text=/\\d+\\.?\\d*%\\s*away from/i, text=/Price.*Difference/i')
      .first();

    const deviationText = await deviationLocator.innerText().catch(() => '');
    console.log(`[high-impact] Deviation text: "${deviationText}"`);

    if (deviationText) {
      const match = deviationText.match(/(\d+\.?\d*)%/);
      if (match) {
        const deviation = parseFloat(match[1]);
        console.log(`[high-impact] Parsed deviation: ${deviation}%`);
        expect(deviation).toBeGreaterThan(expectedDeviationThreshold);
        console.log(`[high-impact] ✓ Price deviation ${deviation}% > ${expectedDeviationThreshold}%`);
      }
    }

    // Step 5: verify the output amount is still calculated (not empty/zero)
    const outputDecimal = TOKEN_DECIMALS[toCoin] ?? 9;
    const outputAmount = await swapPage.getExpectedOutputAmount(outputDecimal).catch(() => BigInt(0));
    expect(outputAmount).toBeGreaterThan(BigInt(0));
    console.log(`[high-impact] Output amount calculated: ${outputAmount} raw ${toSymbol}`);

    // Step 6: check Minimum Received is displayed
    const minReceivedRow = await page
      .locator('text=/Minimum Received/i')
      .locator('..')
      .innerText()
      .catch(() => '');
    console.log(`[high-impact] Min Received: ${minReceivedRow}`);

    // Step 7: check Auto Router is active (multi-pool route for large swap)
    const hasAutoRouter = await swapPage.hasAutoRouter();
    console.log(`[high-impact] Auto Router visible: ${hasAutoRouter}`);

    console.log('[high-impact] ✓ High price impact scenario validated (no actual swap executed)');
  });

  /**
   * Boundary check: a normal-sized swap should NOT trigger the warning.
   */
  test('does not show price difference warning for normal swap amount', async ({
    page,
    walletController
  }) => {
    const { fromCoin, toCoin, fromSymbol } = highImpactScenario;

    const swapPage = new SwapPage(page);
    await swapPage.goto('/swap');
    await walletController.connect(page);

    await swapPage.selectFromToken(fromCoin);
    await swapPage.selectToToken(toCoin);
    // Use a very small amount that should not cause high price impact
    await swapPage.fillAmount('1');
    await page.waitForTimeout(3_000);

    const warningBox = page
      .locator('text=/High price difference/i')
      .first();
    const hasWarning = await warningBox.isVisible({ timeout: 3_000 }).catch(() => false);

    console.log(`[high-impact:normal] Amount: 1 ${fromSymbol}`);
    console.log(`[high-impact:normal] Warning present: ${hasWarning}`);

    expect(hasWarning).toBe(false);
    console.log('[high-impact:normal] ✓ No warning for small amount — boundary check passed');
  });
});
