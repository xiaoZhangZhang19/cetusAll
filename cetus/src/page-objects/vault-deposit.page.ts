import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Page Object for the Cetus Vault "Deposit" flow (stable pool).
 *
 * URL: /vaults
 *
 * Flow:
 *   1. goto()                        → /vaults
 *   2. filterByLst()                 → click the "LST" tab to narrow the list
 *   3. clickDepositForPair(b, q)     → find the target vault row → click "Deposit"
 *   4. waitForDetailPageReady()      → wait for vault detail page to settle
 *   5. fillDepositAmount(amount)     → enter haSUI amount; SUI auto-calculated
 *   6. submitDeposit()               → click detail-page "Deposit" → confirm modal "Deposit"
 *   7. expectDepositSuccess()        → verify "Transaction Completed" visible
 */
export class VaultDepositPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  async goto() {
    await this.page.goto('/vaults', { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle').catch(() => undefined);
    console.log('[VaultDeposit] Navigated to /vaults');
  }

  // ─── Step 1: Filter by LST tab ───────────────────────────────────────────────

  /**
   * Clicks the "LST" filter tab on the Vaults page.
   *
   * The accessibility tree shows the tab as a `group` element containing
   * two images, a "+3" paragraph, and a "LST" paragraph — NOT a button/tab role.
   * Selector strategy: find any clickable container whose text includes "LST"
   * but is NOT the "All Vaults" / "SUI" / "USDC" tab.
   *
   * This step is best-effort: if the tab cannot be found within 8 s we skip it
   * gracefully, since haSUI-SUI is already visible in "All Vaults" view.
   */
  async filterByLst() {
    // The tab renders as a group/div; text content is "LST" (may also contain "+3")
    const lstTab = this.page
      .locator('[role="group"], div, span')
      .filter({ hasText: /LST/ })
      .filter({ hasNotText: /All Vaults|SUI\s*-|USDC/i })
      .first();

    const found = await lstTab.isVisible({ timeout: 8_000 }).catch(() => false);
    if (!found) {
      console.log('[VaultDeposit] LST tab not found — skipping filter, continuing with All Vaults view');
      return;
    }
    await lstTab.click();
    await this.page.waitForTimeout(800);
    console.log('[VaultDeposit] Clicked LST filter tab');
  }

  // ─── Step 2: Click Deposit on the target vault row ───────────────────────────

  /**
   * Finds the vault row whose name contains baseSymbol (e.g. "haSUI"),
   * then clicks its "Deposit" button.
   *
   * The page uses a real <table>; rows are <tr> elements.
   * We match the first <tr> that contains the pair name paragraph text.
   */
  async clickDepositForPair(baseSymbol: string, quoteSymbol: string) {
    console.log(`[VaultDeposit] Looking for vault row: ${baseSymbol}-${quoteSymbol}`);
    await this.page.waitForTimeout(500);

    // Primary: find the table row by paragraph text matching the pair name
    // e.g. paragraph "haSUI - SUI" inside a <td>
    const pairCell = this.page
      .locator('td, [role="cell"]')
      .filter({ hasText: new RegExp(`${baseSymbol}.*${quoteSymbol}|${quoteSymbol}.*${baseSymbol}`, 'i') })
      .first();

    const cellVisible = await pairCell.isVisible({ timeout: 10_000 }).catch(() => false);
    if (cellVisible) {
      // Walk up to the <tr> row, then find its Deposit button
      const row = pairCell.locator('xpath=ancestor::tr[1]');
      const depositBtn = row.getByRole('button', { name: /^deposit$/i }).first();
      if (await depositBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await depositBtn.click();
        console.log(`[VaultDeposit] Clicked Deposit on ${baseSymbol}-${quoteSymbol} row`);
        await this.waitForDetailPageReady();
        return;
      }
    }

    // Fallback: any visible Deposit button in a row containing baseSymbol text
    const rows = this.page.locator('tr').filter({
      has: this.page.locator('td').filter({ hasText: new RegExp(baseSymbol, 'i') }),
    });
    const depositBtn = rows.first().getByRole('button', { name: /^deposit$/i }).first();
    await expect(depositBtn).toBeVisible({ timeout: 10_000 });
    await depositBtn.click();
    console.log(`[VaultDeposit] Clicked Deposit button (fallback row filter)`);
    await this.waitForDetailPageReady();
  }

  // ─── Step 3: Wait for vault detail page ─────────────────────────────────────

  async waitForDetailPageReady() {
    // After clicking Deposit, the page navigates to /vaults/<id>
    // Wait for URL to change away from the list page
    await this.page.waitForURL(/\/vaults\/.+/, { timeout: 20_000 });
    console.log(`[VaultDeposit] Navigated to detail page: ${this.page.url()}`);

    await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);

    // Wait for the amount input to appear
    // The vault detail page renders inputs with placeholder "0.0" (not "0")
    await this.page
      .locator('input[inputmode="decimal"], input[inputmode="numeric"], input[type="number"], input[placeholder="0.0"], input[placeholder="0"]')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });

    // Wait for any loading spinners to clear
    const spinner = this.page.locator('.chakra-spinner, [class*="spinner"], svg[class*="animate-spin"]');
    await spinner.first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    console.log('[VaultDeposit] Detail page ready');
  }

  // ─── Step 4: Fill deposit amount ────────────────────────────────────────────

  /**
   * Fills in the first (haSUI) input field with the given amount.
   * The second (SUI) field auto-calculates.
   */
  async fillDepositAmount(amount: string) {
    const input = this.page
      .locator('input[inputmode="decimal"], input[inputmode="numeric"], input[type="number"], input[placeholder="0.0"], input[placeholder="0"]')
      .first();

    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.click();
    await input.fill('');
    await input.fill(amount);

    // Wait for the paired SUI amount to auto-calculate (spinner may appear)
    const spinner = this.page.locator('.chakra-spinner, [class*="spinner"], svg[class*="animate-spin"]');
    await spinner.first().waitFor({ state: 'visible', timeout: 4_000 }).catch(() => undefined);
    await spinner.first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);

    console.log(`[VaultDeposit] Filled deposit amount: ${amount}`);
  }

  // ─── Step 5: Submit deposit (detail page → confirmation modal) ───────────────

  /**
   * Two-phase submit:
   *   Phase 1 — click the "Deposit" button on the detail page (right panel)
   *   Phase 2 — click the "Deposit" button inside the confirmation modal
   *
   * This entire method is meant to be wrapped in walletController.approveTransactionForAction().
   */
  async submitDeposit() {
    // Phase 1: Click the detail-page Deposit button
    // It lives inside the right panel alongside the amount inputs.
    // Use a more specific selector to avoid hitting nav links.
    const detailDepositBtn = this.page
      .getByRole('button', { name: /^deposit$/i })
      .first();

    await expect(detailDepositBtn).toBeVisible({ timeout: 15_000 });
    await expect(detailDepositBtn).toBeEnabled({ timeout: 10_000 });
    await detailDepositBtn.click();
    console.log('[VaultDeposit] Clicked detail-page Deposit button');

    // Phase 2: Confirmation modal "Deposit" button
    await this.confirmDepositModal();
  }

  /**
   * Handles the confirmation modal that appears after clicking the detail-page Deposit.
   * The modal title is "Deposit" and contains a final "Deposit" button.
   */
  async confirmDepositModal() {
    // Wait for modal to appear — it contains the pair name and token amounts
    const modalDeposit = this.page
      .getByRole('button', { name: /^deposit$/i })
      .last(); // the modal button appears after the detail-page button

    const isVisible = await modalDeposit.isVisible({ timeout: 10_000 }).catch(() => false);
    if (!isVisible) {
      console.log('[VaultDeposit] No confirmation modal appeared — skipping');
      return;
    }

    await expect(modalDeposit).toBeEnabled({ timeout: 10_000 });
    await modalDeposit.click();
    console.log('[VaultDeposit] Clicked modal confirmation Deposit button');
  }

  // ─── Withdraw methods ────────────────────────────────────────────────────────

  /**
   * Switches to the "Withdraw" tab on the vault detail page.
   * After clicking, the panel shows "Remove Amounts" with haSUI + SUI inputs
   * and a percentage slider row.
   */
  async clickWithdrawTab() {
    // The Deposit/Withdraw switcher renders as <p> paragraphs, NOT buttons or tabs.
    // Locate the "Withdraw" paragraph and click it directly.
    const withdrawTab = this.page
      .locator('p, span, div')
      .filter({ hasText: /^Withdraw$/ })
      .first();

    await expect(withdrawTab).toBeVisible({ timeout: 10_000 });
    await withdrawTab.click();
    await this.page.waitForTimeout(600);

    // Wait for "Remove Amounts" label to confirm tab switch
    await this.page.getByText(/remove amounts/i).first()
      .waitFor({ state: 'visible', timeout: 10_000 });

    console.log('[VaultDeposit] Switched to Withdraw tab');
  }

  /**
   * Fills the first (haSUI) input in the Withdraw panel.
   * The SUI amount auto-calculates based on the pool ratio.
   */
  async fillWithdrawAmount(amount: string) {
    const input = this.page
      .locator('input[inputmode="decimal"], input[inputmode="numeric"], input[type="number"], input[placeholder="0.0"], input[placeholder="0"]')
      .first();

    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.click();
    await input.fill('');
    await input.fill(amount);

    // Wait for SUI amount to auto-calculate
    const spinner = this.page.locator('.chakra-spinner, [class*="spinner"], svg[class*="animate-spin"]');
    await spinner.first().waitFor({ state: 'visible', timeout: 4_000 }).catch(() => undefined);
    await spinner.first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);

    // Wait for Withdraw button to become enabled (Total Withdraw > $0)
    await this.page.getByText(/total withdraw/i).first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => undefined);

    console.log(`[VaultDeposit] Filled withdraw amount: ${amount}`);
  }

  /**
   * Clicks the "Withdraw" submit button. No confirmation modal — transaction
   * is submitted directly to the wallet for approval.
   * Wrap in walletController.approveTransactionForAction().
   */
  async submitWithdraw() {
    // The Withdraw submit button is below "Total Withdraw" row.
    // Anchor to "Total Withdraw" text to avoid hitting the tab button.
    const totalWithdraw = this.page.getByText(/total withdraw/i).first();
    const anchorVisible = await totalWithdraw.isVisible({ timeout: 5_000 }).catch(() => false);

    if (anchorVisible) {
      for (const depth of [3, 4, 5, 6]) {
        const panel = totalWithdraw.locator(`xpath=ancestor::div[${depth}]`);
        const withdrawBtn = panel.getByRole('button', { name: /^withdraw$/i }).first();
        if (await withdrawBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await expect(withdrawBtn).toBeEnabled({ timeout: 10_000 });
          await withdrawBtn.click();
          console.log(`[VaultDeposit] Clicked Withdraw submit button (panel depth=${depth})`);
          return;
        }
      }
    }

    // Fallback: last Withdraw button on page (tab is .first(), submit is .last())
    const allBtns = this.page.getByRole('button', { name: /^withdraw$/i });
    const count = await allBtns.count().catch(() => 0);
    const btn = count > 1 ? allBtns.last() : allBtns.first();
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await btn.click();
    console.log('[VaultDeposit] Clicked Withdraw submit button (fallback: last button)');
  }

  // ─── Zap Out methods ─────────────────────────────────────────────────────────

  /**
   * Enables the "Zap Out" toggle on the Withdraw panel.
   * Prerequisite: must have already called clickWithdrawTab().
   * After enabling, the panel shows "haSUI only" / "SUI only" tabs + HALF/MAX buttons.
   */
  async enableZapOut() {
    const zapOutLabel = this.page
      .locator('p, span, div')
      .filter({ hasText: /^Zap\s*Out$/ })
      .first();

    await expect(zapOutLabel).toBeVisible({ timeout: 10_000 });

    for (const depth of [1, 2, 3]) {
      const wrapper = zapOutLabel.locator(`xpath=ancestor::div[${depth}]`);
      const toggle = wrapper.locator(
        '.chakra-switch, [role="switch"], [role="checkbox"][class*="switch"], input[type="checkbox"]'
      ).first();
      if ((await toggle.count().catch(() => 0)) > 0) {
        const isOn =
          (await toggle.getAttribute('aria-checked').catch(() => null)) === 'true' ||
          (await toggle.getAttribute('data-checked').catch(() => null)) !== null ||
          (await toggle.isChecked().catch(() => false));
        if (!isOn) {
          await toggle.click({ force: true });
          await this.page.waitForTimeout(800);
        }
        // Wait for token tabs to appear
        await this.page
          .locator('button, div')
          .filter({ hasText: /haSUI only/i })
          .first()
          .waitFor({ state: 'visible', timeout: 8_000 });
        console.log('[VaultDeposit] Zap Out toggle enabled');
        return;
      }
    }

    // Fallback: click the label row
    await zapOutLabel.locator('xpath=ancestor::div[2]').click();
    await this.page.waitForTimeout(800);
    console.log('[VaultDeposit] Zap Out toggle enabled (fallback)');
  }

  /**
   * Clicks a quick-amount button (HALF or MAX) in the Zap Out panel.
   * These buttons auto-fill the amount and trigger route calculation.
   *
   * @param btn  'HALF' | 'MAX'
   */
  async clickZapOutQuickAmount(btn: 'HALF' | 'MAX') {
    // Wait for "Available 0.xxx" to appear with a non-zero balance before clicking.
    // The HALF/MAX buttons are inert until the balance loads from chain.
    // Strategy: wait for any element whose text matches "Available <non-zero-number>".
    await this.page.waitForSelector(
      '*:has-text("Available")',
      { timeout: 8_000 }
    ).catch(() => undefined);

    // Narrow: confirm the available value is non-zero via a visible locator
    await this.page
      .locator('*')
      .filter({ hasText: /Available\s+0\.[0-9]*[1-9]/ })
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .catch(() => undefined);

    console.log(`[VaultDeposit] Available balance loaded, clicking ${btn}`);

    const quickBtn = this.page
      .getByRole('button', { name: new RegExp(`^${btn}$`, 'i') })
      .first();

    await expect(quickBtn).toBeVisible({ timeout: 8_000 });
    await quickBtn.click();
    console.log(`[VaultDeposit] Clicked ${btn} quick-amount button`);

    // Confirm the input value becomes non-zero after clicking
    const input = this.page
      .locator('input[inputmode="decimal"], input[inputmode="numeric"], input[type="number"], input[placeholder="0.0"], input[placeholder="0"]')
      .first();
    await expect(input).not.toHaveValue('0.0', { timeout: 8_000 });
    await expect(input).not.toHaveValue('', { timeout: 5_000 });

    // Wait for Zap Route calculation to complete
    const spinner = this.page.locator('.chakra-spinner, [class*="spinner"], svg[class*="animate-spin"]');
    await spinner.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    await spinner.first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => undefined);

    // Confirm LP Burn Amount row appears (signals route is ready)
    await this.page.getByText(/lp burn amount/i).first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => undefined);

    console.log(`[VaultDeposit] ${btn} route calculation completed`);
  }

  /**
   * Clicks the "Zap Out" submit button.
   * No confirmation modal — transaction goes directly to wallet.
   * Wrap in walletController.approveTransactionForAction().
   */
  async submitZapOut() {
    // Anchor to "LP Burn Amount" row to avoid hitting the "Zap Out" label/toggle
    const lpBurn = this.page.getByText(/lp burn amount/i).first();
    const anchorVisible = await lpBurn.isVisible({ timeout: 5_000 }).catch(() => false);

    if (anchorVisible) {
      for (const depth of [3, 4, 5, 6]) {
        const panel = lpBurn.locator(`xpath=ancestor::div[${depth}]`);
        const zapOutBtn = panel.getByRole('button', { name: /^zap\s*out$/i }).first();
        if (await zapOutBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await expect(zapOutBtn).toBeEnabled({ timeout: 10_000 });
          await zapOutBtn.click();
          console.log(`[VaultDeposit] Clicked Zap Out submit button (panel depth=${depth})`);
          return;
        }
      }
    }

    // Fallback: last Zap Out button on page
    const allBtns = this.page.getByRole('button', { name: /^zap\s*out$/i });
    const count = await allBtns.count().catch(() => 0);
    const zapOutBtn = count > 1 ? allBtns.last() : allBtns.first();
    await expect(zapOutBtn).toBeVisible({ timeout: 15_000 });
    await expect(zapOutBtn).toBeEnabled({ timeout: 10_000 });
    await zapOutBtn.click();
    console.log('[VaultDeposit] Clicked Zap Out submit button (fallback)');
  }

  // ─── Zap In methods ──────────────────────────────────────────────────────────

  /**
   * Enables the "Zap In" toggle on the vault detail page.
   * After enabling, the panel switches from two-token inputs to a
   * single-token tab UI ("haSUI only" / "SUI only").
   */
  async enableZapIn() {
    // The toggle is a Chakra Switch sibling to the "Zap In" label text.
    // Strategy 1: click the chakra-switch / role="checkbox" near "Zap In" text
    const zapInLabel = this.page
      .locator('span, div, p')
      .filter({ hasText: /^Zap\s*In$/i })
      .first();

    await expect(zapInLabel).toBeVisible({ timeout: 10_000 });

    for (const depth of [1, 2, 3]) {
      const wrapper = zapInLabel.locator(`xpath=ancestor::div[${depth}]`);
      const toggle = wrapper.locator(
        '.chakra-switch, [role="switch"], [role="checkbox"][class*="switch"], input[type="checkbox"]'
      ).first();
      if ((await toggle.count().catch(() => 0)) > 0) {
        const isOn =
          (await toggle.getAttribute('aria-checked').catch(() => null)) === 'true' ||
          (await toggle.getAttribute('data-checked').catch(() => null)) !== null ||
          (await toggle.isChecked().catch(() => false));
        if (!isOn) {
          await toggle.click({ force: true });
          await this.page.waitForTimeout(800);
        }
        console.log('[VaultDeposit] Zap In toggle enabled');

        // Confirm token tabs appeared
        await this.page
          .getByRole('button', { name: /haSUI only/i })
          .or(this.page.locator('button, div').filter({ hasText: /haSUI only/i }))
          .first()
          .waitFor({ state: 'visible', timeout: 8_000 });
        return;
      }
    }

    // Fallback: click the label row directly
    await zapInLabel.locator('xpath=ancestor::div[2]').click();
    await this.page.waitForTimeout(800);
    console.log('[VaultDeposit] Zap In toggle enabled (fallback)');
  }

  /**
   * Selects the single-token tab ("haSUI only" or "SUI only") after Zap In/Out is enabled.
   *
   * The tabs render as <p> paragraphs in Zap Out mode (accessibility tree shows
   * `paragraph: haSUI only` / `paragraph: SUI only`), not as buttons.
   * We try button role first (Zap In mode), then fall back to paragraph/span/div.
   */
  async selectZapToken(token: 'haSUI only' | 'SUI only') {
    const pattern = new RegExp(`^${token}$`, 'i');

    // Try button role first (works in Zap In mode)
    const btnTab = this.page.getByRole('button', { name: pattern }).first();
    if (await btnTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await btnTab.click();
      await this.page.waitForTimeout(400);
      console.log(`[VaultDeposit] Selected Zap token tab (button): ${token}`);
      return;
    }

    // Zap Out mode: tabs are <p> / <span> / <div> paragraphs
    const paraTab = this.page
      .locator('p, span, div')
      .filter({ hasText: pattern })
      .first();

    await expect(paraTab).toBeVisible({ timeout: 10_000 });
    await paraTab.click();
    await this.page.waitForTimeout(400);
    console.log(`[VaultDeposit] Selected Zap token tab (paragraph): ${token}`);
  }

  /**
   * Fills the single-token Zap In input and waits for route calculation.
   */
  async fillZapAmount(amount: string) {
    const input = this.page
      .locator('input[inputmode="decimal"], input[inputmode="numeric"], input[type="number"], input[placeholder="0.0"], input[placeholder="0"]')
      .first();

    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.click();
    await input.fill('');
    await input.fill(amount);

    // Wait for Zap Route calculation
    const spinner = this.page.locator('.chakra-spinner, [class*="spinner"], svg[class*="animate-spin"]');
    await spinner.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    await spinner.first().waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => undefined);

    // Wait for Zap In submit button to become visible (it appears after route calculation)
    // Use "Share of Pool" as anchor — it only shows when the submit button is ready
    await this.page.getByText(/share of pool/i).first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => undefined);

    console.log(`[VaultDeposit] Filled Zap amount: ${amount}`);
  }

  /**
   * Clicks the "Zap In" button then confirms the modal "Deposit" button.
   * Wrap this in walletController.approveTransactionForAction().
   *
   * The submit "Zap In" button is the large blue button at the bottom of the
   * right panel, below "Share of Pool" and "Est. Received LP" rows.
   * We locate it by finding the button AFTER those info rows to avoid
   * accidentally clicking the "Zap In" label/toggle at the top.
   */
  async submitZapIn() {
    // The submit button is inside the right-side deposit panel.
    // Anchor to "Share of Pool" text which only appears in the panel after amount is filled,
    // then walk up to find the containing panel, then get the Zap In button within it.
    const shareOfPool = this.page.getByText(/share of pool/i).first();
    const panelVisible = await shareOfPool.isVisible({ timeout: 10_000 }).catch(() => false);

    if (panelVisible) {
      // Walk up to the panel container and find the Zap In button inside it
      for (const depth of [3, 4, 5, 6]) {
        const panel = shareOfPool.locator(`xpath=ancestor::div[${depth}]`);
        const zapBtn = panel.getByRole('button', { name: /^zap\s*in$/i }).first();
        if (await zapBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await expect(zapBtn).toBeEnabled({ timeout: 10_000 });
          await zapBtn.click();
          console.log(`[VaultDeposit] Clicked Zap In submit button (panel depth=${depth})`);
          await this.confirmDepositModal();
          return;
        }
      }
    }

    // Fallback: get the last Zap In button on page (the submit button is rendered after the label)
    const allZapBtns = this.page.getByRole('button', { name: /^zap\s*in$/i });
    const count = await allZapBtns.count().catch(() => 0);
    const zapBtn = count > 1 ? allZapBtns.last() : allZapBtns.first();
    await expect(zapBtn).toBeVisible({ timeout: 15_000 });
    await expect(zapBtn).toBeEnabled({ timeout: 10_000 });
    await zapBtn.click();
    console.log('[VaultDeposit] Clicked Zap In submit button (fallback: last button)');

    await this.confirmDepositModal();
  }

  /**
   * Closes the "Transaction Completed" success modal by clicking its × button.
   * After closing, the page returns to the vault detail page.
   */
  async closeSuccessModal() {
    // Wait for success modal to be present first
    await this.page.getByText(/transaction completed/i).first()
      .waitFor({ state: 'visible', timeout: 60_000 });

    // Click the × close button (aria-label="Close" or role="button" with ×)
    const closeBtn = this.page
      .locator('[aria-label="Close"], button[class*="close"], button')
      .filter({ hasText: /^[×✕x]$/i })
      .first();

    const chakraClose = this.page.locator('.chakra-modal__close-btn, [data-testid="modal-close"]').first();

    if (await chakraClose.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await chakraClose.click();
    } else if (await closeBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await closeBtn.click();
    } else {
      // Fallback: press Escape
      await this.page.keyboard.press('Escape');
    }

    // Wait for modal to disappear
    await this.page.getByText(/transaction completed/i).first()
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .catch(() => undefined);

    await this.page.waitForTimeout(600);
    console.log('[VaultDeposit] Success modal closed');
  }

  // ─── Step 6: Assert success ──────────────────────────────────────────────────

  async expectDepositSuccess() {
    const successText = this.page
      .getByText(/transaction completed/i)
      .first();
    await expect(successText).toBeVisible({ timeout: 60_000 });
    console.log('[VaultDeposit] ✓ Vault Deposit transaction completed successfully');
  }

  /**
   * Reads the transaction digest from the explorer link in the success modal.
   */
  async readDigest(): Promise<string | undefined> {
    const explorerLink = this.page
      .locator('a[href*="suiscan"], a[href*="suivision"], a[href*="explorer"]')
      .first();

    if (await explorerLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const href = (await explorerLink.getAttribute('href')) ?? '';
      const match =
        href.match(/\/tx(?:block)?\/([1-9A-HJ-NP-Za-km-z]{40,90})/)?.[1] ??
        href.match(/transaction\/([1-9A-HJ-NP-Za-km-z]{40,90})/)?.[1];
      if (match) return match;
    }

    const bodyText = await this.page.locator('body').innerText().catch(() => '');
    return bodyText.match(/[1-9A-HJ-NP-Za-km-z]{43,90}/)?.[0];
  }
}
