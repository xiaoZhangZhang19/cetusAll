import { clmmRemoveScenario } from '@/fixtures/scenarios.js';
import { ClmmRemovePage } from '@/page-objects/clmm-remove.page.js';

import { test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet CLMM Remove', () => {
  test(`removes ${clmmRemoveScenario.baseSymbol}-${clmmRemoveScenario.quoteSymbol} CLMM liquidity with configured token max amount`, async ({ page, walletController }) => {
    const removePage = new ClmmRemovePage(page);
    await removePage.goto();

    await walletController.connect(page);

    // 必须先点 "My Positions"，否则列表还是「全部池子」，找不到持仓卡片
    await removePage.openMyPositions();

    // Filter by CLMM to ensure we're viewing CLMM positions only
    await removePage.filterByClmm();
    
    await removePage.openClmmPositionsForPair(clmmRemoveScenario.baseSymbol, clmmRemoveScenario.quoteSymbol);
    await removePage.openFirstPositionRemovePanel();
    await removePage.switchToRemoveTab();
    await removePage.clickMaxForToken(clmmRemoveScenario.removeTokenSymbol);
    await removePage.submitRemove();
    await walletController.approveTransaction(page);
    await removePage.expectSuccess();
  });
});
