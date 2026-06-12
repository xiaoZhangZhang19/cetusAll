/**
 * Test: DCA order in "Per Order" mode.
 *
 * Difference from Total mode:
 *   - "Total" mode  : the input amount is the TOTAL SUI across all order cycles.
 *   - "Per Order" mode : the input amount is the SUI spent PER SINGLE order cycle.
 *
 * Amount logic (same $3 baseline as Total mode):
 *   perOrderAmount = ceil($3 / suiPrice, 1 decimal)  — meets minimum per-cycle requirement
 *   Price range    = market price ±10 %
 */

import { dcaScenario } from '@/fixtures/scenarios.js';
import { DcaPage } from '@/page-objects/dca.page.js';
import { getSuiPriceUsd } from '@/chain/price.js';

import { expect, test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet DCA Order (Per Order mode)', () => {
  test('creates a SUI to USDC DCA order in Per Order mode', async ({ page, walletController }) => {
    const dcaPage = new DcaPage(page);
    await dcaPage.goto();

    await walletController.connect(page);
    await dcaPage.selectFromToken(dcaScenario.inputCoinType);
    await dcaPage.selectToToken(dcaScenario.outputCoinType);

    // Switch input mode to "Per Order" before filling the amount
    await dcaPage.switchToPerOrderMode();
    console.log('[dca-per-order:e2e] mode switched  : Per Order');

    // Get live SUI price from Pyth Network (more accurate than parsing page body)
    const price = await getSuiPriceUsd();
    console.log(`[dca-per-order:e2e] SUI price (Pyth): $${price.toFixed(4)}`);

    // Fill the per-order amount + price range
    const { perOrderAmount, lowerPrice, upperPrice } = await dcaPage.fillPerOrderByPrice(price);
    console.log(
      `[dca-per-order:e2e] price=${price.toFixed(4)} perOrder=${perOrderAmount} ` +
      `lower=${lowerPrice} upper=${upperPrice}`
    );

    // Verify values were applied correctly
    const inputs = page.locator('input');
    await expect(inputs.nth(0)).toHaveValue(perOrderAmount);
    await expect(inputs.nth(3)).toHaveValue(lowerPrice);
    await expect(inputs.nth(4)).toHaveValue(upperPrice);

    // Submit and approve
    await dcaPage.submitDcaOrder();
    await walletController.approveTransaction(page);
    await dcaPage.expectOrderSubmitted();

    console.log('[dca-per-order:e2e] result          : DCA Per Order created successfully ✓');
  });
});
