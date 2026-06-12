import { clmmScenario } from '@/fixtures/scenarios.js';
import { ClmmPoolsPage } from '@/page-objects/clmm-pools.page.js';

import { test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet CLMM', () => {
  test(`opens ${clmmScenario.baseSymbol}-${clmmScenario.quoteSymbol} CLMM deposit flow and submits add liquidity`, async ({ page, walletController }) => {
    const clmmPage = new ClmmPoolsPage(page);
    await clmmPage.goto();

    await walletController.connect(page);
    await clmmPage.openClmmTab();
    await clmmPage.openDepositForPair(clmmScenario.baseSymbol, clmmScenario.quoteSymbol);
    await clmmPage.fillTokenAmount(clmmScenario.inputTokenSymbol, clmmScenario.inputAmountUi);
    await clmmPage.submitAddLiquidity();
    await walletController.approveTransaction(page);
    await clmmPage.expectAddLiquiditySuccess();
  });
});
