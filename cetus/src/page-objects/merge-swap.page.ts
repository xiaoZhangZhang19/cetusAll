import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { toAtomicAmount } from '@/utils/amount.js';

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Page object for the Merge Swap page (https://app.cetus.zone/merge-swap).
 *
 * Merge swap takes TWO input tokens and produces ONE output token.
 * UI layout:
 *   - Input panel 1 (index 0): first "You Pay" / token selector
 *   - Input panel 2 (index 1): second "You Pay" / token selector
 *   - Output panel: "You Receive" with the target token
 */
export class MergeSwapPage {
  readonly page: Page;
  readonly explorerLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.explorerLink = page.getByRole('link', { name: /explorer|view/i }).first();
  }

  async goto() {
    await this.page.goto('/merge-swap', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle');
    await this.dismissTermsModalIfPresent();
    // Wait until at least one amount input is visible
    await this.page
      .locator('input[inputmode="decimal"], input[placeholder="0"], input[placeholder="0.0"], input[type="text"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
  }

  // ─── Token selection ──────────────────────────────────────────────────────────

  /**
   * Selects an input token.
   *
   * index=0: clicks the "Select a token" button in the "You Pay" panel.
   * index=1: clicks "+ Add one more token" which opens the picker directly,
   *          then picks the second token without needing to find another button.
   */
  async selectInputToken(index: 0 | 1, coinType: string): Promise<void> {
    await this.dismissTermsModalIfPresent();
    await this.closeAnyOpenPickerModal();

    const expectedSymbol = this.getSymbolFromCoinType(coinType);
    const expectedSymbolRegex = new RegExp(`^${escapeRegExp(expectedSymbol)}$`, 'i');

    if (index === 1) {
      // Clicking "+ Add one more token" DIRECTLY opens the token picker modal.
      // There is no intermediate "Select a token" button for the second slot.
      console.log('[MergeSwapPage] Clicking "+ Add one more token" to open picker for input 2');
      await this.clickAddOneMoreToken();
      await this.pickTokenFromPicker(coinType, expectedSymbolRegex);
      return;
    }

    // index === 0: find and click the "Select a token" placeholder in "You Pay"
    const selectorBtn = await this.findInputSlotSelectorButton(0);
    const existingText = (await selectorBtn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (expectedSymbolRegex.test(existingText)) {
      console.log(`[MergeSwapPage] Input 0 already set to ${expectedSymbol}, skipping`);
      return;
    }

    await selectorBtn.click();
    await this.pickTokenFromPicker(coinType, expectedSymbolRegex);
  }

  /**
   * Selects the output token. The "You Receive" section may already show a default
   * token (e.g. SUI); this method clicks it and switches to the desired token.
   */
  async selectOutputToken(coinType: string): Promise<void> {
    await this.dismissTermsModalIfPresent();
    await this.closeAnyOpenPickerModal();
    
    const expectedSymbol = this.getSymbolFromCoinType(coinType);
    const expectedSymbolRegex = new RegExp(`^${escapeRegExp(expectedSymbol)}$`, 'i');

    const selectorBtn = await this.findOutputSlotSelectorButton();
    const existingText = (await selectorBtn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (expectedSymbolRegex.test(existingText)) return;

    await selectorBtn.click();
    await this.pickTokenFromPicker(coinType, expectedSymbolRegex);
  }

  // ─── Amount inputs ────────────────────────────────────────────────────────────

  /**
   * Fills the amount for the given input panel (0 = first, 1 = second).
   */
  async fillInputAmount(index: 0 | 1, amount: string): Promise<void> {
    await this.dismissTermsModalIfPresent();
    const input = await this.findInputAmountField(index);
    await input.fill(amount);
  }

  // ─── Swap actions ─────────────────────────────────────────────────────────────

  async submitSwap(): Promise<void> {
    // The button stays disabled with a spinner until the quote is computed.
    await this.waitForOutputQuote();

    const swapButton = this.page.getByRole('button', { name: /^swap!?$/i }).first();
    await expect(swapButton).toBeVisible({ timeout: 15_000 });
    await expect(swapButton).toBeEnabled({ timeout: 30_000 });
    await swapButton.click();

    // Cetus may show an in-page "Confirm Swap" dialog before the wallet popup appears.
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

  async expectSuccess(): Promise<void> {
    const successText = this.page.getByText(/success|completed|submitted|view in explorer/i).first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
  }

  // ─── Result reading ───────────────────────────────────────────────────────────

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

    const digestFromNavigation = await this.readDigestBySuiVisionNavigation(successDialog);
    if (digestFromNavigation) return digestFromNavigation;

    const bodyText = await this.page.locator('body').innerText().catch(() => '');
    const digest = bodyText.match(/[A-Za-z0-9]{40,90}/)?.[0];
    if (digest) return digest;

    return undefined;
  }

  /**
   * Locator for the read-only amount field in the "You Receive" panel.
   *
   * "You Pay" and "You Receive" are siblings inside the same container, so no
   * ancestor of "You Receive" can exclude the pay panels. Walking forward from the
   * label is the only reliable scoping; the disabled-input fallback works because
   * the receive field is the sole non-editable amount input on the page.
   */
  private outputAmountInput(): Locator {
    return this.page
      .getByText(/^you receive$/i)
      .first()
      .locator('xpath=following::input[1]');
  }

  /**
   * Waits for the aggregator quote to finish computing.
   *
   * While the route is being calculated the receive field stays empty and is
   * wrapped in a chakra skeleton, so reading it immediately yields nothing.
   */
  private async waitForOutputQuote(timeoutMs = 60_000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    let logged = false;

    while (Date.now() < deadline) {
      const value = await this.readOutputAmountValue();
      if (value !== null) {
        console.log(`[MergeSwapPage] Quote ready, output amount: ${value}`);
        return value;
      }
      if (!logged) {
        console.log('[MergeSwapPage] Waiting for the quote to finish loading...');
        logged = true;
      }
      await this.page.waitForTimeout(500);
    }

    console.warn(`[MergeSwapPage] Quote did not load within ${timeoutMs}ms`);
    return null;
  }

  /** Returns the positive receive amount, or null while the quote is unavailable. */
  private async readOutputAmountValue(): Promise<number | null> {
    const candidates = [
      this.outputAmountInput(),
      this.page.locator('input[readonly], input[disabled]').first()
    ];

    for (const candidate of candidates) {
      const raw = await candidate.inputValue({ timeout: 1_000 }).catch(() => '');
      const parsed = parseFloat(raw.replace(/,/g, ''));
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }

    return null;
  }

  /**
   * Reads the expected output amount from the "You Receive" panel.
   * Waits for the quote to settle first, since the field is empty while loading.
   */
  async getExpectedOutputAmount(outputDecimal: number = 9): Promise<bigint> {
    const quoted = await this.waitForOutputQuote();
    if (quoted !== null) {
      return toAtomicAmount(quoted.toFixed(outputDecimal), outputDecimal);
    }

    // Last resort: any numeric-looking text after the "You Receive" label.
    const textNodes = this.page
      .getByText(/^you receive$/i)
      .first()
      .locator('xpath=following::*[self::p or self::span or self::div]');
    const nodeCount = await textNodes.count().catch(() => 0);
    for (let i = 0; i < Math.min(nodeCount, 40); i++) {
      const text = await textNodes.nth(i).innerText().catch(() => '');
      const match = text.trim().match(/^(\d[\d,]*(?:\.\d+)?)$/);
      if (!match) continue;
      const parsed = parseFloat(match[1]!.replace(/,/g, ''));
      if (!isNaN(parsed) && parsed > 0) {
        console.log(`[MergeSwapPage] Output amount from text node: ${parsed}`);
        return toAtomicAmount(parsed.toFixed(outputDecimal), outputDecimal);
      }
    }

    throw new Error('[MergeSwapPage] Cannot read expected output amount from UI');
  }

  async getCurrentSlippagePercent(): Promise<string> {
    const slippageElements = this.page.locator('text=/^[0-9.]+%$/');
    const count = await slippageElements.count();
    for (let i = 0; i < count; i++) {
      const elem = slippageElements.nth(i);
      if (await elem.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const text = await elem.innerText();
        const match = text.match(/^([0-9.]+)%$/);
        if (match) {
          console.log(`[MergeSwapPage] Read slippage from UI: ${match[1]}%`);
          return match[1];
        }
      }
    }
    console.warn('[MergeSwapPage] Could not read slippage from UI, returning default 1%');
    return '1.0';
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  async dismissTermsModalIfPresent() {
    const confirmButton = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^confirm$/i })
      .last();
    const confirmVisible = await confirmButton.isVisible().catch(() => false);
    if (!confirmVisible) return;

    // Do NOT dismiss if the visible "Confirm" belongs to the token picker dialog
    // (identified by the presence of a search input inside the same dialog).
    const isTokenPicker = await this.page
      .locator('[role="dialog"], [data-state="open"]')
      .filter({ has: this.page.locator('input[placeholder*="Search" i], input[placeholder*="token" i]') })
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (isTokenPicker) return;

    for (let attempt = 0; attempt < 5; attempt++) {
      if (!(await confirmButton.isVisible().catch(() => false))) return;

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
              const candidate = Array.from(
                modalRoot.querySelectorAll<HTMLElement>('button, [role="button"], div, span')
              ).find((el) => pattern.test((el.textContent ?? '').trim()));
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
    if (!symbol) throw new Error(`Invalid coin type: "${coinType}"`);
    return symbol;
  }

  /**
   * Closes any open token picker modal by pressing Escape or clicking outside.
   * This prevents picker overlay from blocking subsequent clicks.
   */
  private async closeAnyOpenPickerModal(): Promise<void> {
    // Check for any open picker dialog (with or without search input)
    const pickerDialog = this.page.locator('[role="dialog"]').last();

    const isOpen = await pickerDialog.isVisible({ timeout: 1_000 }).catch(() => false);
    if (!isOpen) {
      console.log('[MergeSwapPage] No open picker found');
      return;
    }

    console.log('[MergeSwapPage] Found open picker, attempting to close it');
    
    // Try pressing Escape to close
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.page.waitForTimeout(800);

    // If still visible, try clicking the X button
    const stillVisible = await pickerDialog.isVisible({ timeout: 500 }).catch(() => false);
    if (stillVisible) {
      const closeBtn = pickerDialog.locator('button[aria-label*="close" i], button:has-text("×")').first();
      if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await closeBtn.click();
        await this.page.waitForTimeout(800);
      }
    }
    
    // Wait for any chakra portal overlay to be fully removed
    let attempts = 0;
    while (attempts < 5) {
      const portalOverlay = this.page.locator('.chakra-portal, [data-state="open"]').first();
      const hasOverlay = await portalOverlay.isVisible({ timeout: 500 }).catch(() => false);
      if (!hasOverlay) {
        console.log('[MergeSwapPage] All picker overlays cleared');
        break;
      }
      console.log(`[MergeSwapPage] Overlay still present, waiting... (attempt ${attempts + 1})`);
      await this.page.waitForTimeout(800);
      attempts++;
    }
  }

  /**
   * Clicks the "+ Add one more token" button.
   * This directly opens the token picker modal for the second input token.
   */
  private async clickAddOneMoreToken(): Promise<void> {
    const addBtn = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /add one more token/i })
      .first();
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
    await addBtn.click();
    // Wait for the picker modal to appear
    await this.page
      .locator('[role="dialog"]')
      .filter({ has: this.page.locator('input[placeholder*="Search" i]') })
      .waitFor({ state: 'visible', timeout: 10_000 });
    console.log('[MergeSwapPage] Picker opened by "+ Add one more token"');
  }

  /**
   * Collects all ENABLED token-selector buttons on the page in DOM order.
   *
   * Criteria:
   *   - Visible and NOT disabled
   *   - Text is "Select a token" (placeholder) OR an uppercase symbol (2–12 chars)
   *   - Excludes action buttons: HALF, MAX, SWAP, CONFIRM
   *
   * On the merge-swap page the DOM order is:
   *   [input-0] → [input-1 (if set)] → [output]
   *
   * The large gray "Select a token" CTA button at the bottom is always DISABLED,
   * so it is automatically excluded.
   */
  private async collectEnabledTokenSelectorButtons(): Promise<Locator[]> {
    const allBtns = this.page.locator('button');
    const count = await allBtns.count();
    const result: Locator[] = [];

    for (let i = 0; i < count; i++) {
      const btn = allBtns.nth(i);
      if (!(await btn.isVisible({ timeout: 300 }).catch(() => false))) continue;
      if (await btn.isDisabled({ timeout: 300 }).catch(() => false)) continue;
      const text = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const isPlaceholder = /select a token/i.test(text);
      const isSymbol = /^[A-Z][A-Z0-9]{1,11}$/.test(text);
      if (!isPlaceholder && !isSymbol) continue;
      if (/^(half|max|swap|confirm)$/i.test(text)) continue;
      result.push(btn);
    }

    const labels = await Promise.all(result.map(b => b.innerText().catch(() => '?')));
    console.log(`[MergeSwapPage] Enabled token selector buttons (${result.length}): [${labels.join(', ')}]`);
    return result;
  }

  /**
   * Finds the token selector button for input slot 0.
   * The FIRST enabled token selector button in DOM order always belongs to input-0
   * ("You Pay" section is above "You Receive" in the DOM).
   */
  private async findInputSlotSelectorButton(_index: 0): Promise<Locator> {
    const btns = await this.collectEnabledTokenSelectorButtons();
    if (btns.length > 0) return btns[0]!;
    throw new Error('[MergeSwapPage] Cannot find input slot selector button at index 0');
  }

  /**
   * Finds the token selector button for the output panel ("You Receive").
   * The LAST enabled token selector button in DOM order always belongs to the
   * output panel (it appears below the input panels in the DOM).
   */
  private async findOutputSlotSelectorButton(): Promise<Locator> {
    const btns = await this.collectEnabledTokenSelectorButtons();
    if (btns.length > 0) {
      const last = btns[btns.length - 1]!;
      const label = await last.innerText().catch(() => '?');
      console.log(`[MergeSwapPage] Output selector = last button: "${label}"`);
      return last;
    }
    throw new Error('[MergeSwapPage] Cannot find output slot selector button');
  }

  private async pickTokenFromPicker(coinType: string, tokenRegex: RegExp): Promise<void> {
    // Wait for picker to be fully rendered
    await this.page.waitForTimeout(800);

    // Type A picker (input tokens): has a search input inside the dialog
    const pickerWithSearch = this.page
      .locator('[role="dialog"], [data-state="open"]')
      .filter({ has: this.page.locator('input[placeholder*="Search" i], input[placeholder*="token" i]') })
      .last();

    // Type B picker (output token): simple list dialog, no search input
    const anyDialog = this.page.locator('[role="dialog"]').last();

    let pickerRoot: typeof anyDialog;

    const hasSearchPicker = await pickerWithSearch.isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasSearchPicker) {
      console.log('[MergeSwapPage] Using Type A picker (with search input)');
      pickerRoot = pickerWithSearch;
    } else {
      console.log('[MergeSwapPage] Falling back to Type B picker (no search input required)');
      await anyDialog.waitFor({ state: 'visible', timeout: 10_000 });
      pickerRoot = anyDialog;
    }

    const searchInput = pickerRoot
      .locator('input[placeholder*="Search" i], input[placeholder*="token" i]')
      .first();

    if (await searchInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      // Search by full coin type to avoid scam tokens with the same symbol
      await searchInput.fill('');
      await this.page.waitForTimeout(300);
      await searchInput.fill(coinType);
      console.log(`[MergeSwapPage] Searching for token: ${coinType}`);
      // Wait for search results to load
      await this.page.waitForTimeout(2_500);
    } else {
      console.log(`[MergeSwapPage] No search input found; scanning list for: ${tokenRegex}`);
      await this.page.waitForTimeout(1_000);
    }

    let clicked = false;
    const symbol = tokenRegex.source.replace(/^\^/, '').replace(/\$$/, '');

    // Strategy 0: row-level button whose FIRST text line is the symbol.
    //
    // Cetus renders each token row as one button containing several lines,
    // e.g. "SUI\n\nSUI Token\n4.740783439\n\n$3.31". Matching /^SUI$/ against the
    // whole accessible name never succeeds, and the nested "SUI Token" button does
    // not select the token. Keying on the first line targets the outer row button.
    if (await this.clickTokenRowByFirstLine(pickerRoot, symbol)) {
      clicked = true;
    }

    // Strategy 1: button role
    if (!clicked) {
      const byButton = pickerRoot.getByRole('button', { name: tokenRegex }).first();
      if (await byButton.isVisible({ timeout: 8_000 }).catch(() => false)) {
        console.log(`[MergeSwapPage] Found token by button role: ${tokenRegex}`);
        await byButton.click();
        clicked = true;
      }
    }

    // Strategy 2: any visible text
    if (!clicked) {
      const byText = pickerRoot.getByText(tokenRegex).first();
      if (await byText.isVisible({ timeout: 6_000 }).catch(() => false)) {
        console.log(`[MergeSwapPage] Found token by text: ${tokenRegex}`);
        await byText.click();
        clicked = true;
      }
    }

    // Strategy 3: any clickable element whose text contains the symbol on its own line
    if (!clicked) {
      const symLower = symbol.toLowerCase();
      const tokenElements = pickerRoot.locator(
        'button, [role="button"], div[data-token-item-index], div[class*="token"], div[class*="item"]'
      );
      const count = await tokenElements.count();
      for (let i = 0; i < count; i++) {
        const elem = tokenElements.nth(i);
        const text = await elem.innerText().catch(() => '');
        const lines = text.split(/\s*\n\s*/).map(l => l.trim()).filter(Boolean);
        if (lines.some(l => l.toLowerCase() === symLower) || tokenRegex.test(text.trim())) {
          console.log(`[MergeSwapPage] Found token by element text: ${lines.join(' | ')}`);
          await elem.click();
          clicked = true;
          break;
        }
      }
    }

    // Strategy 4: page-level fallback
    if (!clicked) {
      const pageLevel = this.page.getByRole('button', { name: tokenRegex }).first();
      if (await pageLevel.isVisible({ timeout: 3_000 }).catch(() => false)) {
        console.log(`[MergeSwapPage] Found token at page level: ${tokenRegex}`);
        await pageLevel.click();
        clicked = true;
      }
    }

    if (!clicked) {
      console.error(`[MergeSwapPage] Failed to find token ${tokenRegex} in picker after searching for: ${coinType}`);
      throw new Error(`[MergeSwapPage] Token "${tokenRegex}" not found in picker`);
    }

    // The merge-swap token picker uses a "Confirm" button to finalise the selection.
    // Click it if visible so the picker modal fully closes before the next action.
    await this.confirmPickerIfNeeded(pickerRoot);
  }

  /**
   * Clicks the token row whose FIRST text line equals the symbol.
   *
   * Token rows render as a single button with stacked lines
   * ("SUI" / "SUI Token" / balance / value), so exact-name matching cannot be used.
   * Rows wrapped in `[data-token-item-index]` are tried first because that is the
   * real list container; the generic button sweep is only a fallback.
   */
  private async clickTokenRowByFirstLine(pickerRoot: Locator, symbol: string): Promise<boolean> {
    const symLower = symbol.toLowerCase();
    const candidateSets = [
      pickerRoot.locator('div[data-token-item-index] > button'),
      pickerRoot.locator('button.chakra-button, button')
    ];

    for (const rows of candidateSets) {
      const count = await rows.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        if (!(await row.isVisible({ timeout: 300 }).catch(() => false))) continue;

        const text = await row.innerText().catch(() => '');
        const firstLine = text.split('\n')[0]?.trim().toLowerCase() ?? '';
        if (firstLine !== symLower) continue;

        console.log(`[MergeSwapPage] Found token row by first line: ${symbol}`);
        await row.click();
        return true;
      }
    }

    return false;
  }

  /**
   * If the picker dialog still shows a "Confirm" button after a token is clicked,
   * click it to close the picker.  This is specific to the merge-swap multi-step picker.
   */
  private async confirmPickerIfNeeded(
    pickerRoot: ReturnType<typeof this.page.locator>
  ): Promise<void> {
    await this.page.waitForTimeout(500);
    
    const confirmBtn = pickerRoot
      .locator('button, [role="button"]')
      .filter({ hasText: /^confirm$/i })
      .first();

    const isVisible = await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!isVisible) {
      console.log('[MergeSwapPage] No Confirm button found in picker, assuming already closed');
      return;
    }

    console.log('[MergeSwapPage] Clicking Confirm button to close picker');
    await confirmBtn.click();
    
    // Wait for the modal to fully close
    await pickerRoot.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    
    // CRITICAL: Wait for the chakra portal overlay to be completely removed from DOM
    // This prevents "intercepts pointer events" errors on subsequent clicks
    await this.page.waitForTimeout(1_000);
    
    // Verify no portal overlay is blocking interactions
    const portalOverlay = this.page.locator('.chakra-portal, [data-state="open"]').first();
    let attempts = 0;
    while (attempts < 5) {
      const hasOverlay = await portalOverlay.isVisible({ timeout: 500 }).catch(() => false);
      if (!hasOverlay) break;
      console.log(`[MergeSwapPage] Portal overlay still visible, waiting... (attempt ${attempts + 1})`);
      await this.page.waitForTimeout(800);
      attempts++;
    }
    
    console.log('[MergeSwapPage] Picker fully closed and overlay removed');
  }

  /**
   * Finds the amount input field for a given input panel (0 or 1).
   * Scopes search to the "You Pay" section so we never accidentally target
   * the read-only "You Receive" output field.
   */
  private async findInputAmountField(index: 0 | 1): Promise<Locator> {
    const inputSelector =
      'input[inputmode="decimal"], input[placeholder="0"], input[placeholder="0.0"], input[type="text"]';

    // Try scoping to the "You Pay" section first.
    for (const depth of [3, 4, 5]) {
      const youPaySection = this.page
        .getByText(/^you pay$/i)
        .first()
        .locator(`xpath=ancestor::*[self::div or self::section][${depth}]`);

      const inputs = youPaySection.locator(inputSelector);
      const count = await inputs.count();
      const editableInputs: Locator[] = [];

      for (let i = 0; i < count; i++) {
        const input = inputs.nth(i);
        if (!(await input.isVisible({ timeout: 500 }).catch(() => false))) continue;
        const isReadonly =
          (await input.getAttribute('readonly').catch(() => null)) !== null ||
          (await input.getAttribute('disabled').catch(() => null)) !== null;
        if (!isReadonly) editableInputs.push(input);
      }

      if (editableInputs.length > index) {
        return editableInputs[index]!;
      }
    }

    // Fallback: all editable inputs on the page in DOM order.
    const allInputs = this.page.locator(inputSelector);
    const total = await allInputs.count();
    const editable: Locator[] = [];
    for (let i = 0; i < total; i++) {
      const inp = allInputs.nth(i);
      if (!(await inp.isVisible({ timeout: 500 }).catch(() => false))) continue;
      const isReadonly =
        (await inp.getAttribute('readonly').catch(() => null)) !== null ||
        (await inp.getAttribute('disabled').catch(() => null)) !== null;
      if (!isReadonly) editable.push(inp);
    }
    if (editable.length > index) return editable[index]!;

    throw new Error(`[MergeSwapPage] Cannot find amount input at index ${index}`);
  }

  private async readDigestBySuiVisionNavigation(
    successDialog?: ReturnType<typeof this.page.locator>
  ): Promise<string | undefined> {
    const dialog =
      successDialog ??
      this.page
        .locator('[role="dialog"], .chakra-modal__content')
        .filter({ hasText: /transaction completed|view on explorer|suivision|suiscan/i })
        .last();

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

      const match =
        url.match(/txblock\/([^/?#]+)/i)?.[1] ??
        url.match(/\/tx\/([^/?#]+)/i)?.[1] ??
        url.match(/transaction\/([^/?#]+)/i)?.[1];

      if (match && match.length > 10) return decodeURIComponent(match);
    } catch {
      // Ignore – caller will fall back to balance-movement checks
    }

    return undefined;
  }
}
