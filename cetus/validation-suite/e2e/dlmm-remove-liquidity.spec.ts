import { dlmmRemoveScenario } from '@/fixtures/scenarios.js';
import { DlmmRemovePage } from '@/page-objects/dlmm-remove.page.js';

import { test } from '../setup/fixtures.js';

test.describe('Cetus Mainnet DLMM Remove', () => {
  test(`removes ${dlmmRemoveScenario.baseSymbol}-${dlmmRemoveScenario.quoteSymbol} DLMM liquidity with configured token max amount`, async ({ page, walletController }) => {
    const removePage = new DlmmRemovePage(page);
    await removePage.goto();

    await walletController.connect(page);
    
    // Filter by DLMM to ensure we're viewing DLMM positions only
    await removePage.filterByDlmm();
    
    await removePage.openDlmmPositionsForPair(dlmmRemoveScenario.baseSymbol, dlmmRemoveScenario.quoteSymbol);
    await removePage.openFirstPositionRemovePanel();
    await removePage.switchToRemoveTab();
    await removePage.clickMaxForToken(dlmmRemoveScenario.removeTokenSymbol);
    await removePage.submitRemove();
    await walletController.approveTransaction(page);
    await removePage.expectSuccess();
  });
});
