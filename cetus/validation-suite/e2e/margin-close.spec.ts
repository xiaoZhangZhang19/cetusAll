import { marginScenario } from '@/fixtures/scenarios.js';
import { MarginPage } from '@/page-objects/margin.page.js';

import { test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet Margin', () => {
  test(`closes ${marginScenario.baseSymbol}/${marginScenario.quoteSymbol} position`, async ({
    page,
    walletController
  }) => {
    const marginPage = new MarginPage(page);
    await marginPage.goto(marginScenario.path);

    await walletController.connect(page);
    await marginPage.dismissRiskAcknowledgementIfPresent();
    await marginPage.selectTradingPair(marginScenario.baseSymbol, marginScenario.quoteSymbol);
    await marginPage.startCloseFromPositionsTable(marginScenario.baseSymbol, marginScenario.quoteSymbol);
    await walletController.approveTransactionForAction(page, async () => {
      await marginPage.confirmClosePositionInModal();
    });
    await marginPage.expectClosePositionSuccess();
  });
});
