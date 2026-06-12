import { type Page, expect } from '@playwright/test';
import type { MetaMaskController } from '../wallet/metamask-controller.js';

export class SwapPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    // Retry once on connection failure (flaky network / VPN issues)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.page.goto('/swap', { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        console.log(`[SwapPage] goto failed (attempt ${attempt}), retrying in 3s...`);
        await this.page.waitForTimeout(3000);
      }
    }
    await this.page.waitForLoadState('networkidle');
    // Wait for the swap UI to load
    await this.page.waitForSelector('text=/You Pay|Enter an amount/i', { timeout: 15000 });
    console.log('[SwapPage] Swap page loaded');
    // Dismiss the "Terms & Policies" dialog if it appears on first visit.
    // The dialog is a fixed overlay that intercepts all pointer events until accepted.
    await this.dismissTermsDialogIfPresent();
  }

  /**
   * If the "Terms & Policies" consent dialog is open, check the agreement
   * checkbox and click "Confirm" so subsequent interactions are not blocked.
   */
  private async dismissTermsDialogIfPresent() {
    const dialog = this.page.locator('role=dialog[name="Terms & Policies"]');
    const isVisible = await dialog.isVisible({ timeout: 3000 }).catch(() => false);
    if (!isVisible) return;

    console.log('[SwapPage] Terms & Policies dialog detected – accepting');
    const checkbox = dialog.locator('role=checkbox');
    await checkbox.check();
    const confirmBtn = dialog.locator('role=button', { hasText: /^Confirm$/i });
    await expect(confirmBtn).toBeEnabled({ timeout: 5000 });
    await confirmBtn.click();
    await expect(dialog).toBeHidden({ timeout: 8000 });
    console.log('[SwapPage] Terms & Policies accepted');
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
   * Click the "Connect Wallet" button on the dApp, choose MetaMask from the
   * wallet-selection modal, then approve the connection in the MetaMask popup.
   *
   * Also handles the case where the dApp asks to switch to BNB Smart Chain.
   */
  async connectWallet(metamask: MetaMaskController) {
    const connectBtn = this.page
      .getByRole('button', { name: /Connect Wallet/i })
      .first();
    await expect(connectBtn).toBeVisible({ timeout: 10000 });
    await connectBtn.click();
    console.log('[SwapPage] Wallet selection modal opened');

    // Select MetaMask in the wallet picker modal (different dApps use different UIs)
    const metaMaskBtn = this.page
      .getByRole('button', { name: /MetaMask/i })
      .or(this.page.locator('button, div[role="button"]').filter({ hasText: /MetaMask/i }))
      .first();
    await expect(metaMaskBtn).toBeVisible({ timeout: 8000 });
    await metaMaskBtn.click();

    // Approve the connection in the MetaMask popup
    await metamask.approveTransaction(this.page);
    console.log('[SwapPage] MetaMask connection approved');

    // The dApp may request a network switch to BNB Smart Chain
    const switchNetworkRequested = await this.page
      .waitForSelector('text=/Switch Network|Wrong Network/i', { timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    if (switchNetworkRequested) {
      console.log('[SwapPage] Network switch requested – approving in MetaMask');
      await metamask.approveTransaction(this.page);
    }

    // Wait until the wallet address appears in the header (proves connection succeeded)
    await this.page.waitForSelector('text=/0x[a-fA-F0-9]{3,}/i', { timeout: 20000 });
    console.log('[SwapPage] Wallet connected successfully');
  }

  // ── Token selection ─────────────────────────────────────────────────────────

  /**
   * Select a token by searching its contract address.
   * Flow: Click token button → Search address → Click result row
   *
   * @param slot    - 'pay' | 'receive'
   * @param address - contract address (e.g. "0xeeee...eeee")
   * @param symbol  - optional symbol (e.g. "BNB") for logging and selection
   */
  async selectToken(slot: 'pay' | 'receive', address: string, symbol?: string) {
    console.log(`[SwapPage] Selecting ${symbol || address.slice(0, 10) + '...'} for "${slot}"`);

    // Step 1: Click the token button
    const tokenButtons = this.page.locator('button').filter({ hasText: /^[A-Z]{2,6}$/ });
    const buttonIndex = slot === 'pay' ? 0 : 1;
    await tokenButtons.nth(buttonIndex).click({ timeout: 10000 });
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
    console.log(`[SwapPage] Entered pay amount: ${amount}`);

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
   * Get token balances from MetaMask directly by reading the wallet.
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
   * "Swap" button, handle the in-page confirmation dialog, and confirm
   * transaction(s) in MetaMask.
   *
   * Peach Protocol shows two different confirmation buttons depending on
   * whether the pay token already has an allowance:
   *
   *   "Confirm Swap"    – token already approved (e.g. BNB, or tokens with
   *                       existing allowance). Only ONE MetaMask popup.
   *
   *   "Approve and Swap" – token needs an ERC-20 approval first (e.g. USDC
   *                        with no prior allowance). TWO MetaMask popups:
   *                        1st = Approve tx,  2nd = Swap tx.
   *
   * This method detects which button was clicked and adjusts the number of
   * MetaMask confirmations automatically.
   */
  async executeSwap(metamask: MetaMaskController, options: { expectApproval?: boolean } = {}) {
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
    // Returns false → "Confirm Swap" was clicked (token already approved / native BNB)
    const needsApproval = await this.waitForConfirmSwap();

    if (needsApproval) {
      // ── "Approve and Swap" path ──────────────────────────────────────────────
      // MetaMask shows TWO consecutive popups:
      //   Popup 1: ERC-20 approval for Permit2
      //   Popup 2: the actual swap transaction
      console.log('[SwapPage] "Approve and Swap" – MetaMask popup 1/2 (ERC-20 approval)...');
      await metamask.approveTransaction(this.page);
      console.log('[SwapPage] Popup 1/2 done – waiting for swap popup 2/2...');
      await metamask.approveTransaction(this.page);
      console.log('[SwapPage] Popup 2/2 done – swap submitted');
    } else {
      // ── "Confirm Swap" path ──────────────────────────────────────────────────
      // Even for already-approved tokens (USDT, BNB), MetaMask still shows
      // TWO consecutive popups (e.g. Permit2 signature + swap tx).
      console.log('[SwapPage] "Confirm Swap" – MetaMask popup 1/2...');
      await metamask.approveTransaction(this.page);
      console.log('[SwapPage] Popup 1/2 done – waiting for popup 2/2...');
      await metamask.approveTransaction(this.page);
      console.log('[SwapPage] Popup 2/2 done – swap submitted');
    }
  }

  /**
   * Wait for the in-page confirmation dialog button to become clickable,
   * then click it. Handles both button variants:
   *
   *   "Confirm Swap"    – token already has allowance, no prior approval needed.
   *   "Approve and Swap" – token needs ERC-20 approval, MetaMask will show
   *                        two consecutive popups after this click.
   *
   * Also handles "Price Updated" / "Accept" banners that may appear before
   * the confirmation button becomes enabled (can happen multiple times).
   *
   * @param timeoutMs  Total budget for the whole loop (default 30 s).
   * @returns  true when "Approve and Swap" was clicked (caller should expect
   *           two MetaMask popups), false when "Confirm Swap" was clicked.
   */
  private async waitForConfirmSwap(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    // Locate the confirm button directly — do NOT scope to [role="dialog"] because
    // Peach's modal may not carry that ARIA role.
    // .last() ensures we pick the button inside the modal overlay, not the main
    // page CTA (which shares similar text but is rendered earlier in the DOM).
    const confirmBtn = this.page
      .locator('button')
      .filter({ hasText: /confirm\s*swap|approve\s*and\s*swap/i })
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
      (isApproveAndSwap ? 'Approve and Swap (2 MetaMask popups)' : 'Confirm Swap (1 MetaMask popup)')
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
        // Wait up to 6 s for it to become hidden (MetaMask usually opens within 2–3 s).
        const btnGone = await confirmBtn
          .waitFor({ state: 'hidden', timeout: 6_000 })
          .then(() => true)
          .catch(() => false);

        if (btnGone) {
          console.log('[SwapPage] Confirm button gone → modal closed, MetaMask popup expected');
          return currentIsApprove;
        }

        // Button still visible — modal didn't close. Check for inline error messages.
        const errorText = await this.page
          .locator('p, span, div')
          .filter({ hasText: /error|fail|insufficient|too small|minimum|invalid/i })
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
    metamask: MetaMaskController,
    routes: string[],
    payAmount: string,
    options: { expectApproval?: boolean } = {},
  ): Promise<string> {
    await this.selectRoutes(routes);
    await this.confirmSettingsChanges();
    await this.enterPayAmount(payAmount);

    const quote = await this.getReceiveAmount();
    console.log(`[SwapPage] Quote: ${payAmount} → ${quote}`);

    await this.executeSwap(metamask, options);
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
