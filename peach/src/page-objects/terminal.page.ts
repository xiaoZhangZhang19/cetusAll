import { type Page } from '@playwright/test';
import type { MetaMaskController } from '../wallet/metamask-controller.js';

export interface TokenEntry {
  symbol: string;
  rank: number;
}

export interface SwapUsdValues {
  payUsd: number | null;
  receiveUsd: number | null;
  payUsdText: string;
  receiveUsdText: string;
}

export interface TerminalSwapResult {
  symbol: string;
  rank: number;
  status: 'passed' | 'failed' | 'skipped' | 'error';
  reason?: string;
  payUsd?: number | null;
  receiveUsd?: number | null;
  durationMs?: number;
}

// Known UI keywords to exclude from token-symbol extraction.
// NOTE: Single-char time labels (1h/4h/24h) contain digits so they fail the
// regex — do NOT add H/M/D/W here because those are also valid token names.
const UI_KEYWORDS = new Set([
  'TOKEN', 'PRICE', 'BUY', 'SELL', 'BNB', 'USD', 'NEW', 'AGE',
  'FDV', 'LIQ', 'VOL', 'MC', 'TRENDING', 'WATCHLIST', 'GAINERS',
  'TX', 'TXNS', 'QUICK', 'SWAP', 'TRADE', 'BRIDGE', 'ANALYTICS',
  'TERMINAL', 'SEARCH', 'PEACH', 'FILTER', 'SAFE', 'ALL',
  'WBNB',  // wrapped-BNB – a price pair label, not a standalone token in the list
]);

/**
 * Page Object for Peach Terminal page.
 *
 * Responsibilities:
 *   - Navigate to /terminal and collect the top-N token symbols
 *   - Open the global search and navigate to a specific token's swap page
 *   - Read USD values from the token swap widget ("You Pay" / "You Receive")
 *   - Execute the buy (swap) and handle MetaMask confirmation
 */
export class TerminalPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  async goto(appUrl: string) {
    await this.page.goto(`${appUrl}/terminal`, { waitUntil: 'domcontentloaded' });
    try {
      await this.page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {
      console.log('[TerminalPage] networkidle timed out, continuing...');
    }
    // Lightweight check — wait for Trending/Watchlist tab
    await this.page
      .locator('text=/Trending|Watchlist/i')
      .first()
      .waitFor({ timeout: 20000 })
      .catch(() => console.log('[TerminalPage] Trending/Watchlist not found, continuing...'));
    console.log('[TerminalPage] Terminal page loaded');
    await this.dismissTermsDialogIfPresent();
  }

  /**
   * After metamask.connect() (which reloads the page), wait for token list
   * to actually render before we try to collect symbols.
   */
  async waitForTokenListReady(timeoutMs = 25_000): Promise<void> {
    console.log('[TerminalPage] Waiting for token list to render...');

    // Wait for at least one element that looks like it is inside a token row:
    // table row OR a div containing a short price like "$0.xxx"
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Look for dollar-price text — a reliable sign the list has loaded
      const priceTexts = await this.page
        .locator('td, span, div, p')
        .filter({ hasText: /^\$[\d,.]+$/ })
        .count()
        .catch(() => 0);

      if (priceTexts >= 3) {
        console.log(`[TerminalPage] Token list ready (${priceTexts} price cells found)`);
        return;
      }
      await this.page.waitForTimeout(1000);
    }
    console.log('[TerminalPage] ⚠ Token list may not be fully loaded, proceeding anyway');
  }

  private async dismissTermsDialogIfPresent() {
    const dialog = this.page.locator('[role="dialog"]').filter({ hasText: /Terms.*Policies/i });
    const isVisible = await dialog.isVisible({ timeout: 3000 }).catch(() => false);
    if (!isVisible) return;

    console.log('[TerminalPage] Terms & Policies dialog – accepting');
    const checkbox = dialog.locator('[type="checkbox"], [role="checkbox"]').first();
    if (await checkbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      await checkbox.check();
      await this.page.waitForTimeout(500);
    }
    const confirmBtn = dialog.locator('button').filter({ hasText: /Confirm/i }).first();
    if (await confirmBtn.isEnabled({ timeout: 3000 }).catch(() => false)) {
      await confirmBtn.click();
    }
    await dialog.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
    console.log('[TerminalPage] Terms & Policies accepted');
  }

  // ── Token collection ──────────────────────────────────────────────────────

  /**
   * Scroll the terminal token list and collect the top `count` token symbols.
   *
   * Strategy: read all short uppercase text nodes on the page (via Playwright
   * locator + allTextContents), filter to token-symbol pattern, scroll down
   * to load more rows until we have enough.
   */
  async collectTopTokens(count = 20): Promise<TokenEntry[]> {
    const collected: TokenEntry[] = [];
    const seen = new Set<string>();
    let scrollAttempts = 0;
    const maxScrollAttempts = 15;

    console.log(`[TerminalPage] Collecting top ${count} tokens from terminal...`);
    await this.waitForTokenListReady();

    while (collected.length < count && scrollAttempts < maxScrollAttempts) {
      const symbolTexts = await this._extractVisibleSymbols();

      for (const sym of symbolTexts) {
        if (collected.length >= count) break;
        if (!seen.has(sym)) {
          seen.add(sym);
          const rank = collected.length + 1;
          collected.push({ symbol: sym, rank });
          console.log(`[TerminalPage]  #${rank} ${sym}`);
        }
      }

      if (collected.length < count) {
        // Move mouse into the token list area before scrolling.
        // We hover the last visible token row (or fallback to a fixed coordinate),
        // then wheel down — matching the user's manual scroll gesture.
        await this._scrollTokenList();
        await this.page.waitForTimeout(1200);
        scrollAttempts++;
      }
    }

    if (collected.length === 0) {
      // Debug: dump visible text to help diagnose selector mismatches
      const sample = await this.page
        .locator('span, td, p')
        .allTextContents()
        .catch(() => [] as string[]);
      const short = sample.filter((t) => t.trim().length > 0).slice(0, 60);
      console.log('[TerminalPage] ⚠ Debug — visible text nodes:', JSON.stringify(short));
    }

    console.log(`[TerminalPage] Collected ${collected.length} tokens.`);
    return collected;
  }

  /**
   * Move the mouse cursor to the center of the viewport (the token list area),
   * then wheel-scroll down. Placing the cursor at the screen center is required
   * to hit the scrollable token list — matching the user's manual scroll gesture
   * shown in the red-box reference screenshot.
   */
  private async _scrollTokenList(): Promise<void> {
    const viewport = this.page.viewportSize() ?? { width: 1440, height: 960 };
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;

    await this.page.mouse.move(cx, cy);
    await this.page.mouse.wheel(0, 600);
  }

  /**
   * Extract short uppercase token symbols from all visible leaf text nodes.
   * Uses Playwright's `allTextContents()` — no browser-side DOM traversal.
   */
  private async _extractVisibleSymbols(): Promise<string[]> {
    // Gather all text content from small inline elements
    const raw = await this.page
      .locator('span, td, p, h1, h2, h3')
      .allTextContents()
      .catch(() => [] as string[]);

    const results: string[] = [];
    for (const text of raw) {
      const t = text.trim();
      // Token symbol: 1–12 uppercase alphanumeric chars, starts with letter
      if (!/^[A-Z][A-Z0-9]{0,11}$/.test(t)) continue;
      if (UI_KEYWORDS.has(t)) continue;
      results.push(t);
    }

    return [...new Set(results)];
  }

  // ── Search & navigate to token page ──────────────────────────────────────

  /**
   * Click the global search button, type the token symbol, and click the
   * first matching result to navigate to the token's swap page.
   */
  async searchAndNavigateToToken(symbol: string): Promise<void> {
    console.log(`[TerminalPage] Searching for token: ${symbol}`);

    // Capture the current URL so we can detect navigation completion
    const urlBefore = this.page.url();

    const searchDialog = await this._openGlobalSearch();

    const searchInput = searchDialog
      .locator('input[placeholder*="Search" i], input[placeholder*="token" i], input[placeholder*="address" i]')
      .first();
    await searchInput.waitFor({ state: 'visible', timeout: 10000 });
    await searchInput.fill(symbol);
    console.log(`[TerminalPage] Typed: "${symbol}"`);

    // Wait for search results to appear inside the dialog (up to 6s)
    const resultsAppeared = await searchDialog
      .locator('[role="option"], li, div[role="button"]')
      .first()
      .isVisible({ timeout: 6000 })
      .catch(() => false);

    if (!resultsAppeared) {
      await this.page.waitForTimeout(1000).catch(() => {});
    }

    // Click within the dialog scope to avoid hitting the background token list
    const clicked = await this._clickFirstSearchResult(symbol, searchDialog);
    if (!clicked) {
      await this.page.keyboard.press('Escape');
      throw new Error(`[TerminalPage] No search results found for "${symbol}"`);
    }

    // Wait for URL to change (navigation started), then wait for the token page
    // header to appear — much faster than waiting for networkidle (avoids 15s timeout).
    await this.page.waitForFunction(
      (before) => window.location.href !== before,
      urlBefore,
      { timeout: 10000 },
    ).catch(() => {});

    // Wait for the "You Pay" label AND its input to be visible — this confirms
    // the swap widget has fully rendered and is ready for interaction.
    // Checking for the input (not just text) prevents race conditions where
    // the label text appears before the widget is interactive.
    await this.page
      .locator('div')
      .filter({ hasText: /You Pay/i })
      .filter({ has: this.page.locator('input') })
      .last()
      .waitFor({ state: 'visible', timeout: 15000 })
      .catch(async () => {
        // Fallback: at minimum wait for "You Pay" text node
        await this.page
          .locator('text=/You Pay/i')
          .first()
          .waitFor({ state: 'visible', timeout: 8000 })
          .catch(() => {});
      });

    // Extra settle: let the widget finish its initial route-search before we interact
    await this.page.waitForTimeout(1000);

    console.log(`[TerminalPage] Navigated to token page for: ${symbol}`);
  }

  /**
   * Open the global search dialog and return a scoped Locator for it.
   * Scoping all subsequent queries to this container prevents accidentally
   * matching background elements (e.g. token rows in the Terminal list).
   */
  private async _openGlobalSearch(): Promise<import('@playwright/test').Locator> {
    // Try keyboard shortcut first (⌘K / Ctrl+K)
    await this.page.keyboard.press('Meta+k').catch(() => {});
    const inputAppeared = await this.page
      .locator('input[placeholder*="Search" i], input[placeholder*="token" i]')
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);

    if (!inputAppeared) {
      const searchTriggers = [
        this.page.getByRole('button', { name: /search/i }),
        this.page.locator('button, [role="button"]').filter({ hasText: /Search/i }),
      ];
      for (const trigger of searchTriggers) {
        if (await trigger.first().isVisible({ timeout: 1500 }).catch(() => false)) {
          await trigger.first().click();
          break;
        }
      }
      await this.page
        .locator('input[placeholder*="Search" i], input[placeholder*="token" i]')
        .first()
        .waitFor({ state: 'visible', timeout: 8000 });
    }

    console.log('[TerminalPage] Global search opened');

    // Return the dialog/modal container scoped locator so callers don't
    // accidentally match background page elements.
    // Prefer an explicit [role="dialog"] or [role="combobox"] wrapper;
    // fall back to the narrowest visible container that holds the input.
    const dialogCandidates = [
      this.page.locator('[role="dialog"]').filter({
        has: this.page.locator('input[placeholder*="Search" i]'),
      }),
      this.page.locator('[role="combobox"]').filter({
        has: this.page.locator('input'),
      }),
      // Broader: any overlay/modal div containing the search input
      this.page.locator('div[class*="modal" i], div[class*="dialog" i], div[class*="overlay" i], div[class*="popup" i]').filter({
        has: this.page.locator('input[placeholder*="Search" i]'),
      }),
    ];

    for (const candidate of dialogCandidates) {
      if (await candidate.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        return candidate.first();
      }
    }

    // Fallback: scope to the immediate scrollable container around the input
    // (ancestor::div[3] is tighter than [5], reducing the chance of including
    // background terminal list items in the search scope).
    const input = this.page.locator('input[placeholder*="Search" i], input[placeholder*="token" i]').first();

    // Try to find a fixed/absolute-positioned ancestor first (modal container)
    const fixedAncestor = input.locator('xpath=ancestor::div[position()="fixed" or @style[contains(., "fixed")] or @style[contains(., "absolute")]][1]');
    const hasFixed = await fixedAncestor.isVisible({ timeout: 500 }).catch(() => false);
    if (hasFixed) return fixedAncestor;

    // Walk up 3 levels (conservative — likely stays inside the popup)
    return input.locator('xpath=ancestor::div[3]');
  }

  /**
   * Click the first search result that matches the token symbol.
   * All locators are scoped to `dialog` to prevent accidentally clicking
   * background elements (e.g. the same token symbol in the Terminal list).
   * Returns true if clicked, false if no results found.
   */
  private async _clickFirstSearchResult(
    symbol: string,
    dialog: import('@playwright/test').Locator,
  ): Promise<boolean> {
    // Wait for search API to return results
    await this.page.waitForTimeout(1500).catch(() => {});

    // Strategy 1: [role="option"] — standard combobox/listbox pattern
    const optionLoc = dialog.locator('[role="option"]');
    const optionCount = await optionLoc.count().catch(() => 0);
    if (optionCount > 0) {
      await optionLoc.first().click({ timeout: 15000 });
      console.log(`[TerminalPage] Clicked first result (role=option) for "${symbol}"`);
      return true;
    }

    // Strategy 2: clickable list items inside the dialog that contain the symbol
    const candidates = [
      dialog.locator('li, div[role="button"], [class*="result"]').filter({ hasText: symbol }),
      dialog.locator('a, button').filter({ hasText: new RegExp(`^${symbol}$|^${symbol}\\s`) }),
    ];

    for (const loc of candidates) {
      const first = loc.first();
      if (await first.isVisible({ timeout: 3000 }).catch(() => false)) {
        await first.click({ timeout: 15000 });
        console.log(`[TerminalPage] Clicked first result for "${symbol}"`);
        return true;
      }
    }

    // Strategy 3: any visible element with exact symbol text, scoped to dialog.
    // Restrict to interactive elements only (not plain text labels or headings)
    // to avoid accidentally clicking background token rows.
    const interactiveLoc = dialog
      .locator('li, a, button, [role="option"], [role="listitem"], [role="button"], div[class*="item"], div[class*="result"], div[class*="token"]')
      .filter({ hasText: new RegExp(`^${symbol}[\\s$/]|^${symbol}$`) })
      .first();
    if (await interactiveLoc.isVisible({ timeout: 3000 }).catch(() => false)) {
      await interactiveLoc.click({ timeout: 15000 });
      console.log(`[TerminalPage] Clicked interactive match for "${symbol}"`);
      return true;
    }

    // Strategy 4 (last resort): exact text match in dialog, but ONLY if it is
    // a child of a list/listbox to avoid hitting background elements.
    const listItems = dialog.locator('[role="listbox"] *, ul *, ol *').filter({ hasText: new RegExp(`^${symbol}$`) }).first();
    if (await listItems.isVisible({ timeout: 2000 }).catch(() => false)) {
      await listItems.click({ timeout: 15000 });
      console.log(`[TerminalPage] Clicked listbox item for "${symbol}"`);
      return true;
    }

    console.log(`[TerminalPage] ⚠ No clickable result found for "${symbol}"`);
    return false;
  }

  // ── Token swap widget (on /tokens/... pages) ──────────────────────────────

  /**
   * Wait for the Swap Tools toolbar (the bar containing the slippage/settings button)
   * to become visible. Returns true if the toolbar is found, false if not present
   * (so callers can skip settings interactions rather than waiting for a 10s timeout).
   *
   * Uses a short probe (1.5s) before committing to a longer wait, so if the
   * aria-label element simply doesn't exist on this page variant the method
   * returns quickly instead of burning 15+ seconds.
   */
  async waitForSwapToolbar(timeoutMs = 15000): Promise<boolean> {
    console.log('[TerminalPage] Waiting for Swap Tools toolbar...');

    // Fast probe: if the element isn't present within 1.5s, skip the long wait
    const quickFound = await this.page
      .locator('[aria-label="Swap tools"]')
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);

    if (!quickFound) {
      // Fallback: check for a slippage % text (alternate UI variant)
      const slippageFound = await this.page
        .locator('div, button, span')
        .filter({ hasText: /^\d+(\.\d+)?%$/ })
        .first()
        .isVisible({ timeout: 1500 })
        .catch(() => false);

      if (slippageFound) {
        console.log('[TerminalPage] Swap Tools toolbar found via slippage % fallback');
        await this.page.waitForTimeout(500);
        return true;
      }

      console.log('[TerminalPage] ⚠ Swap Tools toolbar not found — settings will be skipped');
      return false;
    }

    // Full wait now that we know the element exists
    await this.page
      .locator('[aria-label="Swap tools"]')
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .catch(() => {});
    console.log('[TerminalPage] Swap Tools toolbar is visible');
    await this.page.waitForTimeout(800);
    return true;
  }

  /**
   * Enter the pay amount in the "You Pay" input on the token swap widget.
   * Waits for the swap widget to fully render (You Pay label visible) before typing.
   * Waits for the "You Receive" quote to populate afterward.
   */
  async enterPayAmount(amount: string, timeoutMs = 20000): Promise<void> {
    // Step 0: wait for the "You Pay" label to be visible — confirms the swap
    // widget has fully rendered and is not still loading after navigation.
    await this.page
      .locator('text=/You Pay/i')
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => console.log('[TerminalPage] ⚠ "You Pay" label not found yet, continuing...'));

    // Step 1: locate the You Pay input by name="You Pay" (confirmed from DOM inspection).
    // Fallback to the first numeric-placeholder input if name attribute is absent.
    // We intentionally avoid any click() or coordinate-based interaction to prevent
    // accidentally triggering the 25%/50%/75%/100% balance shortcut buttons nearby.
    let payInput = this.page.locator('input[name="You Pay"]').first();
    const namedFound = await payInput.isVisible({ timeout: 3000 }).catch(() => false);

    if (!namedFound) {
      payInput = this.page.locator('input[placeholder="0.0"]').first();
      const placeholderFound = await payInput.isVisible({ timeout: 3000 }).catch(() => false);
      if (!placeholderFound) {
        // Last resort: DOM walk to find the input inside the You Pay card
        payInput = this.page.locator('input').first();
        await payInput.waitFor({ state: 'visible', timeout: 5000 });
        console.log('[TerminalPage] ⚠ Fell back to first input on page');
      }
    }

    // focus() + fill() — no click(), no coordinate dispatch, cannot misfire onto shortcut buttons
    await payInput.focus();
    await payInput.fill(amount);

    const actualValue = await payInput.inputValue().catch(() => '');
    if (actualValue !== amount) {
      console.log(`[TerminalPage] ⚠ Value mismatch: got="${actualValue}" expected="${amount}", retrying via keyboard`);
      await payInput.focus();
      await this.page.keyboard.press('Control+a');
      await this.page.keyboard.type(amount, { delay: 20 });
    }

    console.log(`[TerminalPage] Entered pay amount: ${amount}`);

    // Wait for "Searching routes" spinner to clear, then extra buffer
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const searching = await this.page
        .locator('text=/Searching routes/i')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (!searching) break;
      console.log('[TerminalPage] ⏳ Searching routes...');
      await this.page.waitForTimeout(1000).catch(() => {});
    }
    await this.page.waitForTimeout(1200).catch(() => {});
  }

  /**
   * Read the USD values shown below "You Pay" and "You Receive".
   *
   * DOM structure (Peach Terminal token page swap widget):
   *
   *   <div>  ← You Pay card
   *     <span>You Pay</span>
   *     <input value="0.0001" />        ← pay amount input (editable)
   *     <span>$0.06</span>              ← pay USD value  ← we want this
   *   </div>
   *   <div>  ← You Receive card
   *     <span>You Receive</span>
   *     <span>0.726189</span>           ← receive amount (NOT an input)
   *     <span>$0.07</span>              ← receive USD value  ← we want this
   *   </div>
   *
   * Strategy: locate each card by its label text, then find the first
   * dollar-formatted text node inside that card.
   * The "You Pay" card is the only one with an <input>; "You Receive" has none.
   * We do NOT filter by { has: input } for the receive section.
   */
  async getSwapUsdValues(): Promise<SwapUsdValues> {
    const parseDollar = (s: string): number | null => {
      const num = parseFloat(s.replace(/[$,]/g, ''));
      return isNaN(num) ? null : num;
    };

    let payUsdText = '';
    let receiveUsdText = '';

    // Locate the two swap cards using their label text.
    // We find the smallest enclosing div that contains ONLY the label
    // text (using .filter({ hasText }) with a tight regex to avoid matching
    // the outer wrapper which contains both cards).
    //
    // We take the LAST match for "You Pay" because the outer container
    // may also match; the innermost (last) element is the card itself.

    try {
      // "You Pay" card: has the pay input → use that to narrow scope
      const payCard = this.page
        .locator('div')
        .filter({ hasText: /You Pay/i })
        .filter({ has: this.page.locator('input') })
        .last();

      // The USD value is a span/div with text like "$0.06" inside the pay card
      payUsdText = (await payCard
        .locator('span, div, p')
        .filter({ hasText: /^\$[\d,.]+$/ })
        .first()
        .textContent({ timeout: 3000 })
        .catch(() => null))?.trim() ?? '';
    } catch { /* fallback below */ }

    try {
      // "You Receive" card: does NOT contain an input (receive amount is display-only).
      // Find the card that has "You Receive" label but NO input element.
      const allReceiveDivs = this.page
        .locator('div')
        .filter({ hasText: /You Receive/i });

      const count = await allReceiveDivs.count().catch(() => 0);
      let receiveCard = allReceiveDivs.first();

      // Prefer the innermost div that has "You Receive" text but no nested input
      for (let i = 0; i < count; i++) {
        const el = allReceiveDivs.nth(i);
        const hasInput = await el.locator('input').count().then(n => n > 0).catch(() => false);
        if (!hasInput) {
          receiveCard = el;
          break;
        }
      }

      receiveUsdText = (await receiveCard
        .locator('span, div, p')
        .filter({ hasText: /^\$[\d,.]+$/ })
        .first()
        .textContent({ timeout: 3000 })
        .catch(() => null))?.trim() ?? '';
    } catch { /* fallback below */ }

    // Fallback: if either value is still missing, collect all dollar-formatted
    // texts that appear between "You Pay" and "Min. Received" on the page.
    // We use evaluate() to walk the DOM in order and pick the first two small
    // dollar values found inside the swap widget area.
    if (!payUsdText || !receiveUsdText) {
      console.log('[TerminalPage] Primary USD selectors missed, trying DOM walk fallback...');
      try {
        const allDollarTexts: string[] = await this.page.evaluate(() => {
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
          );
          const results: string[] = [];
          let node: Node | null;
          while ((node = walker.nextNode())) {
            const text = (node.textContent ?? '').trim();
            if (/^\$[\d,.]+$/.test(text)) {
              // Exclude nodes that are children of the sidebar token list
              // (typically in a <table> or a list that scrolls)
              const el = node.parentElement;
              const inTable = el?.closest('table, [class*="token-list"], [class*="TokenList"]');
              if (!inTable) results.push(text);
            }
          }
          return results;
        });

        if (!payUsdText && allDollarTexts[0]) payUsdText = allDollarTexts[0];
        if (!receiveUsdText && allDollarTexts[1]) receiveUsdText = allDollarTexts[1];
      } catch { /* ignore */ }
    }

    const result: SwapUsdValues = {
      payUsdText,
      receiveUsdText,
      payUsd: parseDollar(payUsdText),
      receiveUsd: parseDollar(receiveUsdText),
    };

    if (!payUsdText && !receiveUsdText) {
      console.log('[TerminalPage] ⚠ No USD values found in swap widget');
    } else {
      console.log(`[TerminalPage] USD values — Pay: ${payUsdText} (${result.payUsd}), Receive: ${receiveUsdText} (${result.receiveUsd})`);
    }
    return result;
  }

  /**
   * Returns true if the receive USD value is suspiciously low vs pay USD.
   */
  isUsdValueSuspicious(usdValues: SwapUsdValues, threshold = 0.5): boolean {
    const { payUsd, receiveUsd } = usdValues;
    if (payUsd === null || receiveUsd === null || payUsd === 0) return false;
    const ratio = receiveUsd / payUsd;
    if (ratio < threshold) {
      console.log(
        `[TerminalPage] ⚠ Suspicious USD ratio: ${receiveUsd} / ${payUsd} = ${ratio.toFixed(2)} < ${threshold}`,
      );
      return true;
    }
    return false;
  }

  /**
   * Returns true if there is no valid route for the current token.
   */
  async hasNoRoute(): Promise<boolean> {
    const noRoute = await this.page
      .locator('button, div')
      .filter({ hasText: /No route|Insufficient liquidity|No liquidity|Route not found/i })
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (noRoute) console.log('[TerminalPage] No route found for this token');
    return noRoute;
  }

  /**
   * Execute the buy/swap on the token page.
   * Waits for Buy button to be stable and enabled, clicks it, handles
   * in-page confirmation, then approves in MetaMask.
   */
  async executeBuy(metamask: MetaMaskController): Promise<void> {
    // Step 0: dismiss any overlays (language popup, tooltips, etc.)
    await this._dismissOverlays();

    // The token page has TWO "Buy" elements:
    //   1. The "Buy | Sell" toggle tab at the top of the swap panel
    //   2. The green action button at the bottom (the real one to click)
    // `.last()` targets the green action button, not the tab.
    const buyBtn = this.page
      .locator('button')
      .filter({ hasText: /^Buy$/i })
      .last();

    // Poll every 5s (up to 60s) for Buy button to become visible AND enabled.
    // The button may be absent or disabled while routes are being searched.
    const BUY_POLL_INTERVAL_MS = 5_000;
    const BUY_MAX_WAIT_MS      = 60_000;
    const buyDeadline          = Date.now() + BUY_MAX_WAIT_MS;
    let   btnEnabled           = false;

    while (Date.now() < buyDeadline) {
      const elapsed = Math.round((BUY_MAX_WAIT_MS - (buyDeadline - Date.now())) / 1000);

      // Is there a "Searching routes" indicator on screen?
      const searching = await this.page
        .locator('text=/Searching.*route|Finding.*route|Loading.*route|Fetching.*route/i')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);

      // Is the Buy button currently visible?
      const visible = await buyBtn.isVisible({ timeout: 500 }).catch(() => false);
      // Is it enabled (not grayed-out / disabled)?
      const enabled = visible
        ? await buyBtn.isEnabled({ timeout: 500 }).catch(() => false)
        : false;

      console.log(
        `[TerminalPage] Buy button check @ ${elapsed}s — ` +
        `visible=${visible} enabled=${enabled} searching=${searching}`
      );

      if (visible && enabled) {
        btnEnabled = true;
        break;
      }

      const remaining = Math.ceil((buyDeadline - Date.now()) / 1000);
      if (remaining <= 0) break;

      console.log(`[TerminalPage] Waiting 5s for Buy button... (${remaining}s left)`);
      await this.page.waitForTimeout(BUY_POLL_INTERVAL_MS);
    }

    if (!btnEnabled) {
      throw new Error('[TerminalPage] Buy button did not become enabled within 60s — routes not found?');
    }

    // Scroll Buy button into view and let it stabilize before clicking
    await buyBtn.scrollIntoViewIfNeeded();
    await this.page.waitForTimeout(500);

    console.log(`[TerminalPage] Buy button visible, enabled=true`);
    
    // Force-click to bypass any potential overlays
    await buyBtn.click({ force: true });
    console.log('[TerminalPage] Buy button clicked (force)');
    
    // Give more time for the transaction request to be sent to MetaMask
    await this.page.waitForTimeout(2500);

    // Verify that the click actually triggered something:
    // Check if any loading indicator appears, or button becomes disabled
    const btnStillEnabled = await buyBtn.isEnabled({ timeout: 2000 }).catch(() => true);
    const loadingVisible = await this.page
      .locator('text=/Loading|Confirming|Pending/i')
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    
    console.log(`[TerminalPage] After Buy click: btnEnabled=${btnStillEnabled}, loading=${loadingVisible}`);

    await this._waitForConfirmAndSubmit();
    
    console.log('[TerminalPage] Waiting for MetaMask popup...');
    await metamask.approveTransaction(this.page);
    // Bring the dApp page back to front after MetaMask popup closes
    await this.page.bringToFront().catch(() => {});
    console.log('[TerminalPage] Buy transaction submitted to MetaMask');
  }

  /**
   * Dismiss any overlays that might block the Buy button (language popup, etc.)
   */
  private async _dismissOverlays(): Promise<void> {
    // Try to close any visible modal/popup by pressing Escape
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(300);
    
    // Look for common close buttons (× only — avoid accidentally clicking the swap Close button)
    const closeButtons = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /^×$|^✕$|^Dismiss$/i });
    
    const count = await closeButtons.count().catch(() => 0);
    if (count > 0) {
      for (let i = 0; i < Math.min(count, 3); i++) {
        const btn = closeButtons.nth(i);
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click({ timeout: 1000 }).catch(() => {});
          console.log('[TerminalPage] Dismissed overlay');
        }
      }
    }
  }

  private async _waitForConfirmAndSubmit(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    const confirmBtn = this.page
      .locator('button')
      .filter({ hasText: /Confirm Swap|Confirm Buy|Confirm/i })
      .last();

    if (!(await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
      console.log('[TerminalPage] No in-page confirm dialog, going directly to MetaMask');
      return;
    }

    console.log('[TerminalPage] Waiting for Confirm button...');

    while (Date.now() < deadline) {
      const acceptBtn = this.page.locator('button').filter({ hasText: /^Accept$/i }).first();
      if (await acceptBtn.isVisible({ timeout: 800 }).catch(() => false)) {
        console.log('[TerminalPage] Price update – clicking Accept');
        await acceptBtn.click({ timeout: 3000 }).catch(() => {});
        await this.page.waitForTimeout(800);
        continue;
      }

      if (await confirmBtn.isEnabled({ timeout: 800 }).catch(() => false)) {
        await this.page.waitForTimeout(300);
        if (await this.page.locator('button').filter({ hasText: /^Accept$/i }).first()
          .isVisible({ timeout: 300 }).catch(() => false)) continue;
        await confirmBtn.click({ timeout: 5000 }).catch(() => {});
        console.log('[TerminalPage] Confirm button clicked');
        return;
      }

      await this.page.waitForTimeout(500);
    }

    throw new Error('[TerminalPage] Timed out waiting for Confirm button');
  }

  /**
   * Check whether the page is still alive (not closed/crashed).
   */
  private async _isPageAlive(): Promise<boolean> {
    try {
      await this.page.evaluate(() => true);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Dismiss the success dialog (Swap completed popup) with retries.
   * Dialog structure: title="Swap", body="Success", orange "Close" button, × top-right.
   */
  private async _dismissSuccessDialog(tag = ''): Promise<void> {
    // Give the dialog a moment to fully render before attempting close
    await this.page.waitForTimeout(500).catch(() => {});

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!(await this._isPageAlive())) {
        console.log(`[TerminalPage] ${tag}Page is closed, skip dismiss`);
        return;
      }

      // Strategy A: getByRole — most reliable, handles whitespace automatically
      const byRole = this.page.getByRole('button', { name: /close/i });
      const byRoleCount = await byRole.count().catch(() => 0);
      console.log(`[TerminalPage] ${tag}[dismiss attempt ${attempt}] getByRole "close" found ${byRoleCount}`);

      if (byRoleCount > 0) {
        // Pick the last visible one (the orange action button, not any icon button)
        const btn = byRole.last();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.log(`[TerminalPage] ${tag}Clicking "Close" button (getByRole, last)`);
          await btn.click({ force: true });
          // Wait for the success text to disappear (dialog closed)
          const gone = await this.page
            .locator(':text("Success")')
            .waitFor({ state: 'hidden', timeout: 4000 })
            .then(() => true)
            .catch(() => false);
          console.log(`[TerminalPage] ${tag}Success dialog gone=${gone}`);
          await this.page.waitForTimeout(300).catch(() => {});
          return;
        }
      }

      // Strategy B: × icon at top-right of the dialog
      const xBtn = this.page.locator('button').filter({ hasText: /^[×✕x]$/i }).last();
      if (await xBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log(`[TerminalPage] ${tag}Clicking × icon button`);
        await xBtn.click({ force: true });
        await this.page.waitForTimeout(500).catch(() => {});
        return;
      }

      // Strategy C: keyboard Escape
      console.log(`[TerminalPage] ${tag}[dismiss attempt ${attempt}] Pressing Escape`);
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(500).catch(() => {});

      // Check if dialog closed
      const stillVisible = await this.page
        .locator(':text("Success")')
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (!stillVisible) {
        console.log(`[TerminalPage] ${tag}Success dialog dismissed via Escape`);
        return;
      }
    }

    console.log(`[TerminalPage] ${tag}⚠ Could not dismiss success dialog after 3 attempts`);
  }

  /**
   * Wait for a "Success" dialog after the swap transaction.
   * Returns true on success, false on failure or page-closed.
   */
  async waitForSwapSuccess(timeoutMs = 60_000, label = ''): Promise<boolean> {
    const tag = label ? `[${label}] ` : '';
    const deadline = Date.now() + timeoutMs;
    const intervalMs = 2_000;

    console.log(`[TerminalPage] ${tag}Waiting for swap success (timeout ${timeoutMs / 1000}s)...`);

    while (Date.now() < deadline) {
      // Bail out early if page was closed
      if (!(await this._isPageAlive())) {
        console.log(`[TerminalPage] ${tag}⚠ Page closed while waiting for success`);
        return false;
      }

      const remaining = Math.ceil((deadline - Date.now()) / 1000);

      // Accept multiple success patterns: /swap page uses "Success",
      // token detail pages may say "Confirmed", "Successful", etc.
      const successVisible = await this.page
        .locator('text=/Success|Confirmed|Successful|Transaction.*complete|Buy.*confirm/i')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);

      if (successVisible) {
        const tradedText = await this.page
          .locator('text=/Traded.*for|Bought|Confirmed/i').first()
          .textContent({ timeout: 3000 }).catch(() => null);
        console.log(`[TerminalPage] ${tag}✓ Swap success${tradedText ? ': ' + tradedText.trim() : ''}`);

        // Dismiss success dialog — required before next token
        await this._dismissSuccessDialog(tag);
        return true;
      }

      const FAIL_PATTERN = /Transaction failed|Swap failed|Something went wrong|Oops/i;
      const failVisible = await this.page
        .locator(`text=${FAIL_PATTERN}`).first()
        .isVisible({ timeout: 500 }).catch(() => false);

      if (failVisible) {
        const failText = await this.page
          .locator(`text=${FAIL_PATTERN}`).first()
          .textContent({ timeout: 1000 }).catch(() => 'unknown error');
        console.log(`[TerminalPage] ${tag}✗ Transaction failed: ${failText?.trim()}`);

        // Dismiss the error dialog so next token can proceed cleanly
        const dismissBtn = this.page.getByRole('button', { name: /Dismiss/i }).first();
        if (await dismissBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await dismissBtn.click().catch(() => {});
          console.log(`[TerminalPage] ${tag}Error dialog dismissed`);
        }
        return false;
      }

      console.log(`[TerminalPage] ${tag}⏳ Still waiting... (${remaining}s remaining)`);
      await this.page.waitForTimeout(intervalMs).catch(() => {
        // Page may have closed; next iteration will catch it via _isPageAlive
      });
    }

    console.log(`[TerminalPage] ${tag}✗ Timed out – no success dialog`);
    return false;
  }

  // ── Swap Settings (liquidity sources) ────────────────────────────────────

  /**
   * Click the slippage/settings button to open the Swap Settings modal.
   * Supports two UI variants:
   *   1. Button lives inside [aria-label="Swap tools"] container (regular swap page)
   *   2. Standalone clickable container showing "X% [icon]" (Terminal page)
   *      The icon (slider/filter svg) sits next to the % text inside the same
   *      clickable div — we locate that parent container rather than the % text alone.
   */
  async openSettings() {
    // Check if the "Swap tools" container exists first
    const hasToolbar = await this.page
      .locator('[aria-label="Swap tools"]')
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (hasToolbar) {
      const { expect } = await import('@playwright/test');
      // Regular swap page: slippage % div inside the toolbar container
      const settingsBtn = this.page
        .locator('[aria-label="Swap tools"]')
        .locator('div')
        .filter({ hasText: /[\d.]+%/ })
        .first();
      await expect(settingsBtn).toBeVisible({ timeout: 10000 });

      const btnText = await settingsBtn.textContent().catch(() => '?');
      console.log(`[TerminalPage] Clicking settings btn: "${btnText?.trim().slice(0, 30)}"`);
      await settingsBtn.click();
      console.log('[TerminalPage] Settings modal opened');
      await this.page.waitForSelector('text=/Swap Settings|Slippage/i', { timeout: 8000 });
    } else {
      // Terminal page: the slippage/settings button is always in the top-right corner
      // of the swap widget panel (next to "Buy / Sell / Market").
      // We locate the swap panel by the "You Pay" input, get its bounding box,
      // then click at the top-right corner where the settings button sits.
      const swapPanel = this.page.locator('input[name="You Pay"]');
      await swapPanel.waitFor({ state: 'visible', timeout: 8000 });
      const panelBox = await swapPanel.boundingBox();
      if (!panelBox) throw new Error('[TerminalPage] Could not get swap panel bounding box');

      // The settings button is above and to the right of the You Pay input.
      // From screenshots: it sits at roughly (panel.right - 30, panel.top - 65)
      // relative to the input's bounding box.
      const x = panelBox.x + panelBox.width + 30;  // right edge of input + small offset
      const y = panelBox.y - 65;                    // above the You Pay input row

      console.log(`[TerminalPage] Clicking settings btn at coords (${Math.round(x)}, ${Math.round(y)})`);
      await this.page.mouse.click(x, y);
      console.log('[TerminalPage] Settings btn clicked');
      await this.page.waitForTimeout(1500);

      // Verify modal appeared; if not, try a slightly adjusted position
      const modalAppeared = await this.page.locator(
        '[role="dialog"],[role="tooltip"],[data-radix-popper-content-wrapper]'
      ).first().isVisible({ timeout: 2000 }).catch(() => false);

      if (!modalAppeared) {
        // Try a second click slightly to the left (icon is ~30px wide)
        const x2 = x - 20;
        console.log(`[TerminalPage] Modal not found, retrying at (${Math.round(x2)}, ${Math.round(y)})`);
        await this.page.mouse.click(x2, y);
        await this.page.waitForTimeout(1500);
      }

      const modalText = await this.page.evaluate(() => {
        const sel = '[role="dialog"],[role="tooltip"],[data-radix-popper-content-wrapper]';
        return document.querySelector(sel)?.textContent?.trim().slice(0, 120) ?? '';
      });
      console.log(`[TerminalPage] Modal text: "${modalText}"`);
    }
  }

  /**
   * Click "X out of Y selected" to open the Liquidity Sources sub-panel.
   * Requires the Settings modal to already be open.
   */
  async openLiquiditySources() {
    const { expect } = await import('@playwright/test');
    const sourcesRow = this.page
      .getByText(/\d+\s*out of\s*\d+\s*selected/i)
      .first();
    await expect(sourcesRow).toBeVisible({ timeout: 8000 });
    await sourcesRow.click();
    console.log('[TerminalPage] Liquidity Sources panel opened');
    await this.page.waitForSelector('text=/Liquidity Sources/i', { timeout: 8000 });
    await this.page.waitForTimeout(500);
  }

  /**
   * Parse "X out of Y selected" or "X/Y" counter text from the Liquidity Sources panel.
   */
  private async _readCounterText(): Promise<{ selected: number; total: number } | null> {
    const outOfLoc = this.page
      .locator('text=/\\d+\\s+out\\s+of\\s+\\d+\\s+selected/i')
      .first();
    const outOfText = await outOfLoc.textContent({ timeout: 3000 }).catch(() => null);
    if (outOfText) {
      const m = outOfText.match(/(\d+)\s+out\s+of\s+(\d+)/i);
      if (m) return { selected: parseInt(m[1], 10), total: parseInt(m[2], 10) };
    }
    const slashLoc = this.page.locator('text=/\\d+\\/\\d+/').first();
    const slashText = await slashLoc.textContent({ timeout: 3000 }).catch(() => null);
    if (slashText) {
      const m = slashText.match(/(\d+)\/(\d+)/);
      if (m) return { selected: parseInt(m[1], 10), total: parseInt(m[2], 10) };
    }
    return null;
  }

  private async readTotalCount(): Promise<number> {
    const counts = await this._readCounterText();
    return counts?.total ?? 24;
  }

  private async readSelectedCount(): Promise<number> {
    const counts = await this._readCounterText();
    return counts?.selected ?? 0;
  }

  /**
   * Locate the select-all toggle button inside the Liquidity Sources sub-panel.
   */
  private async _findSelectAllToggle(): Promise<import('@playwright/test').Locator> {
    const counterLocators = [
      this.page.locator('text=/\\d+\\s+out\\s+of\\s+\\d+\\s+selected/i').first(),
      this.page.locator('text=/\\d+\\/\\d+/').first(),
    ];
    for (const counterLoc of counterLocators) {
      const visible = await counterLoc.isVisible({ timeout: 2000 }).catch(() => false);
      if (!visible) continue;
      const rowCandidates = [
        counterLoc.locator('xpath=ancestor::div[1]//button | ancestor::div[1]//input[@type="checkbox"]'),
        counterLoc.locator('xpath=ancestor::div[2]//button | ancestor::div[2]//input[@type="checkbox"]'),
        counterLoc.locator('xpath=following-sibling::*[1]'),
      ];
      for (const candidate of rowCandidates) {
        const count = await candidate.count().catch(() => 0);
        if (count > 0) {
          const btn = candidate.last();
          if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
            return btn;
          }
        }
      }
    }
    const flexRow = this.page
      .locator('[class*="flex"], [class*="row"], [class*="header"]')
      .filter({ has: this.page.locator('text=/out of|\\d+\\/\\d+/i') })
      .first();
    return flexRow.locator('button, input[type="checkbox"], [role="checkbox"]').last();
  }
  /**
   * Ensure ALL liquidity sources are selected.
   * Reads current state first; only clicks the toggle if not already fully selected.
   */
  async selectAllSources() {
    const { expect } = await import('@playwright/test');
    await expect(
      this.page.locator('text=/\\d+\\s+out\\s+of\\s+\\d+\\s+selected|\\d+\\/\\d+/i').first()
    ).toBeVisible({ timeout: 8000 });

    const totalCount = await this.readTotalCount();
    console.log(`[TerminalPage] selectAllSources: total=${totalCount}`);

    const currentCount = await this.readSelectedCount();
    if (currentCount === totalCount) {
      console.log(`[TerminalPage] All ${totalCount} sources already selected, skipping`);
      return;
    }

    const toggleButton = await this._findSelectAllToggle();
    await toggleButton.click();
    console.log('[TerminalPage] Select-all toggle clicked');
    await this.page.waitForTimeout(800);

    const afterFirst = await this.readSelectedCount();
    if (afterFirst !== totalCount) {
      await toggleButton.click();
      console.log('[TerminalPage] Select-all toggle clicked (2nd attempt)');
      await this.page.waitForTimeout(800);
    }

    const finalCount = await this.readSelectedCount();
    console.log(`[TerminalPage] All sources selected: ${finalCount}/${totalCount}`);

    if (finalCount !== totalCount) {
      throw new Error(`Expected ${totalCount} selected routes but got ${finalCount}/${totalCount}`);
    }
    await this.page.waitForTimeout(300);
  }
  /**
   * After modifying routes/slippage in the Swap Settings dialog,
   * click "Confirm Changes" to apply and close the modal.
   * If the button is disabled (no changes), just close the dialog.
   */
  async confirmSettingsChanges() {
    const { expect } = await import('@playwright/test');
    const dialog = this.page.locator('[role="dialog"]').first();
    const confirmBtn = dialog.getByRole('button', { name: /Confirm Changes/i });

    const backBtn = dialog.getByRole('button', { name: /Back|<|←/i }).first();
    if (await backBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await backBtn.click();
      console.log('[TerminalPage] Navigated back from sub-panel');
      await this.page.waitForTimeout(500);
    }

    const isEnabled = await confirmBtn.isEnabled({ timeout: 3000 }).catch(() => false);
    if (isEnabled) {
      await confirmBtn.click();
      console.log('[TerminalPage] Settings changes confirmed');
    } else {
      const closeBtn = dialog.getByRole('button', { name: /Close|×/i });
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
      }
    }
    await expect(dialog).toBeHidden({ timeout: 8000 });
    console.log('[TerminalPage] Settings dialog closed');
  }
}
