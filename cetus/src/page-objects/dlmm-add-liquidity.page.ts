import type { Page } from '@playwright/test';

import { AddLiquidityBasePage } from './add-liquidity-base.page.js';

export type { TokenAmounts } from './add-liquidity-base.page.js';

/**
 * Page Object for adding more liquidity to an existing DLMM position.
 *
 * Flow:
 *   1. goto()                           → /pools?tab=positions
 *   2. filterByDlmm()                   → click "DLMM" sub-filter chip
 *   3. openAddLiquidityForPair(b, q)    → click "+" → /position-detail/{id}
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
 *
 * URL 说明：DLMM 点击 "+" 后跳转到 /position-detail/{id}（无 /increase 后缀），
 * 与 CLMM 的 /position-detail/{id}/increase 不同。
 */
export class DlmmAddLiquidityPage extends AddLiquidityBasePage {
  constructor(page: Page) {
    super(page);
  }

  // DLMM position detail URL does NOT have "/increase"
  // Clicking "+" goes directly to the position page with the Add form already shown.
  protected get positionPageUrlPattern(): RegExp {
    return /position-detail/i;
  }

  /** Click the "DLMM" sub-filter chip inside My Positions. */
  async filterByDlmm() {
    await this.clickSubFilterChip('dlmm');
    await this.page.waitForTimeout(1_500);
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  }

  /** Find the DLMM pair card and click the "+" button. */
  async openAddLiquidityForPair(baseSymbol: string, quoteSymbol: string) {
    await this.openPlusButtonForPair(baseSymbol, quoteSymbol, 'dlmm');
  }

  /**
   * Override fillTokenAmount for DLMM: after filling SUI, the form calculates
   * USDC asynchronously (shows a spinner). We wait for the spinner to settle
   * before returning so that readDepositFormAmounts() gets the final values.
   */
  override async fillTokenAmount(tokenSymbol: string, amount: string) {
    await super.fillTokenAmount(tokenSymbol, amount);

    // Wait for the async USDC calculation spinner to disappear
    const spinnerSelectors = [
      'svg[class*="animate-spin"]',
      '[class*="spinner"]',
      '[class*="loading"]',
      '.chakra-spinner',
    ].join(', ');
    const spinner = this.page.locator(spinnerSelectors);
    await spinner.first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    // Extra settle time to allow React state to flush
    await this.page.waitForTimeout(1_000);
  }
}
