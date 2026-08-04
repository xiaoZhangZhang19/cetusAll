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
      .locator('input[inputmode="decimal"], input[type="number"], input[placeholder="0.0"], input[placeholder="0"]')
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
      .locator('input[inputmode="decimal"], input[type="number"], input[placeholder="0.0"], input[placeholder="0"]')
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
