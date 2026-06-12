import type { Page } from '@playwright/test';

import { AddLiquidityBasePage } from './add-liquidity-base.page.js';

export type { TokenAmounts } from './add-liquidity-base.page.js';

/**
 * Page Object for adding more liquidity to an existing CLMM position.
 *
 * Flow:
 *   1. goto()                           → /pools?tab=positions
 *   2. filterByClmm()                   → click "CLMM" sub-filter chip
 *   3. openAddLiquidityForPair(b, q)    → click "+" → /position-detail/{id}/increase
 *   4. waitForIncreasePageReady()
 *   5. readPositionAmounts()            → BEFORE amounts
 *   6. fillTokenAmount(symbol, amount)
 *   7. readDepositFormAmounts()
 *   8. submitAddMoreLiquidity()
 *   9. (wallet approval handled externally)
 *  10. waitForTransactionCompletedModal()
 *  11. closeTransactionModal()
 *  12. reloadAndWaitForPositionData()
 *  13. readPositionAmounts()            → AFTER amounts
 *  14. assertAmountsIncreased(...)
 */
export class ClmmAddLiquidityPage extends AddLiquidityBasePage {
  constructor(page: Page) {
    super(page);
  }

  // CLMM position detail URL contains "/increase", e.g. /position-detail/{id}/increase
  protected get positionPageUrlPattern(): RegExp {
    return /position-detail.*increase/i;
  }

  /** Click the "CLMM" sub-filter chip inside My Positions. */
  async filterByClmm() {
    await this.clickSubFilterChip('clmm');
  }

  /** Find the CLMM pair card and click the "+" button. */
  async openAddLiquidityForPair(baseSymbol: string, quoteSymbol: string) {
    await this.openPlusButtonForPair(baseSymbol, quoteSymbol, 'clmm');
  }
}
