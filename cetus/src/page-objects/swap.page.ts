import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { CHILD_TO_PARENT_MAP, PARENT_ROUTE_MAP } from '@/config/routes.js';

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class SwapPage {
  readonly page: Page;
  readonly inputAmount: Locator;
  readonly explorerLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.inputAmount = page
      .locator('input[inputmode="decimal"], input[placeholder="0"], input[placeholder="0.0"], input[type="text"]')
      .first();
    this.explorerLink = page.getByRole('link', { name: /explorer|view/i }).first();
  }

  async goto(path: string = '/swap') {
    await this.page.goto(path, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
    await this.dismissTermsModalIfPresent();
    await expect(this.inputAmount).toBeVisible();
  }

  async selectFromToken(coinType: string) {
    await this.selectTokenByCoinType('from', coinType);
  }

  async selectToToken(coinType: string) {
    await this.selectTokenByCoinType('to', coinType);
  }

  async fillAmount(amount: string) {
    await this.dismissTermsModalIfPresent();
    // Fill the amount input inside the "You Pay" (from) panel specifically,
    // so we never accidentally target the read-only "You Receive" field.
    const fromInput = await this.getAmountInput();
    await fromInput.fill(amount);
  }

  async fillSlippageBps(slippageBps: string) {
    const slippagePercent = String(Number(slippageBps) / 100);
    const settingsButton = this.page.getByRole('button', { name: /setting|slippage/i }).first();
    await settingsButton.click();
    const slippageInput = this.page.locator('input').filter({ hasText: /^$/ }).last();
    await slippageInput.fill(slippagePercent);
  }

  /**
   * Reads the current slippage setting from the swap UI.
   * Returns the slippage as a percentage string (e.g., "0.5", "1.0").
   */
  async getCurrentSlippagePercent(): Promise<string> {
    // Strategy 1: Find the slippage percentage button/text directly on the swap page.
    // In Cetus UI, it's displayed near "Aggregator Mode" as a clickable element showing "0.5%", "1%", etc.
    const slippageElements = this.page.locator('text=/^[0-9.]+%$/');
    const count = await slippageElements.count();
    
    for (let i = 0; i < count; i++) {
      const elem = slippageElements.nth(i);
      if (await elem.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const text = await elem.innerText();
        const match = text.match(/^([0-9.]+)%$/);
        if (match) {
          console.log(`[SwapPage] Read slippage from UI: ${match[1]}%`);
          return match[1];
        }
      }
    }

    // Strategy 2: Try to read from buttons with percentage text
    const slippageButtons = this.page.locator('button, [role="button"], div, span').filter({ hasText: /^[0-9.]+%$/ });
    const btnCount = await slippageButtons.count();
    
    for (let i = 0; i < btnCount; i++) {
      const btn = slippageButtons.nth(i);
      if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const text = (await btn.innerText()).trim();
        const match = text.match(/^([0-9.]+)%$/);
        if (match) {
          console.log(`[SwapPage] Read slippage from button: ${match[1]}%`);
          return match[1];
        }
      }
    }

    // Strategy 3: Open settings modal and read the slippage input value
    const settingsButton = this.page.getByRole('button', { name: /setting|slippage/i }).first();
    if (await settingsButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await settingsButton.click();
      await this.page.waitForTimeout(500);
      
      const slippageInput = this.page.locator('input[type="text"], input[type="number"]').last();
      if (await slippageInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const value = await slippageInput.inputValue();
        // Close the settings modal
        await this.page.keyboard.press('Escape').catch(() => undefined);
        if (value) {
          console.log(`[SwapPage] Read slippage from settings input: ${value}%`);
          return value;
        }
      }
    }

    // Default fallback
    console.warn('[SwapPage] Could not read slippage from UI, returning default 1%');
    return '1.0';
  }

  async submitSwap() {
    // In Lite mode, the main action is always "Swap". Do NOT click "Lite/Pro" toggles.
    const swapButton = this.page.getByRole('button', { name: /^swap!?$/i }).first();
    await expect(swapButton).toBeVisible({ timeout: 15_000 });
    await expect(swapButton).toBeEnabled({ timeout: 15_000 });
    await swapButton.click();

    // After clicking Swap, Cetus may show an in-page "Confirm Swap" dialog before
    // the wallet popup appears.
    const confirmButton = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^confirm(?: swap)?$/i })
      .first();
    const hasConfirm = await confirmButton.isVisible({ timeout: 8_000 }).catch(() => false);
    if (hasConfirm) {
      await expect(confirmButton).toBeEnabled({ timeout: 10_000 });
      await confirmButton.click();
    }
  }

  async expectSuccess() {
    const successText = this.page.getByText(/success|completed|submitted|view in explorer/i).first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
  }

  async readDigest(): Promise<string | undefined> {
    const txFromHref = (href: string | null) =>
      href?.match(/tx(?:block)?\/([^/?#]+)/i)?.[1] ??
      href?.match(/transaction\/([^/?#]+)/i)?.[1] ??
      href?.match(/[?&](?:digest|tx|txDigest|hash)=([^&#]+)/i)?.[1];

    if (await this.explorerLink.isVisible().catch(() => false)) {
      const href = await this.explorerLink.getAttribute('href');
      const digest = txFromHref(href);
      if (digest) return decodeURIComponent(digest);
      if (href && href.length > 10) return href;
    }

    // Try links/buttons ONLY inside the success dialog to avoid unrelated site nav links (e.g. /pro).
    const successDialog = this.page
      .locator('[role="dialog"], .chakra-modal__content')
      .filter({ hasText: /transaction completed|view on explorer|explorer|suivision|suiscan/i })
      .last();

    const explorerCandidates = await successDialog
      .locator('a[href], button, [role="button"]')
      .evaluateAll((elements) =>
        elements
          .map((el) => {
            const text = (el.textContent || '').trim();
            const href = el instanceof HTMLAnchorElement ? el.href : null;
            return { text, href };
          })
          .filter((item) => /explorer|view|suivision|suiscan/i.test(item.text))
      )
      .catch(() => []);

    for (const item of explorerCandidates) {
      const digest = txFromHref(item.href);
      if (digest) return decodeURIComponent(digest);
      if (item.href && /suivision|suiscan|explorer|tx|transaction|digest/i.test(item.href)) return item.href;
    }

    // Navigate into SuiVision page to read the tx digest from the URL.
    const digestFromNavigation = await this.readDigestBySuiVisionNavigation(successDialog);
    if (digestFromNavigation) return digestFromNavigation;

    const bodyText = await this.page.locator('body').innerText().catch(() => '');
    const digest = bodyText.match(/[A-Za-z0-9]{40,90}/)?.[0];
    if (digest) {
      return digest;
    }

    return undefined;
  }

  /**
   * Clicks the SuiVision (or Suiscan) button in the success dialog, waits for
   * the new browser tab to open, reads the tab URL and extracts the tx digest,
   * then closes the tab.  Falls back to Suiscan if SuiVision is not found.
   */
  async readDigestBySuiVisionNavigation(
    successDialog?: ReturnType<typeof this.page.locator>
  ): Promise<string | undefined> {
    const dialog =
      successDialog ??
      this.page
        .locator('[role="dialog"], .chakra-modal__content')
        .filter({ hasText: /transaction completed|view on explorer|suivision|suiscan/i })
        .last();

    // Prefer SuiVision, fall back to Suiscan.
    const explorerButton = dialog
      .locator('a, button, [role="button"]')
      .filter({ hasText: /suivision|suiscan/i })
      .first();

    const isVisible = await explorerButton.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!isVisible) return undefined;

    try {
      const newPagePromise = this.page.context().waitForEvent('page', { timeout: 15_000 });
      await explorerButton.click();
      const newPage = await newPagePromise;
      await newPage.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined);

      const url = newPage.url();
      await newPage.close().catch(() => undefined);

      // URL formats:
      //   https://suivision.xyz/txblock/DIGEST
      //   https://suiscan.xyz/mainnet/tx/DIGEST
      const match =
        url.match(/txblock\/([^/?#]+)/i)?.[1] ??
        url.match(/\/tx\/([^/?#]+)/i)?.[1] ??
        url.match(/transaction\/([^/?#]+)/i)?.[1];

      if (match && match.length > 10) {
        return decodeURIComponent(match);
      }
    } catch {
      // Ignore errors – caller will fall back to balance-movement checks.
    }

    return undefined;
  }

  // ─── Token selection ─────────────────────────────────────────────────────────

  private async selectTokenByCoinType(direction: 'from' | 'to', coinType: string) {
    await this.dismissTermsModalIfPresent();
    const expectedSymbol = this.getSymbolFromCoinType(coinType);
    const expectedSymbolRegex = new RegExp(`^${escapeRegExp(expectedSymbol)}$`, 'i');

    // 2. Open the token-picker by clicking the current token selector button in this
    //    section, then search using full coin type to avoid same-symbol scam tokens.
    const selectorBtn = await this.findTokenSelectorButton(direction);
    const existingText = (await selectorBtn.innerText().catch(() => '')).trim();
    if (expectedSymbolRegex.test(existingText)) return;

    await selectorBtn.click();

    // Scope strictly to the token picker UI to avoid clicking same-name tokens
    // that may appear elsewhere on the page (watchlist/price cards/etc.).
    const pickerRoot = this.page
      .locator('[role="dialog"], [data-state="open"]')
      .filter({ has: this.page.locator('input[placeholder*="Search" i], input[placeholder*="token" i]') })
      .last();

    const searchInput = pickerRoot
      .locator('input[placeholder*="Search" i], input[placeholder*="token" i]')
      .first();
    if (await searchInput.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await searchInput.fill(coinType);
      // Wait longer for search results, especially for less common tokens
      await this.page.waitForTimeout(1500);
    }

    await this.pickTokenFromPicker(pickerRoot, expectedSymbolRegex);
  }

  async dismissTermsModalIfPresent() {
    const confirmButton = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^confirm$/i })
      .last();
    const confirmVisible = await confirmButton.isVisible().catch(() => false);
    if (!confirmVisible) {
      return;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      if (!(await confirmButton.isVisible().catch(() => false))) {
        return;
      }

      if (!(await confirmButton.isEnabled().catch(() => false))) {
        const agreeText = this.page.getByText(/agree to the terms/i).first();
        if (await agreeText.isVisible().catch(() => false)) {
          const box = await agreeText.boundingBox().catch(() => null);
          if (box) {
            await this.page.mouse.click(Math.max(0, box.x - 14), box.y + box.height / 2);
            await this.page.waitForTimeout(250);
          }
          await agreeText.click({ force: true }).catch(() => undefined);
        }

        await this.page
          .evaluate(() => {
            const modalRoot =
              Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], .chakra-modal__content')).find((el) =>
                /terms|agree to the terms|suivision|suiscan/i.test(el.textContent ?? '')
              ) ?? document.body;

            const clickNearest = (pattern: RegExp) => {
              const candidate = Array.from(modalRoot.querySelectorAll<HTMLElement>('button, [role="button"], div, span')).find(
                (el) => pattern.test((el.textContent ?? '').trim())
              );
              if (!candidate) return;
              (candidate.closest('button, [role="button"], div') as HTMLElement | null)?.click();
            };

            clickNearest(/agree to the terms/i);
            clickNearest(/^suivision$/i);
            clickNearest(/^suiscan$/i);
          })
          .catch(() => undefined);
        await this.page.waitForTimeout(300);
      }

      if (await confirmButton.isEnabled().catch(() => false)) {
        await confirmButton.click({ force: true }).catch(() => undefined);
        await confirmButton.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
      }
    }
  }

  private getSymbolFromCoinType(coinType: string): string {
    const parts = coinType.split('::');
    const symbol = parts[parts.length - 1]?.trim();
    if (!symbol) {
      throw new Error(`Invalid coin type: "${coinType}"`);
    }
    return symbol;
  }

  /**
   * Finds the token-selector dropdown button for a given swap direction.
   *
   * Strategy: Cetus renders two panels ("You Pay" / "You Receive"). In each panel the
   * first button encountered in DOM order is the token selector (e.g. "USDC ▼").
   * HALF and MAX come after it.  We go 3 ancestor levels up from the label text so the
   * whole panel is in scope.
   */
  private async findTokenSelectorButton(direction: 'from' | 'to'): Promise<Locator> {
    // Keep scope very narrow to avoid matching top controls such as Lite/Pro toggle.
    // Depth=2 is the panel container around "You Pay"/"You Receive".
    for (const depth of [2, 3, 4]) {
      const section = this.findSwapSection(direction, depth);
      const buttons = section.locator('button');
      const count = await buttons.count();

      for (let i = 0; i < count; i++) {
        const btn = buttons.nth(i);
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;

        const text = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        // Exclude non-token action buttons and mode toggles.
        if (/^(half|max|buy|sell|swap|limit|dca|margin|merge|pro|lite|connect|review|confirm|enter an amount)$/i.test(text)) {
          continue;
        }
        if (/switch to pro mode|switch to lite mode/i.test(text)) continue;
        // Token labels are usually upper-case symbols like SUI / USDC.
        // Allow for dropdown arrows (▼) and whitespace variations
        const cleanedText = text.replace(/[▼▽⌄↓\s]/g, '');
        if (!/^[A-Z0-9]{2,12}$/.test(cleanedText)) continue;

        return btn;
      }
    }
    throw new Error(`Cannot find the token-selector button for the "${direction}" panel`);
  }

  private async pickTokenFromPicker(pickerRoot: Locator, tokenRegex: RegExp): Promise<void> {
    // Strategy 1: Try to find by button role (exact name match)
    const byButton = pickerRoot.getByRole('button', { name: tokenRegex }).first();
    if (await byButton.isVisible({ timeout: 6_000 }).catch(() => false)) {
      await byButton.click();
      return;
    }

    // Strategy 2: Try to find by text (exact)
    const byText = pickerRoot.getByText(tokenRegex).first();
    if (await byText.isVisible({ timeout: 6_000 }).catch(() => false)) {
      await byText.click();
      return;
    }

    // Strategy 3: Find any clickable row whose innerText contains the token symbol
    // on any line (handles multi-line rows like "SUI\nSui\n$3.70").
    // tokenRegex is /^SYM$/i — extract the symbol to do a per-line contains check.
    const symMatch = tokenRegex.source.replace(/^\^/, '').replace(/\$$/, '');
    const symLower = symMatch.toLowerCase();

    const tokenElements = pickerRoot.locator(
      'button, [role="button"], li, div[class*="token"], div[class*="item"], div[class*="row"], div[class*="list"] > div'
    );
    const count = await tokenElements.count();
    for (let i = 0; i < count; i++) {
      const elem = tokenElements.nth(i);
      if (!(await elem.isVisible({ timeout: 500 }).catch(() => false))) continue;
      const text = await elem.innerText().catch(() => '');
      // Check each line: any line that matches the symbol exactly (case-insensitive)
      const lines = text.split(/\s*\n\s*/).map((l) => l.trim()).filter(Boolean);
      const matches = lines.some((line) => line.toLowerCase() === symLower) ||
                      tokenRegex.test(text.trim());
      if (matches) {
        await elem.click();
        return;
      }
    }

    // Strategy 4: Page-level fallback
    const pageLevel = this.page.getByRole('button', { name: tokenRegex }).first();
    if (await pageLevel.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await pageLevel.click();
      return;
    }

    // Strategy 5: Any visible element whose first text line matches the symbol
    const allVisible = this.page.locator('button, li, [role="option"], [role="listitem"]');
    const allCount = await allVisible.count();
    for (let i = 0; i < allCount; i++) {
      const elem = allVisible.nth(i);
      if (!(await elem.isVisible({ timeout: 300 }).catch(() => false))) continue;
      const text = await elem.innerText().catch(() => '');
      const firstLine = text.split('\n')[0]?.trim() ?? '';
      if (firstLine.toLowerCase() === symLower) {
        await elem.click();
        return;
      }
    }

    throw new Error(`Token "${tokenRegex}" not found in token picker`);
  }

  // ─── Amount input ─────────────────────────────────────────────────────────────

  private async getAmountInput(): Promise<Locator> {
    // Try to scope to the "You Pay" panel first.
    for (const depth of [3, 2, 4]) {
      const section = this.findSwapSection('from', depth);
      const input = section
        .locator('input[inputmode="decimal"], input[placeholder="0"], input[placeholder="0.0"], input[type="text"]')
        .first();
      if (await input.isVisible({ timeout: 2_000 }).catch(() => false)) {
        return input;
      }
    }
    // Last resort: first input on the whole page.
    return this.inputAmount;
  }

  // ─── Quote & Route helpers ────────────────────────────────────────────────────

  /**
   * Reads the raw text shown in the "You Receive" amount field.
   * Returns the string as-is (e.g. "5,000,000", "0.0", "NaN") so callers can
   * inspect it for overflow / NaN / empty conditions.
   */
  async readReceiveAmountText(): Promise<string> {
    await this.page.waitForTimeout(800); // allow UI to recalculate after price change

    for (const depth of [3, 2, 4]) {
      const section = this.findSwapSection('to', depth);

      // Prefer a read-only / disabled input (the receive field is not user-editable)
      const roInput = section.locator('input[readonly], input[disabled]').first();
      if (await roInput.isVisible({ timeout: 1_500 }).catch(() => false)) {
        const val = await roInput.inputValue().catch(() => '');
        if (val.trim() && parseFloat(val) > 0) return val.trim();
      }

      // Find all numeric-looking text nodes; skip "0" / "0.0" balance displays
      // and return the first positive value (= the receive amount).
      const numericEls = section.locator('div, span, p').filter({ hasText: /^[\d,.\-NnAaIi∞]+$/ });
      const count = await numericEls.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const el = numericEls.nth(i);
        if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) continue;
        const text = (await el.innerText().catch(() => '')).trim();
        if (!text) continue;
        // Skip zero-like values (e.g. "0", "0.0") — those are balance displays
        if (/^0\.?0*$/.test(text)) continue;
        if (/nan|inf|∞/i.test(text)) return text; // pass through NaN / Infinity
        const num = parseFloat(text.replace(/,/g, ''));
        if (!isNaN(num) && num > 0) return text;
      }
    }

    // Last resort: the first input on the "to" section that has any value
    const section = this.findSwapSection('to', 3);
    const anyInput = section.locator('input').first();
    return (await anyInput.inputValue().catch(() => '')).trim();
  }

  /**
   * Reads the expected output amount displayed in the "You Receive" panel.
   * Returns the value as a BigInt using the provided decimal (default 9).
   */
  async getExpectedOutputAmount(outputDecimal: number = 9): Promise<bigint> {
    const outputSection = this.findSwapSection('to', 3);

    // Strategy 1: read-only input inside the output panel
    for (const depth of [3, 2, 4]) {
      const section = this.findSwapSection('to', depth);
      const readonlyInput = section.locator('input[readonly], input[disabled]').first();
      if (await readonlyInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const raw = await readonlyInput.inputValue().catch(() => '');
        const parsed = parseFloat(raw.replace(/,/g, ''));
        if (raw && !isNaN(parsed) && parsed > 0) {
          return BigInt(Math.floor(parsed * 10 ** outputDecimal));
        }
      }
    }

    // Strategy 2: first numeric text inside the output panel
    const amountText = await outputSection
      .locator('[class*="amount"], [class*="output"], [class*="value"]')
      .first()
      .innerText()
      .catch(() => '');

    const match = amountText.match(/(\d[\d,]*(?:\.\d+)?)/);
    if (match) {
      const parsed = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(parsed) && parsed > 0) {
        return BigInt(Math.floor(parsed * 10 ** outputDecimal));
      }
    }

    // Strategy 3: any visible input whose value looks like a number > 0
    const allInputs = this.page.locator('input[readonly], input[disabled]');
    const count = await allInputs.count();
    for (let i = 0; i < count; i++) {
      const input = allInputs.nth(i);
      if (!(await input.isVisible().catch(() => false))) continue;
      const val = await input.inputValue().catch(() => '');
      const num = parseFloat(val.replace(/,/g, ''));
      if (!isNaN(num) && num > 0) {
        return BigInt(Math.floor(num * 10 ** outputDecimal));
      }
    }

    throw new Error('Cannot read expected output amount from UI');
  }

  /**
   * Returns true if the "Insufficient liquidity for this trade" error message
   * is currently visible on the swap page (shown in the swap button area or
   * as an inline warning when a route has no liquidity for the selected pair).
   */
  async hasInsufficientLiquidity(): Promise<boolean> {
    const pattern = /insufficient liquidity for this trade/i;
    // Check the swap action button area (most common location)
    const btn = this.page.locator('button, [role="button"], div, span, p').filter({ hasText: pattern }).first();
    return btn.isVisible({ timeout: 2_000 }).catch(() => false);
  }

  /**
   * Returns true if the "Auto Router" label is visible in the swap UI.
   */
  async hasAutoRouter(): Promise<boolean> {
    return this.page
      .locator('text=Auto Router')
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
  }

  /**
   * Clicks the Auto Router icon/button to open route detail (if available).
   */
  async openRouterDetails(): Promise<void> {
    const routerIcon = this.page
      .locator('[data-testid*="router"], button:near(text="Auto Router")')
      .first();
    if (await routerIcon.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await routerIcon.click();
      await this.page.waitForTimeout(1_000);
    }
  }

  /**
   * Reads the route path description from a modal/dialog or inline element.
   */
  async getRoutePathInfo(): Promise<string> {
    const dialog = this.page
      .locator('[role="dialog"], [class*="modal"]')
      .filter({ hasText: /route|path/i });
    if (await dialog.isVisible({ timeout: 2_000 }).catch(() => false)) {
      return dialog.innerText();
    }

    const inline = this.page.locator('[class*="route"], [data-testid*="route"]').first();
    if (await inline.isVisible({ timeout: 2_000 }).catch(() => false)) {
      return inline.innerText();
    }

    return '';
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Locates the swap panel (source or destination) by traversing up from the
   * panel label text.  `depth` controls how many ancestor levels to climb;
   * 3 usually reaches the full panel container.
   */
  findSwapSection(direction: 'from' | 'to', depth: number = 3): Locator {
    // Cetus labels panels "You Pay" / "You Receive".  Fall back to "from" / "to".
    const label =
      direction === 'from'
        ? /^you pay$|^from$/i
        : /^you receive$|^to$/i;

    return this.page
      .getByText(label)
      .first()
      .locator(`xpath=ancestor::*[self::div or self::section][${depth}]`);
  }

  /**
   * 关闭 swap 成功后出现的 "Transaction Completed" 弹窗。
   * 点击弹窗右上角的 × 关闭按钮，或点弹窗外部区域。
   * 确保弹窗消失后再继续，避免遮挡下一条路由的操作。
   */
  async dismissSuccessDialog(): Promise<void> {
    const successDialog = this.page
      .locator('[role="dialog"]')
      .filter({ has: this.page.locator('text=/Transaction Completed/i') })
      .last();

    const isVisible = await successDialog.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!isVisible) return;

    // 策略 1：点击弹窗内的关闭按钮（× svg 按钮）
    const closeBtn = successDialog
      .locator('button, [role="button"]')
      .filter({ has: this.page.locator('svg') })
      .last();
    if (await closeBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await closeBtn.click();
      await successDialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
      console.log('[SwapPage] dismissSuccessDialog: closed via × button');
      return;
    }

    // 策略 2：按 Escape
    await this.page.keyboard.press('Escape');
    await successDialog.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => undefined);
    console.log('[SwapPage] dismissSuccessDialog: closed via Escape');
  }

  // ─── Aggregator Settings ──────────────────────────────────────────────────────

  /**
   * 打开 Aggregator Settings 弹窗。
   *
   * 诊断确认：触发器是 ancestor[4]（chakra-stack css-1jjq5p5）内唯一的按钮，
   * class="chakra-button css-19l1y94"，innerText 为空，位于 "0.5%" 旁边。
   */
  async openAggregatorSettings(): Promise<void> {
    // 如果弹窗已经打开，直接返回
    const aggDialog = this.page
      .locator('[role="dialog"]')
      .filter({ has: this.page.locator('text=Aggregator Settings') });
    if (await aggDialog.isVisible({ timeout: 500 }).catch(() => false)) return;

    const aggregatorLabel = this.page.getByText(/aggregator mode/i).first();
    await expect(aggregatorLabel).toBeVisible({ timeout: 8_000 });

    // ancestor[4] 是 "chakra-stack css-1jjq5p5"，内含唯一的触发按钮（空文字）
    const container = aggregatorLabel.locator('xpath=ancestor::*[4]');
    const triggerBtn = container.locator('button, [role="button"]').first();
    await expect(triggerBtn).toBeVisible({ timeout: 5_000 });
    await triggerBtn.click();

    await expect(aggDialog).toBeVisible({ timeout: 8_000 });
  }

  /**
   * 获取 Aggregator Settings 弹窗的根容器。
   */
  private getAggregatorDialog(): Locator {
    return this.page
      .locator('[role="dialog"]')
      .filter({ has: this.page.locator('text=Aggregator Settings') })
      .last();
  }

  /**
   * 读取弹窗当前的 "N/28" 总计数。
   */
  private async getRouteCounter(): Promise<number> {
    const dialog = this.getAggregatorDialog();
    return dialog.locator('input#select-all').evaluate((el: HTMLInputElement) => {
      let anc: Element | null = el.parentElement;
      for (let i = 0; i < 6 && anc; i++) {
        const m = (anc.textContent ?? '').match(/(\d+)\s*\n?\s*\/\s*28/);
        if (m) return parseInt(m[1], 10);
        anc = anc.parentElement;
      }
      return -1;
    }).catch(() => -1);
  }

  /**
   * 将所有路由重置为 0/28（全部关闭）。
   *
   * 流程：
   *   1. 通过 Select All 开关循环，把计数收敛到 3/28（Cetus 锁定底线）
   *   2. 对 Cetus 3 条子路由各执行 5 次 toggleCetusSubRoute，把它们关闭
   *   3. 目标：0/28
   */
  async disableAllRoutes(): Promise<void> {
    const dialog = this.getAggregatorDialog();
    const selectAllTrack = dialog.locator('label:has(input#select-all) .chakra-switch__track');

    await expect(selectAllTrack).toBeVisible({ timeout: 5_000 });

    // Step 1: 确保非 Cetus 路由全部关闭（计数收敛到 ≤3）。
    //
    // Bug 修复：旧逻辑用 currentCount === 3 判断"已到底线"并 break，
    // 这会误判任意 3 条路由组合（例如 Cetus Tide + DeepBook V3 + Kriya V2），
    // 导致 DeepBook V3 等非 Cetus 路由未被关闭就进入 Step 2。
    //
    // 新逻辑：始终先把所有路由切换到"全关"状态，再用计数验证。
    // 策略：连续点两次 Select All（开→关→开→关），无论初始状态如何，
    // 最终都会处于"全关"状态（非 Cetus 部分 = 0）。
    for (let attempt = 0; attempt < 4; attempt++) {
      const currentCount = await this.getRouteCounter();
      console.log(`[SwapPage] disableAllRoutes step1 attempt=${attempt}: current=${currentCount}/28`);

      // 已经完成（只剩 Cetus 子路由锁定的 ≤3 条）
      if (attempt > 0 && currentCount <= 3) break;

      // 通过"全选→全关"两步操作，确保非 Cetus 路由全部关闭
      await selectAllTrack.click(); // 全选（或从部分→全选）
      await this.page.waitForTimeout(400);
      await selectAllTrack.click(); // 全关
      await this.page.waitForTimeout(500);

      if (!(await dialog.isVisible({ timeout: 2_000 }).catch(() => false))) {
        console.warn('[SwapPage] Dialog closed unexpectedly, reopening...');
        await this.openAggregatorSettings();
        await this.page.waitForTimeout(300);
      }
    }

    const afterSelectAll = await this.getRouteCounter();
    console.log(`[SwapPage] disableAllRoutes: after select-all loop = ${afterSelectAll}/28`);

    // Step 2: 关闭仍处于开启状态的 Cetus 子路由（CLMM/DLMM/Cetus Tide）。
    //
    // 先读 Cetus badge（"N/3"）判断有几条子路由还开着；
    // 为 0 则跳过，避免对已关闭的子路由触发 toggle 导致重新开启。
    const cetusBadge = dialog.locator('button.chakra-menu__menu-button').first();
    const badgeText  = await cetusBadge.textContent({ timeout: 2_000 }).catch(() => '0/3');
    const openCount  = parseInt(badgeText?.split('/')[0] ?? '0', 10);
    console.log(`[SwapPage] disableAllRoutes: Cetus badge = "${badgeText}", openCount = ${openCount}`);

    if (openCount > 0) {
      for (const subRoute of ['CLMM', 'DLMM', 'Cetus Tide'] as const) {
        await this.toggleCetusSubRoute(subRoute, 5);
      }
    }

    const finalCount = await this.getRouteCounter();
    console.log(`[SwapPage] disableAllRoutes: final = ${finalCount}/28 (expected 0)`);
    if (finalCount !== 0) {
      console.warn(`[SwapPage] disableAllRoutes: expected 0/28 but got ${finalCount}/28`);
    }
  }

  /**
   * 对 Cetus 子路由（CLMM / DLMM / Cetus Tide）的勾选框连续点击 5 次切换状态。
   *
   * Cetus 子路由使用防误触设计：需要在同一次展开内连续点击勾选框 5 次才能切换状态。
   * 菜单展开后不会因点击勾选框而关闭，因此只需展开一次再连续点 5 次。
   *
   * DOM 结构（诊断确认）：
   *   button.chakra-menu__menu-button.arrow_box  → 展开 badge（"3/3"、"2/3" 等）
   *     chakra-menu__menu-list[role="menu"]
   *       div.css-3dlw9v  → 每条子路由行
   *         p.css-1qnulsw → 路由名
   *         div.css-1i01hyg > div.css-u8o7oo > svg  → 勾选图标（点击目标）
   *
   * @param routeName  子路由名称：'CLMM' | 'DLMM' | 'Cetus Tide'
   * @param times      点击次数，默认 5
   */
  async toggleCetusSubRoute(
    routeName: 'CLMM' | 'DLMM' | 'Cetus Tide',
    times: number = 5,
  ): Promise<boolean> {
    const dialog = this.getAggregatorDialog();

    // 先确保菜单是关闭状态，再展开（避免重复展开导致反向关闭）
    const badge = dialog.locator('button.chakra-menu__menu-button').first();
    await expect(badge).toBeVisible({ timeout: 5_000 });

    // 取 badge 的 aria-controls，精确定位 Cetus 的菜单列表（弹窗内共有 6 个 menu-list）
    const menuListId = await badge.getAttribute('aria-controls').catch(() => null);
    const cetusMenuList = menuListId
      ? dialog.locator(`[id="${menuListId}"]`)
      : dialog.locator('.chakra-menu__menu-list').first();

    const menuAlreadyOpen = await cetusMenuList.isVisible({ timeout: 300 }).catch(() => false);
    if (menuAlreadyOpen) {
      await badge.click();
      await this.page.waitForTimeout(400);
    }
    // 展开 Cetus 下拉
    await badge.click();
    // 等待 Cetus 专属菜单列表出现，再额外等待动画稳定
    await cetusMenuList.waitFor({ state: 'visible', timeout: 5_000 });
    await this.page.waitForTimeout(600);

    // 获取勾选框坐标（在 Cetus 菜单列表内精确查找）
    const coord = await cetusMenuList.evaluate((menuEl: Element, name: string) => {
      const findIconCoord = (root: Element) => {
        // 优先找 .css-u8o7oo（勾选图标容器）
        const icon = root.querySelector<HTMLElement>('.css-u8o7oo');
        if (icon) {
          const rect = icon.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0)
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        // 备用：找行内最后一个可点击的 div（Chakra checkbox 容器）
        const divs = Array.from(root.querySelectorAll<HTMLElement>('div[class*="css-"]'));
        for (let i = divs.length - 1; i >= 0; i--) {
          const rect = divs[i].getBoundingClientRect();
          if (rect.width >= 12 && rect.height >= 12 && rect.width <= 40)
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        return null;
      };

      const all = Array.from(menuEl.querySelectorAll<HTMLElement>('p, div'));
      for (const el of all) {
        const directText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent ?? '').trim())
          .join('');
        if (directText !== name) continue;
        let row: Element | null = el;
        for (let d = 0; d < 8 && row; d++) {
          if ((row as HTMLElement).className?.includes?.('css-3dlw9v')) break;
          row = row.parentElement;
        }
        const c = findIconCoord(row ?? el);
        if (c) return c;
      }
      return null;
    }, routeName).catch(() => null);

    if (!coord) {
      console.warn(`[SwapPage] toggleCetusSubRoute "${routeName}": coord not found after expand`);
      await badge.click().catch(() => undefined);
      await this.page.waitForTimeout(300);
      return false;
    }

    // 在同一次展开内连续点击 times 次，每次重新获取坐标防止 UI 偏移
    for (let i = 0; i < times; i++) {
      // 每次点击前重新查询坐标，防止 UI 动画或状态变化导致位置偏移
      const freshCoord = await cetusMenuList.evaluate((menuEl: Element, name: string) => {
        const findIconCoord = (root: Element) => {
          const icon = root.querySelector<HTMLElement>('.css-u8o7oo');
          if (icon) {
            const rect = icon.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0)
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
          const divs = Array.from(root.querySelectorAll<HTMLElement>('div[class*="css-"]'));
          for (let i = divs.length - 1; i >= 0; i--) {
            const rect = divs[i].getBoundingClientRect();
            if (rect.width >= 12 && rect.height >= 12 && rect.width <= 40)
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
          return null;
        };
        const all = Array.from(menuEl.querySelectorAll<HTMLElement>('p, div'));
        for (const el of all) {
          const directText = Array.from(el.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => (n.textContent ?? '').trim())
            .join('');
          if (directText !== name) continue;
          let row: Element | null = el;
          for (let d = 0; d < 8 && row; d++) {
            if ((row as HTMLElement).className?.includes?.('css-3dlw9v')) break;
            row = row.parentElement;
          }
          return findIconCoord(row ?? el);
        }
        return null;
      }, routeName).catch(() => null);

      const clickCoord = freshCoord ?? coord;
      await this.page.mouse.click(clickCoord.x, clickCoord.y);
      await this.page.waitForTimeout(150);
      console.log(`[SwapPage] toggleCetusSubRoute "${routeName}" [${i + 1}/${times}] at (${Math.round(clickCoord.x)},${Math.round(clickCoord.y)})`);
    }

    // 收起菜单
    const menuStillOpen = await cetusMenuList.isVisible({ timeout: 500 }).catch(() => false);
    if (menuStillOpen) {
      await badge.click();
      await this.page.waitForTimeout(400);
    }

    const finalCount = await this.getRouteCounter();
    console.log(`[SwapPage] toggleCetusSubRoute "${routeName}": done, counter=${finalCount}/28`);
    return true;
  }

  /**
   * 展开带子路由的协议（如 "Kriya 2/2 ▼"），使子路由列表可见。
   *
   * 诊断确认的 DOM 结构：
   *   展开 badge 是 <button class="chakra-menu__menu-button arrow_box css-bxvxk9">
   *   文字为 "3/ 3"、"2/ 2"、"0/ 2" 等格式
   *
   * 定位方式：找协议名旁边的 .chakra-menu__menu-button（最近的祖先容器内）
   *
   * @param parentName 父协议名称，如 "Kriya"
   */
  private async expandParentRoute(parentName: string): Promise<void> {
    const dialog = this.getAggregatorDialog();
    const firstChild = PARENT_ROUTE_MAP[parentName]?.[0] ?? '';

    // 判断是否已展开（firstChild 文字是否出现在 DOM 里）
    const isExpanded = await dialog.evaluate((dialogEl: Element, childName: string) => {
      const lower = childName.toLowerCase();
      const walker = document.createTreeWalker(dialogEl, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if ((node.textContent ?? '').toLowerCase().includes(lower)) return true;
        node = walker.nextNode();
      }
      return false;
    }, firstChild).catch(() => false);

    if (isExpanded) return;

    // 找协议名文字，向上找包含它的卡片容器，在容器内找 .chakra-menu__menu-button
    const parentLabel = dialog.getByText(parentName, { exact: true }).first();
    if (!(await parentLabel.isVisible({ timeout: 2_000 }).catch(() => false))) {
      console.warn(`[SwapPage] expandParentRoute "${parentName}": label not found`);
      return;
    }

    for (const depth of [1, 2, 3, 4, 5]) {
      const row = parentLabel.locator(`xpath=ancestor::*[${depth}]`);
      const badge = row.locator('button.chakra-menu__menu-button, button.arrow_box').first();
      if (await badge.isVisible({ timeout: 600 }).catch(() => false)) {
        const badgeTxt = (await badge.innerText().catch(() => '')).trim();
        console.log(`[SwapPage] expandParentRoute "${parentName}": clicking badge "${badgeTxt}"`);
        await badge.scrollIntoViewIfNeeded().catch(() => undefined);
        await this.page.waitForTimeout(150);
        await badge.click();
        await this.page.waitForTimeout(500);

        const expanded = await dialog.evaluate((dialogEl: Element, childName: string) => {
          const lower = childName.toLowerCase();
          const walker = document.createTreeWalker(dialogEl, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            if ((node.textContent ?? '').toLowerCase().includes(lower)) return true;
            node = walker.nextNode();
          }
          return false;
        }, firstChild).catch(() => false);

        if (expanded) {
          console.log(`[SwapPage] expandParentRoute "${parentName}": expanded OK`);
        } else {
          console.warn(`[SwapPage] expandParentRoute "${parentName}": not expanded after click`);
        }
        return;
      }
    }

    console.warn(`[SwapPage] expandParentRoute "${parentName}": badge not found`);
  }

  /**
   * 在 Aggregator Settings 弹窗中勾选指定路由。
   * 支持有/无子路由的协议，自动展开父协议。
   *
   * 规则：
   *   - Cetus 子路由（CLMM / DLMM / Cetus Tide）：
   *     disableAllRoutes 已将它们关闭（0/28），需要调用 toggleCetusSubRoute 点 5 次开启。
   *   - 其他有子路由的协议（Kriya/FlowX/Magma/Ferra/Haedal）：
   *     先点击 "N/N ▼" 展开下拉，再勾选对应子路由行。
   *   - 无子路由的顶级卡片（DeepBook V3、Aftermath 等）：直接点击卡片切换。
   *
   * 流程：
   *   1. 先全部关闭（disableAllRoutes）→ 0/28
   *   2. 对每条目标路由按上述规则开启
   *   3. 返回成功勾选的数量
   *
   * @param routes 要勾选的路由名称数组（来自 CETUS_ROUTES 常量）
   * @returns 成功勾选的路由数量
   */
  async selectCetusRoutes(routes: string[]): Promise<number> {
    const dialog = this.getAggregatorDialog();
    let selectedCount = 0;

    // 前置条件：调用方必须先调用 disableAllRoutes() 将所有路由清为 0/28。
    // 本方法只负责"勾选"，不再隐式清空，确保调用方的意图在 spec 层显式可见。
    await this.page.waitForTimeout(300);

    // Step 2: 将路由按父协议分组
    const groups = new Map<string, string[]>();
    for (const route of routes) {
      const parentName = CHILD_TO_PARENT_MAP[route];
      const key = parentName ?? '__top__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(route);
    }

    // Step 3: 按组处理
    for (const [key, groupRoutes] of groups) {
      if (key === 'Cetus') {
        // Cetus 子路由：每条点 5 次开启
        for (const route of groupRoutes) {
          const ok = await this.toggleCetusSubRoute(route as 'CLMM' | 'DLMM' | 'Cetus Tide', 5);
          if (ok) {
            selectedCount++;
            console.log(`[SwapPage] ✓ Toggled Cetus sub-route ON (5x): ${route}`);
          } else {
            console.warn(`[SwapPage] ✗ Failed to toggle Cetus sub-route: ${route}`);
          }
          await this.page.waitForTimeout(200);
        }
      } else if (key === '__top__') {
        // 顶级卡片：逐个点击
        for (const route of groupRoutes) {
          const checked = await this.checkTopLevelCard(dialog, route);
          if (checked) {
            selectedCount++;
            console.log(`[SwapPage] ✓ Selected top-level: ${route}`);
          } else {
            console.warn(`[SwapPage] ✗ Failed: ${route}`);
          }
          await this.page.waitForTimeout(150);
        }
      } else {
        // 有父协议的子路由：Chakra Menu 点一项就关闭，需要每次重新展开
        for (const route of groupRoutes) {
          await this.expandParentRoute(key);
          const checked = await this.checkSubRouteItem(dialog, route, key);
          if (checked) {
            selectedCount++;
            console.log(`[SwapPage] ✓ Selected sub-route: ${route} (parent: ${key})`);
          } else {
            console.warn(`[SwapPage] ✗ Failed sub-route: ${route} (parent: ${key})`);
          }
          await this.page.waitForTimeout(300);
        }
      }
    }

    return selectedCount;
  }

  /**
   * 勾选顶级无子路由的协议卡片（如 DeepBook V3、Aftermath、Turbos 等）。
   *
   * 诊断确认：路由卡片没有 checkbox/switch，整张卡片是可点击区域。
   * 路由名字在 <p class="chakra-text source_name css-6pd8e4"> 内。
   * 点击 source_name 元素即可触发 React onClick。
   * 使用 exact: true 避免 "Aftermath" 误匹配 "Aftermath LSD"。
   * 点击前先 scrollIntoViewIfNeeded，避免元素被遮挡（如 Full Sail 在滚动区域边缘）。
   */
  private async checkTopLevelCard(dialog: Locator, routeName: string): Promise<boolean> {
    // 精确匹配路由名（exact: true 防止 "Aftermath" 匹配到 "Aftermath LSD"）
    const nameEl = dialog.locator('p.source_name').filter({ hasText: routeName }).first();
    if (await nameEl.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const actualText = (await nameEl.innerText().catch(() => '')).trim();
      if (actualText === routeName) {
        // 滚动到可见区域，避免元素被弹窗边界遮挡
        await nameEl.scrollIntoViewIfNeeded().catch(() => undefined);
        await this.page.waitForTimeout(150);
        await nameEl.click();
        await this.page.waitForTimeout(200);
        console.log(`[SwapPage] checkTopLevelCard "${routeName}": clicked source_name`);
        return true;
      }
    }

    // 备用：evaluate 找直接文字节点完全等于 routeName 的最小元素
    const exactMatch = await dialog.evaluate((dialogEl: Element, name: string) => {
      const all = Array.from(dialogEl.querySelectorAll<HTMLElement>('p, span, div'));
      for (const el of all) {
        const directText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent ?? '').trim())
          .join('');
        if (directText === name) {
          el.scrollIntoView({ block: 'nearest' });
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
        }
      }
      return { found: false, x: 0, y: 0 };
    }, routeName).catch(() => ({ found: false, x: 0, y: 0 }));

    if (exactMatch.found) {
      await this.page.waitForTimeout(150);
      await this.page.mouse.click(exactMatch.x, exactMatch.y);
      await this.page.waitForTimeout(200);
      console.log(`[SwapPage] checkTopLevelCard "${routeName}": clicked via evaluate`);
      return true;
    }

    console.warn(`[SwapPage] checkTopLevelCard "${routeName}": not found`);
    return false;
  }

  /**
   * 勾选父协议展开后的子路由。
   *
   * 子路由展开后，名字也在 p.source_name 或类似元素内。
   * 同样用精确文字匹配点击，点击前滚动到可见。
   */
  private async checkSubRouteItem(
    dialog: Locator,
    routeName: string,
    parentName: string
  ): Promise<boolean> {
    // 精确匹配子路由名
    const nameEl = dialog.locator('p.source_name').filter({ hasText: routeName }).first();
    if (await nameEl.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const actualText = (await nameEl.innerText().catch(() => '')).trim();
      if (actualText === routeName) {
        await nameEl.scrollIntoViewIfNeeded().catch(() => undefined);
        await this.page.waitForTimeout(150);
        await nameEl.click();
        await this.page.waitForTimeout(200);
        console.log(`[SwapPage] checkSubRouteItem "${routeName}": clicked (parent: ${parentName})`);
        return true;
      }
    }

    // 备用：evaluate 精确文字匹配 + scrollIntoView
    const exactMatch = await dialog.evaluate((dialogEl: Element, name: string) => {
      const all = Array.from(dialogEl.querySelectorAll<HTMLElement>('p, span, div'));
      for (const el of all) {
        const directText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent ?? '').trim())
          .join('');
        if (directText === name) {
          el.scrollIntoView({ block: 'nearest' });
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
        }
      }
      return { found: false, x: 0, y: 0 };
    }, routeName).catch(() => ({ found: false, x: 0, y: 0 }));

    if (exactMatch.found) {
      await this.page.waitForTimeout(150);
      await this.page.mouse.click(exactMatch.x, exactMatch.y);
      await this.page.waitForTimeout(200);
      console.log(`[SwapPage] checkSubRouteItem "${routeName}": clicked via evaluate (parent: ${parentName})`);
      return true;
    }

    console.warn(`[SwapPage] checkSubRouteItem "${routeName}": not found (parent: ${parentName})`);
    return false;
  }

  /**
   * 点击 Aggregator Settings 弹窗的 "Save" 按钮确认设置。
   */
  async confirmAggregatorSettings(): Promise<void> {
    const dialog = this.getAggregatorDialog();
    const saveBtn = dialog
      .locator('button, [role="button"]')
      .filter({ hasText: /^save$/i })
      .first();

    await expect(saveBtn).toBeVisible({ timeout: 5_000 });
    await saveBtn.click();

    // 等待弹窗关闭
    await dialog.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined);
    await this.page.waitForTimeout(500);
  }
}
