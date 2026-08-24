/**
 * Test: Limit page UI interactions — all 5 scenarios in one test.
 *
 * 1. 页面初始状态  — default tokens, rate, expiry, button, empty orders
 * 2. 余额展示      — UI balance matches chain balance (USDC + SUI)
 * 3. HALF / MAX   — fill half/max balance, You Receive updates
 * 4. Token 切换   — swap direction arrow swaps pair, rate refreshes
 * 5. Expires in   — dropdown contains all options, selection reflects correctly
 */

import { env } from '@/config/env.js';
import { COIN_TYPES } from '@/fixtures/scenarios.js';
import { LimitPage } from '@/page-objects/limit.page.js';
import { getBalanceSnapshot } from '@/chain/queries.js';
import { calcSuiAmountForFiveDollars, getSuiPriceUsd } from '@/chain/price.js';

import { expect, test } from '../setup/fixtures.js';

/** Read the balance number displayed next to HALF/MAX in the given direction panel. */
async function readUiPanelBalance(limitPage: LimitPage, direction: 'from' | 'to'): Promise<number> {
  // Try multiple depths — Cetus renders balance text at varying depths
  for (const depth of [2, 3, 4, 5]) {
    const section = limitPage.findSwapSection(direction, depth);
    const raw = await section.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const text = node.textContent?.trim() ?? '';
        // Match positive decimals like "5.4142" or "0.0" but not plain "0"
        if (/^\d+\.\d+$/.test(text)) return text;
      }
      return '';
    }).catch(() => '');
    const val = parseFloat(raw.replace(/,/g, ''));
    if (!isNaN(val) && val > 0) return val;
  }
  return 0;
}

/** Read the current token symbol shown in the given direction panel. */
async function readPanelToken(limitPage: LimitPage, direction: 'from' | 'to'): Promise<string> {
  // Try multiple ancestor depths — Cetus renders panels at different depths
  for (const depth of [2, 3, 4, 5]) {
    const section = limitPage.findSwapSection(direction, depth);
    const buttons = section.locator('button');
    const count = await buttons.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      if (!(await btn.isVisible({ timeout: 300 }).catch(() => false))) continue;
      const text = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      // Skip action buttons
      if (/^(half|max|buy|sell|swap|limit|dca|margin|merge|pro|lite|connect|confirm|enter|market)$/i.test(text)) continue;
      if (/switch to|mode/i.test(text)) continue;
      // Token names are 2–12 uppercase chars (e.g. SUI, USDC, CETUS)
      const clean = text.replace(/[▼▽⌄↓\s→←]/g, '');
      if (/^[A-Z0-9]{2,12}$/.test(clean)) return clean;
    }
  }
  return '';
}

test.describe('Cetus Mainnet Limit Page — UI Interactions', () => {
  test('verifies all UI interactions: initial state, balance, HALF/MAX, token swap, expiry dropdown', async ({
    page,
    walletController,
  }) => {
    const limitPage = new LimitPage(page);
    await limitPage.goto();
    await walletController.connect(page);

    // Wait for page to stabilise after wallet reconnects and reloads
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await limitPage.dismissTermsModalIfPresent();
    // Ensure "You Pay" label is visible before reading any UI elements
    await page.getByText(/^you pay$/i).first().waitFor({ state: 'visible', timeout: 15_000 });

    // ════════════════════════════════════════════════════════════════════════
    // Section 1: 页面初始状态
    // ════════════════════════════════════════════════════════════════════════
    console.log('[limit-ui:e2e] ── Section 1: 页面初始状态 ──');

    // 1-a. Default token pair: You Pay = USDC, You Receive = SUI
    const defaultFromToken = await readPanelToken(limitPage, 'from');
    const defaultToToken   = await readPanelToken(limitPage, 'to');
    console.log(`[limit-ui:e2e] You Pay token    : ${defaultFromToken}`);
    console.log(`[limit-ui:e2e] You Receive token: ${defaultToToken}`);
    expect(defaultFromToken).toMatch(/^(USDC|SUI)$/);
    expect(defaultToToken).toMatch(/^(SUI|USDC)$/);
    expect(defaultFromToken).not.toBe(defaultToToken);

    // 1-b. "Market" tag is visible in the rate section
    const marketTag = page.locator('button, div, span').filter({ hasText: /^market$/i }).first();
    await expect(marketTag).toBeVisible({ timeout: 5_000 });
    console.log('[limit-ui:e2e] "Market" tag     : visible ✓');

    // 1-c. Rate field shows a positive number (it renders empty while loading)
    const rateInput = await limitPage.findRatePriceInput().catch(() => null);
    if (rateInput) {
      await expect
        .poll(async () => parseFloat((await rateInput.inputValue()).replace(/,/g, '')), {
          timeout: 30_000,
        })
        .toBeGreaterThan(0);
      console.log(`[limit-ui:e2e] rate value       : ${await rateInput.inputValue()}`);
    }

    // 1-d. "Expires in" defaults to "7 Days"
    // The value ("7 Days") is in a sibling element of the label.
    // Walk up from the label until we find an ancestor that also contains
    // the duration text, then extract it.
    let expiresText = '';
    const expiresLabel = page.getByText(/^expires in$/i).first();
    for (const depth of [2, 3, 4, 5]) {
      const container = expiresLabel.locator(`xpath=ancestor::*[self::div][${depth}]`);
      const raw = await container.innerText().catch(() => '');
      const match = raw.match(/(\d+\s*(?:days?|minutes?|hours?|months?))/i);
      if (match) {
        expiresText = match[1].trim();
        break;
      }
    }
    // Fallback: look for the dropdown trigger element directly
    if (!expiresText) {
      const dropdownTrigger = page
        .locator('div, button, span, [role="button"]')
        .filter({ hasText: /^(?:\d+\s*(?:days?|minutes?|hours?|months?)|1m)$/i })
        .first();
      expiresText = (await dropdownTrigger.innerText().catch(() => '')).trim();
    }
    console.log(`[limit-ui:e2e] Expires in       : "${expiresText}"`);
    expect(expiresText).toMatch(/7\s*days?/i);

    // 1-e. Submit button shows "Enter an amount" and is disabled (wallet connected, no amount)
    const enterAmountBtn = page
      .locator('button, [role="button"]')
      .filter({ hasText: /enter an amount/i })
      .first();
    await expect(enterAmountBtn).toBeVisible({ timeout: 5_000 });
    await expect(enterAmountBtn).toBeDisabled();
    console.log('[limit-ui:e2e] submit button    : "Enter an amount" disabled ✓');

    // 1-f. Open Orders renders either existing orders or the empty state.
    // openOrdersPanel() already waits out the loading skeletons.
    await limitPage.openOrdersPanel();
    const hasOrders = await limitPage.waitForOpenOrdersLoaded();
    if (hasOrders) {
      await expect(page.getByRole('button', { name: /^cancel$/i }).first()).toBeVisible();
      console.log('[limit-ui:e2e] Open Orders      : has existing orders ✓');
    } else {
      await expect(page.getByText(/you don't have any open orders yet/i).first()).toBeVisible({
        timeout: 5_000,
      });
      console.log('[limit-ui:e2e] Open Orders      : empty state text visible ✓');
    }
    // Close panel
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(400);

    // ════════════════════════════════════════════════════════════════════════
    // Section 2: 余额展示
    // ════════════════════════════════════════════════════════════════════════
    console.log('[limit-ui:e2e] ── Section 2: 余额展示 ──');

    // Determine which coin type is in each panel based on detected token symbol
    const fromCoinType = defaultFromToken === 'USDC' ? COIN_TYPES.USDC : COIN_TYPES.SUI;
    const toCoinType   = defaultToToken   === 'SUI'  ? COIN_TYPES.SUI  : COIN_TYPES.USDC;
    const fromDecimals = fromCoinType === COIN_TYPES.SUI ? 9 : 6;
    const toDecimals   = toCoinType   === COIN_TYPES.SUI ? 9 : 6;

    const [chainFrom, chainTo] = await Promise.all([
      getBalanceSnapshot(env.testWalletAddress, fromCoinType),
      getBalanceSnapshot(env.testWalletAddress, toCoinType),
    ]);
    const chainFromSui = Number(chainFrom.totalBalance) / 10 ** fromDecimals;
    const chainToSui   = Number(chainTo.totalBalance)   / 10 ** toDecimals;

    const uiFromBalance = await readUiPanelBalance(limitPage, 'from');
    const uiToBalance   = await readUiPanelBalance(limitPage, 'to');

    console.log(`[limit-ui:e2e] You Pay balance  : UI=${uiFromBalance.toFixed(4)}  chain=${chainFromSui.toFixed(4)} (${defaultFromToken})`);
    console.log(`[limit-ui:e2e] You Recv balance : UI=${uiToBalance.toFixed(4)}  chain=${chainToSui.toFixed(4)}   (${defaultToToken})`);

    // UI balance should be within 0.1% of chain balance (rounding only)
    if (uiFromBalance > 0 && chainFromSui > 0) {
      const fromDiff = Math.abs(uiFromBalance - chainFromSui) / chainFromSui;
      expect(fromDiff, 'You Pay UI balance must match chain balance within 0.1%').toBeLessThan(0.001);
      console.log('[limit-ui:e2e] You Pay balance  : matches chain ✓');
    }
    if (uiToBalance > 0 && chainToSui > 0) {
      const toDiff = Math.abs(uiToBalance - chainToSui) / chainToSui;
      expect(toDiff, 'You Receive UI balance must match chain balance within 0.1%').toBeLessThan(0.001);
      console.log('[limit-ui:e2e] You Recv balance : matches chain ✓');
    }

    // ════════════════════════════════════════════════════════════════════════
    // Section 3: HALF / MAX 按钮
    // ════════════════════════════════════════════════════════════════════════
    console.log('[limit-ui:e2e] ── Section 3: HALF / MAX ──');

    // HALF/MAX require a non-zero "You Pay" balance.
    // If the current "You Pay" token has 0 balance (e.g. wallet holds no USDC),
    // click the swap arrow so the token with a real balance (SUI) moves to "You Pay".
    let halfMaxFromBalance = chainFromSui;
    let halfMaxFromToken   = defaultFromToken;

    if (chainFromSui === 0) {
      console.log(`[limit-ui:e2e] You Pay (${defaultFromToken}) balance = 0 — selecting SUI as You Pay`);
      // Use selectFromToken to explicitly put SUI in "You Pay"
      await limitPage.selectFromToken(COIN_TYPES.SUI);
      await page.waitForTimeout(800);
      halfMaxFromToken   = 'SUI';
      halfMaxFromBalance = chainToSui;
    }

    // Compute a valid order amount: ceil($5 / SUI price) — ensures we meet the
    // $5 minimum order size so "You Receive" actually calculates a non-zero value.
    const suiPrice = await getSuiPriceUsd();
    const validAmount = await calcSuiAmountForFiveDollars();
    console.log(`[limit-ui:e2e] SUI price (Pyth)  : $${suiPrice.toFixed(4)}`);
    console.log(`[limit-ui:e2e] HALF/MAX on        : ${halfMaxFromToken} (balance=${halfMaxFromBalance.toFixed(4)})`);
    console.log(`[limit-ui:e2e] valid order amount : ${validAmount} SUI (≥ $5)`);

    const halfBtn = page.getByRole('button', { name: /^half$/i }).first();
    const maxBtn  = page.getByRole('button', { name: /^max$/i  }).first();

    // ── Test HALF button: verify it fills balance / 2 ────────────────────────
    await halfBtn.click();
    await page.waitForTimeout(600);
    const afterHalfRaw = (await limitPage.inputAmount.inputValue()).replace(/,/g, '');
    const afterHalf = parseFloat(afterHalfRaw);
    const expectedHalf = halfMaxFromBalance / 2;
    console.log(`[limit-ui:e2e] HALF value         : ${afterHalf.toFixed(6)} (expected ≈ ${expectedHalf.toFixed(6)})`);
    if (expectedHalf > 0) {
      expect(
        Math.abs(afterHalf - expectedHalf) / expectedHalf,
        'HALF must be within 1% of balance / 2'
      ).toBeLessThan(0.01);
    }
    console.log('[limit-ui:e2e] HALF               : ≈ balance / 2 ✓');

    // ── Test MAX button: verify it fills full balance ─────────────────────────
    await maxBtn.click();
    await page.waitForTimeout(600);
    const afterMaxRaw = (await limitPage.inputAmount.inputValue()).replace(/,/g, '');
    const afterMax = parseFloat(afterMaxRaw);
    console.log(`[limit-ui:e2e] MAX value          : ${afterMax.toFixed(6)} (expected ≈ ${halfMaxFromBalance.toFixed(6)})`);
    if (halfMaxFromBalance > 0) {
      expect(
        Math.abs(afterMax - halfMaxFromBalance) / halfMaxFromBalance,
        'MAX must be within 1% of full balance'
      ).toBeLessThan(0.01);
    }
    console.log('[limit-ui:e2e] MAX                : ≈ full balance ✓');

    // ── You Receive联动: 用 ceil($5/price) 填入，确保超过最小订单金额 ──────────
    // HALF/MAX may produce < $5 (Cetus minimum), so we use a guaranteed-valid
    // amount to verify the "You Receive" field actually calculates.
    // Use fillAmount() (which uses getAmountInput() + proper focus/blur) so
    // the UI reacts and recalculates the receive value.
    await limitPage.fillAmount(validAmount);
    // Wait for the rate-based calculation to settle (Cetus updates asynchronously)
    await page.waitForTimeout(1_500);

    // Read the "You Receive" amount directly via DOM evaluation.
    // Playwright's section-based filter misses Cetus's receive-amount element;
    // DOM eval finds the first leaf-level number with 4+ decimals that is > 0.
    const receiveAfterValid = await page.evaluate(() => {
      const walk = (root: Element): string => {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (el.children.length > 0) continue; // leaf nodes only
          const text = (el.textContent ?? '').trim();
          if (/^\d+\.\d{4,}$/.test(text)) {
            const num = parseFloat(text);
            if (num > 0.01 && num < 1_000_000) return text;
          }
        }
        return '';
      };
      // Scope to "You Receive" panel
      const label = Array.from(document.querySelectorAll('*')).find(
        el => /^you receive$/i.test(el.textContent?.trim() ?? '') && el.children.length === 0
      );
      if (label) {
        let container = label.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!container) break;
          const result = walk(container);
          if (result) return result;
          container = container.parentElement;
        }
      }
      // Fallback: search the whole page
      return walk(document.body);
    });

    const receiveNumValid = parseFloat((receiveAfterValid ?? '').replace(/,/g, ''));
    console.log(`[limit-ui:e2e] You Receive (${validAmount} SUI): ${receiveAfterValid}`);
    expect(isNaN(receiveNumValid) ? 0 : receiveNumValid, 'You Receive must update when amount ≥ $5').toBeGreaterThan(0);
    console.log('[limit-ui:e2e] You Receive联动     : ✓');

    // Clear the amount input for next sections
    await limitPage.fillAmount('');
    await page.waitForTimeout(300);

    // ════════════════════════════════════════════════════════════════════════
    // Section 4: Token 切换
    // ════════════════════════════════════════════════════════════════════════
    console.log('[limit-ui:e2e] ── Section 4: Token 切换 ──');

    // Read current state (may be SUI→USDC if HALF/MAX swapped earlier)
    const beforeSwapFrom = await readPanelToken(limitPage, 'from');
    const beforeSwapTo   = await readPanelToken(limitPage, 'to');
    const rateBeforeSwap = rateInput
      ? parseFloat((await rateInput.inputValue().catch(() => '0')).replace(/,/g, ''))
      : 0;
    console.log(`[limit-ui:e2e] before swap      : Pay=${beforeSwapFrom}, Recv=${beforeSwapTo}, rate=${rateBeforeSwap.toFixed(6)}`);

    // Determine target pair (reverse of current)
    const targetFrom = beforeSwapTo;   // e.g. SUI → becomes You Pay
    const targetTo   = beforeSwapFrom; // e.g. USDC → becomes You Receive
    const targetFromCoinType = targetFrom === 'SUI' ? COIN_TYPES.SUI : COIN_TYPES.USDC;
    const targetToCoinType   = targetTo   === 'SUI' ? COIN_TYPES.SUI : COIN_TYPES.USDC;

    // Use selectFromToken / selectToToken for a reliable token swap
    await limitPage.selectFromToken(targetFromCoinType);
    await page.waitForTimeout(500);
    await limitPage.selectToToken(targetToCoinType);
    await page.waitForTimeout(800);

    const afterSwapFrom = await readPanelToken(limitPage, 'from');
    const afterSwapTo   = await readPanelToken(limitPage, 'to');
    const rateAfterSwap = rateInput
      ? parseFloat((await rateInput.inputValue().catch(() => '0')).replace(/,/g, ''))
      : 0;
    console.log(`[limit-ui:e2e] after swap       : Pay=${afterSwapFrom}, Recv=${afterSwapTo}, rate=${rateAfterSwap.toFixed(6)}`);

    // Tokens must be reversed
    expect(afterSwapFrom, 'After swap, You Pay must equal the old You Receive').toBe(beforeSwapTo);
    expect(afterSwapTo,   'After swap, You Receive must equal the old You Pay').toBe(beforeSwapFrom);
    console.log('[limit-ui:e2e] token swap       : pair correctly reversed ✓');

    // Rate must update (different value after swap)
    if (rateBeforeSwap > 0 && rateAfterSwap > 0) {
      expect(rateAfterSwap).not.toBeCloseTo(rateBeforeSwap, 2);
      console.log('[limit-ui:e2e] rate after swap  : updated ✓');
    }

    // ════════════════════════════════════════════════════════════════════════
    // Section 5: Expires in 下拉选项
    // ════════════════════════════════════════════════════════════════════════
    console.log('[limit-ui:e2e] ── Section 5: Expires in 下拉 ──');

    const EXPECTED_OPTIONS = [
      /5\s*minutes?/i,
      /10\s*minutes?/i,
      /30\s*minutes?/i,
      /1\s*hours?/i,
      /1\s*days?/i,
      /3\s*days?/i,
      /7\s*days?/i,
      /1\s*months?/i,
      /custom/i,
    ];

    // Open the Expires in dropdown
    const expiryDropdownTrigger = page
      .locator('button, div, [role="button"]')
      .filter({ hasText: /\d+\s*(days?|minutes?|hours?|month)/i })
      .last();
    await expiryDropdownTrigger.click();

    // Options render as role="menuitem" buttons inside a chakra menu portal.
    // Scoping to the open menu matters: a generic "div" selector also matches the
    // hidden portal wrappers that appear earlier in the DOM, and .first() would
    // resolve to one of those instead of the visible option.
    const expiryMenu = page.locator('[role="menu"]').filter({ hasText: /minutes|hour|day|month/i }).last();
    await expect(expiryMenu).toBeVisible({ timeout: 5_000 });

    // Verify all expected options are present
    for (const optionPattern of EXPECTED_OPTIONS) {
      const option = expiryMenu.getByRole('menuitem', { name: optionPattern }).first();
      const visible = await option.isVisible({ timeout: 3_000 }).catch(() => false);
      console.log(`[limit-ui:e2e] dropdown option  : "${optionPattern.source}" — ${visible ? 'visible ✓' : 'NOT FOUND ✗'}`);
      expect(visible, `Dropdown option "${optionPattern.source}" must be visible`).toBe(true);
    }

    // Select "1 Day" and verify
    await expiryMenu.getByRole('menuitem', { name: /^1\s*days?$/i }).click();
    await expect(expiryMenu).toBeHidden({ timeout: 5_000 });
    const afterOneDayText = await expiryDropdownTrigger.innerText().catch(() => '');
    console.log(`[limit-ui:e2e] selected "1 Day"  : trigger shows "${afterOneDayText.trim()}"`);
    expect(afterOneDayText).toMatch(/1\s*days?/i);
    console.log('[limit-ui:e2e] 1 Day selection  : ✓');

    // Re-open and select "7 Days" (restore default)
    await expiryDropdownTrigger.click();
    await expect(expiryMenu).toBeVisible({ timeout: 5_000 });
    await expiryMenu.getByRole('menuitem', { name: /^7\s*days?$/i }).click();
    await expect(expiryMenu).toBeHidden({ timeout: 5_000 });
    const afterSevenDaysText = await expiryDropdownTrigger.innerText().catch(() => '');
    console.log(`[limit-ui:e2e] selected "7 Days" : trigger shows "${afterSevenDaysText.trim()}"`);
    expect(afterSevenDaysText).toMatch(/7\s*days?/i);
    console.log('[limit-ui:e2e] 7 Days selection : ✓ (default restored)');

    console.log('[limit-ui:e2e] ── All sections passed ──');
  });
});
