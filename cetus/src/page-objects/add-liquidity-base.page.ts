import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { buildPairPattern, escapeRegExp } from './pools-shared.js';

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

  async goto() {
    await this.page.goto('/pools?tab=positions', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
  }

  // ─── Sub-filter chip ─────────────────────────────────────────────────────────

  /**
   * Click the CLMM or DLMM sub-filter chip inside the My Positions filter row.
   *
   * UI layout:
   *   Top navigation tabs : [CLMM]  [DLMM]  [My Positions 2]
   *   Filter row (target) : [All 2] [CLMM 1] [DLMM 1]
   *
   * Key insight: sub-filter chips include a position count (e.g. "CLMM 1"),
   * while top-level tabs are plain text ("CLMM") without a count.
   */
  protected async clickSubFilterChip(poolType: 'clmm' | 'dlmm') {
    const typeText = poolType.toUpperCase(); // "CLMM" or "DLMM"

    // ── Strategy 1: chip text = "<TYPE> <digits>", e.g. "CLMM 1" ─────────────
    // Top-level tabs never have a trailing count, so this uniquely identifies the chip.
    const chipWithCount = this.page
      .locator('*')
      .filter({ hasText: new RegExp(`^${typeText}\\s+\\d+$`) })
      .first();

    if (await chipWithCount.isVisible({ timeout: 8_000 }).catch(() => false)) {
      await chipWithCount.click();
      await this.page.waitForTimeout(500);
      return;
    }

    // ── Strategy 2: same Y-row as the "All N" chip (any element type) ─────────
    const allChip = this.page
      .locator('*')
      .filter({ hasText: /^All\s*\d*$/ })
      .first();

    if (await allChip.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const allBox = await allChip.boundingBox().catch(() => null);
      if (allBox) {
        const clicked = await this.page.evaluate(
          ({ typeText, refY }) => {
            const pattern = new RegExp(`^${typeText}(\\s+\\d+)?$`, 'i');
            const candidates = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((el) => {
              const text = (el.textContent ?? '').trim();
              if (!pattern.test(text)) return false;
              const childMatches = Array.from(el.children).some((c) =>
                pattern.test((c.textContent ?? '').trim())
              );
              if (childMatches) return false;
              const rect = el.getBoundingClientRect();
              if (rect.width < 20 || rect.height < 8) return false;
              return Math.abs(rect.top + rect.height / 2 - refY) < 30;
            });
            if (candidates.length === 0) return false;
            (candidates[0] as HTMLElement).click();
            return true;
          },
          { typeText, refY: allBox.y + allBox.height / 2 }
        );

        if (clicked) {
          await this.page.waitForTimeout(500);
          return;
        }
      }
    }

    // ── Strategy 3: plain text match, pick second occurrence ──────────────────
    const allMatches = this.page.locator('*').filter({ hasText: new RegExp(`^${typeText}$`, 'i') });
    const total = await allMatches.count().catch(() => 0);
    if (total >= 2) {
      await allMatches.nth(1).click();
      await this.page.waitForTimeout(500);
      return;
    }
    if (total === 1) {
      await allMatches.first().click();
      await this.page.waitForTimeout(500);
    }
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
    const modal = this.page
      .locator('[role="dialog"], .chakra-modal__content, [class*="modal"]')
      .filter({ hasText: /transaction completed/i })
      .last();

    if (!(await modal.isVisible({ timeout: 3_000 }).catch(() => false))) return;

    for (const btn of [
      modal.locator('button[aria-label*="close" i]').first(),
      modal.locator('[class*="close"]').first(),
      modal.getByRole('button').filter({ hasText: /^[×x]$/i }).first()
    ]) {
      if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await btn.click().catch(() => undefined);
        await modal.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
        return;
      }
    }

    await this.page.keyboard.press('Escape');
    await modal.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
    await this.page.waitForTimeout(300);
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
