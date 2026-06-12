import { dlmmScenario } from '@/fixtures/scenarios.js';
import { DlmmPoolsPage } from '@/page-objects/dlmm-pools.page.js';

import { test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet DLMM', () => {
  test(`opens ${dlmmScenario.baseSymbol}-${dlmmScenario.quoteSymbol} DLMM and submits add liquidity`, async ({ page, walletController }) => {
    const dlmmPage = new DlmmPoolsPage(page);
    await dlmmPage.goto();

    await walletController.connect(page);
    await dlmmPage.openDepositForPair(dlmmScenario.baseSymbol, dlmmScenario.quoteSymbol);
    await dlmmPage.fillPrimaryDepositAmount(dlmmScenario.inputAmountUi);
    await dlmmPage.submitAddLiquidity();
    await walletController.approveTransaction(page);
    await dlmmPage.expectSuccess();
  });
});
