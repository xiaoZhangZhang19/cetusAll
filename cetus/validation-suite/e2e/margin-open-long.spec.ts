import { marginScenario } from '@/fixtures/scenarios.js';
import { MarginPage } from '@/page-objects/margin.page.js';
import { getReferencePriceFromAggregator } from '@/protocol/quotes.js';

import { test } from '../setup/fixtures.js';

const SUI_DECIMALS = 9;
const USDC_DECIMALS = 6;

test.describe('Cetus Mainnet Margin', () => {
  test(`opens ${marginScenario.baseSymbol}/${marginScenario.quoteSymbol} long with 3x leverage from SDK quote`, async ({
    page,
    walletController
  }) => {
    const marginPage = new MarginPage(page);
    await marginPage.goto(marginScenario.path);

    await walletController.connect(page);
    await marginPage.dismissRiskAcknowledgementIfPresent();
    await marginPage.selectTradingPair(marginScenario.baseSymbol, marginScenario.quoteSymbol);
    await marginPage.switchToBuyLong();

    const price = await getReferencePriceFromAggregator({
      fromCoinType: marginScenario.inputCoinType,
      targetCoinType: marginScenario.outputCoinType,
      fromDecimals: SUI_DECIMALS,
      targetDecimals: USDC_DECIMALS
    });
    const depositAmount = String(Math.ceil(marginScenario.targetNotionalUsd / price));
    console.log(
      `[margin:e2e] price=${price.toFixed(6)} targetUsd=${marginScenario.targetNotionalUsd} depositAmount=${depositAmount}`
    );

    await marginPage.fillDepositAmount(depositAmount);
    await marginPage.maximizeLeverage();
    await walletController.approveTransactionForAction(page, async () => {
      await marginPage.submitOpenLong(marginScenario.baseSymbol);
    });
    await marginPage.expectOpenLongSuccess();
  });
});
