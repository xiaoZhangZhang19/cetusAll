import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { dismissCetusTerms } from '@/utils/dismiss-terms.js';

import {
  buildPairPattern,
  clickFirstActionButtonInActionsColumn,
  clickMaxForTokenInRemovePanel,
  clickPositionsSubFilterChip,
  closeTransactionCompletedModal,
  gotoPoolsList,
  openMyPositionsTab
} from './pools-shared.js';

export class DlmmRemovePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * 进入池子列表页。直接 goto('/pools?tab=positions') 会落到池子列表、
   * 持仓列表不渲染，所以切持仓统一由 openMyPositions() 点 "My Positions" 完成。
   */
  async goto() {
    await gotoPoolsList(this.page);
  }

  /** 点击 "My Positions" tab 切到持仓列表。幂等，可在任意步骤前调用。 */
  async openMyPositions() {
    await openMyPositionsTab(this.page);
  }

  /**
   * Click the "DLMM" sub-filter chip inside My Positions filter row.
   * This ensures we're viewing DLMM positions only, not CLMM.
   */
  async filterByDlmm() {
    await this.clickSubFilterChip('dlmm');
    // Wait for filter to take effect and positions to reload
    await this.page.waitForTimeout(1_500);
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  }

  /**
   * Click the CLMM or DLMM sub-filter chip inside the My Positions filter row.
   * 内部会先确保处在 My Positions 视图（见 pools-shared 里的实现说明）。
   */
  private async clickSubFilterChip(poolType: 'clmm' | 'dlmm') {
    await clickPositionsSubFilterChip(this.page, poolType);
  }

  async openDlmmPositionsForPair(baseSymbol: string, quoteSymbol: string) {
    // 持仓卡片只在 My Positions 视图里；openMyPositionsTab 是幂等的，
    // 已经在持仓视图时直接返回，不会重置 DLMM 子筛选。
    await this.openMyPositions();

    const pairPattern = buildPairPattern(baseSymbol, quoteSymbol);

    const filterInput = this.page
      .locator('input[placeholder*="filter" i], input[placeholder*="token" i], input[type="search"]')
      .first();
    if (await filterInput.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await filterInput.fill(`${baseSymbol}-${quoteSymbol}`.toLowerCase());
      await this.page.waitForTimeout(400);
    }

    await expect(this.page.getByText(pairPattern).first()).toBeVisible({ timeout: 15_000 });
  }

  async openFirstPositionRemovePanel() {
    // Same strategy as CLMM remove.
    const byTextMinus = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^\s*-\s*$/ })
      .first();
    if (await byTextMinus.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await byTextMinus.click();
      return;
    }

    const iconMinus = this.page
      .locator(
        'button:has(svg[class*="minus" i]), button:has(i[class*="minus" i]), button[aria-label*="minus" i], button[title*="minus" i]'
      )
      .first();
    if (await iconMinus.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await iconMinus.click();
      return;
    }

    const clicked = await this.clickFirstRemoveButtonInActionsColumn();
    if (clicked) return;

    throw new Error('Cannot find clickable remove (-) button in DLMM positions list');
  }

  async switchToRemoveTab() {
    // Some DLMM positions may show the remove panel directly without tabs.
    // First check if we're already on a remove view by looking for remove-specific elements.
    const removePanel = this.page
      .locator('section, div')
      .filter({ hasText: /remove amounts|remove amount/i })
      .first();
    
    if (await removePanel.isVisible({ timeout: 2_000 }).catch(() => false)) {
      // Already on remove view, no tab switch needed
      return;
    }

    // Try to click the Remove tab
    const removeTab = this.page.getByRole('button', { name: /^remove$/i }).first();
    if (await removeTab.isVisible({ timeout: 6_000 }).catch(() => false)) {
      await removeTab.click();
      await this.page.waitForTimeout(500);
      return;
    }

    const removeText = this.page
      .locator('button, [role="button"], div')
      .filter({ hasText: /^remove$/i })
      .first();
    
    if (await removeText.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await removeText.click();
      await this.page.waitForTimeout(500);
      return;
    }

    // If no tab found, assume we're already in the correct view
    console.log('[DLMM Remove] No Remove tab found, assuming already in remove view');
  }

  async clickMaxForToken(tokenSymbol?: string) {
    await clickMaxForTokenInRemovePanel(this.page, tokenSymbol);
  }

  /** 关掉 "Transaction Completed" 弹窗（范围限定在弹窗内部找关闭按钮）。 */
  async closeTransactionModal() {
    await closeTransactionCompletedModal(this.page);
  }

  /**
   * 刷新仓位详情页并等 Remove 面板重新挂载。
   *
   * 供交易后「等仓位数据刷新」的轮询兜底用：前端偶发不会自己重拉仓位。
   * ⚠️ 刷新会重置 Zap Out 开关和输入金额，调用方要继续操作面板得重新设置。
   */
  async reloadAndWaitForRemovePanel() {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await dismissCetusTerms(this.page, { timeout: 5_000 }).catch(() => undefined);
    await this.switchToRemoveTab().catch(() => undefined);
    await expect(this.page.getByText(/^remove amounts?$/i).first()).toBeVisible({ timeout: 20_000 });
    await this.page.waitForTimeout(1_000);
  }

  async submitRemove() {
    const removePanel = this.page
      .locator('section, div')
      .filter({ hasText: /remove amounts|remove amount/i })
      .first();

    const submitButton = removePanel.getByRole('button', { name: /^remove$/i }).last();
    await expect(submitButton).toBeVisible({ timeout: 10_000 });
    await expect(submitButton).toBeEnabled({ timeout: 10_000 });
    await submitButton.click();

    const confirmDialog = this.page.locator('[role="dialog"], .chakra-modal__content').last();
    const hasDialog = await confirmDialog.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasDialog) return;

    const confirmButton = confirmDialog
      .locator('button, [role="button"]')
      .filter({ hasText: /^remove$|^confirm$|^approve$/i })
      .first();
    const hasConfirmButton = await confirmButton.isVisible({ timeout: 4_000 }).catch(() => false);
    if (!hasConfirmButton) return;
    if (!(await confirmButton.isEnabled().catch(() => false))) return;
    await confirmButton.click();
  }

  async expectSuccess() {
    const successText = this.page.getByText(/success|completed|submitted|view in explorer/i).first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
  }

  private async clickFirstRemoveButtonInActionsColumn(): Promise<boolean> {
    const clicked = await clickFirstActionButtonInActionsColumn(this.page);

    if (clicked) {
      await this.page.waitForTimeout(400);
    }
    return clicked;
  }
}
