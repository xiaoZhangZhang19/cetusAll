import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import {
  buildPairPattern,
  ensureTokenCheckedInFilter,
  findFirstPoolRowByPair,
  openTokenFilterPanel,
  resolveTokenFilterTrigger
} from './pools-shared.js';

export class DlmmPoolsPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto('/pools?tab=dlmm_pools', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
  }

  async openDepositForPair(baseSymbol: string, quoteSymbol: string) {
    const filterTrigger = await resolveTokenFilterTrigger(this.page);
    await openTokenFilterPanel(this.page, filterTrigger);
    await ensureTokenCheckedInFilter(this.page, baseSymbol, filterTrigger);
    await ensureTokenCheckedInFilter(this.page, quoteSymbol, filterTrigger);
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.page.waitForTimeout(400);

    const pairRow = await findFirstPoolRowByPair(this.page, buildPairPattern(baseSymbol, quoteSymbol), filterTrigger);
    const rowDepositButton = pairRow.getByRole('button', { name: /deposit/i }).first();
    if (await rowDepositButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await rowDepositButton.click();
      await this.waitForProvideLiquidityView();
      return;
    }

    await pairRow.click({ force: true }).catch(async () => {
      const box = await pairRow.boundingBox();
      if (!box) throw new Error(`DLMM row for ${baseSymbol}-${quoteSymbol} is not clickable`);
      await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    await this.page.waitForTimeout(500);

    const depositButtons = this.page.getByRole('button', { name: /deposit/i });
    await expect(depositButtons.first()).toBeVisible({ timeout: 15_000 });
    const total = await depositButtons.count();
    for (let i = 0; i < total; i++) {
      const button = depositButtons.nth(i);
      if (!(await button.isVisible({ timeout: 1_000 }).catch(() => false))) continue;
      await button.click();
      await this.waitForProvideLiquidityView();
      return;
    }

    throw new Error(`No visible expanded Deposit button found after filtering by ${baseSymbol} and ${quoteSymbol}`);
  }

  async fillPrimaryDepositAmount(amount: string) {
    const depositTitle = this.page.getByText(/^deposit amounts$/i).first();
    await expect(depositTitle).toBeVisible({ timeout: 15_000 });
    const depositPanel = depositTitle.locator('xpath=ancestor::*[self::div or self::section][2]');
    await expect(depositPanel).toBeVisible({ timeout: 10_000 });

    // Red-box field in your screenshot: first amount input under Deposit Amounts.
    const firstAmountInput = depositPanel
      .locator('input[inputmode="decimal"], input[type="number"], input[type="text"], [contenteditable="true"], [role="textbox"]')
      .first();
    await expect(firstAmountInput).toBeVisible({ timeout: 10_000 });
    await firstAmountInput.fill(amount);

    await this.waitForProvideLiquidityView();
  }

  async submitAddLiquidity() {
    const addLiquidityButton = this.page.getByRole('button', { name: /^add liquidity$/i }).first();
    await expect(addLiquidityButton).toBeVisible({ timeout: 15_000 });
    await expect(addLiquidityButton).toBeEnabled({ timeout: 15_000 });
    await addLiquidityButton.click();

    const confirmDialog = this.page
      .locator('[role="dialog"], .chakra-modal__content')
      .filter({ hasText: /add liquidity/i })
      .last();
    const hasDialog = await confirmDialog.isVisible({ timeout: 8_000 }).catch(() => false);
    if (!hasDialog) return;

    const confirmButton = confirmDialog.getByRole('button', { name: /^add liquidity$/i }).first();
    await expect(confirmButton).toBeVisible({ timeout: 10_000 });
    await expect(confirmButton).toBeEnabled({ timeout: 10_000 });
    await confirmButton.click();
  }

  async expectSuccess() {
    const successText = this.page.getByText(/success|completed|submitted|view in explorer/i).first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
  }

  private async waitForProvideLiquidityView() {
    await expect(this.page.getByText(/provide liquidity/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(this.page.getByText(/deposit amounts/i).first()).toBeVisible({ timeout: 30_000 });
  }
}
