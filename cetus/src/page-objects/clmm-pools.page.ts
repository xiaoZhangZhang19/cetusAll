import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import {
  buildPairPattern,
  ensureTokenCheckedInFilter,
  escapeRegExp,
  findFirstPoolRowByPair,
  openTokenFilterPanel,
  resolveTokenFilterTrigger
} from './pools-shared.js';

export class ClmmPoolsPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto('/pools', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
  }

  async openClmmTab() {
    // On Cetus pools page CLMM is often the default selected mode and rendered as a
    // custom chip (not always role=tab/button). If pool rows are already visible, skip.
    if (
      (await this.page.getByRole('button', { name: /deposit/i }).first().isVisible({ timeout: 4_000 }).catch(() => false)) &&
      (await this.page.getByText(/pools/i).first().isVisible().catch(() => false))
    ) {
      return;
    }

    const clmmTab = this.page.getByRole('tab', { name: /clmm/i }).first();
    if (await clmmTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await clmmTab.click();
      return;
    }

    const clmmButton = this.page
      .locator('button, [role="button"], [role="tab"], div')
      .filter({ hasText: /^\s*clmm\b/i })
      .first();
    await expect(clmmButton).toBeVisible({ timeout: 10_000 });
    await clmmButton.click().catch(async () => {
      // Fallback for custom chips that only react on direct pointer events.
      const box = await clmmButton.boundingBox();
      if (!box) throw new Error('CLMM switch is visible but cannot be clicked');
      await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
  }

  async openDepositForPair(baseSymbol: string, quoteSymbol: string) {
    const filterTrigger = await resolveTokenFilterTrigger(this.page);

    // Follow the manual flow: open "Filter by token" and tick target tokens.
    await openTokenFilterPanel(this.page, filterTrigger);
    await ensureTokenCheckedInFilter(this.page, baseSymbol, filterTrigger);
    await ensureTokenCheckedInFilter(this.page, quoteSymbol, filterTrigger);

    // Close filter popover/list so the rows are actionable.
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.page.waitForTimeout(400);

    const pairRow = await findFirstPoolRowByPair(this.page, buildPairPattern(baseSymbol, quoteSymbol), filterTrigger);
    const rowDepositButton = pairRow.getByRole('button', { name: /deposit/i }).first();
    if (await rowDepositButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await rowDepositButton.click();
      await this.waitForDepositFormReady();
      return;
    }

    await pairRow.click({ force: true }).catch(async () => {
      const box = await pairRow.boundingBox();
      if (!box) throw new Error(`Pool row for ${baseSymbol}-${quoteSymbol} is not clickable`);
      await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    await this.page.waitForTimeout(500);

    const depositButtons = this.page.getByRole('button', { name: /deposit/i });
    await expect(depositButtons.first()).toBeVisible({ timeout: 15_000 });
    await depositButtons.first().click();
    await this.waitForDepositFormReady();
    return;
  }

  async fillTokenAmount(tokenSymbol: string, amount: string) {
    const amountInputSelector =
      'input[inputmode="decimal"], input[type="number"], input[type="text"], [contenteditable="true"], [role="textbox"]';
    const tokenPattern = new RegExp(`^${escapeRegExp(tokenSymbol)}$`, 'i');
    const depositTitle = this.page.getByText(/^deposit amounts$/i).first();
    await expect(depositTitle).toBeVisible({ timeout: 15_000 });

    // Anchor to the nearest card that owns the "Deposit Amounts" title.
    // This avoids grabbing outer wrappers that also contain left-side range inputs.
    const depositPanel = depositTitle.locator('xpath=ancestor::*[self::div or self::section][2]');
    await expect(depositPanel).toBeVisible({ timeout: 10_000 });

    // Prefer exact token row under the "Deposit Amounts" panel, so we don't fill
    // unrelated inputs (e.g. price range / min-max controls on the left).
    const tokenLabel = depositPanel.getByText(tokenPattern).first();
    if (await tokenLabel.isVisible({ timeout: 5_000 }).catch(() => false)) {
      for (const depth of [1, 2, 3]) {
        const row = tokenLabel.locator(`xpath=ancestor::*[self::div or self::section][${depth}]`);
        const rowInput = row.locator(amountInputSelector).last();
        if (await rowInput.isVisible({ timeout: 1_500 }).catch(() => false)) {
          await rowInput.fill(amount);
          return;
        }
      }
    }

    // Fallback: inside "Deposit Amounts", SUI is usually first and USDC second.
    const panelInputs = depositPanel.locator(amountInputSelector).filter({ hasNotText: /min|max|price/i });
    const total = await panelInputs.count();
    const preferredIndex = /sui/i.test(tokenSymbol) ? 0 : 1;
    if (total > preferredIndex) {
      const preferredInput = panelInputs.nth(preferredIndex);
      if (await preferredInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await preferredInput.fill(amount);
        return;
      }
    }

    // Last fallback: any visible input in the deposit panel.
    for (let i = 0; i < total; i++) {
      const input = panelInputs.nth(i);
      if (!(await input.isVisible({ timeout: 800 }).catch(() => false))) continue;
      await input.fill(amount);
      return;
    }

    throw new Error(`Cannot find a visible amount input for token "${tokenSymbol}"`);
  }

  private async waitForDepositFormReady() {
    const loadingIndicators = this.page.locator(
      '.chakra-spinner, [class*="spinner"], [class*="loading"], svg[class*="animate-spin"]'
    );
    await loadingIndicators.first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => undefined);

    const formReady = this.page
      .locator(
        'input[inputmode="decimal"], input[type="number"], input[placeholder="0"], input[placeholder="0.0"], button:has-text("Add Liquidity")'
      )
      .first();
    await expect(formReady).toBeVisible({ timeout: 45_000 });
  }

  async submitAddLiquidity() {
    const addLiquidityButton = this.page.getByRole('button', { name: /add liquidity/i }).first();
    await expect(addLiquidityButton).toBeVisible({ timeout: 15_000 });
    await expect(addLiquidityButton).toBeEnabled({ timeout: 15_000 });
    await addLiquidityButton.click();

    // Cetus shows a confirmation modal after the first click. Confirm inside modal.
    const confirmDialog = this.page
      .locator('[role="dialog"], .chakra-modal__content')
      .filter({ hasText: /add liquidity/i })
      .last();
    const hasConfirmDialog = await confirmDialog.isVisible({ timeout: 8_000 }).catch(() => false);
    if (!hasConfirmDialog) return;

    const confirmAddLiquidity = confirmDialog.getByRole('button', { name: /^add liquidity$/i }).first();
    await expect(confirmAddLiquidity).toBeVisible({ timeout: 10_000 });
    await expect(confirmAddLiquidity).toBeEnabled({ timeout: 10_000 });
    await confirmAddLiquidity.click();
  }

  async expectAddLiquiditySuccess() {
    const successText = this.page.getByText(/success|liquidity added|transaction submitted|view in explorer/i).first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
  }
}
