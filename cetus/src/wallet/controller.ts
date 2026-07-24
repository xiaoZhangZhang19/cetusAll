import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { env } from '@/config/env.js';

export interface WalletController {
  connect(page: Page): Promise<void>;
  approveTransaction(page: Page): Promise<void>;
  approveTransactionForAction(page: Page, action: () => Promise<void>): Promise<void>;
}

export class ExtensionWalletController implements WalletController {
  async connect(page: Page): Promise<void> {
    await this.tryUnlockExtension(page);
    // After unlock the extension re-injects its provider; reload the Cetus page so it
    // detects the wallet correctly (avoids the "extension not found → open slush.app" fallback).
    await page.reload({ waitUntil: 'networkidle' }).catch(() => undefined);
    await this.dismissCetusTermsIfPresent(page);
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // Cetus truncates the connected address as "0xABCD…WXYZ". Only the first 6
    // characters ("0x" + 4 hex digits) appear before the ellipsis, so we must
    // use at most 6 chars to reliably detect the connected state.
    const addrPrefix = env.testWalletAddress.slice(0, 6);
    const connectedAddress = page.getByText(new RegExp(addrPrefix, 'i')).first();
    if (await connectedAddress.isVisible().catch(() => false)) {
      return;
    }

    const connectButton = this.getConnectButton(page);

    // Short-circuit: if the connect button is not visible within 5 s, the wallet
    // is already connected (e.g. the page shows a different button state).
    const connectVisible = await connectButton.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!connectVisible) {
      return;
    }

    // Wait a bit longer for the button to stabilise before clicking.
    try {
      await expect(connectButton).toBeVisible({ timeout: 20_000 });
    } catch (error) {
      const visibleButtons = await page
        .locator('button, [role="button"]')
        .evaluateAll((elements) =>
          elements
            .map((element) => (element.textContent || '').trim())
            .filter(Boolean)
            .slice(0, 30)
        )
        .catch(() => []);

      throw new Error(`Cetus connect button not found. Visible button texts: ${JSON.stringify(visibleButtons)}`, {
        cause: error
      });
    }

    await this.withOptionalWalletPopup(page, async () => {
      await connectButton.click();
      await this.selectWalletFromCetusModal(page);
    });

    // Ensure Cetus connect modal is gone before interacting with swap form.
    await this.selectWalletFromCetusModal(page);
  }

  async approveTransaction(page: Page): Promise<void> {
    await this.withOptionalWalletPopup(page, async () => {
      await page.waitForTimeout(500);
    });
  }

  /**
   * Rejects a pending transaction in the wallet popup.
   * Useful for testing user rejection scenarios.
   */
  async rejectTransaction(page: Page): Promise<void> {
    const context = page.context();
    const pagesBeforeAction = new Set(context.pages());
    // Wallet popup may appear late when extension is cold-starting.
    const popupPromise = context.waitForEvent('page', { timeout: 30_000 }).catch(() => undefined);

    // Wait for popup to appear
    await page.waitForTimeout(500);

    let popup = await popupPromise;

    // Cetus may open slush.app even when extension pages are also present.
    // Treat slush.app as noise and continue searching for a real extension page.
    if (popup && (popup.url().includes('slush.app') || popup.url().startsWith('https://slush'))) {
      await popup.close().catch(() => undefined);
      popup = undefined;
    }

    popup = await this.waitForActionableExtensionPage(page, pagesBeforeAction, popup);
    if (!popup) {
      await page.bringToFront().catch(() => undefined);
      return;
    }

    await popup.waitForLoadState('domcontentloaded').catch(() => undefined);
    await this.unlockWalletPageIfNeeded(popup);
    await this.clickWalletRejectionButton(popup);
    await popup.waitForEvent('close', { timeout: 20_000 }).catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
  }

  async approveTransactionForAction(page: Page, action: () => Promise<void>): Promise<void> {
    await this.withOptionalWalletPopup(page, action);
  }

  private async tryUnlockExtension(page: Page) {
    if (!env.walletPassword) {
      return;
    }

    // Unlock any extension pages that are already open (e.g. a background popup tab).
    for (const extensionPage of page.context().pages().filter((candidate) => this.isExtensionPage(candidate))) {
      await this.unlockWalletPageIfNeeded(extensionPage);
    }

    // Proactively open the extension popup so it can be unlocked.
    // The extension popup is never opened automatically by Playwright; without this step
    // the wallet stays locked and cannot inject its provider into DApp pages, causing
    // Cetus to fall back to opening the slush.app website.
    const extId = this.extractExtensionId(env.walletExtensionPath);
    if (extId) {
      const popupPage = await page.context().newPage();
      try {
        const popupUrl = `chrome-extension://${extId}/index.html`;
        await popupPage.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await this.unlockWalletPageIfNeeded(popupPage);
        // Give the extension a moment to re-inject its provider into existing tabs after unlock.
        await popupPage.waitForTimeout(1_500);
      } catch {
        // Extension popup may not be reachable in some environments; proceed anyway.
      } finally {
        await popupPage.close().catch(() => undefined);
      }
    }

    // Bring main test page back to front after interacting with extension pages.
    await page.bringToFront().catch(() => undefined);
  }

  /** Extracts the 32-character extension ID from a WALLET_EXTENSION_PATH value.
   *  Path format: …/Extensions/{extensionId}/{version}/ */
  private extractExtensionId(extensionPath?: string): string | undefined {
    if (!extensionPath) return undefined;
    const match = extensionPath.match(/[/\\]([a-z]{32})[/\\]/i);
    return match?.[1];
  }

  private isExtensionPage(page: Page) {
    return page.url().startsWith('chrome-extension://');
  }

  private async withOptionalWalletPopup(page: Page, action: () => Promise<void>) {
    const context = page.context();
    const pagesBeforeAction = new Set(context.pages());
    // Wallet popup may appear late when extension is cold-starting.
    const popupPromise = context.waitForEvent('page', { timeout: 30_000 }).catch(() => undefined);

    await action();

    let popup = await popupPromise;

    // Cetus may open slush.app even when extension pages are also present.
    // Treat slush.app as noise and continue searching for a real extension page.
    if (popup && (popup.url().includes('slush.app') || popup.url().startsWith('https://slush'))) {
      await popup.close().catch(() => undefined);
      popup = undefined;
    }

    popup = await this.waitForActionableExtensionPage(page, pagesBeforeAction, popup);
    if (!popup) {
      await page.bringToFront().catch(() => undefined);
      return;
    }

    await popup.waitForLoadState('domcontentloaded').catch(() => undefined);
    await this.unlockWalletPageIfNeeded(popup);
    await this.clickWalletApprovalButton(popup);
    await popup.waitForEvent('close', { timeout: 20_000 }).catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
  }

  private async clickWalletApprovalButton(walletPage: Page) {
    let activePage = walletPage;
    await activePage.bringToFront().catch(() => undefined);
    await activePage.waitForLoadState('domcontentloaded').catch(() => undefined);

    // The extension may present an "Unlock wallet" overlay before/after clicking Approve.
    // Keep looping through unlock -> approve until popup closes or timeout.
    for (let attempt = 0; attempt < 25; attempt++) {
      if (activePage.isClosed()) {
        return;
      }

      // If we are stuck on a loading/splash extension page, switch to any sibling
      // extension page that already has unlock/approve controls.
      const bestPage = await this.findBestExtensionActionPage(activePage);
      if (bestPage) {
        activePage = bestPage;
      }

      await this.unlockWalletPageIfNeeded(activePage);
      const stillLocked = await this.hasUnlockControls(activePage);
      if (stillLocked) {
        const alive = await this.waitIfOpen(activePage, 800);
        if (!alive) return;
        continue;
      }

      const slushPrimaryButton = activePage
        .getByRole('button', {
          name: /connect|approve|confirm|sign|sign and execute|approve transaction|accept|allow/i
        })
        .filter({ hasNotText: /reject|cancel|deny|disconnect/i })
        .last();

      const visible = await slushPrimaryButton.isVisible({ timeout: 5_000 }).catch(() => false);
      if (visible) {
        const enabled = await slushPrimaryButton.isEnabled().catch(() => false);
        if (!enabled) {
          await this.unlockWalletPageIfNeeded(activePage);
          const alive = await this.waitIfOpen(activePage, 700);
          if (!alive) return;
          continue;
        }
        await slushPrimaryButton.click();
        // If a lock modal appears right after approve click, handle it in next loop round.
        const alive = await this.waitIfOpen(activePage, 600);
        if (!alive) return;
        continue;
      }

      const fallbackButton = activePage
        .locator('button')
        .filter({ hasText: /connect|approve|confirm|sign|allow/i })
        .filter({ hasNotText: /reject|cancel|deny|disconnect/i })
        .last();
      if (await fallbackButton.isVisible({ timeout: 4_000 }).catch(() => false)) {
        await fallbackButton.click();
        const alive = await this.waitIfOpen(activePage, 600);
        if (!alive) return;
        continue;
      }

      // If no controls are visible yet, keep waiting on the same page instead of
      // force-reloading; aggressive reload can cause visible popup flicker loops.
      const alive = await this.waitIfOpen(activePage, 1_200);
      if (!alive) return;
    }

    throw new Error('Wallet approval button was not found after unlock retries.');
  }

  /**
   * Clicks the reject/cancel button in the wallet popup.
   * Used for testing user rejection scenarios.
   */
  private async clickWalletRejectionButton(walletPage: Page) {
    let activePage = walletPage;
    await activePage.bringToFront().catch(() => undefined);
    await activePage.waitForLoadState('domcontentloaded').catch(() => undefined);

    // Keep looping to find and click reject button
    for (let attempt = 0; attempt < 25; attempt++) {
      if (activePage.isClosed()) {
        return;
      }

      // Find best extension page if stuck on loading
      const bestPage = await this.findBestExtensionActionPage(activePage);
      if (bestPage) {
        activePage = bestPage;
      }

      await this.unlockWalletPageIfNeeded(activePage);
      const stillLocked = await this.hasUnlockControls(activePage);
      if (stillLocked) {
        const alive = await this.waitIfOpen(activePage, 800);
        if (!alive) return;
        continue;
      }

      // Try to find reject/cancel/deny button
      const rejectButton = activePage
        .getByRole('button', {
          name: /reject|cancel|deny|decline/i
        })
        .first();

      const visible = await rejectButton.isVisible({ timeout: 5_000 }).catch(() => false);
      if (visible) {
        const enabled = await rejectButton.isEnabled().catch(() => false);
        if (!enabled) {
          const alive = await this.waitIfOpen(activePage, 700);
          if (!alive) return;
          continue;
        }
        await rejectButton.click();
        const alive = await this.waitIfOpen(activePage, 600);
        if (!alive) return;
        return;
      }

      // Fallback: look for any button with reject/cancel text
      const fallbackButton = activePage
        .locator('button')
        .filter({ hasText: /reject|cancel|deny/i })
        .first();
      if (await fallbackButton.isVisible({ timeout: 4_000 }).catch(() => false)) {
        await fallbackButton.click();
        const alive = await this.waitIfOpen(activePage, 600);
        if (!alive) return;
        return;
      }

      // If no reject button found, keep waiting
      const alive = await this.waitIfOpen(activePage, 1_200);
      if (!alive) return;
    }

    throw new Error('Wallet rejection button was not found after retries.');
  }

  private getWalletOptionPattern() {
    if (env.walletExtension === 'slush') {
      return /slush wallet|slush|sui wallet/i;
    }

    return new RegExp(env.walletDisplayName, 'i');
  }

  private async selectWalletFromCetusModal(page: Page) {
    await page.bringToFront().catch(() => undefined);
    const connectWalletTitle = page.getByText(/connect a wallet/i).first();
    // The modal is rendered asynchronously after clicking Connect.
    const modalVisible = await connectWalletTitle.isVisible({ timeout: 10_000 }).catch(() => false);
    if (!modalVisible) {
      return;
    }

    // Cetus UI changed "Slush Wallet" → "Slush" — accept either form
    const walletPattern = env.walletExtension === 'slush' ? /^slush(?: wallet)?$/i : this.getWalletOptionPattern();
    const walletText = page.getByText(walletPattern, { exact: false }).first();
    await expect(walletText).toBeVisible({ timeout: 15_000 });

    for (let attempt = 0; attempt < 5; attempt++) {
      if (!(await connectWalletTitle.isVisible().catch(() => false))) {
        break;
      }

      // 1) Click nearest card container in Playwright layer.
      const clickableCard = walletText.locator('xpath=ancestor::*[self::button or self::div][1]');
      await clickableCard.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(200);

      // 2) Click by coordinates (more human-like; some UIs bind on pointer position).
      if (await connectWalletTitle.isVisible().catch(() => false)) {
        const textBox = await walletText.boundingBox().catch(() => null);
        if (textBox) {
          await page.mouse.click(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2);
          await page.waitForTimeout(200);
        }
      }

      // 3) In-page native event dispatch on the exact card.
      if (await connectWalletTitle.isVisible().catch(() => false)) {
        await page.evaluate(() => {
          const root =
            document.querySelector('[role="dialog"]') ??
            document.querySelector('.chakra-modal__content') ??
            document.body;

          // 精确查找 Slush 卡片，避免全量枚举 querySelectorAll('*') 导致大 DOM 占用
          const slushCard =
            root.querySelector<HTMLElement>('button[data-wallet="slush"], button[data-wallet="slush-wallet"]') ??
            root.querySelector<HTMLElement>('[role="button"][data-wallet*="slush"]') ??
            (() => {
              // fallback：仅在 button 和 role=button 中查找，不扫描 div
              const candidates = Array.from(
                root.querySelectorAll<HTMLElement>('button, [role="button"]')
              );
              return candidates.find((el) => /^slush(?: wallet)?$/i.test((el.textContent ?? '').trim())) ?? null;
            })();

          if (!slushCard) return;
          slushCard.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
          slushCard.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          slushCard.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          slushCard.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        });
      }

      await page.waitForTimeout(450);
    }
  }

  private async unlockWalletPageIfNeeded(walletPage: Page) {
    if (!env.walletPassword) {
      return;
    }
    if (walletPage.isClosed()) {
      return;
    }

    await walletPage.bringToFront().catch(() => undefined);
    await walletPage.waitForLoadState('domcontentloaded').catch(() => undefined);
    if (walletPage.isClosed()) {
      return;
    }

    const unlockButton = walletPage
      .locator('button, [role="button"]')
      .filter({ hasText: /unlock|confirm|continue/i })
      .last();
    const passwordInputs = walletPage.locator(
      'input[type="password"], input[name*="password" i], input[placeholder*="password" i], input[autocomplete="current-password"], input[aria-label*="password" i]'
    );

    const isUnlockVisible = await unlockButton.isVisible({ timeout: 2_000 }).catch(() => false);
    const inputCount = await passwordInputs.count().catch(() => 0);
    let visiblePasswordInput: null | ReturnType<typeof passwordInputs.nth> = null;
    for (let i = 0; i < inputCount; i++) {
      const candidate = passwordInputs.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        visiblePasswordInput = candidate;
        break;
      }
    }
    const isPasswordVisible = visiblePasswordInput !== null;

    if (!isUnlockVisible && !isPasswordVisible) {
      return;
    }

    if (visiblePasswordInput) {
      if (walletPage.isClosed()) {
        return;
      }
      await visiblePasswordInput.click().catch(() => undefined);
      await visiblePasswordInput.fill(env.walletPassword);
      // Some wallets only enable Unlock after a key event.
      await visiblePasswordInput.press('Tab').catch(() => undefined);
      await visiblePasswordInput.press('Enter').catch(() => undefined);
    }

    if (isUnlockVisible) {
      if (walletPage.isClosed()) {
        return;
      }
      await expect(unlockButton).toBeEnabled({ timeout: 10_000 }).catch(() => undefined);
      await unlockButton.click().catch((error: unknown) => {
        // Race: wallet popup may close immediately after auto-approval.
        if (walletPage.isClosed()) return;
        throw error;
      });
      if (walletPage.isClosed()) {
        return;
      }
      await walletPage.waitForTimeout(1_000);
    }
  }

  private getConnectButton(page: Page) {
    return page
      .locator('button, [role="button"]')
      .filter({ hasText: /connect wallet|connect/i })
      .first();
  }

  private async dismissCetusTermsIfPresent(page: Page) {
    const confirmButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /^confirm$/i })
      .first();

    const confirmVisible = await confirmButton.isVisible().catch(() => false);
    if (!confirmVisible) {
      return;
    }

    await page.bringToFront().catch(() => undefined);
    await page.waitForTimeout(500);

    const agreeText = page.getByText(/agree to the terms/i).first();
    if (await agreeText.isVisible().catch(() => false)) {
      // 站点 UI 是自绘复选框，最稳定方式是先点击文字左侧方框坐标。
      const box = await agreeText.boundingBox();
      if (box) {
        const checkboxX = Math.max(0, box.x - 14);
        const checkboxY = box.y + box.height / 2;
        await page.mouse.click(checkboxX, checkboxY);
        await page.waitForTimeout(250);
      }

      // 兜底 1：点击文字本身。
      if (!(await confirmButton.isEnabled().catch(() => false))) {
        await agreeText.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(250);
      }

      // 兜底 2：点击包含文字的行容器（chakra-stack）。
      if (!(await confirmButton.isEnabled().catch(() => false))) {
        const agreeRow = agreeText.locator('xpath=ancestor::div[contains(@class,"chakra-stack")][1]');
        await agreeRow.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(250);
      }
    }

    // Cetus terms modal also requires selecting a default explorer (SuiVision / Suiscan).
    // Do precise modal-scoped clicking to avoid matching unrelated page text.
    if (!(await confirmButton.isEnabled().catch(() => false))) {
      await page.evaluate(() => {
        const isText = (el: Element | null, pattern: RegExp) =>
          !!el && pattern.test((el.textContent ?? '').trim());

        const confirm = Array.from(document.querySelectorAll('button')).find((b) =>
          /^confirm$/i.test((b.textContent ?? '').trim())
        );
        if (!confirm) return;

        // Limit search to the terms modal area around Confirm button.
        const modalRoot =
          confirm.closest('[role="dialog"]') ??
          confirm.closest('div')?.parentElement ??
          document.body;

        const rows = Array.from(modalRoot.querySelectorAll('div.chakra-stack.css-9aagvw'));
        // Prefer SuiVision row, then Suiscan row.
        const optionRow =
          rows.find((row) => isText(row, /^suivision$/i)) ??
          rows.find((row) => isText(row, /^suiscan$/i));

        optionRow?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
      await page.waitForTimeout(300);

      // Secondary fallback: click explicit text and its row container.
      if (!(await confirmButton.isEnabled().catch(() => false))) {
        const suiVisionText = page.getByText(/^suivision$/i).first();
        if (await suiVisionText.isVisible().catch(() => false)) {
          await suiVisionText.click({ force: true }).catch(() => undefined);
          await page.waitForTimeout(250);
          if (!(await confirmButton.isEnabled().catch(() => false))) {
            const suiVisionRow = suiVisionText.locator('xpath=ancestor::div[contains(@class,"chakra-stack")][1]');
            await suiVisionRow.click({ force: true }).catch(() => undefined);
            await page.waitForTimeout(250);
          }
        }
      }
    }

    await expect(confirmButton).toBeEnabled({ timeout: 15_000 });
    await confirmButton.click();
    await confirmButton.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }

  private findExistingExtensionPage(page: Page) {
    return page
      .context()
      .pages()
      .find((candidate) => {
        const url = candidate.url();
        // Only match actual browser extension pages, NOT the slush.app website
        // (Cetus opens slush.app as a fallback when the extension is not installed)
        return url.startsWith('chrome-extension://');
      });
  }

  private async findActionableExtensionPage(page: Page, pagesBeforeAction: Set<Page>) {
    const extensionPages = page
      .context()
      .pages()
      .filter((candidate) => {
        const url = candidate.url();
        // Only match actual browser extension pages, NOT the slush.app website
        return url.startsWith('chrome-extension://');
      });

    // Prefer brand-new popup pages opened by the current action.
    const newlyOpened = extensionPages.filter((candidate) => !pagesBeforeAction.has(candidate));
    for (const candidate of newlyOpened) {
      // If a new extension page exists but is still loading (spinner/skeleton),
      // take it and let downstream logic wait for unlock/approve controls.
      if (!candidate.isClosed()) {
        return candidate;
      }
    }

    for (const candidate of newlyOpened) {
      if ((await this.hasApprovalButton(candidate)) || (await this.hasUnlockControls(candidate))) {
        return candidate;
      }
    }

    // Fallback to existing extension pages only if they really contain an approval button.
    for (const candidate of extensionPages) {
      if ((await this.hasApprovalButton(candidate)) || (await this.hasUnlockControls(candidate))) {
        return candidate;
      }
    }

    return undefined;
  }

  private async hasApprovalButton(extensionPage: Page) {
    await extensionPage.waitForLoadState('domcontentloaded').catch(() => undefined);

    const approveButton = extensionPage
      .getByRole('button', {
        name: /connect|approve|confirm|sign|sign and execute|approve transaction|accept|allow/i
      })
      .filter({ hasNotText: /reject|cancel|deny|disconnect/i })
      .first();

    return approveButton.isVisible({ timeout: 2_000 }).catch(() => false);
  }

  private async hasUnlockControls(extensionPage: Page) {
    await extensionPage.waitForLoadState('domcontentloaded').catch(() => undefined);
    const unlock = extensionPage.getByRole('button', { name: /unlock/i }).first();
    const pwd = extensionPage.locator('input[type="password"], input[placeholder*="password" i]').first();
    const hasUnlock = await unlock.isVisible({ timeout: 1_000 }).catch(() => false);
    const hasPwd = await pwd.isVisible({ timeout: 1_000 }).catch(() => false);
    return hasUnlock || hasPwd;
  }

  private async waitIfOpen(walletPage: Page, ms: number): Promise<boolean> {
    if (walletPage.isClosed()) return false;
    try {
      await walletPage.waitForTimeout(ms);
      return !walletPage.isClosed();
    } catch {
      return !walletPage.isClosed();
    }
  }

  private async reloadIfOpen(walletPage: Page): Promise<boolean> {
    if (walletPage.isClosed()) return false;
    try {
      await walletPage.reload({ waitUntil: 'domcontentloaded' });
      return !walletPage.isClosed();
    } catch {
      return !walletPage.isClosed();
    }
  }

  private async findBestExtensionActionPage(currentPage: Page): Promise<Page | undefined> {
    const extensionPages = currentPage
      .context()
      .pages()
      .filter((candidate) => !candidate.isClosed() && candidate.url().startsWith('chrome-extension://'));

    // Prefer pages that are already actionable.
    for (const candidate of extensionPages) {
      if ((await this.hasUnlockControls(candidate)) || (await this.hasApprovalButton(candidate))) {
        return candidate;
      }
    }

    // Otherwise keep using current page if still alive.
    if (!currentPage.isClosed() && currentPage.url().startsWith('chrome-extension://')) {
      return currentPage;
    }

    return extensionPages[0];
  }

  private async waitForActionableExtensionPage(
    page: Page,
    pagesBeforeAction: Set<Page>,
    preferred?: Page
  ): Promise<Page | undefined> {
    // Try immediately with the just-opened popup first.
    if (preferred) {
      const url = preferred.url();
      if (
        url.startsWith('chrome-extension://') &&
        ((await this.hasApprovalButton(preferred)) || (await this.hasUnlockControls(preferred)))
      ) {
        return preferred;
      }
    }

    // Keep polling long enough for late popup render and unlock UI hydration.
    for (let i = 0; i < 40; i++) {
      const actionable = await this.findActionableExtensionPage(page, pagesBeforeAction);
      if (actionable) {
        return actionable;
      }
      await page.waitForTimeout(1_000);
    }

    return undefined;
  }
}
