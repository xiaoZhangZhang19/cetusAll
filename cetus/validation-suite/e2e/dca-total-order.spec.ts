import { dcaScenario } from '@/fixtures/scenarios.js';
import { DcaPage } from '@/page-objects/dca.page.js';

import { expect, test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet DCA Order', () => {
  test('creates a SUI to USDC DCA order from live SUI price', async ({ page, walletController }) => {
    const dcaPage = new DcaPage(page);
    await dcaPage.goto();

    await walletController.connect(page);
    await dcaPage.selectFromToken(dcaScenario.inputCoinType);
    await dcaPage.selectToToken(dcaScenario.outputCoinType);

    const price = await dcaPage.readCurrentSuiPriceUsd();
    const { totalAmount, lowerPrice, upperPrice } = await dcaPage.fillOrderByPrice(price);
    console.log(
      `[dca:e2e] price=${price.toFixed(4)} totalAmount=${totalAmount} lower=${lowerPrice} upper=${upperPrice}`
    );

    const inputs = page.locator('input');
    await expect(inputs.nth(0)).toHaveValue(totalAmount);
    await expect(inputs.nth(3)).toHaveValue(lowerPrice);
    await expect(inputs.nth(4)).toHaveValue(upperPrice);

    await dcaPage.submitDcaOrder();
    await walletController.approveTransaction(page);
    await dcaPage.expectOrderSubmitted();
  });
});
