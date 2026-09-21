import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import {
  buildPairPattern,
  clickPositionsSubFilterChip,
  closeTransactionCompletedModal,
  escapeRegExp,
  gotoPoolsList,
  openMyPositionsTab
} from './pools-shared.js';

export interface TokenAmounts {
  sui: number;
  usdc: number;
}

/**
 * Base Page Object — shared logic for adding more liquidity to an existing position.
 * Extended by ClmmAddLiquidityPage and DlmmAddLiquidityPage.
 *
 * URL 差异说明：
 *   CLMM 点击 "+" 后跳转到：/position-detail/{id}/increase
 *   DLMM 点击 "+" 后跳转到：/position-detail/{id}   （无 /increase 后缀）
 * 因此子类通过覆写 positionPageUrlPattern 来区分。
 */
export abstract class AddLiquidityBasePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Subclasses override this to return the URL pattern for their position detail page.
   * CLMM → /position-detail.*increase/i
   * DLMM → /position-detail/i
   */
  protected abstract get positionPageUrlPattern(): RegExp;

  // ─── Navigation ─────────────────────────────────────────────────────────────

  /**
   * 进入池子列表页（CLMM tab）。
   *
   * 注意：直接 goto('/pools?tab=positions') 在当前站点上会被重定向/落到
   * CLMM 池子列表，持仓列表并不会渲染 —— 所以这里只负责把页面打开，
   * 真正切到持仓列表由 openMyPositions() 点击 "My Positions" 完成。
   */
  async goto() {
    await gotoPoolsList(this.page);
  }

  // ─── My Positions tab ────────────────────────────────────────────────────────

  /**
   * 点击池子列表页上的 "My Positions"（与 CLMM / DLMM 同一行的 tab）。
   * 幂等：已经在持仓视图时直接返回。
   */
  async openMyPositions() {
    await openMyPositionsTab(this.page);
  }

  // ─── Sub-filter chip ─────────────────────────────────────────────────────────

  /**
   * Click the CLMM or DLMM sub-filter chip inside the My Positions filter row.
   * 内部会先确保处在 My Positions 视图（见 pools-shared 里的实现说明）。
   */
  protected async clickSubFilterChip(poolType: 'clmm' | 'dlmm') {
    await clickPositionsSubFilterChip(this.page, poolType);
  }

  // ─── Open "+" button ─────────────────────────────────────────────────────────

  /**
   * Find the pair card filtered by poolType, click the "+" button,
   * and wait for navigation to the position detail page.
   */
  protected async openPlusButtonForPair(
    baseSymbol: string,
    quoteSymbol: string,
    poolType: 'clmm' | 'dlmm'
  ) {
    // 持仓卡片只在 My Positions 视图里；如果当前还在池子列表就先切过去。
    await this.openMyPositions();

    const pairPattern = buildPairPattern(baseSymbol, quoteSymbol);
    const typePattern = poolType === 'dlmm' ? /dlmm/i : /clmm/i;
    const urlPattern = this.positionPageUrlPattern;

    const pairCard = this.page
      .locator('div')
      .filter({ hasText: pairPattern })
      .filter({ hasText: typePattern })
      .first();
    await expect(pairCard).toBeVisible({ timeout: 15_000 });

    // Attempt 1: "+" directly inside the card
    const plusInCard = pairCard
      .locator('button, [role="button"]')
      .filter({ hasText: /^\s*\+\s*$/ })
      .first();
    if (await plusInCard.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await plusInCard.click();
      await this.page.waitForURL(urlPattern, { timeout: 25_000 });
      return;
    }

    // Attempt 2: expand card, then find "+"
    await pairCard.click({ force: true }).catch(async () => {
      const box = await pairCard.boundingBox();
      if (box) await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    await this.page.waitForTimeout(500);

    const plusAfterExpand = pairCard
      .locator('button, [role="button"]')
      .filter({ hasText: /^\s*\+\s*$/ })
      .first();
    if (await plusAfterExpand.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await plusAfterExpand.click();
      await this.page.waitForURL(urlPattern, { timeout: 25_000 });
      return;
    }

    // Attempt 3: coordinate-based Actions column
    const clicked = await this.clickPlusInActionsColumn();
    if (clicked) {
      await this.page.waitForURL(urlPattern, { timeout: 25_000 });
      return;
    }

    throw new Error(`Cannot find "+" button for ${baseSymbol}-${quoteSymbol} ${poolType.toUpperCase()} position`);
  }

  // ─── Increase page helpers ────────────────────────────────────────────────────

  /**
   * Wait until the position detail / increase deposit form is ready.
   * Uses content detection (Deposit Amounts visible) as the primary signal,
   * since CLMM and DLMM have different URL patterns.
   */
  async waitForIncreasePageReady() {
    // Wait for URL to match the pool-type-specific pattern
    await this.page.waitForURL(this.positionPageUrlPattern, { timeout: 25_000 });
    await this.page.waitForLoadState('networkidle');

    const spinner = this.page.locator(
      '.chakra-spinner, [class*="spinner"], [class*="loading"], svg[class*="animate-spin"]'
    );
    await spinner.first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => undefined);

    // "Deposit Amounts" section is the definitive sign the form is ready
    const depositTitle = this.page.getByText(/deposit amounts/i).first();
    await expect(depositTitle).toBeVisible({ timeout: 20_000 });
  }

  async readPositionAmounts(): Promise<TokenAmounts> {
    const liquidityText = this.page.getByText(/^liquidity$/i).first();
    await liquidityText.waitFor({ state: 'visible', timeout: 10_000 });
    await this.page.waitForTimeout(1_500);

    const tokenHeader = this.page.getByText(/^token$/i).first();
    await tokenHeader.waitFor({ state: 'visible', timeout: 10_000 });

    const tableContainer = tokenHeader.locator('xpath=ancestor::*[self::div or self::section or self::table][3]');
    const tableText = await tableContainer.innerText().catch(() => '');
    const lines = tableText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

    let sui = 0;
    let usdc = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] === 'SUI' && /^[\d.]+$/.test(lines[i + 1])) sui = parseFloat(lines[i + 1]);
      if (lines[i] === 'USDC' && /^[\d.]+$/.test(lines[i + 1])) usdc = parseFloat(lines[i + 1]);
    }
    return { sui, usdc };
  }

  /**
   * 交易成功后读取仓位数量 —— 轮询到数值相对 `before` 真的变了才返回。
   *
   * 为什么不能读一次就信：链上交易成功（有 digest + Transaction Completed 弹窗）
   * 不等于前端 Liquidity 表格已经是新值。仓位数据要等索引器同步 + 前端重新拉取，
   * 关掉弹窗后立刻读大概率还是旧值，于是断言会拿 before 去比 predicted，
   * 报成「偏差超过 5%」这种指向完全错误的失败。
   */
  async readPositionAmountsUntilChanged(
    before: TokenAmounts,
    options: { timeout?: number; epsilon?: number } = {}
  ): Promise<TokenAmounts> {
    const timeout = options.timeout ?? 60_000;
    const epsilon = options.epsilon ?? 1e-9;
    const deadline = Date.now() + timeout;
    let latest: TokenAmounts = before;
    let attempt = 0;

    while (true) {
      attempt++;
      latest = await this.readPositionAmounts();
      const changed =
        Math.abs(latest.sui - before.sui) > epsilon ||
        Math.abs(latest.usdc - before.usdc) > epsilon;

      if (changed) {
        console.log(
          `[position] 仓位数据已刷新（第 ${attempt} 次读取）：` +
            `SUI=${latest.sui.toFixed(6)}  USDC=${latest.usdc.toFixed(6)}`
        );
        return latest;
      }

      if (Date.now() >= deadline) break;
      console.log(`[position] 第 ${attempt} 次读取仍是旧值，刷新页面后重试`);
      // 刷新本身可能撞上 CDN 抖动；这里失败不该终止轮询，退避后下一轮再试。
      await this.reloadAndWaitForPositionData().catch((error: unknown) => {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        console.warn(`[position] 刷新页面失败：${message} — 继续重试`);
        return this.page.waitForTimeout(2_000);
      });
    }

    throw new Error(
      `仓位数量在 ${timeout / 1000}s 内始终未变化（读了 ${attempt} 次，含刷新重试）。\n` +
        `  before: SUI=${before.sui.toFixed(6)}  USDC=${before.usdc.toFixed(6)}\n` +
        `  latest: SUI=${latest.sui.toFixed(6)}  USDC=${latest.usdc.toFixed(6)}\n` +
        '可能原因：1) 索引器同步比预期慢；2) 交易虽然上链但实际未改变该仓位。'
    );
  }

  async fillTokenAmount(tokenSymbol: string, amount: string) {
    const amountInputSelector =
      'input[inputmode="decimal"], input[type="number"], input[type="text"], [contenteditable="true"], [role="textbox"]';
    const tokenPattern = new RegExp(`^${escapeRegExp(tokenSymbol)}$`, 'i');

    const depositTitle = this.page.getByText(/^deposit amounts$/i).first();
    await expect(depositTitle).toBeVisible({ timeout: 15_000 });
    const depositPanel = depositTitle.locator('xpath=ancestor::*[self::div or self::section][2]');
    await expect(depositPanel).toBeVisible({ timeout: 10_000 });

    const tokenLabel = depositPanel.getByText(tokenPattern).first();
    if (await tokenLabel.isVisible({ timeout: 5_000 }).catch(() => false)) {
      for (const depth of [1, 2, 3]) {
        const row = tokenLabel.locator(`xpath=ancestor::*[self::div or self::section][${depth}]`);
        const rowInput = row.locator(amountInputSelector).last();
        if (await rowInput.isVisible({ timeout: 1_500 }).catch(() => false)) {
          await rowInput.fill(amount);
          await this.page.waitForTimeout(800);
          return;
        }
      }
    }

    const panelInputs = depositPanel.locator(amountInputSelector).filter({ hasNotText: /min|max|price/i });
    const total = await panelInputs.count();
    const preferredIndex = /sui/i.test(tokenSymbol) ? 0 : 1;
    if (total > preferredIndex) {
      const preferred = panelInputs.nth(preferredIndex);
      if (await preferred.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await preferred.fill(amount);
        await this.page.waitForTimeout(800);
        return;
      }
    }
    throw new Error(`Cannot find amount input for token "${tokenSymbol}"`);
  }

  async readDepositFormAmounts(): Promise<TokenAmounts> {
    const amountInputSelector = 'input[inputmode="decimal"], input[type="number"], input[type="text"]';
    const depositTitle = this.page.getByText(/^deposit amounts$/i).first();
    const depositPanel = depositTitle.locator('xpath=ancestor::*[self::div or self::section][2]');
    const inputs = depositPanel.locator(amountInputSelector);
    const count = await inputs.count();

    let sui = 0;
    let usdc = 0;
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      if (!(await input.isVisible({ timeout: 500 }).catch(() => false))) continue;
      const val = parseFloat((await input.inputValue().catch(() => '0')) || '0');
      if (Number.isNaN(val) || val <= 0) continue;
      if (sui === 0) { sui = val; } else { usdc = val; break; }
    }
    return { sui, usdc };
  }

  async submitAddMoreLiquidity() {
    const addMoreBtn = this.page.getByRole('button', { name: /add more liquidity/i }).first();
    await expect(addMoreBtn).toBeVisible({ timeout: 15_000 });
    await expect(addMoreBtn).toBeEnabled({ timeout: 15_000 });
    await addMoreBtn.click();

    const confirmDialog = this.page
      .locator('[role="dialog"], .chakra-modal__content')
      .filter({ hasText: /add.*liquidity/i })
      .last();
    if (await confirmDialog.isVisible({ timeout: 6_000 }).catch(() => false)) {
      const confirmBtn = confirmDialog
        .getByRole('button', { name: /add more liquidity|add liquidity|confirm|approve/i })
        .first();
      if (await confirmBtn.isVisible({ timeout: 4_000 }).catch(() => false)) {
        await expect(confirmBtn).toBeEnabled({ timeout: 5_000 });
        await confirmBtn.click();
      }
    }
  }

  async waitForTransactionCompletedModal(): Promise<TokenAmounts> {
    const txModal = this.page
      .locator('[role="dialog"], .chakra-modal__content, [class*="modal"], [class*="dialog"]')
      .filter({ hasText: /transaction completed/i })
      .last();

    if (await txModal.isVisible({ timeout: 60_000 }).catch(() => false)) {
      const modalText = (await txModal.textContent().catch(() => '')) ?? '';
      const match = modalText.match(/add\s+([\d.]+)\s+sui\s+and\s+([\d.]+)\s+usdc/i);
      return {
        sui: match ? parseFloat(match[1]) : 0,
        usdc: match ? parseFloat(match[2]) : 0
      };
    }

    const successText = this.page
      .getByText(/transaction completed|view on explorer|view in explorer|success|submitted/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
    return { sui: 0, usdc: 0 };
  }

  async closeTransactionModal() {
    await closeTransactionCompletedModal(this.page);
  }

  async reloadAndWaitForPositionData() {
    await this.page.reload({ waitUntil: 'networkidle' });
    await this.waitForIncreasePageReady();
    await this.page.waitForTimeout(1_000);
  }

  assertAmountsIncreased(
    before: TokenAmounts,
    added: TokenAmounts,
    after: TokenAmounts,
    tolerancePct = 0.01
  ) {
    expect(after.sui, `SUI amount decreased: before=${before.sui}, after=${after.sui}`)
      .toBeGreaterThanOrEqual(before.sui * (1 - tolerancePct));
    expect(after.usdc, `USDC amount decreased: before=${before.usdc}, after=${after.usdc}`)
      .toBeGreaterThanOrEqual(before.usdc * (1 - tolerancePct));

    if (added.sui > 0) {
      const suiError = Math.abs(after.sui - before.sui - added.sui) / added.sui;
      expect(
        suiError,
        `SUI increase error ${(suiError * 100).toFixed(2)}% exceeds ${tolerancePct * 100}% tolerance\n` +
          `  before=${before.sui}  added=${added.sui}  expected_after=${before.sui + added.sui}  actual_after=${after.sui}`
      ).toBeLessThanOrEqual(tolerancePct);
    }

    if (added.usdc > 0) {
      const usdcError = Math.abs(after.usdc - before.usdc - added.usdc) / added.usdc;
      expect(
        usdcError,
        `USDC increase error ${(usdcError * 100).toFixed(2)}% exceeds ${tolerancePct * 100}% tolerance\n` +
          `  before=${before.usdc}  added=${added.usdc}  expected_after=${before.usdc + added.usdc}  actual_after=${after.usdc}`
      ).toBeLessThanOrEqual(tolerancePct);
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async clickPlusInActionsColumn(): Promise<boolean> {
    const actionsHeader = this.page.getByText(/^actions$/i).first();
    if (!(await actionsHeader.isVisible({ timeout: 8_000 }).catch(() => false))) return false;
    const headerBox = await actionsHeader.boundingBox();
    if (!headerBox) return false;

    const clicked = await this.page.evaluate(
      ({ x, y }) => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).filter((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 14 || rect.height < 14) return false;
          if (rect.right < x - 80 || rect.top < y + 14) return false;
          const style = window.getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') return false;
          if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
          return true;
        });
        candidates.sort((a, b) => {
          const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
          if (Math.abs(ar.top - br.top) > 6) return ar.top - br.top;
          const aP = (a.textContent ?? '').trim() === '+';
          const bP = (b.textContent ?? '').trim() === '+';
          if (aP !== bP) return aP ? -1 : 1;
          return br.left - ar.left;
        });
        const target = candidates[0];
        if (!target) return false;
        ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) =>
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
        );
        return true;
      },
      { x: headerBox.x, y: headerBox.y }
    );

    if (clicked) await this.page.waitForTimeout(400);
    return clicked;
  }
}
