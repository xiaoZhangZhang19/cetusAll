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

export class ClmmRemovePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * 进入池子列表页（CLMM tab）。
   *
   * 直接 goto('/pools?tab=positions') 会落到 CLMM 池子列表、持仓列表不渲染，
   * 所以切持仓统一由 openMyPositions() 点击 "My Positions" 完成。
   */
  async goto() {
    await gotoPoolsList(this.page);
  }

  /**
   * 点击 "My Positions" tab 切到持仓列表。幂等，可在任意步骤前调用。
   */
  async openMyPositions() {
    await openMyPositionsTab(this.page);
  }

  /**
   * Click the "CLMM" sub-filter chip inside My Positions filter row.
   * This ensures we're viewing CLMM positions only, not DLMM.
   */
  async filterByClmm() {
    await this.clickSubFilterChip('clmm');
  }

  /**
   * Click the CLMM or DLMM sub-filter chip inside the My Positions filter row.
   * 内部会先确保处在 My Positions 视图（见 pools-shared 里的实现说明）。
   */
  private async clickSubFilterChip(poolType: 'clmm' | 'dlmm') {
    await clickPositionsSubFilterChip(this.page, poolType);
  }

  async openClmmPositionsForPair(baseSymbol: string, quoteSymbol: string) {
    // 持仓卡片只在 My Positions 视图里；openMyPositionsTab 是幂等的，
    // 已经在持仓视图时直接返回，不会重置 CLMM 子筛选。
    await this.openMyPositions();

    const pairPattern = buildPairPattern(baseSymbol, quoteSymbol);

    const pairCard = this.page
      .locator('div')
      .filter({ hasText: pairPattern })
      .filter({ hasText: /clmm/i })
      .first();
    await expect(pairCard).toBeVisible({ timeout: 15_000 });
    await pairCard.click();
  }

  async openFirstPositionRemovePanel() {
    // 1) Preferred: textual minus button.
    const byTextMinus = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^\s*-\s*$/ })
      .first();
    if (await byTextMinus.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await byTextMinus.click();
      return;
    }

    // 2) Icon-only minus button (common on Cetus positions list).
    const iconMinus = this.page
      .locator(
        'button:has(svg[class*="minus" i]), button:has(i[class*="minus" i]), button[aria-label*="minus" i], button[title*="minus" i]'
      )
      .first();
    if (await iconMinus.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await iconMinus.click();
      return;
    }

    // 3) Fallback for icon-only action buttons: click first button in the "Actions" column.
    const clicked = await this.clickFirstRemoveButtonInActionsColumn();
    if (clicked) return;

    throw new Error('Cannot find clickable remove (-) button in positions list');
  }

  async switchToRemoveTab() {
    const removeTab = this.page.getByRole('button', { name: /^remove$/i }).first();
    if (await removeTab.isVisible({ timeout: 6_000 }).catch(() => false)) {
      await removeTab.click();
      return;
    }

    const removeText = this.page.locator('button, [role="button"], div').filter({ hasText: /^remove$/i }).first();
    await expect(removeText).toBeVisible({ timeout: 10_000 });
    await removeText.click();
  }

  async clickMaxForToken(tokenSymbol?: string) {
    await clickMaxForTokenInRemovePanel(this.page, tokenSymbol);
  }

  /** 关掉 "Transaction Completed" 弹窗（范围限定在弹窗内部找关闭按钮）。 */
  async closeTransactionModal() {
    await closeTransactionCompletedModal(this.page);
  }

  /**
   * 刷新 /position-detail/{id}/remove 页并等 Remove 面板重新挂载。
   *
   * 供交易后「等仓位数据刷新」的轮询兜底用：前端偶发不会自己重拉仓位。
   * ⚠️ 刷新会把 Zap Out 开关、输入金额等面板状态重置回默认，
   * 调用方如果还要继续操作面板，必须重新走一遍 enableZapOut() 之类的步骤。
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

    // Some flows show an in-page confirmation dialog, while others jump directly
    // to wallet approval. Treat this step as optional and non-blocking.
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
