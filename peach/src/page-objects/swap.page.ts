import { type Page, expect } from '@playwright/test';
import { chainPath } from '../config/env.js';
import { dismissConsentDialog } from '../utils/consent-dialog.js';
import type { E2EWalletController } from '../wallet/e2e-wallet-controller.js';

/**
 * The in-page "Review your order" modal submits under three different labels:
 *   "Confirm Swap"     – normal quote, pay token already approved
 *   "Approve and Swap" – pay token still needs an ERC-20 / Permit2 allowance
 *   "Swap Anyway"      – high price difference warning replaces "Confirm Swap"
 */
const CONFIRM_SWAP_BUTTON_TEXT = /confirm\s*swap|approve\s*and\s*swap|swap\s*anyway/i;

export class SwapPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    // Retry once on connection failure (flaky network / VPN issues)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // 必须带链前缀：不带前缀的 /swap 会被重定向到前端默认链，
        // 与注入钱包的 chainId 不一致时 header 只显示 "Switch to ..."。
        await this.page.goto(chainPath('/swap'), { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        console.log(`[SwapPage] goto failed (attempt ${attempt}), retrying in 3s...`);
        await this.page.waitForTimeout(3000);
      }
    }
    // waitForSelector below is the actual readiness signal; skipping networkidle
    // avoids a long poll that never resolves on DApps with persistent WebSocket connections.
    // Wait for the swap UI to load
    await this.page.waitForSelector('text=/You Pay|Enter an amount/i', { timeout: 15000 });
    console.log('[SwapPage] Swap page loaded');
    // Dismiss the "Terms & Policies" dialog if it appears on first visit.
    // The dialog is a fixed overlay that intercepts all pointer events until accepted.
    await this.dismissTermsDialogIfPresent();
  }

  /**
   * 关掉首次进入的同意弹窗。它是 fixed 遮罩，不关掉会拦截所有 pointer 事件。
   * 两种形态（"Welcome to Peach" + Continue / "Terms & Policies" + 勾选框）
   * 都由共享实现覆盖，并会等遮罩层退场动画结束。
   */
  private async dismissTermsDialogIfPresent(timeoutMs = 8_000) {
    await dismissConsentDialog(this.page, 'SwapPage', timeoutMs);
  }

  // ── Settings modal ─────────────────────────────────────────────────────────

  /**
   * Click the slippage/settings button (e.g. "0.5% ⚙️") to open settings modal.
   */
  async openSettings() {
    // The slippage/settings control is a <div> (not a <button>) inside the
    // "Swap tools" toolbar (aria-label="Swap tools"). It shows the current
    // slippage % (e.g. "0.5%") and a gear icon. Do NOT use locator('button')
    // or it will match the 25%/50%/75%/100% balance shortcuts inside the input card.
    const settingsBtn = this.page
      .locator('[aria-label="Swap tools"]')
      .locator('div')
      .filter({ hasText: /[\d.]+%/ })
      .first();
    await expect(settingsBtn).toBeVisible({ timeout: 10000 });
    await settingsBtn.click();
    console.log('[SwapPage] Settings modal opened');
    // Wait for the modal to appear
    await this.page.waitForSelector('text=/Swap Settings|Slippage/i', { timeout: 8000 });
  }

  /**
   * Set a custom slippage value in the Swap Settings modal.
   * Requires the settings modal to already be open (call openSettings() first).
   *
   * Steps:
   *   1. Click the "Custom" button to activate the custom input
   *   2. Clear and fill the custom slippage input
   *   3. Wait briefly for the UI to react (warning text may appear)
   *
   * @param value - slippage percentage as a string, e.g. "0.05", "2.5", "20"
   */
  async setCustomSlippage(value: string) {
    await this.activateCustomSlippage();
    await this.fillSlippageInput(value);
  }

  /**
   * Open Settings, set a custom slippage value, then confirm and close the dialog.
   * Call this BEFORE selectRoutes() so the slippage is applied before route selection.
   *
   * @param value - slippage percentage as a string, e.g. "0.5", "1.0", "2.5"
   */
  async setSlippage(value: string) {
    console.log(`[SwapPage] Setting slippage to ${value}%...`);
    await this.openSettings();
    await this.setCustomSlippage(value);
    await this.confirmSettingsChanges();
    console.log(`[SwapPage] ✓ Slippage set to ${value}%`);
  }

  /**
   * Click the "Custom" button once to activate the custom slippage input.
   * Only needs to be called once per Settings modal session.
   */
  async activateCustomSlippage() {
    const dialog = this.page.locator('[role="dialog"]').first();
    const customBtn = dialog
      .locator('button, span, div')
      .filter({ hasText: /^Custom$/i })
      .first();
    if (await customBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await customBtn.click();
      console.log('[SwapPage] Clicked Custom slippage button');
      await this.page.waitForTimeout(300);
    }
  }

  /**
   * Clear the custom slippage input and fill with a new value.
   * Assumes the Custom input is already active (call activateCustomSlippage first).
   * Triple-click selects all existing content before typing.
   *
   * @param value - slippage percentage as a string, e.g. "0.05", "2.5", "20"
   */
  async fillSlippageInput(value: string) {
    const dialog = this.page.locator('[role="dialog"]').first();

    // Strategy 1: input inside a flex row that also has a standalone "%" text
    const rowWithPercent = dialog.locator('div, span').filter({
      has: this.page.locator('text=/^\\s*%\\s*$/'),
    });
    let slippageInput = rowWithPercent.locator('input').first();

    // Strategy 2: first number/decimal input in the dialog
    if (!await slippageInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      slippageInput = dialog
        .locator('input[type="number"], input[inputmode="decimal"], input[inputmode="numeric"]')
        .first();
    }

    // Strategy 3: first non-search input in the dialog
    if (!await slippageInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      slippageInput = dialog
        .locator('input')
        .filter({ hasNotText: /Search/i })
        .first();
    }

    await expect(slippageInput).toBeVisible({ timeout: 5000 });
    // Triple-click to select all, then fill
    await slippageInput.click({ clickCount: 3 });
    await slippageInput.fill(value);
    console.log(`[SwapPage] Filled slippage input: ${value}%`);

    // Wait for UI to react (warning banner animates in)
    await this.page.waitForTimeout(800);
  }

  /**
   * Read the warning/error message shown below the slippage input in Swap Settings.
   * Returns the trimmed text content, or an empty string if no warning is visible.
   *
   * Peach renders three distinct messages:
   *   - Low  (< ~1%):  "Your slippage is quite low and may cause failed transactions..."
   *   - High (≥ ~2%):  "Your slippage setting might be high..."
   *   - Over-max (≥20%): "Enter a valid slippage percentage. Max is 19.99%"
   */
  async getSlippageWarning(): Promise<string> {
    try {
      const dialog = this.page.locator('[role="dialog"]').first();

      // The warning banner appears between the slippage input row and "Liquidity Sources".
      // It contains a triangle/warning icon and colored text.
      // Try multiple selectors in order of specificity.

      // Strategy 1: element with known warning class names
      for (const sel of [
        '[class*="warning"]', '[class*="Warning"]',
        '[class*="alert"]',   '[class*="Alert"]',
        '[class*="error"]',   '[class*="Error"]',
        '[class*="tip"]',     '[class*="Tip"]',
      ]) {
        const el = dialog.locator(sel).first();
        if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
          const t = await el.textContent({ timeout: 2000 }).catch(() => null);
          if (t?.trim()) {
            console.log(`[SwapPage] Slippage warning (${sel}): "${t.trim()}"`);
            return t.trim();
          }
        }
      }

      // Strategy 2: find the text content matching known warning phrases directly
      const phrases = [
        /quite low and may cause failed/i,
        /might be high.*front-running/i,
        /front-running/i,
        /Enter a valid slippage/i,
        /Max is 19\.99/i,
      ];
      for (const phrase of phrases) {
        const el = dialog.getByText(phrase).first();
        if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
          const t = await el.textContent({ timeout: 2000 }).catch(() => null);
          if (t?.trim()) {
            console.log(`[SwapPage] Slippage warning (phrase match): "${t.trim()}"`);
            return t.trim();
          }
        }
      }

      // Strategy 3: any colored text between slippage row and Liquidity Sources header
      // Look for a <p> or <div> with orange/yellow/red text color styles
      const coloredEl = dialog
        .locator('p, span, div')
        .filter({ hasText: /slippage|low|high|failed|front-running|valid|19\.99/i })
        .first();
      if (await coloredEl.isVisible({ timeout: 1500 }).catch(() => false)) {
        const t = await coloredEl.textContent({ timeout: 2000 }).catch(() => null);
        if (t?.trim()) {
          console.log(`[SwapPage] Slippage warning (fallback): "${t.trim()}"`);
          return t.trim();
        }
      }

      console.log('[SwapPage] No slippage warning found');
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Check whether the "Confirm Changes" button in the settings dialog is enabled.
   * When slippage is invalid (e.g. ≥20%), the button is disabled.
   */
  async isConfirmChangesEnabled(): Promise<boolean> {
    const dialog = this.page.locator('[role="dialog"]').first();
    const confirmBtn = dialog.getByRole('button', { name: /Confirm Changes/i });
    return confirmBtn.isEnabled({ timeout: 3000 }).catch(() => false);
  }

  /**
   * Click "X out of Y selected" to open the Liquidity Sources panel.
   */
  async openLiquiditySources() {
    // The "X out of Y selected" row renders as a <p> inside the Swap Settings dialog,
    // not as a <button>. Use getByText so the selector works regardless of element type.
    const sourcesRow = this.page
      .getByText(/\d+\s*out of\s*\d+\s*selected/i)
      .first();
    await expect(sourcesRow).toBeVisible({ timeout: 8000 });
    await sourcesRow.click();
    console.log('[SwapPage] Liquidity Sources panel opened');
    // Wait for the sources list to appear
    await this.page.waitForSelector('text=/Liquidity Sources/i', { timeout: 8000 });
    await this.page.waitForTimeout(500);
  }

  /**
   * Locate the select-all toggle button inside the Liquidity Sources sub-panel.
   * The sub-panel header shows "X out of Y selected →" (or "X/Y" in compact form).
   * The toggle (checkbox/button) is always a sibling or close ancestor of that text.
   */
  private async _findSelectAllToggle(): Promise<import('@playwright/test').Locator> {
    // Strategy 1: find a row/div containing the counter text, then grab the last
    // button or checkbox inside it (the toggle is usually the rightmost control).
    const counterLocators = [
      this.page.locator('text=/\\d+\\s+out\\s+of\\s+\\d+\\s+selected/i').first(),
      this.page.locator('text=/\\d+\\/\\d+/').first(),
    ];

    for (const counterLoc of counterLocators) {
      const visible = await counterLoc.isVisible({ timeout: 2000 }).catch(() => false);
      if (!visible) continue;

      // Walk up to the nearest row container and look for a toggle inside it
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

    // Strategy 2: broadest fallback — any row with [class*="flex"] that contains the counter
    const flexRow = this.page
      .locator('[class*="flex"], [class*="row"], [class*="header"]')
      .filter({ has: this.page.locator('text=/out of|\\d+\\/\\d+/i') })
      .first();
    return flexRow.locator('button, input[type="checkbox"], [role="checkbox"]').last();
  }

  /**
   * Click the "select-all" toggle to deselect ALL liquidity sources.
   */
  async deselectAllSources() {
    await expect(
      this.page.locator('text=/\\d+\\s+out\\s+of\\s+\\d+\\s+selected|\\d+\\/\\d+/i').first()
    ).toBeVisible({ timeout: 8000 });

    const totalCount = await this.readTotalCount();
    const toggleButton = await this._findSelectAllToggle();
    const currentCount = await this.readSelectedCount();
    console.log(`[SwapPage] deselectAll: current count = ${currentCount}/${totalCount}`);

    if (currentCount === totalCount) {
      await toggleButton.click();
      console.log('[SwapPage] Toggle clicked once (was fully selected → now deselecting)');
      await this.page.waitForTimeout(800);
    } else {
      await toggleButton.click();
      console.log('[SwapPage] Toggle clicked (1st time: selecting all)');
      await this.page.waitForTimeout(800);
      await toggleButton.click();
      console.log('[SwapPage] Toggle clicked (2nd time: deselecting all)');
      await this.page.waitForTimeout(800);
    }

    const finalCount = await this.readSelectedCount();
    console.log(`[SwapPage] All sources deselected: ${finalCount}/${totalCount}`);

    if (finalCount !== 0) {
      throw new Error(`Expected 0 selected routes but got ${finalCount}/${totalCount}`);
    }

    await this.page.waitForTimeout(300);
  }

  /**
   * Ensure ALL liquidity sources are selected.
   * Reads current state first; only clicks the toggle if not already fully selected.
   */
  async selectAllSources() {
    await expect(
      this.page.locator('text=/\\d+\\s+out\\s+of\\s+\\d+\\s+selected|\\d+\\/\\d+/i').first()
    ).toBeVisible({ timeout: 8000 });

    const totalCount = await this.readTotalCount();
    console.log(`[SwapPage] selectAllSources: total=${totalCount}`);

    const currentCount = await this.readSelectedCount();
    if (currentCount === totalCount) {
      console.log(`[SwapPage] All ${totalCount} sources already selected, skipping toggle`);
      return;
    }

    const toggleButton = await this._findSelectAllToggle();

    await toggleButton.click();
    console.log('[SwapPage] Select-all toggle clicked');
    await this.page.waitForTimeout(800);

    const afterFirst = await this.readSelectedCount();
    if (afterFirst !== totalCount) {
      await toggleButton.click();
      console.log('[SwapPage] Select-all toggle clicked (2nd attempt)');
      await this.page.waitForTimeout(800);
    }

    const finalCount = await this.readSelectedCount();
    console.log(`[SwapPage] All sources selected: ${finalCount}/${totalCount}`);

    if (finalCount !== totalCount) {
      throw new Error(`Expected ${totalCount} selected routes but got ${finalCount}/${totalCount}`);
    }

    await this.page.waitForTimeout(300);
  }

  /**
   * Type the route name in the search box, click the matching item to select it,
   * then clear the search box.
   */
  async selectRouteByName(routeName: string) {
    const searchInput = this.page
      .locator('input[placeholder*="Search" i], input[placeholder*="liquidity" i]')
      .first();
    await expect(searchInput).toBeVisible({ timeout: 8000 });

    // Type the route name to filter
    await searchInput.fill(routeName);
    await this.page.waitForTimeout(400);
    console.log(`[SwapPage] Searching for route: "${routeName}"`);

    // Find the matching row in the list (exact text match)
    const routeItem = this.page
      .locator('div, li, label')
      .filter({ hasText: new RegExp(`^${escapeRegExp(routeName)}$`, 'i') })
      .first();

    await expect(routeItem).toBeVisible({ timeout: 6000 });
    await routeItem.click();
    console.log(`[SwapPage] ✓ Selected route: "${routeName}"`);

    // Clear the search box
    await searchInput.fill('');
    await this.page.waitForTimeout(300);
  }

  /**
   * Select multiple routes by name, starting from an all-deselected state.
   * Steps:
   *   1. Open settings
   *   2. Open liquidity sources
   *   3. Deselect all
   *   4. Search & select each route
   */
  async selectRoutes(routes: string[]) {
    if (routes.length === 0) {
      throw new Error('[SwapPage] No routes specified to select');
    }

    await this.openSettings();
    await this.openLiquiditySources();
    await this.deselectAllSources();

    for (const route of routes) {
      await this.selectRouteByName(route);
    }

    const total = routes.length;
    console.log(`[SwapPage] ✓ Route selection complete: ${total} route(s) selected`);

    // Verify the counter shows correct number
    const totalCount = await this.readTotalCount();
    const counter = this.page.locator(`text=/${total}\\/${totalCount}/`);
    const counterVisible = await counter.isVisible({ timeout: 5000 }).catch(() => false);
    if (counterVisible) {
      console.log(`[SwapPage] ✓ Counter confirmed: ${total}/${totalCount}`);
    } else {
      console.log(`[SwapPage] ⚠ Counter not found, continuing...`);
    }

    return total;
  }

  /**
   * Ensure `routes` are the active liquidity sources, skipping the whole
   * settings dance when the current selection already matches.
   *
   * Used by the combined-routes pair mode: routes are picked once up front, and
   * every later trading pair reuses that selection instead of re-opening
   * settings and re-checking 24 rows per pair.
   *
   * @returns `changed` = whether a re-selection was actually performed.
   */
  async ensureRoutesSelected(routes: string[]): Promise<{ changed: boolean; selected: number }> {
    if (routes.length === 0) throw new Error('[SwapPage] No routes specified');

    await this.openSettings();
    await this.openLiquiditySources();
    const current = await this.readSelectedCount();

    if (current === routes.length) {
      console.log(`[SwapPage] Route selection already ${current}/${routes.length} — reusing, skipping re-select`);
      await this.confirmSettingsChanges();
      return { changed: false, selected: current };
    }

    console.log(`[SwapPage] Route selection drifted (${current} selected, expected ${routes.length}) — re-selecting`);
    await this.deselectAllSources();
    for (const route of routes) {
      await this.selectRouteByName(route);
    }
    await this.confirmSettingsChanges();
    return { changed: true, selected: routes.length };
  }

  /**
   * Recover the swap form after a failed direction without reloading the page,
   * so the current route selection survives.
   *
   * Closes any leftover modal and clears the pay amount. Returns false when the
   * page is unusable (closed/crashed), signalling the caller to fall back to a
   * full reload plus route re-selection.
   */
  async softResetAfterFailure(): Promise<boolean> {
    try {
      if (this.page.isClosed()) return false;

      for (let i = 0; i < 3; i++) {
        const dialogOpen = await this.page
          .locator('[role="dialog"]')
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);
        if (!dialogOpen) break;
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(400);
      }

      for (const name of [/^Close$/i, /^Dismiss$/i, /^Cancel$/i]) {
        const btn = this.page.getByRole('button', { name }).last();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click({ timeout: 2000 }).catch(() => {});
          await this.page.waitForTimeout(300);
        }
      }

      const payInput = this.page.locator('input[placeholder="0.0"]').first();
      if (!await payInput.isVisible({ timeout: 3000 }).catch(() => false)) return false;
      await payInput.fill('');
      await this.page.waitForTimeout(500);

      const marked = await this.markTokenSelectors();
      if (!marked.pay || !marked.receive) return false;

      console.log('[SwapPage] ✓ Soft reset done (route selection preserved)');
      return true;
    } catch (err) {
      console.log(`[SwapPage] Soft reset failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Read the raw counter text from the Liquidity Sources panel.
   * Supports two UI formats:
   *   - Sub-panel header: "24 out of 24 selected"  (Settings → Liquidity Sources page)
   *   - Compact form:     "24/24"                  (some UI variants)
   * Returns { selected, total } or null if not found.
   */
  private async _readCounterText(): Promise<{ selected: number; total: number } | null> {
    // Try "X out of Y selected" format first (shown inside Liquidity Sources sub-panel)
    const outOfLoc = this.page
      .locator('text=/\\d+\\s+out\\s+of\\s+\\d+\\s+selected/i')
      .first();
    const outOfText = await outOfLoc.textContent({ timeout: 3000 }).catch(() => null);
    if (outOfText) {
      const m = outOfText.match(/(\d+)\s+out\s+of\s+(\d+)/i);
      if (m) return { selected: parseInt(m[1], 10), total: parseInt(m[2], 10) };
    }

    // Fallback: "X/Y" compact format
    const slashLoc = this.page.locator('text=/\\d+\\/\\d+/').first();
    const slashText = await slashLoc.textContent({ timeout: 3000 }).catch(() => null);
    if (slashText) {
      const m = slashText.match(/(\d+)\/(\d+)/);
      if (m) return { selected: parseInt(m[1], 10), total: parseInt(m[2], 10) };
    }

    return null;
  }

  /**
   * Read the total number of liquidity sources.
   * Returns the Y value (total), e.g. 24 from "24 out of 24 selected".
   */
  async readTotalCount(): Promise<number> {
    const counts = await this._readCounterText();
    return counts?.total ?? 24; // fallback to 24
  }

  /**
   * Read the current selected count from the Liquidity Sources panel.
   * Returns the X value, e.g. 18 from "18 out of 24 selected".
   */
  async readSelectedCount(): Promise<number> {
    const counts = await this._readCounterText();
    return counts?.selected ?? 0;
  }

  // ── Settings confirmation ───────────────────────────────────────────────────

  /**
   * After modifying routes/slippage inside the Swap Settings dialog,
   * click "Confirm Changes" to apply and close the modal.
   * If the button is disabled (no changes detected), just close the dialog.
   * 
   * Note: The dialog title may change to "Liquidity Sources" when the sources panel is open,
   * so we don't filter by specific text.
   */
  async confirmSettingsChanges() {
    // Find the settings dialog (don't filter by text since title may change)
    const dialog = this.page.locator('[role="dialog"]').first();
    const confirmBtn = dialog.getByRole('button', { name: /Confirm Changes/i });
    
    // If we're in the Liquidity Sources sub-panel, go back first
    const backBtn = dialog.getByRole('button', { name: /Back|<|←/i }).first();
    if (await backBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await backBtn.click();
      console.log('[SwapPage] Navigated back from sub-panel');
      await this.page.waitForTimeout(500);
    }
    
    const isEnabled = await confirmBtn.isEnabled({ timeout: 3000 }).catch(() => false);
    if (isEnabled) {
      await confirmBtn.click();
      console.log('[SwapPage] Settings changes confirmed');
    } else {
      const closeBtn = dialog.getByRole('button', { name: /Close|×/i });
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
      }
    }
    await expect(dialog).toBeHidden({ timeout: 8000 });
    console.log('[SwapPage] Settings dialog closed');
  }

  // ── Wallet connection ───────────────────────────────────────────────────────

  /**
   * Wait for the injected E2E Wallet to be picked up by the dApp.
   *
   * 注入式 provider 对 eth_accounts 返回非空数组，AppKit 据此自动恢复连接，
   * 所以不需要点 Connect Wallet、不需要在弹窗里选钱包、也没有审批弹窗。
   * 这里只是把等待逻辑委托给控制器。
   */
  async connectWallet(wallet: E2EWalletController) {
    await wallet.connect(this.page);
    console.log('[SwapPage] Wallet connected successfully');
  }

  // ── Token selection ─────────────────────────────────────────────────────────

  /**
   * Tag the pay/receive token-selector buttons with `data-e2e-token-slot` so they
   * can be targeted by structure instead of by symbol text.
   *
   * Symbol-regex matching is unusable here: real symbols include digits ("USD1")
   * and single characters ("U"), and the receive card also holds a "Paste CA"
   * button. Anchoring on each amount input and walking up to its card is stable
   * regardless of the symbol rendered.
   */
  private async markTokenSelectors(): Promise<{ pay: boolean; receive: boolean }> {
    return this.page.evaluate(() => {
      document
        .querySelectorAll('[data-e2e-token-slot]')
        .forEach((el) => el.removeAttribute('data-e2e-token-slot'));

      const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[placeholder="0.0"]'),
      );
      const marked = { pay: false, receive: false };

      (['pay', 'receive'] as const).forEach((slot, idx) => {
        const input = inputs[idx];
        if (!input) return;

        // Walk outward from the amount input; the first ancestor that owns a
        // token-selector button is that slot's card.
        let node: HTMLElement | null = input.parentElement;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          const candidate = Array.from(node.querySelectorAll('button')).find((btn) => {
            const text = (btn.textContent ?? '').trim();
            if (!text) return false;
            // Exclude non-token controls living in the same card
            if (/paste|max|^\d+\s*%$|^swap$|^limit$|^dca$/i.test(text)) return false;
            return /^[A-Za-z0-9$._+-]{1,14}$/.test(text);
          });
          if (candidate) {
            candidate.setAttribute('data-e2e-token-slot', slot);
            marked[slot] = true;
            return;
          }
        }
      });

      return marked;
    });
  }

  /** Locator for a slot's token-selector button (must call markTokenSelectors first). */
  private tokenSelectorLocator(slot: 'pay' | 'receive') {
    return this.page.locator(`[data-e2e-token-slot="${slot}"]`).first();
  }

  /**
   * Read the token symbol currently shown in a slot's selector button.
   * Returns an empty string when the button cannot be located.
   */
  async getSelectedTokenSymbol(slot: 'pay' | 'receive'): Promise<string> {
    const marked = await this.markTokenSelectors().catch(() => ({ pay: false, receive: false }));
    if (!marked[slot]) return '';
    const text = await this.tokenSelectorLocator(slot)
      .textContent({ timeout: 2000 })
      .catch(() => null);
    return (text ?? '').trim();
  }

  /**
   * 用 URL query 指定币对：/bsc/swap?sell=<payAddr>&buy=<receiveAddr>。
   *
   * 只改目标 slot 对应的参数，另一个 slot 保留当前值，这样连续调用
   * selectToken('pay', ...) 和 selectToken('receive', ...) 不会互相覆盖。
   *
   * @returns 成功导航并且页面就绪时返回 true；不支持时返回 false 由调用方回退。
   */
  private async selectTokenByUrl(slot: 'pay' | 'receive', address: string): Promise<boolean> {
    try {
      const url = new URL(this.page.url());
      // 只在 swap 页生效；token 详情页等其它页面没有这套参数
      if (!/\/swap$/.test(url.pathname)) return false;

      const param = slot === 'pay' ? 'sell' : 'buy';
      if (url.searchParams.get(param)?.toLowerCase() === address.toLowerCase()) {
        console.log(`[SwapPage] ${slot} already set to ${address.slice(0, 10)}... (URL)`);
        return true;
      }
      url.searchParams.set(param, address);

      await this.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.page.waitForSelector('text=/You Pay|Enter an amount/i', { timeout: 15_000 });
      await this.dismissTermsDialogIfPresent();
      console.log(`[SwapPage] ✓ ${slot} set via URL param ${param}=${address.slice(0, 10)}...`);
      return true;
    } catch (err) {
      console.log(`[SwapPage] URL token selection failed, falling back to dialog: ${err}`);
      return false;
    }
  }

  /**
   * Select a token by searching its contract address.
   * Flow: Click token button → Search address → Click result row
   *
   * @param slot    - 'pay' | 'receive'
   * @param address - contract address (e.g. "0xeeee...eeee")
   * @param symbol  - optional symbol (e.g. "BNB"); when given it is verified
   *                  after selection so a mis-targeted slot fails loudly
   */
  async selectToken(slot: 'pay' | 'receive', address: string, symbol?: string) {
    console.log(`[SwapPage] Selecting ${symbol || address.slice(0, 10) + '...'} for "${slot}"`);

    // 快路径：swap 页支持用 URL query 直接指定币对（?sell=<addr>&buy=<addr>），
    // 比点开 Select Token 对话框再搜索稳定得多 —— 对话框的结果行没有稳定的
    // 定位锚点，实测会误点到别的 token 并跳走。失败时回退到对话框流程。
    if (await this.selectTokenByUrl(slot, address)) return;

    // Step 1: Click the token button for this slot.
    // Tag both selectors first so we click the correct card even when the symbol
    // contains digits ("USD1") or is a single character ("U").
    const marked = await this.markTokenSelectors();
    if (!marked[slot]) {
      throw new Error(
        `[SwapPage] Could not locate the "${slot}" token selector button ` +
        `(pay=${marked.pay}, receive=${marked.receive})`,
      );
    }
    await this.tokenSelectorLocator(slot).click({ timeout: 10000 });
    console.log(`[SwapPage] Clicked ${slot} token button`);

    // Step 2: 等待 Select Token 对话框出现
    await this.page.waitForSelector('text=Select Token', { timeout: 8000 });
    console.log('[SwapPage] Select Token dialog opened');

    // Step 3: 在搜索框输入合约地址
    const searchInput = this.page.locator('[role="dialog"] input').first();
    await searchInput.fill(address);
    await this.page.waitForTimeout(1500);
    console.log(`[SwapPage] Searched: ${address.slice(0, 10)}...`);

    // Step 4: 点击搜索结果行
    // 等待搜索结果出现，然后点击第一个结果
    await this.page.waitForTimeout(1000); // 等待搜索结果加载
    
    // 尝试多种方式定位搜索结果
    let clicked = false;
    
    // 方式1: 如果提供了 symbol，使用 symbol 查找
    if (symbol && !clicked) {
      const symbolRow = this.page.locator('[role="dialog"]').locator(`text=${symbol}`).first();
      if (await symbolRow.isVisible({ timeout: 2000 }).catch(() => false)) {
        await symbolRow.click();
        clicked = true;
        console.log(`[SwapPage] ✓ Clicked result by symbol: ${symbol}`);
      }
    }
    
    // 方式2: 查找包含余额的行（通常搜索结果会显示余额）
    if (!clicked) {
      const resultWithBalance = this.page.locator('[role="dialog"]').locator('[class*="token"], div, li').filter({ hasText: /\d+\.?\d*/ }).first();
      if (await resultWithBalance.isVisible({ timeout: 2000 }).catch(() => false)) {
        await resultWithBalance.click();
        clicked = true;
        console.log('[SwapPage] ✓ Clicked result by balance indicator');
      }
    }
    
    // 方式3: 直接点击对话框中的第一个可点击的代币项
    if (!clicked) {
      // 在对话框中查找看起来像代币行的元素（通常包含图标和文字）
      const tokenRow = this.page.locator('[role="dialog"]').locator('button, div[role="button"], li, [class*="cursor-pointer"]').filter({ hasNotText: 'Select Token' }).first();
      await tokenRow.click({ timeout: 5000 });
      clicked = true;
      console.log('[SwapPage] ✓ Clicked first token result');
    }
    
    // 等待对话框关闭
    await this.page.waitForSelector('text=Select Token', { state: 'hidden', timeout: 5000 });
    await this.page.waitForTimeout(400);

    // Verify the slot actually holds the requested token. Peach auto-flips the
    // pair when you pick a token that already occupies the other slot, so a
    // silent mismatch here would swap the direction under test.
    // Address-derived labels (e.g. "0x55d3") are not real symbols — skip those.
    if (symbol && !symbol.startsWith('0x')) {
      const actual = await this.getSelectedTokenSymbol(slot);
      if (actual && actual.toLowerCase() !== symbol.toLowerCase()) {
        throw new Error(
          `[SwapPage] ${slot} slot shows "${actual}" but "${symbol}" was requested`,
        );
      }
    }
    console.log(`[SwapPage] ✓ Token selected for ${slot}`);
  }

  // ── Swap amount & quote ─────────────────────────────────────────────────────

  /**
   * Type a value into the "You Pay" token amount input.
   * After filling, waits up to `quoteTimeoutMs` for the receive-amount to become non-zero.
   */
  async enterPayAmount(amount: string, quoteTimeoutMs = 15000) {
    const payInput = this.page.locator('input[placeholder="0.0"]').first();
    await expect(payInput).toBeVisible({ timeout: 8000 });
    await payInput.fill(amount);

    // Some re-renders (token switch, quote refresh) wipe the input right after
    // fill. Re-assert the value so we never proceed with an empty amount.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const current = await payInput.inputValue().catch(() => '');
      if (parseFloat(current || '0') > 0) break;
      console.log(`[SwapPage] Pay amount empty after fill (attempt ${attempt}), re-typing...`);
      await payInput.click({ clickCount: 3 }).catch(() => {});
      await payInput.fill(amount).catch(() => {});
      await this.page.waitForTimeout(500);
    }
    const finalValue = await payInput.inputValue().catch(() => '');
    if (!(parseFloat(finalValue || '0') > 0)) {
      throw new Error(`[SwapPage] Failed to enter pay amount "${amount}" (input value: "${finalValue}")`);
    }
    console.log(`[SwapPage] Entered pay amount: ${finalValue}`);

    // Wait for quote – receive input should become non-empty and non-zero
    const receiveInput = this.page.locator('input[placeholder="0.0"]').nth(1);
    await receiveInput
      .waitFor({ state: 'visible', timeout: quoteTimeoutMs })
      .then(async () => {
        // Poll until the value is a non-zero number
        const deadline = Date.now() + quoteTimeoutMs;
        while (Date.now() < deadline) {
          const val = await receiveInput.inputValue().catch(() => '');
          if (val && val !== '0' && val !== '0.0') break;
          await this.page.waitForTimeout(500);
        }
      })
      .catch(() => {
        console.log('[SwapPage] ⚠ Quote did not appear within timeout');
      });
  }

  /**
   * Read the current value of the "You Receive" amount input.
   * Returns an empty string when no quote is available.
   */
  async getReceiveAmount(): Promise<string> {
    const receiveInput = this.page.locator('input[placeholder="0.0"]').nth(1);
    return receiveInput.inputValue({ timeout: 5000 }).catch(() => '');
  }

  // ── Token balance queries ───────────────────────────────────────────────────

  /**
   * Get the displayed balance for the Pay token.
   * The balance is usually shown near the "You Pay" input field (e.g., "Balance: 0.0225")
   */
  async getPayTokenBalance(): Promise<string> {
    try {
      // Look for balance text near the pay input
      // Common patterns: "Balance: 0.123", "Bal: 0.123", or just the number
      const balanceLocator = this.page
        .locator('text=/Balance.*\\d+\\.?\\d*/i, text=/Bal.*\\d+\\.?\\d*/i')
        .first();
      
      const balanceText = await balanceLocator.textContent({ timeout: 5000 }).catch(() => null);
      
      if (balanceText) {
        // Extract the number from text like "Balance: 0.123"
        const match = balanceText.match(/(\d+\.?\d*)/);
        if (match) {
          console.log(`[SwapPage] Pay token balance: ${match[1]}`);
          return match[1];
        }
      }
      
      console.log('[SwapPage] Could not read pay token balance');
      return '0';
    } catch (err) {
      console.log(`[SwapPage] Error reading pay token balance: ${err}`);
      return '0';
    }
  }

  /**
   * Get the displayed balance for the Receive token.
   * Similar to pay token, but looks in the "You Receive" section.
   */
  async getReceiveTokenBalance(): Promise<string> {
    try {
      // The receive token balance is in the second input section
      const allBalances = await this.page
        .locator('text=/Balance.*\\d+\\.?\\d*/i, text=/Bal.*\\d+\\.?\\d*/i')
        .allTextContents();
      
      if (allBalances.length >= 2) {
        const match = allBalances[1].match(/(\d+\.?\d*)/);
        if (match) {
          console.log(`[SwapPage] Receive token balance: ${match[1]}`);
          return match[1];
        }
      }
      
      console.log('[SwapPage] Could not read receive token balance');
      return '0';
    } catch (err) {
      console.log(`[SwapPage] Error reading receive token balance: ${err}`);
      return '0';
    }
  }

  /**
   * Read token balances from the dApp UI (wallet balance shown in the token dialog).
   * This is more reliable than parsing UI text.
   * Note: Requires the wallet to be on the correct network.
   */
  async getTokenBalanceFromWallet(tokenAddress: string): Promise<string> {
    try {
      // Open token selector dialog to see balance
      const tokenButtons = this.page.locator('button').filter({ hasText: /^[A-Z]{2,6}$/ });
      const wasOpen = await this.page.locator('[role="dialog"]').isVisible().catch(() => false);
      
      if (!wasOpen) {
        await tokenButtons.first().click({ timeout: 5000 });
        await this.page.waitForSelector('text=Select Token', { timeout: 5000 });
      }
      
      // Search for the token
      const searchInput = this.page.locator('[role="dialog"] input').first();
      await searchInput.fill(tokenAddress);
      await this.page.waitForTimeout(1500);
      
      // Extract balance from search result
      // Balance is usually displayed alongside the token (e.g., "BNB  0.0225388")
      const dialogContent = await this.page.locator('[role="dialog"]').textContent({ timeout: 3000 });
      const balanceMatch = dialogContent?.match(/(\d+\.?\d+)/);
      const balance = balanceMatch ? balanceMatch[1] : '0';
      
      // Close dialog by pressing Escape
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(500);
      
      console.log(`[SwapPage] Wallet balance for ${tokenAddress.slice(0, 10)}...: ${balance}`);
      return balance;
    } catch (err) {
      console.log(`[SwapPage] Error reading wallet balance: ${err}`);
      // Try to close dialog if still open
      await this.page.keyboard.press('Escape').catch(() => {});
      return '0';
    }
  }

  // ── Swap execution ──────────────────────────────────────────────────────────

  /**
   * Assert a valid swap quote is shown (receive amount > 0) then click the
   * "Swap" button, handle the in-page confirmation dialog, and wait for the
   * wallet to sign / broadcast.
   *
   * Peach Protocol labels the modal's submit button differently depending on
   * allowance state and price difference:
   *
   *   "Confirm Swap"    – token already approved (e.g. BNB, or tokens with
   *                       existing allowance). Usually one wallet action.
   *
   *   "Swap Anyway"     – same as "Confirm Swap", but the quote tripped the
   *                       high-price-difference warning. Still submits.
   *
   *   "Approve and Swap" – token needs an ERC-20 approval first (e.g. USDC
   *                        with no prior allowance). Two wallet actions:
   *                        1st = Approve tx,  2nd = Swap tx.
   *
   * 注入式钱包没有审批弹窗，签名同步完成，所以这里等的是 bridge 的活动计数
   * （广播交易数 + 签名数）增加，次数由实际发生的动作决定而非硬编码。
   */
  async executeSwap(wallet: E2EWalletController, options: { expectApproval?: boolean } = {}) {
    const receiveAmount = await this.getReceiveAmount();
    if (!receiveAmount || receiveAmount === '0' || receiveAmount === '0.0') {
      throw new Error('[SwapPage] Cannot execute swap – no quote available');
    }
    const receiveValue = parseFloat(receiveAmount);
    if (receiveValue < 0.000001) {
      console.log(`[SwapPage] ⚠ Very small receive amount: ${receiveAmount} — swap may be rejected by the dApp`);
    }

    const swapBtn = this.page.getByRole('button', { name: /^Swap$/i });
    await expect(swapBtn).toBeEnabled({ timeout: 15000 });
    await swapBtn.click();
    console.log('[SwapPage] Swap button clicked');

    // Step 1: wait for the in-page confirmation modal and click it.
    // Returns true  → "Approve and Swap" was clicked (ERC-20 needs Permit2 allowance)
    // Returns false → "Confirm Swap" / "Swap Anyway" was clicked (already approved)
    const needsApproval = await this.waitForConfirmSwap();

    // Step 2: 等钱包动作真的发生。
    //
    // 注入钱包没有弹窗，签名是同步完成的，所以这里等的是 bridge 的活动计数
    // （广播交易数 + 签名数）增加。一次 swap 可能产生 1~2 个钱包动作：
    //   - "Approve and Swap"：ERC-20 / Permit2 授权 + swap 交易
    //   - "Confirm Swap"    ：Permit2 签名 + swap 交易，或只有 swap 交易
    // 次数不确定，所以循环等到不再有新动作为止，而不是硬编码调用两次。
    const label = needsApproval ? 'Approve and Swap' : 'Confirm Swap/Swap Anyway';
    console.log(`[SwapPage] "${label}" – waiting for wallet actions...`);

    let actions = 0;
    const maxActions = needsApproval ? 3 : 2;
    while (actions < maxActions) {
      const happened = await wallet.approveTransaction(this.page);
      if (!happened) break;
      actions += 1;
      console.log(`[SwapPage] Wallet action ${actions} completed`);
    }

    if (actions === 0) {
      throw new Error(
        '[SwapPage] 点击确认后钱包没有任何签名或交易动作。' +
        '可能是报价失效、余额不足，或前端在提交前就报错了。',
      );
    }
    console.log(`[SwapPage] Swap submitted (${actions} wallet action(s)), tx=${wallet.lastTxHash ?? 'none'}`);
  }

  /**
   * Wait for the in-page confirmation dialog button to become clickable,
   * then click it. Handles both button variants:
   *
   *   "Confirm Swap"    – token already has allowance, no prior approval needed.
   *   "Swap Anyway"     – same submit action, shown when the quote triggers the
   *                        high-price-difference warning.
   *   "Approve and Swap" – token needs ERC-20 approval, so two wallet actions
   *                        follow this click instead of one.
   *
   * Also handles "Price Updated" / "Accept" banners that may appear before
   * the confirmation button becomes enabled (can happen multiple times).
   *
   * @param timeoutMs  Total budget for the whole loop (default 30 s).
   * @returns  true when "Approve and Swap" was clicked (caller should expect
   *           an extra wallet action), false for "Confirm Swap" / "Swap Anyway".
   */
  private async waitForConfirmSwap(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    // Locate the confirm button directly — do NOT scope to [role="dialog"] because
    // Peach's modal may not carry that ARIA role.
    // .last() ensures we pick the button inside the modal overlay, not the main
    // page CTA (which shares similar text but is rendered earlier in the DOM).
    const confirmBtn = this.page
      .locator('button')
      .filter({ hasText: CONFIRM_SWAP_BUTTON_TEXT })
      .last();

    // Wait up to 10 s for the button to appear (modal animation + React render time).
    // If it never appears, skip the whole flow (no modal = no click needed).
    const appeared = await confirmBtn
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!appeared) {
      console.log('[SwapPage] Confirm/Approve button never appeared — skipping modal click');
      return false;
    }

    // Read button text once it's visible so we can log which variant appeared.
    const btnText = await confirmBtn.textContent({ timeout: 2000 }).catch(() => '');
    const isApproveAndSwap = /approve\s*and\s*swap/i.test(btnText ?? '');
    console.log(
      `[SwapPage] Confirmation button detected: "${btnText?.trim()}" → ` +
      (isApproveAndSwap ? 'approval flow (2 wallet actions)' : 'direct submit flow')
    );
    console.log(`[SwapPage] Entering confirm loop, deadline in ${Math.ceil(timeoutMs / 1000)}s`);

    while (Date.now() < deadline) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);

      // --- 1. Handle "Price Updated" → Accept banner first ---
      const acceptBtn = this.page
        .locator('button')
        .filter({ hasText: /^accept$/i })
        .first();

      const acceptVisible = await acceptBtn.isVisible({ timeout: 800 }).catch(() => false);
      if (acceptVisible) {
        console.log('[SwapPage] Price update detected → clicking Accept');
        try {
          await acceptBtn.click({ timeout: 3000 });
          console.log('[SwapPage] Accept clicked');
        } catch {
          console.log('[SwapPage] Accept click failed, retrying...');
        }
        await this.page.waitForTimeout(800);
        continue;
      }

      // --- 2. Re-read button text in case price update changed the variant ---
      const currentText = await confirmBtn.textContent({ timeout: 500 }).catch(() => btnText);
      const currentIsApprove = /approve\s*and\s*swap/i.test(currentText ?? '');

      // --- 3. Check if the confirmation button is stably enabled ---
      const enabled = await confirmBtn.isEnabled({ timeout: 800 }).catch(() => false);
      console.log(`[SwapPage] Loop tick: enabled=${enabled} text="${currentText?.trim()}" (${remaining}s left)`);
      if (!enabled) {
        await this.page.waitForTimeout(500);
        continue;
      }

      // Wait briefly to ensure it's not mid-animation / price-update debounce
      await this.page.waitForTimeout(300);

      // Re-check Accept hasn't appeared in the meantime
      const acceptAfter = await this.page
        .locator('button')
        .filter({ hasText: /^accept$/i })
        .first()
        .isVisible({ timeout: 300 })
        .catch(() => false);
      if (acceptAfter) continue;

      try {
        await confirmBtn.click({ timeout: 5000 });
        console.log(`[SwapPage] "${currentText?.trim()}" clicked — waiting for button to disappear`);

        // After a successful click the modal closes and the confirm button disappears.
        // Wait up to 6 s for it to become hidden (the wallet signs within 1-2 s).
        const btnGone = await confirmBtn
          .waitFor({ state: 'hidden', timeout: 6_000 })
          .then(() => true)
          .catch(() => false);

        if (btnGone) {
          console.log('[SwapPage] Confirm button gone → modal closed, wallet action expected');
          return currentIsApprove;
        }

        // Button still visible — modal didn't close. Check for inline error messages.
        // "minimum" alone is not an error signal: the review modal always renders a
        // "Minimum Received" row, and the high-price-difference warning is expected
        // whenever the button reads "Swap Anyway".
        const errorText = await this.page
          .locator('p, span, div')
          .filter({ hasText: /error|failed|insufficient|too small|minimum amount|invalid/i })
          .first()
          .textContent({ timeout: 1_000 })
          .catch(() => null);

        if (errorText) {
          throw new Error(`[SwapPage] dApp rejected swap after confirm click: "${errorText.trim()}"`);
        }

        // No visible error but button still there — price may have refreshed,
        // loop back to handle a new Accept banner or re-enabled button state.
        console.log('[SwapPage] Confirm button still visible after click (possible price refresh), retrying...');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('[SwapPage] dApp rejected')) throw err;
        console.log(`[SwapPage] Confirmation button click failed: ${msg}, retrying loop...`);
      }

      await this.page.waitForTimeout(500);
    }

    // Budget exhausted — one last attempt with a full error
    console.log('[SwapPage] Timeout budget exhausted, final attempt...');
    const finalText = await confirmBtn.textContent({ timeout: 1000 }).catch(() => '');
    const finalIsApprove = /approve\s*and\s*swap/i.test(finalText ?? '');
    await expect(confirmBtn).toBeEnabled({ timeout: 5000 });
    await confirmBtn.click();
    const finalGone = await confirmBtn
      .waitFor({ state: 'hidden', timeout: 6_000 })
      .then(() => true)
      .catch(() => false);
    if (!finalGone) {
      throw new Error('[SwapPage] Confirm button still visible after click — dApp may have rejected the swap');
    }
    console.log(`[SwapPage] "${finalText?.trim()}" clicked (final attempt)`);
    return finalIsApprove;
  }

  /**
   * Wait for the "Success" dialog to appear after a swap transaction.
   * Polls every second and prints progress so the user can see it's alive.
   * Returns true if success dialog appeared within timeoutMs, throws otherwise.
   *
   * @param timeoutMs  Maximum wait time (default 60 s). After this throws.
   * @param label      Optional label printed in logs (e.g. route name).
   */
  async waitForSwapSuccess(
    timeoutMs = 60_000,
    label = '',
  ): Promise<{ success: boolean; reason?: 'on-chain-failure' | 'timeout'; errorText?: string }> {
    const tag = label ? `[${label}] ` : '';
    const deadline = Date.now() + timeoutMs;
    const intervalMs = 2_000;

    console.log(`[SwapPage] ${tag}Waiting for swap success dialog (timeout ${timeoutMs / 1000}s)...`);

    while (Date.now() < deadline) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);

      // Check for success
      const successVisible = await this.page
        .locator('text=/Success/i')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);

      if (successVisible) {
        // Extract "Traded X for Y" message if present
        const tradedText = await this.page
          .locator('text=/Traded.*for/i')
          .first()
          .textContent({ timeout: 3000 })
          .catch(() => null);

        if (tradedText) {
          console.log(`[SwapPage] ${tag}✓ Swap success: ${tradedText.trim()}`);
        } else {
          console.log(`[SwapPage] ${tag}✓ Swap success`);
        }

        // Dismiss the success dialog
        const closeBtn = this.page.getByRole('button', { name: /Close/i }).last();
        if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await closeBtn.click();
          console.log(`[SwapPage] ${tag}Success dialog closed`);
        }

        return { success: true };
      }
      const FAIL_PATTERN = /Transaction failed|Swap failed|Something went wrong|Oops|失败/i;
      const failVisible = await this.page
        .locator(`text=${FAIL_PATTERN}`)
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);

      if (failVisible) {
        const failText = await this.page
          .locator(`text=${FAIL_PATTERN}`)
          .first()
          .textContent({ timeout: 1000 })
          .catch(() => 'unknown error');
        console.log(`[SwapPage] ${tag}⚠️  Failure indicator detected: "${failText?.trim()}" — waiting 5s to confirm it's not transient...`);

        // Some DEX UIs briefly show a failed state before the on-chain confirmation
        // arrives. Wait 5s and check again for a success dialog before giving up.
        await this.page.waitForTimeout(5_000);

        const successAfterFail = await this.page
          .locator('text=/Success/i')
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);

        if (successAfterFail) {
          const tradedText = await this.page
            .locator('text=/Traded.*for/i')
            .first()
            .textContent({ timeout: 3000 })
            .catch(() => null);
          console.log(`[SwapPage] ${tag}✓ Success appeared after transient failure indicator${tradedText ? `: ${tradedText.trim()}` : ''}`);
          const closeBtn = this.page.getByRole('button', { name: /Close/i }).last();
          if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await closeBtn.click();
          }
          return { success: true };
        }

        // Try to get more detail from the error dialog body
        const errorDetail = await this.page
          .locator('text=/Something went wrong|Transaction failed|Swap failed/i')
          .first()
          .textContent({ timeout: 1000 })
          .catch(() => null);

        const errorMsg = errorDetail?.trim() ?? failText?.trim() ?? 'Transaction failed on-chain';
        console.log(`[SwapPage] ${tag}✗ Transaction failed on-chain: ${errorMsg}`);
        console.log(`[SwapPage] ${tag}##SWAP_ONCHAIN_FAILURE:${errorMsg}##`);

        // Dismiss the error dialog so the UI is clean for the next route
        const dismissBtn = this.page.getByRole('button', { name: /Dismiss/i }).first();
        if (await dismissBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await dismissBtn.click().catch(() => {});
          console.log(`[SwapPage] ${tag}Error dialog dismissed`);
        }
        return { success: false, reason: 'on-chain-failure', errorText: errorMsg };
      }

      console.log(`[SwapPage] ${tag}⏳ Still waiting... (${remaining}s remaining)`);
      await this.page.waitForTimeout(intervalMs);
    }

    // Timed out
    console.log(`[SwapPage] ${tag}✗ Timed out after ${timeoutMs / 1000}s — no success dialog appeared`);
    return { success: false, reason: 'timeout' };
  }

  /**
   * Read the number of active routes shown in the "Auto Router" section.
   * The UI typically shows "X Stream" or "X Route(s)" below the Swap button.
   * Returns 0 if the route count element is not visible.
   */
  async getRouteCount(): Promise<number> {
    try {
      // "Auto Router" row typically shows "1 Stream" or "2 Streams" / "3 Routes"
      const routeText = await this.page
        .locator('text=/\\d+\\s*(Stream|Route)/i')
        .first()
        .textContent({ timeout: 8000 })
        .catch(() => null);

      if (routeText) {
        const match = routeText.match(/(\d+)/);
        if (match) {
          const count = parseInt(match[1], 10);
          console.log(`[SwapPage] Route count: ${count} (from "${routeText.trim()}")`);
          return count;
        }
      }

      // Fallback: look for any route-count indicator near "Auto Router" label
      const autoRouterSection = this.page.locator('text=/Auto Router/i').first();
      const parentText = await autoRouterSection
        .locator('xpath=parent::*')
        .textContent({ timeout: 3000 })
        .catch(() => null);

      if (parentText) {
        const match = parentText.match(/(\d+)\s*(Stream|Route)/i);
        if (match) {
          const count = parseInt(match[1], 10);
          console.log(`[SwapPage] Route count (fallback): ${count}`);
          return count;
        }
      }

      console.log('[SwapPage] Could not read route count');
      return 0;
    } catch (err) {
      console.log(`[SwapPage] Error reading route count: ${err}`);
      return 0;
    }
  }

  /**
   * Convenience method: select routes, confirm settings, enter amount, and swap.
   * Returns the receive-amount string for assertions.
   */
  async selectRoutesAndSwap(
    wallet: E2EWalletController,
    routes: string[],
    payAmount: string,
    options: { expectApproval?: boolean } = {},
  ): Promise<string> {
    await this.selectRoutes(routes);
    await this.confirmSettingsChanges();
    await this.enterPayAmount(payAmount);

    const quote = await this.getReceiveAmount();
    console.log(`[SwapPage] Quote: ${payAmount} → ${quote}`);

    await this.executeSwap(wallet, options);
    return quote;
  }

  /**
   * Read the BNB balance shown in the "You Pay" input card.
   * The balance is displayed as a small number below the token selector, e.g. "0.0207209".
   * Returns the numeric value, or null if not readable.
   */
  async getBnbBalance(): Promise<number | null> {
    try {
      // The balance row is in the "You Pay" section, shows a number with many decimals
      // Typical structure: <span>0.0207209</span> (wallet BNB balance)
      const balanceEl = this.page
        .locator('[class*="pay"], [class*="Pay"]')
        .locator('text=/^\\d+\\.\\d+$/')
        .first();

      let text = await balanceEl.textContent({ timeout: 3000 }).catch(() => null);

      // Fallback: look for the balance row beneath the BNB token selector
      if (!text) {
        const bnbRow = this.page.locator('text=/BNB/i').first();
        const parent = bnbRow.locator('xpath=ancestor::div[3]');
        const numEl = parent.locator('text=/^\\d+\\.\\d{4,}$/').first();
        text = await numEl.textContent({ timeout: 3000 }).catch(() => null);
      }

      if (text) {
        const val = parseFloat(text.trim());
        if (!isNaN(val)) {
          console.log(`[SwapPage] BNB balance: ${val}`);
          return val;
        }
      }
      console.log('[SwapPage] Could not read BNB balance');
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Read the gas-fee warning banner that appears above the Swap button.
   * Peach shows: "Must have 0.00005 BNB or more left in wallet for gas fee."
   * when the entered amount leaves insufficient BNB for gas.
   *
   * Returns the trimmed warning text, or empty string if not visible.
   */
  async getGasWarning(): Promise<string> {
    try {
      // The warning is an orange-bordered banner between the rate row and the Swap button
      const knownPhrases = [
        /Must have.*BNB.*or more left.*for gas/i,
        /left in wallet for gas/i,
        /insufficient.*gas/i,
        /gas fee/i,
      ];

      for (const phrase of knownPhrases) {
        const el = this.page.getByText(phrase).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          const t = await el.textContent({ timeout: 2000 }).catch(() => null);
          if (t?.trim()) {
            console.log(`[SwapPage] Gas warning: "${t.trim()}"`);
            return t.trim();
          }
        }
      }

      // Fallback: look for any warning-colored element near the Swap button
      const swapBtn = this.page.getByRole('button', { name: /^Swap$/i }).first();
      const warningAboveSwap = swapBtn
        .locator('xpath=preceding-sibling::*[1]')
        .first();
      const t = await warningAboveSwap.textContent({ timeout: 2000 }).catch(() => null);
      if (t?.trim() && /gas|BNB|wallet/i.test(t)) {
        console.log(`[SwapPage] Gas warning (fallback): "${t.trim()}"`);
        return t.trim();
      }

      return '';
    } catch {
      return '';
    }
  }
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
