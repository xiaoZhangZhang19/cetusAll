import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export class MarginPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(path: string = '/margin') {
    await this.page.goto(path, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
  }

  async dismissRiskAcknowledgementIfPresent() {
    const continueButton = this.page.getByRole('button', { name: /^continue$/i }).first();
    const isVisible = await continueButton.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!isVisible) return;

    // 先勾选风险确认复选框
    const acknowledgeText = this.page.getByText(/I acknowledge and accept all the risk/i).first();
    const isCheckboxVisible = await acknowledgeText.isVisible({ timeout: 2_000 }).catch(() => false);
    
    if (isCheckboxVisible) {
      // 尝试多种方式勾选复选框
      // 方式1: 点击文字左侧的复选框区域
      const box = await acknowledgeText.boundingBox().catch(() => null);
      if (box) {
        await this.page.mouse.click(Math.max(0, box.x - 20), box.y + box.height / 2);
        await this.page.waitForTimeout(300);
      }

      // 方式2: 如果还是禁用状态，强制点击文字本身
      const stillDisabled = !(await continueButton.isEnabled().catch(() => false));
      if (stillDisabled) {
        await acknowledgeText.click({ force: true }).catch(() => undefined);
        await this.page.waitForTimeout(300);
      }

      // 方式3: 在页面中直接执行 DOM 点击
      if (!(await continueButton.isEnabled().catch(() => false))) {
        await this.page.evaluate(() => {
          const modalRoot = document.querySelector('[role="dialog"]') ?? document.body;
          const checkboxContainer = Array.from(
            modalRoot.querySelectorAll<HTMLElement>('div, label, span')
          ).find((el) => /I acknowledge and accept all the risk/i.test(el.textContent ?? ''));
          
          if (checkboxContainer) {
            checkboxContainer.click();
            // 尝试点击可能的 checkbox input
            const checkbox = checkboxContainer.querySelector('input[type="checkbox"]');
            if (checkbox) (checkbox as HTMLInputElement).click();
          }
        }).catch(() => undefined);
        await this.page.waitForTimeout(500);
      }
    }

    // 等待 Continue 按钮启用并点击
    await expect(continueButton).toBeEnabled({ timeout: 10_000 });
    await continueButton.click();
    await continueButton.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  }

  async selectTradingPair(baseSymbol: string, quoteSymbol: string) {
    const pairButton = this.page.getByRole('button', { name: new RegExp(`${baseSymbol}/${quoteSymbol}`, 'i') }).first();
    await expect(pairButton).toBeVisible({ timeout: 10_000 });
    await pairButton.click();
  }

  async switchToBuyLong() {
    const buyButton = this.page.getByRole('button', { name: /^buy$/i }).first();
    const isVisible = await buyButton.isVisible({ timeout: 2_000 }).catch(() => false);
    if (isVisible) {
      await buyButton.click();
    }
  }

  async switchToSellShort() {
    // codegen line 8: getByText('Sell / Short').click()
    await this.page.getByText('Sell / Short').click();
  }

  async fillDepositAmount(amount: string) {
    const amountInput = this.page
      .getByRole('textbox', { name: /^0\.0$|^$/i })
      .first();
    await expect(amountInput).toBeVisible({ timeout: 10_000 });
    await amountInput.click();
    await amountInput.fill(amount);
    
    // 等待页面根据输入金额重新计算（估算借款额、清算价格等）
    await this.page.waitForTimeout(1_000);
    console.log(`[margin] Filled deposit amount: ${amount}`);
  }

  async maximizeLeverage() {
    const leverageInput = this.page.getByRole('textbox').nth(2);
    await leverageInput.dblclick();
    await leverageInput.fill('3x');
    // 等待杠杆输入生效，页面重新计算
    await this.page.waitForTimeout(1_000);
  }

  async submitOpenLong(baseSymbol: string) {
    await this.page.waitForTimeout(2_000);

    const buttonText = `Open ${baseSymbol} Long`;
    const openButton = this.page.locator('button').filter({ hasText: new RegExp(`^\\s*${buttonText}\\s*$`, 'i') }).first();
    await expect(openButton).toBeVisible({ timeout: 10_000 });
    await openButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await expect(openButton).toBeEnabled({ timeout: 20_000 });

    // 第一次点击：可能触发确认弹窗（如价格影响警告）
    console.log(`[margin] First click: "${buttonText}"`);
    await openButton.click();
    await this.page.waitForTimeout(1_500);

    // 如果出现确认弹窗，再次点击 "Open SUI Long" 按钮提交
    const isStillVisible = await openButton.isVisible({ timeout: 2_000 }).catch(() => false);
    if (isStillVisible && await openButton.isEnabled().catch(() => false)) {
      console.log(`[margin] Second click: "${buttonText}" (confirming after dialog)`);
      await openButton.click();
      await this.page.waitForTimeout(1_000);
    }
  }

  async expectOpenLongSuccess() {
    const closeButton = this.page.getByRole('button', { name: /^close$/i }).last();
    await expect(closeButton).toBeVisible({ timeout: 60_000 });
  }

  async submitOpenShort(baseSymbol: string) {
    await this.page.waitForTimeout(2_000);

    const buttonText = `Open ${baseSymbol} Short`;
    const openButton = this.page.locator('button').filter({ hasText: new RegExp(`^\\s*${buttonText}\\s*$`, 'i') }).first();
    await expect(openButton).toBeVisible({ timeout: 10_000 });
    await openButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await expect(openButton).toBeEnabled({ timeout: 20_000 });

    // codegen line 21: getByRole('button', { name: 'Open SUI Short' }).click()
    // 第一次点击：可能触发确认弹窗（如价格影响警告）
    console.log(`[margin] First click: "${buttonText}"`);
    await openButton.click();
    await this.page.waitForTimeout(1_500);

    // 如果出现确认弹窗，再次点击提交
    const isStillVisible = await openButton.isVisible({ timeout: 2_000 }).catch(() => false);
    if (isStillVisible && await openButton.isEnabled().catch(() => false)) {
      console.log(`[margin] Second click: "${buttonText}" (confirming after dialog)`);
      await openButton.click();
      await this.page.waitForTimeout(1_000);
    }
  }

  async expectOpenShortSuccess() {
    // codegen line 26: getByRole('button', { name: 'Close' }).click()
    const closeButton = this.page.getByRole('button', { name: /^close$/i }).last();
    await expect(closeButton).toBeVisible({ timeout: 60_000 });
  }

  async startCloseFromPositionsTable(baseSymbol: string, quoteSymbol: string) {
    // codegen line 25: click Positions tab
    await this.page.locator('div').filter({ hasText: /^Positions$/ }).first().click();
    await this.page.waitForTimeout(1_000);

    // codegen line 26: click the expand SVG on the position row
    await this.page.locator('.css-u7ab40 > svg').click();
    await this.page.waitForTimeout(500);

    // codegen line 27: click "Close" button in the expanded position row
    await this.page.getByRole('button', { name: 'Close' }).click();
    await this.page.waitForTimeout(500);
  }

  async confirmClosePositionInModal() {
    // codegen line 28: click "Close Position" in the confirmation modal
    await this.page.getByRole('button', { name: 'Close Position' }).nth(1).click();
  }

  async expectClosePositionSuccess() {
    // 关仓成功后，Active Positions 数量应减少，或出现成功提示
    // 等待关仓弹窗消失即视为成功
    const closePositionButton = this.page.getByRole('button', { name: 'Close Position' });
    await closePositionButton.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => undefined);
  }
}
