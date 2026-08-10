import { marginScenario } from '@/fixtures/scenarios.js';
import { MarginPage } from '@/page-objects/margin.page.js';
import { getReferencePriceFromAggregator } from '@/protocol/quotes.js';

import { test } from '../setup/fixtures.js';

const SUI_DECIMALS = 9;
const USDC_DECIMALS = 6;

test.describe('Cetus Mainnet Margin', () => {
  test(`opens ${marginScenario.baseSymbol}/${marginScenario.quoteSymbol} short with 3x leverage from SDK quote`, async ({
    page,
    walletController
  }) => {
    const marginPage = new MarginPage(page);
    await marginPage.goto(marginScenario.path);

    await walletController.connect(page);
    await marginPage.dismissRiskAcknowledgementIfPresent();
    await marginPage.selectTradingPair(marginScenario.baseSymbol, marginScenario.quoteSymbol);

    // codegen line 8: getByText('Sell / Short').click()
    await marginPage.switchToSellShort();

    // 开空默认存入 USDC，但测试钱包 USDC 余额不足，切换为 SUI
    await marginPage.selectDepositToken(marginScenario.baseSymbol);

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

    // codegen lines 9-10: fill deposit amount
    await marginPage.fillDepositAmount(depositAmount);

    // codegen lines 11-13: set leverage to 3x
    await marginPage.maximizeLeverage();

    // codegen line 21: Open SUI Short (wrapped with wallet approval)
    await walletController.approveTransactionForAction(page, async () => {
      await marginPage.submitOpenShort(marginScenario.baseSymbol);
    });

    // codegen line 26: wait for Close button on success dialog
    await marginPage.expectOpenShortSuccess();
  });
});
