import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { CHILD_TO_PARENT_MAP, PARENT_ROUTE_MAP } from '@/config/routes.js';
import { dismissCetusTerms } from '@/utils/dismiss-terms.js';

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class SwapPage {
  readonly page: Page;
  readonly inputAmount: Locator;
  readonly explorerLink: Locator;

  /** 路由布局缓存：key=badgeCount，避免每次 selectCetusRoutes 都重新扫描 */
  private routeLayoutCache: {
    badgeCount: number;
    layout: Map<string, { type: 'cetus' | 'sub' | 'top'; menuListId?: string; badgeIndex?: number }>;
  } | null = null;

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
    //
    // 不要在这里先等 receive 金额：报价结算前 Cetus 让按钮保持 disabled 并显示
    // "Loading..."，因此"按钮名为 Swap 且可点击"本身就是报价已就绪的充分证据。
    // 按 accessible name 精确匹配 /^swap!?$/ 天然排除了 Loading 中间态。
    const swapButton = this.page.getByRole('button', { name: /^swap!?$/i }).first();
    await expect(swapButton).toBeVisible({ timeout: 30_000 });
    await expect(swapButton).toBeEnabled({ timeout: 30_000 });
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

    // 只在成功弹窗范围内按 Sui digest 的 base58 特征取值。
    // 整页正则会匹配到 CSS class / 合约地址等噪音，导致假 digest 通过断言。
    const dialogText = await successDialog.innerText().catch(() => '');
    const digest = dialogText.match(/\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/)?.[0];
    if (digest) {
      return digest;
    }

    // 兜底：Cetus 的 "View on Explorer" 是纯 <button>（走 window.open），
    // 没有 href 也不把 digest 渲染进文案，因此上面的策略全部读不到。
    // 拦截 window.open 的目标 URL 取 digest，新标签页立即关闭、不等加载。
    return this.readDigestFromExplorerPopup(successDialog, txFromHref);
  }

  /**
   * 点击成功弹窗内的 SuiVision / Suiscan 按钮，从 window.open 的 URL 提取 digest。
   *
   * 新标签页一打开就关闭，不触发区块浏览器页面加载。
   */
  private async readDigestFromExplorerPopup(
    successDialog: Locator,
    txFromHref: (href: string | null) => string | undefined
  ): Promise<string | undefined> {
    const context = this.page.context();

    for (const name of [/suivision/i, /suiscan/i]) {
      const button = successDialog
        .locator('button, [role="button"]')
        .filter({ hasText: name })
        .first();
      if (!(await button.isVisible({ timeout: 1_500 }).catch(() => false))) continue;

      const popupPromise = context.waitForEvent('page', { timeout: 8_000 }).catch(() => undefined);
      await button.click().catch(() => undefined);
      const popup = await popupPromise;
      if (!popup) continue;

      // popup 刚创建时 url() 可能还是 about:blank，轮询等真实地址
      let url = popup.url();
      for (let i = 0; i < 20 && (!url || url === 'about:blank'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        url = popup.url();
      }
      await popup.close().catch(() => undefined);
      await this.page.bringToFront().catch(() => undefined);

      const digest = txFromHref(url);
      if (digest) {
        console.log(`[SwapPage] readDigest: extracted from explorer popup ${url}`);
        return decodeURIComponent(digest);
      }
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

    // 确认选择真的生效：弹窗关闭 + 选择器文字变成目标代币。
    // 若点到了行内嵌套按钮，弹窗会保持打开并遮挡后续操作，
    // 导致金额被填进上一个代币的面板（静默产生错误的报价）。
    await pickerRoot.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined);

    const selectedText = (await selectorBtn.innerText().catch(() => '')).trim();
    if (!expectedSymbolRegex.test(selectedText)) {
      throw new Error(
        `Token selection failed for the "${direction}" panel: expected "${expectedSymbol}" but the selector shows "${selectedText}"`
      );
    }
  }

  async dismissTermsModalIfPresent() {
    await dismissCetusTerms(this.page);
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
    const symbol = tokenRegex.source.replace(/^\^/, '').replace(/\$$/, '');

    // Strategy 0: row-level button whose FIRST text line is the symbol.
    //
    // Cetus renders each token row as a button that nests a second button for the
    // project name, e.g. "SBOX\nSuiBoxer". Matching the accessible name against
    // /^SBOX$/ misses it, and clicking the inner <p> does not select the token.
    // Keying on the first line targets the outer row button and skips the nested
    // project-name button (whose first line is "SuiBoxer").
    if (await this.clickRowByFirstLine(pickerRoot, symbol)) return;

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

  /**
   * 在代币选择弹窗内点击"首行文字等于 symbol"的整行按钮。
   *
   * 只接受首行匹配，可避免点到行内嵌套的项目名按钮（如 SBOX 行里的 "SuiBoxer"）。
   */
  private async clickRowByFirstLine(pickerRoot: Locator, symbol: string): Promise<boolean> {
    const symLower = symbol.toLowerCase();
    const rows = pickerRoot.locator('button.chakra-button, button');
    const count = await rows.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      if (!(await row.isVisible({ timeout: 300 }).catch(() => false))) continue;

      const text = await row.innerText().catch(() => '');
      const firstLine = text.split('\n')[0]?.trim().toLowerCase() ?? '';
      if (firstLine !== symLower) continue;

      await row.click();
      return true;
    }

    return false;
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
   * Returns the positive receive amount, or null while the quote is unavailable.
   *
   * While `find_routes` is in flight Cetus wraps the receive field in a
   * chakra-skeleton and leaves its value empty, so an immediate read yields nothing.
   */
  private async readReceiveAmountValue(): Promise<number | null> {
    const candidates: Locator[] = [
      // 首选：紧跟 "You Receive" 标签的第一个 input。
      // 不能只认 input[readonly] / input[disabled]：该字段支持反向输入
      // （填收到数量倒推支付数量），因此通常两个属性都没有，按属性筛会一个都匹配不到，
      // 每个候选各耗满 1s 超时，最终把调用方拖到 30s 空转。
      this.page.getByText(/^you receive$/i).first().locator('xpath=following::input[1]')
    ];
    for (const depth of [3, 2, 4]) {
      candidates.push(this.findSwapSection('to', depth).locator('input').first());
    }
    candidates.push(this.page.locator('input[readonly], input[disabled]').first());

    for (const candidate of candidates) {
      const raw = await candidate.inputValue({ timeout: 500 }).catch(() => '');
      const parsed = parseFloat(raw.replace(/,/g, ''));
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }

    return null;
  }

  /**
   * Waits until the receive amount is rendered (i.e. the loading skeleton is gone).
   *
   * Best-effort by design: scenarios such as insufficient liquidity or dust never
   * produce a quote, and those callers must still be able to inspect the UI state.
   *
   * @returns the receive amount, or null if it never rendered
   */
  async waitForReceiveAmount(timeoutMs: number = 30_000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    let logged = false;

    while (Date.now() < deadline) {
      const value = await this.readReceiveAmountValue();
      if (value !== null) {
        console.log(`[SwapPage] Quote ready, receive amount: ${value}`);
        return value;
      }
      if (!logged) {
        console.log('[SwapPage] Waiting for the quote skeleton to resolve...');
        logged = true;
      }
      await this.page.waitForTimeout(200);
    }

    console.warn(`[SwapPage] Receive amount did not render within ${timeoutMs}ms`);
    return null;
  }

  /**
   * Reads the expected output amount displayed in the "You Receive" panel.
   * Returns the value as a BigInt using the provided decimal (default 9).
   */
  async getExpectedOutputAmount(outputDecimal: number = 9): Promise<bigint> {
    await this.waitForReceiveAmount();
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
   * Reads the "Minimum Received" row from the quote details panel.
   *
   * Cetus renders the value inside a chakra-skeleton placeholder while the
   * quote is (re)loading, so the row text is empty for a short window and is
   * refreshed periodically. Poll until a numeric value appears.
   *
   * @returns `{ text, value }` or `null` when the value never renders.
   */
  async getMinimumReceived(
    symbol: string,
    timeoutMs: number = 20_000
  ): Promise<{ text: string; value: number } | null> {
    const label = this.page.locator('p, span').filter({ hasText: /^Minimum Received$/i }).first();
    const valuePattern = new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s*${escapeRegExp(symbol)}`, 'i');
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // The value sits in a sibling container, so walk up until the row text
      // contains both the label and the amount.
      for (const level of [2, 3, 4]) {
        const row = label.locator(`xpath=ancestor::*[${level}]`);
        const rowText = (await row.innerText().catch(() => '')).trim();
        const match = rowText.match(valuePattern);
        if (match) {
          const value = parseFloat(match[1].replace(/,/g, ''));
          if (!isNaN(value)) return { text: match[0], value };
        }
      }
      await this.page.waitForTimeout(500);
    }

    return null;
  }

  /**
   * Reads the USD value displayed below the token amount in a swap panel.
   *
   * Cetus renders the fiat value as e.g. "$1.88" directly beneath the amount
   * input inside each panel.  Returns `null` when the value is not found or
   * cannot be parsed (e.g. "$0.00", still loading).
   *
   * @param direction 'from' (You Pay) or 'to' (You Receive)
   */
  async readPanelUsdValue(direction: 'from' | 'to'): Promise<number | null> {
    for (const depth of [3, 2, 4]) {
      const section = this.findSwapSection(direction, depth);
      // Match elements whose text is a USD amount: "$1.88", "$ 0.00", etc.
      const candidates = section.locator('div, span, p').filter({ hasText: /^\$[\d,]+(?:\.\d+)?$/ });
      const count = await candidates.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const el = candidates.nth(i);
        if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) continue;
        const text = (await el.innerText().catch(() => '')).trim();
        const num = parseFloat(text.replace(/[$,]/g, ''));
        if (!isNaN(num) && num > 0) return num;
      }
    }
    return null;
  }

  /**
   * Checks whether the quote price impact (pay USD vs receive USD) exceeds the
   * given slippage tolerance percentage.
   *
   * Returns an object describing the result so callers can log details and
   * decide how to handle it.
   *
   * @param slippagePercent  e.g. 0.5 means 0.5 %
   */
  async checkQuotePriceImpact(slippagePercent: number): Promise<{
    exceeded: boolean;
    payUsd: number | null;
    receiveUsd: number | null;
    impactPercent: number | null;
  }> {
    // Allow the UI a moment to finish updating both panels
    await this.page.waitForTimeout(600);

    const payUsd     = await this.readPanelUsdValue('from');
    const receiveUsd = await this.readPanelUsdValue('to');

    if (payUsd === null || receiveUsd === null || payUsd === 0) {
      return { exceeded: false, payUsd, receiveUsd, impactPercent: null };
    }

    // Price impact = how much value is lost expressed as a percentage of pay value
    const impactPercent = ((payUsd - receiveUsd) / payUsd) * 100;
    const exceeded = impactPercent > slippagePercent;

    return { exceeded, payUsd, receiveUsd, impactPercent };
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
   * 读取主操作按钮当前的文案（"Swap" / "Loading..." / "Enter an amount" /
   * "Insufficient liquidity for this trade" / "Insufficient SUI Balance" 等）。
   *
   * Cetus 把报价状态直接反映在这个按钮上，因此它是判断报价是否结算完成的依据。
   */
  async readActionButtonText(): Promise<string> {
    for (const depth of [3, 4, 2]) {
      const section = this.findSwapSection('to', depth);
      const btn = section.locator('xpath=following::button[1]');
      const text = (await btn.innerText({ timeout: 1_000 }).catch(() => '')).trim();
      if (text) return text;
    }

    // 兜底：整页范围内匹配已知的主按钮文案
    const known = this.page
      .locator('button.chakra-button')
      .filter({ hasText: /swap|loading|enter an amount|insufficient|liquidity/i })
      .last();
    return (await known.innerText().catch(() => '')).trim();
  }

  /**
   * 轮询等待报价结算完成，返回主操作按钮的最终文案。
   *
   * Cetus 请求 find_routes 期间按钮显示 "Loading..."，且会周期性重新报价。
   * 固定 waitForTimeout 后直接断言会读到中间态，本方法等到按钮不再是
   * Loading 为止，避免这类偶发失败。
   *
   * @returns 结算后的按钮文案；超时则返回最后一次读到的文案
   */
  async waitForQuoteSettled(timeoutMs: number = 25_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastText = '';

    while (Date.now() < deadline) {
      lastText = await this.readActionButtonText();
      if (lastText && !/loading/i.test(lastText)) return lastText;
      await this.page.waitForTimeout(500);
    }

    console.warn(`[SwapPage] waitForQuoteSettled: timed out, last text = "${lastText}"`);
    return lastText;
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
   * 轮询等待 "Auto Router" 标签出现。
   *
   * Cetus 只有在 find_routes 返回后才渲染路由区，固定 waitForTimeout 之后
   * 直接断言会读到报价未结算的中间态（标签尚未挂载）。
   *
   * @returns 标签是否出现
   */
  async waitForAutoRouter(timeoutMs: number = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.hasAutoRouter()) return true;
      await this.page.waitForTimeout(500);
    }
    return false;
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
   * 读取弹窗当前的 "N/总数" 计数（总数由接口动态决定，不再硬编码）。
   */
  private async getRouteCounter(): Promise<number> {
    const dialog = this.getAggregatorDialog();
    return dialog.locator('input#select-all').evaluate((el: HTMLInputElement) => {
      let anc: Element | null = el.parentElement;
      for (let i = 0; i < 6 && anc; i++) {
        const m = (anc.textContent ?? '').match(/(\d+)\s*\n?\s*\/\s*\d+/);
        if (m) return parseInt(m[1], 10);
        anc = anc.parentElement;
      }
      return -1;
    }).catch(() => -1);
  }

  /**
   * 读取弹窗当前的 "N / M" 计数（已选 / 总数）。
   */
  private async getRouteCountPair(): Promise<{ selected: number; total: number }> {
    const dialog = this.getAggregatorDialog();
    return dialog.locator('input#select-all').evaluate((el: HTMLInputElement) => {
      let anc: Element | null = el.parentElement;
      for (let i = 0; i < 6 && anc; i++) {
        const m = (anc.textContent ?? '').match(/(\d+)\s*\n?\s*\/\s*(\d+)/);
        if (m) return { selected: parseInt(m[1], 10), total: parseInt(m[2], 10) };
        anc = anc.parentElement;
      }
      return { selected: -1, total: -1 };
    }).catch(() => ({ selected: -1, total: -1 }));
  }

  /**
   * 将所有路由重置为 0（全部关闭）。
   *
   * 流程：
   *   1. 无条件执行"确保全选 → 全关"：
   *      - 读 Select All checked 状态
   *      - 若未全选 → 点一次变为全选，再点一次变为全关
   *      - 若已全选 → 直接点一次变为全关
   *      （不用计数判断，避免"1条非Cetus路由 ≤3"误判跳过的 bug）
   *   2. 关闭仍处于开启状态的 Cetus 子路由
   *   3. 目标：0
   */
  async disableAllRoutes(): Promise<void> {
    const dialog = this.getAggregatorDialog();
    const selectAllInput = dialog.locator('input#select-all');
    const selectAllTrack = dialog.locator('label:has(input#select-all) .chakra-switch__track');

    await expect(selectAllTrack).toBeVisible({ timeout: 5_000 });

    // Step 1: 无条件将所有非 Cetus 路由关闭。
    // 读 Select All checked 状态决定点几次，避免点反。
    const currentCount = await this.getRouteCounter();
    console.log(`[SwapPage] disableAllRoutes: initial count=${currentCount}`);

    const isChecked = await selectAllInput.evaluate(
      (el: HTMLInputElement) => el.checked
    ).catch(() => false);
    console.log(`[SwapPage] disableAllRoutes: selectAll checked=${isChecked}`);

    if (!isChecked) {
      // 未全选（部分选中或全关）→ 先点一次变为全选
      await selectAllTrack.click();
      await this.page.waitForTimeout(400);
      console.log(`[SwapPage] disableAllRoutes: clicked selectAll to full-on`);
    }
    // 此时一定是全选状态，再点一次变为全关
    await selectAllTrack.click();
    await this.page.waitForTimeout(500);
    console.log(`[SwapPage] disableAllRoutes: clicked selectAll to full-off`);

    if (!(await dialog.isVisible({ timeout: 2_000 }).catch(() => false))) {
      console.warn('[SwapPage] Dialog closed unexpectedly, reopening...');
      await this.openAggregatorSettings();
      await this.page.waitForTimeout(300);
    }

    const afterSelectAll = await this.getRouteCounter();
    console.log(`[SwapPage] disableAllRoutes: after select-all = ${afterSelectAll}`);

    // Step 2: 关闭仍处于开启状态的 Cetus 子路由（CLMM/DLMM/Cetus Tide）。
    //
    // Cetus 是弹窗内唯一带锁的协议，其 badge 始终是第一个 chakra-menu__menu-button。
    // Select All 全关后 Cetus 子路由仍可能处于开启状态（Cetus 锁定，不受 Select All 影响）。
    // 读第一个 badge 的文字，解析分子判断有几条子路由还开着。
    const firstBadgeText = await dialog
      .locator('button.chakra-menu__menu-button').first()
      .textContent({ timeout: 2_000 })
      .catch(() => '');
    console.log(`[SwapPage] disableAllRoutes: Cetus badge text = "${firstBadgeText}"`);
    // badge 格式："3/ 3"、"3/3"、"2/ 3" 等，取第一个数字
    const openCount = parseInt((firstBadgeText ?? '').match(/(\d+)/)?.[1] ?? '0', 10);
    console.log(`[SwapPage] disableAllRoutes: Cetus openCount = ${openCount}`);

    if (openCount > 0) {
      for (const subRoute of ['CLMM', 'DLMM', 'Cetus Tide'] as const) {
        await this.toggleCetusSubRoute(subRoute, 5);
      }
    }

    const finalCount = await this.getRouteCounter();
    console.log(`[SwapPage] disableAllRoutes: final = ${finalCount} (expected 0)`);
    if (finalCount !== 0) {
      console.warn(`[SwapPage] disableAllRoutes: expected 0 but got ${finalCount}`);
    }
  }

  /**
   * 打开 Aggregator Settings，将 "Select all" 打开使全部流动性源生效，然后保存。
   *
   * 背景：Chromium 持久化 profile 会保留上一次运行残留的路由勾选状态。
   * 若只剩单一 provider（例如 KRIYAV3），find_routes 接口只查那一个流动性源，
   * 大额报价会返回 "Insufficient liquidity for this trade"，Auto Router 不渲染。
   * 路由测试前调用本方法可保证从全量流动性源开始。
   *
   * @returns 已启用的流动性源数量，读取失败返回 -1
   */
  async enableAllRoutes(): Promise<number> {
    await this.openAggregatorSettings();

    const dialog = this.getAggregatorDialog();
    const selectAllInput = dialog.locator('input#select-all');
    const selectAllTrack = dialog.locator('label:has(input#select-all) .chakra-switch__track');
    await expect(selectAllTrack).toBeVisible({ timeout: 5_000 });

    const before = await this.getRouteCountPair();
    console.log(`[SwapPage] enableAllRoutes: initial ${before.selected}/${before.total}`);

    // Select All 是三态展示（全选 / 部分 / 全关），checked 只在全选时为 true。
    // 未全选时点一次即变为全选；已全选则无需操作，避免点成全关。
    const isChecked = await selectAllInput
      .evaluate((el: HTMLInputElement) => el.checked)
      .catch(() => false);

    if (!isChecked) {
      await selectAllTrack.click();
      await this.page.waitForTimeout(500);
      console.log('[SwapPage] enableAllRoutes: clicked selectAll to full-on');
    } else {
      console.log('[SwapPage] enableAllRoutes: already fully selected');
    }

    const after = await this.getRouteCountPair();
    console.log(`[SwapPage] enableAllRoutes: after ${after.selected}/${after.total}`);
    if (after.total > 0 && after.selected !== after.total) {
      console.warn(
        `[SwapPage] enableAllRoutes: expected ${after.total} but got ${after.selected}`
      );
    }

    await this.confirmAggregatorSettings();
    // 保存后 Cetus 会用新的 provider 列表重新请求报价
    await this.page.waitForTimeout(1_500);

    return after.selected;
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
    console.log(`[SwapPage] toggleCetusSubRoute "${routeName}": done, counter=${finalCount}`);
    return true;
  }

  /**
   * 展开带子路由的协议（如 "Kriya 2/2 ▼"），使子路由列表可见。
   *
   * 诊断确认的 DOM 结构：
   *   展开 badge 是 <button class="chakra-menu__menu-button arrow_box css-bxvxk9">
   *   文字为 "3/ 3"、"2/ 2"、"0/ 2"、"1/ 1" 等格式（子路由数量动态变化）
   *
   * 定位方式：找协议名旁边的 .chakra-menu__menu-button（最近的祖先容器内）
   * 展开判断：等待对应 menuList 可见，不再依赖固定子路由名（兼容动态数量）
   *
   * @param parentName 父协议名称，如 "Kriya"、"Magma"
   * @returns 展开后的 menuListId，供 checkSubRouteItem 精确定位
   */
  private async expandParentRoute(parentName: string): Promise<string | null> {
    const dialog = this.getAggregatorDialog();

    // 找协议名：优先找 p.source_name 精确匹配，避免 badge 复合文字干扰
    // 例如 "Magma 1/1 ▼" 里包含 "Magma"，但 getByText exact 会因多余文字匹配失败
    let parentLabel = dialog.locator('p.source_name').filter({ hasText: parentName }).first();
    const sourceNameVisible = await parentLabel.isVisible({ timeout: 1_500 }).catch(() => false);
    if (!sourceNameVisible) {
      // 备用：getByText（非 exact）
      parentLabel = dialog.getByText(parentName).first();
      if (!(await parentLabel.isVisible({ timeout: 1_500 }).catch(() => false))) {
        console.warn(`[SwapPage] expandParentRoute "${parentName}": label not found`);
        return null;
      }
    }

    let badgeFound = false;
    let menuListId: string | null = null;

    for (const depth of [1, 2, 3, 4, 5]) {
      const row = parentLabel.locator(`xpath=ancestor::*[${depth}]`);
      const badge = row.locator('button.chakra-menu__menu-button, button.arrow_box').first();
      if (!(await badge.isVisible({ timeout: 600 }).catch(() => false))) continue;

      const badgeTxt = (await badge.innerText().catch(() => '')).trim();
      console.log(`[SwapPage] expandParentRoute "${parentName}": found badge "${badgeTxt}" at depth ${depth}`);

      // 取 aria-controls 以便精确定位对应 menuList
      menuListId = await badge.getAttribute('aria-controls').catch(() => null);

      // 判断菜单是否已展开：通过 menuListId 对应的列表是否可见
      const menuList = menuListId
        ? dialog.locator(`[id="${menuListId}"]`)
        : dialog.locator('.chakra-menu__menu-list').first();

      const alreadyOpen = await menuList.isVisible({ timeout: 300 }).catch(() => false);
      if (alreadyOpen) {
        console.log(`[SwapPage] expandParentRoute "${parentName}": already expanded`);
        badgeFound = true;
        break;
      }

      await badge.scrollIntoViewIfNeeded().catch(() => undefined);
      await this.page.waitForTimeout(150);
      await badge.click();

      // 等待菜单列表出现，最多 3s
      const expanded = await menuList.waitFor({ state: 'visible', timeout: 3_000 })
        .then(() => true)
        .catch(() => false);

      if (expanded) {
        console.log(`[SwapPage] expandParentRoute "${parentName}": expanded OK`);
        await this.page.waitForTimeout(300);
        badgeFound = true;
        break;
      } else {
        console.warn(`[SwapPage] expandParentRoute "${parentName}": not expanded after click at depth ${depth}`);
      }
    }

    if (!badgeFound) {
      console.warn(`[SwapPage] expandParentRoute "${parentName}": badge not found`);
      return null;
    }

    return menuListId;
  }

  /**
   * 运行时探测弹窗内所有路由的 UI 类型。
   *
   * 扫描弹窗内每个 .chakra-menu__menu-button（下拉 badge），
   * 展开后读取菜单列表内的路由名，建立映射：
   *   路由名 → { type: 'cetus' | 'sub', badgeIndex, menuListId }
   * 未在任何下拉内找到的路由 → type: 'top'（顶级卡片）
   *
   * Cetus 识别：第一个 badge（弹窗内唯一带锁的协议）
   *
   * @returns Map<路由名, 类型信息>
   */
  private async detectRouteLayout(dialog: import('@playwright/test').Locator): Promise<Map<string, { type: 'cetus' | 'sub' | 'top'; menuListId?: string; badgeIndex?: number }>> {
    const layout = new Map<string, { type: 'cetus' | 'sub' | 'top'; menuListId?: string; badgeIndex?: number }>();

    const badges = dialog.locator('button.chakra-menu__menu-button');
    const badgeCount = await badges.count().catch(() => 0);
    console.log(`[detectRouteLayout] found ${badgeCount} badges`);

    for (let i = 0; i < badgeCount; i++) {
      const badge = badges.nth(i);
      const menuListId = await badge.getAttribute('aria-controls').catch(() => null);
      if (!menuListId) continue;

      const menuList = dialog.locator(`[id="${menuListId}"]`);

      // 展开
      const alreadyOpen = await menuList.isVisible({ timeout: 300 }).catch(() => false);
      if (!alreadyOpen) {
        await badge.scrollIntoViewIfNeeded().catch(() => undefined);
        await badge.click();
        const opened = await menuList.waitFor({ state: 'visible', timeout: 3_000 })
          .then(() => true).catch(() => false);
        if (!opened) {
          console.warn(`[detectRouteLayout] badge[${i}] failed to expand`);
          continue;
        }
        await this.page.waitForTimeout(200);
      }

      // 读菜单列表内所有路由名（p.source_name 或直接文字节点）
      const names = await menuList.evaluate((el: Element) => {
        const results: string[] = [];
        // 优先 p.source_name
        el.querySelectorAll<HTMLElement>('p.source_name, p[class*="source_name"]').forEach((p) => {
          const t = (p.textContent ?? '').trim();
          if (t) results.push(t);
        });
        if (results.length > 0) return results;
        // 备用：直接文字节点
        el.querySelectorAll<HTMLElement>('p, span').forEach((p) => {
          const directText = Array.from(p.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => (n.textContent ?? '').trim())
            .join('');
          if (directText) results.push(directText);
        });
        return [...new Set(results)];
      }).catch(() => [] as string[]);

      const routeType = i === 0 ? 'cetus' : 'sub';
      console.log(`[detectRouteLayout] badge[${i}] (${routeType}): ${names.join(', ')}`);

      for (const name of names) {
        if (name) layout.set(name, { type: routeType, menuListId, badgeIndex: i });
      }

      // 收起（避免菜单覆盖后续操作）
      const stillOpen = await menuList.isVisible({ timeout: 300 }).catch(() => false);
      if (stillOpen) {
        await badge.click();
        await this.page.waitForTimeout(200);
      }
    }

    return layout;
  }

  /**
   * 在 Aggregator Settings 弹窗中勾选指定路由。
   *
   * 动态探测策略（不依赖静态父子关系配置）：
   *   1. 调用 detectRouteLayout 扫描弹窗内所有 badge，建立路由名→类型映射
   *   2. 先处理所有在下拉菜单内的路由（按 menuListId 分组，同一菜单一次展开全部勾选）
   *      - Cetus 子路由：每条点 5 次（防误触设计）
   *      - 其他子路由：直接点击
   *   3. 再处理所有顶级卡片路由
   *
   * @param routes 要勾选的路由名称数组
   * @returns 成功勾选的路由数量
   */
  async selectCetusRoutes(routes: string[]): Promise<number> {
    const dialog = this.getAggregatorDialog();
    let selectedCount = 0;
    await this.page.waitForTimeout(300);

    // Step 1: 运行时探测所有路由的 UI 类型（有缓存则复用，badge 数量变化时自动失效）
    const badgeCount = await dialog.locator('button.chakra-menu__menu-button').count().catch(() => 0);
    if (!this.routeLayoutCache || this.routeLayoutCache.badgeCount !== badgeCount) {
      console.log(`[selectCetusRoutes] cache miss (badgeCount=${badgeCount}), scanning layout...`);
      const layout = await this.detectRouteLayout(dialog);
      this.routeLayoutCache = { badgeCount, layout };
    } else {
      console.log(`[selectCetusRoutes] cache hit (badgeCount=${badgeCount})`);
    }
    const layout = this.routeLayoutCache.layout;
    console.log(`[selectCetusRoutes] layout keys: ${[...layout.keys()].join(', ')}`);

    // Step 2: 将目标路由按 badgeIndex 分组（下拉），未匹配的归入顶级
    // 不使用 menuListId 分组，因为 Chakra UI 的 aria-controls 是动态 ID，每次渲染可能变化
    const subGroups = new Map<number, { badgeIndex: number; isCetus: boolean; routes: string[] }>();
    const topRoutes: string[] = [];

    for (const route of routes) {
      const info = layout.get(route);
      if (info && (info.type === 'cetus' || info.type === 'sub') && info.badgeIndex !== undefined) {
        const key = info.badgeIndex;
        if (!subGroups.has(key)) {
          subGroups.set(key, { badgeIndex: key, isCetus: info.type === 'cetus', routes: [] });
        }
        subGroups.get(key)!.routes.push(route);
      } else {
        // 未在任何下拉内找到 → 当顶级卡片处理
        topRoutes.push(route);
      }
    }

    // Step 3: 先处理下拉路由（按 badgeIndex 分组，同一菜单内一次展开处理完）
    // 注意：aria-controls 是 Chakra UI 动态生成的 ID，每次渲染可能变化。
    // 因此不缓存 menuListId，而是通过 badgeIndex 定位 badge，展开时重新读取当前 aria-controls。
    for (const [, group] of subGroups) {
      const allBadges = dialog.locator('button.chakra-menu__menu-button');
      const targetBadge = allBadges.nth(group.badgeIndex ?? 0);

      // 展开时重新读取最新的 aria-controls（ID 可能已变化）
      const currentMenuListId = await targetBadge.getAttribute('aria-controls').catch(() => null);
      const menuList = currentMenuListId
        ? dialog.locator(`[id="${currentMenuListId}"]`)
        : dialog.locator('.chakra-menu__menu-list').nth(group.badgeIndex ?? 0);

      if (group.isCetus) {
        // Cetus：展开一次，在同一次展开内逐条点 5 次
        const alreadyOpen = await menuList.isVisible({ timeout: 300 }).catch(() => false);
        if (!alreadyOpen) {
          await targetBadge.scrollIntoViewIfNeeded().catch(() => undefined);
          await targetBadge.click();
          await menuList.waitFor({ state: 'visible', timeout: 5_000 });
          await this.page.waitForTimeout(600);
        }
        for (const route of group.routes) {
          const ok = await this.toggleCetusSubRouteInMenu(menuList, route as 'CLMM' | 'DLMM' | 'Cetus Tide', 5);
          if (ok) { selectedCount++; console.log(`[selectCetusRoutes] ✓ Cetus sub: ${route}`); }
          else { console.warn(`[selectCetusRoutes] ✗ Cetus sub failed: ${route}`); }
        }
        // 收起
        const stillOpen = await menuList.isVisible({ timeout: 300 }).catch(() => false);
        if (stillOpen) { await targetBadge.click(); await this.page.waitForTimeout(300); }
      } else {
        // 其他下拉：每条路由需要重新展开（Chakra Menu 点击后自动收起），每次重新读 aria-controls
        for (const route of group.routes) {
          const freshMenuListId = await targetBadge.getAttribute('aria-controls').catch(() => null);
          const freshMenuList = freshMenuListId
            ? dialog.locator(`[id="${freshMenuListId}"]`)
            : menuList;
          const open = await freshMenuList.isVisible({ timeout: 300 }).catch(() => false);
          if (!open) {
            await targetBadge.scrollIntoViewIfNeeded().catch(() => undefined);
            await targetBadge.click();
            await freshMenuList.waitFor({ state: 'visible', timeout: 3_000 });
            await this.page.waitForTimeout(300);
          }
          const checked = await this.checkSubRouteItem(dialog, route, 'dynamic', freshMenuListId ?? undefined);
          if (checked) { selectedCount++; console.log(`[selectCetusRoutes] ✓ sub: ${route}`); }
          else { console.warn(`[selectCetusRoutes] ✗ sub failed: ${route}`); }
          await this.page.waitForTimeout(300);
        }
      }
    }

    // Step 4: 处理顶级卡片路由
    for (const route of topRoutes) {
      const checked = await this.checkTopLevelCard(dialog, route);
      if (checked) { selectedCount++; console.log(`[selectCetusRoutes] ✓ top: ${route}`); }
      else { console.warn(`[selectCetusRoutes] ✗ top failed: ${route}`); }
      await this.page.waitForTimeout(150);
    }

    return selectedCount;
  }

  /**
   * 在已展开的 Cetus 菜单列表内，对单条子路由点击 times 次切换状态。
   * 调用方负责展开和收起菜单，本方法只负责点击指定路由的 checkbox。
   * 在同一次展开内可连续调用多条，避免反复开关菜单导致坐标偏移。
   */
  private async toggleCetusSubRouteInMenu(
    menuList: import('@playwright/test').Locator,
    routeName: 'CLMM' | 'DLMM' | 'Cetus Tide',
    times: number = 5,
  ): Promise<boolean> {
    const findCoord = (menuEl: Element, name: string) => {
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
        const c = findIconCoord(row ?? el);
        if (c) return c;
      }
      return null;
    };

    // 初次获取坐标
    const initCoord = await menuList.evaluate(findCoord, routeName).catch(() => null);
    if (!initCoord) {
      console.warn(`[toggleCetusSubRouteInMenu] "${routeName}": coord not found`);
      return false;
    }

    for (let i = 0; i < times; i++) {
      const coord = await menuList.evaluate(findCoord, routeName).catch(() => null) ?? initCoord;
      await this.page.mouse.click(coord.x, coord.y);
      await this.page.waitForTimeout(150);
      console.log(`[toggleCetusSubRouteInMenu] "${routeName}" [${i + 1}/${times}]`);
    }
    return true;
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
   * 优先在 menuListId 对应的菜单列表内精确查找，避免跨菜单误匹配。
   * 兼容父协议子路由数量动态变化（如 Magma 1/1 或 2/2）。
   */
  private async checkSubRouteItem(
    dialog: Locator,
    routeName: string,
    parentName: string,
    menuListId?: string,
  ): Promise<boolean> {
    // 优先在展开的菜单列表内精确匹配（避免跨菜单污染）
    const scope = menuListId
      ? dialog.locator(`[id="${menuListId}"]`)
      : dialog;

    const nameEl = scope.locator('p.source_name').filter({ hasText: routeName }).first();
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

    // 备用：在 scope 内 evaluate 精确文字匹配 + scrollIntoView
    const scopeEl = menuListId
      ? dialog.locator(`[id="${menuListId}"]`)
      : dialog;

    const exactMatch = await scopeEl.evaluate((root: Element, name: string) => {
      const all = Array.from(root.querySelectorAll<HTMLElement>('p, span, div'));
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

  // ─── 订单面板入口（Limit / DCA 共用）────────────────────────────────────────

  /**
   * 返回订单入口图标（widget 头部最右侧的列表按钮）的中心坐标。
   *
   * 交易成功后 Cetus 会重新挂载 widget，popover 的 React id 和 DOM 层级都会变，
   * 因此不能用 popover-trigger id 或固定 ancestor 层级定位。
   *
   * 主策略按视觉位置取 tab 行右侧最靠右的无文字图标按钮（排除带文字的 Pro/Lite），
   * 兜底策略扫描 svg #icon-History 引用名。
   */
  protected async findOrderIconPoint(): Promise<{ x: number; y: number } | null> {
    return (await this.findHeaderTrailingIconPoint()) ?? (await this.findIconPointByRef());
  }

  /**
   * 按视觉位置定位订单入口：以 tab 行（Swap / Limit / DCA / Margin）为锚，
   * 取其右侧同一行内最靠右的"无文字图标按钮"。
   *
   * 不依赖 svg 图标命名，也不依赖 React 生成的 popover id。
   * "Pro" / "Lite" 切换按钮带文字，因此会被过滤掉，不会被误点。
   */
  private async findHeaderTrailingIconPoint(): Promise<{ x: number; y: number } | null> {
    return this.page.evaluate(() => {
      const directText = (el: Element) =>
        Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent ?? '').trim())
          .join('');

      const tabPattern = /^(swap|limit|dca|margin)$/i;
      let anchor: DOMRect | null = null;
      for (const el of Array.from(document.querySelectorAll('p, span, div, a, button'))) {
        if (!tabPattern.test(directText(el))) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        if (!anchor || rect.top < anchor.top) anchor = rect;
      }
      if (!anchor) return null;

      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>('button, [role="button"], div[id^="popover-trigger-"]')
      ).filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 16 || rect.width > 72 || rect.height < 16 || rect.height > 72) return false;
        if (Math.abs(rect.top - anchor!.top) > 40) return false;
        if (rect.left < anchor!.right) return false;
        if ((el.textContent ?? '').trim() !== '') return false;
        return el.querySelector('svg') !== null;
      });
      if (candidates.length === 0) return null;

      const target = candidates.reduce((best, el) =>
        el.getBoundingClientRect().left > best.getBoundingClientRect().left ? el : best
      );
      const rect = target.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }).catch(() => null);
  }

  /** 兜底策略：扫描 svg <use xlink:href="#icon-History"> 取可点击祖先坐标。 */
  private async findIconPointByRef(): Promise<{ x: number; y: number } | null> {
    return this.page
      .evaluate(() => {
        const uses = Array.from(document.querySelectorAll('use'));
        for (const use of uses) {
          const ref =
            (use as SVGUseElement).href?.baseVal ??
            use.getAttribute('xlink:href') ??
            use.getAttribute('href') ??
            '';
          if (!/icon[-_]?History/i.test(ref)) continue;

          let node: Element | null = use.closest('div[id^="popover-trigger-"]') ?? use.closest('svg');
          while (node) {
            const rect = node.getBoundingClientRect();
            if (rect.width >= 8 && rect.height >= 8) {
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            }
            node = node.parentElement;
          }
        }
        return null;
      })
      .catch(() => null);
  }

  /** 等待头部订单图标渲染完成（widget 重新挂载后需要时间）。 */
  protected async waitForOrderIcon(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.findOrderIconPoint()) return true;
      await this.page.waitForTimeout(500);
    }
    console.warn(`[SwapPage] order icon did not render within ${timeoutMs}ms`);
    return false;
  }

  /** 点击订单入口图标；坐标扫描失败时退回按 widget 头部内的 popover 触发器。 */
  protected async clickOrderIcon(widgetLabel: RegExp): Promise<void> {
    const point = await this.findOrderIconPoint();
    if (point) {
      await this.page.mouse.click(point.x, point.y);
      return;
    }

    console.warn('[SwapPage] order icon not found by coordinate scan, falling back to header scan');
    // hasNotText 过滤掉 "Pro" / "Lite" 切换按钮，它们和订单图标同处一行。
    const fallback = this.page
      .getByText(widgetLabel)
      .first()
      .locator('xpath=ancestor::*[self::div or self::section][6]')
      .locator('div[id^="popover-trigger-"]')
      .filter({ hasNotText: /\S/ })
      .last();
    await expect(fallback).toBeVisible({ timeout: 20_000 });
    await fallback.click({ force: true });
  }

  /** 关闭交易成功弹窗，避免它遮挡订单面板入口。 */
  protected async dismissSuccessDialogIfPresent(): Promise<void> {
    const successDialog = this.page
      .locator('[role="dialog"], .chakra-modal__content')
      .filter({ hasText: /transaction completed|order placed|order created|view on explorer|view in explorer/i })
      .last();

    if (!(await successDialog.isVisible().catch(() => false))) {
      return;
    }

    const closeButton = successDialog
      .locator('button, [role="button"]')
      .filter({ hasNotText: /view on explorer|view in explorer|suivision|suiscan/i })
      .last();

    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click({ force: true }).catch(() => undefined);
    }

    if (await successDialog.isVisible().catch(() => false)) {
      await this.page.keyboard.press('Escape').catch(() => undefined);
    }

    if (await successDialog.isVisible().catch(() => false)) {
      await this.page.mouse.click(40, 40);
    }

    await successDialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }
}
