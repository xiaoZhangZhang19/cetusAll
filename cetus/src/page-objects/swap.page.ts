import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

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
    // Strategy 1: Try to find by button role
    const byButton = pickerRoot.getByRole('button', { name: tokenRegex }).first();
    if (await byButton.isVisible({ timeout: 6_000 }).catch(() => false)) {
      await byButton.click();
      return;
    }

    // Strategy 2: Try to find by text
    const byText = pickerRoot.getByText(tokenRegex).first();
    if (await byText.isVisible({ timeout: 6_000 }).catch(() => false)) {
      await byText.click();
      return;
    }

    // Strategy 3: Try to find any clickable element containing the token symbol
    const tokenElements = pickerRoot.locator(`button, [role="button"], div[class*="token"], div[class*="item"]`);
    const count = await tokenElements.count();
    for (let i = 0; i < count; i++) {
      const elem = tokenElements.nth(i);
      const text = await elem.innerText().catch(() => '');
      if (tokenRegex.test(text.trim())) {
        await elem.click();
        return;
      }
    }

    // Strategy 4: Fallback - try page-level selection
    const pageLevel = this.page.getByRole('button', { name: tokenRegex }).first();
    if (await pageLevel.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await pageLevel.click();
      return;
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
}
