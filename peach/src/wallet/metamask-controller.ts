import { type Page, type BrowserContext } from '@playwright/test';
import { env } from '../config/env.js';

/**
 * MetaMask Extension Controller
 * 
 * Handles MetaMask connection, unlock, transaction approval flows.
 * Adapted from cetus project's ExtensionWalletController pattern.
 */
export class MetaMaskController {
  /**
   * Connect MetaMask wallet to the dApp.
   * Flow:
   *   1. Proactively unlock extension (open extension page and unlock)
   *   2. Reload page to ensure provider is detected
   *   3. Dismiss terms if present
   *   4. Check if already connected
   *   5. Click "Connect Wallet" and select MetaMask
   *   6. Approve connection in extension popup
   */
  async connect(page: Page): Promise<void> {
    const context = page.context();
    
    // 1. Proactively unlock MetaMask extension
    await this.tryUnlockExtension(page);
    
    // 2. Reload to ensure window.ethereum is detected.
    // 'domcontentloaded' is much lighter than 'networkidle' for DApps with WebSocket connections,
    // which never reach a true network-idle state.
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    
    // 3. Handle Peach Terms & Policies dialog
    await this.dismissTermsIfPresent(page);
    
    // 4. Check if already connected
    const addressVisible = await page
      .locator('text=/0x[a-fA-F0-9]{3,}/i')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    
    if (addressVisible) {
      console.log('[MetaMask] Already connected');
      return;
    }
    
    // 5. Click Connect Wallet button
    const connectBtn = page.getByRole('button', { name: /Connect Wallet/i }).first();
    await connectBtn.click({ timeout: 10000 });
    console.log('[MetaMask] Connect Wallet clicked');
    
    // 6. Select MetaMask from wallet modal and handle popup
    // Note: We need to register the popup listener BEFORE clicking MetaMask
    const pagesBeforeClick = new Set(context.pages());
    
    // Click MetaMask option
    await this.selectMetaMaskFromModal(page);
    
    // 7. Wait for and approve in MetaMask popup
    await page.waitForTimeout(1500); // Give popup time to appear
    
    const popup = await this.waitForActionableExtensionPage(page, pagesBeforeClick);
    if (popup) {
      console.log('[MetaMask] Popup found, approving connection...');
      await this.clickMetaMaskApprovalButton(popup);
      await page.waitForTimeout(1000);
    } else {
      console.log('[MetaMask] No popup found, connection may have been auto-approved');
    }
    
    // 8. Verify connection
    await page.waitForSelector('text=/0x[a-fA-F0-9]{3,}/i', { timeout: 20000 });
    console.log('[MetaMask] Wallet connected successfully');
  }

  /**
   * Approve a transaction in MetaMask popup.
   * Call this after clicking a button that triggers a transaction.
   *
   * 注意：MetaMask 的后续弹框（第2、3个）有时复用同一个 popup 页面，
   * 而不是打开新的 page 对象。因此需要同时扫描已知 popup 页面是否有新内容。
   */
  async approveTransaction(page: Page): Promise<void> {
    await this.withOptionalMetaMaskPopup(page, async () => {
      await page.waitForTimeout(500);
    });
  }

  /**
   * Approve transaction with action pattern (like cetus).
   * Registers popup listener BEFORE executing the action.
   */
  async approveTransactionForAction(
    page: Page,
    action: () => Promise<void>
  ): Promise<void> {
    await this.withOptionalMetaMaskPopup(page, action);
  }

  /**
   * Reject a transaction in MetaMask popup.
   */
  async rejectTransaction(page: Page): Promise<void> {
    const context = page.context();
    const pagesBeforeAction = new Set(context.pages());
    
    await page.waitForTimeout(500);
    
    const popup = await this.waitForActionableExtensionPage(page, pagesBeforeAction);
    if (!popup) {
      await page.bringToFront().catch(() => undefined);
      return;
    }
    
    await this.clickMetaMaskRejectionButton(popup);
    await popup.waitForEvent('close', { timeout: 20_000 }).catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Proactively unlock MetaMask extension.
   * On first run (empty profile): automatically imports the wallet from WALLET_SEED_PHRASE.
   * On subsequent runs: just unlocks the already-imported wallet.
   * This mirrors how cetus works: the profile persists after the first run.
   */
  private async tryUnlockExtension(page: Page): Promise<void> {
    if (!env.walletPassword) {
      return;
    }
    
    const context = page.context();
    
    // Unlock any already-open extension pages
    for (const extensionPage of context.pages().filter((p) => this.isExtensionPage(p))) {
      await this.unlockPageIfNeeded(extensionPage);
    }
    
    const extId = this.extractExtensionId(env.walletExtensionPath);
    if (!extId) return;

    const extPage = await context.newPage();
    try {
      const homeUrl = `chrome-extension://${extId}/home.html`;
      await extPage.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await extPage.waitForTimeout(1_000);

      // Detect onboarding (wallet not yet imported into this profile)
      const onboardingVisible = await extPage
        .getByText(/import.*wallet|import an existing|get started|welcome to metamask/i)
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false);

      if (onboardingVisible) {
        console.log('[MetaMask] Onboarding detected — auto-importing wallet from seed phrase');
        await this.runOnboardingImport(extPage);
      } else {
        await this.unlockPageIfNeeded(extPage);
      }

      // Give extension time to re-inject provider into existing pages
      await extPage.waitForTimeout(1_500);
      console.log('[MetaMask] Extension ready');
    } catch (err) {
      console.log('[MetaMask] Could not open extension popup:', err);
    } finally {
      await extPage.close().catch(() => undefined);
    }
    
    await page.bringToFront().catch(() => undefined);
  }

  /**
   * Automate MetaMask first-time onboarding: import wallet from seed phrase.
   * Handles MetaMask 10.x ~ 13.x onboarding flow.
   */
  private async runOnboardingImport(extPage: Page): Promise<void> {
    if (!env.walletSeedPhrase) {
      throw new Error(
        '[MetaMask] WALLET_SEED_PHRASE is required for first-time setup. ' +
        'Add the seed phrase to .env (test wallet only!).'
      );
    }
    if (!env.walletPassword) {
      throw new Error('[MetaMask] WALLET_PASSWORD is required for wallet setup.');
    }

    const words = env.walletSeedPhrase.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      throw new Error(`[MetaMask] Seed phrase must be 12 or 24 words, got ${words.length}.`);
    }

    // ── Step 1: Click "Import an existing wallet" ──────────────────────────
    const importBtn = extPage
      .getByRole('button', { name: /import.*wallet|import an existing/i })
      .first();
    if (await importBtn.isVisible({ timeout: 8_000 }).catch(() => false)) {
      await importBtn.click();
      console.log('[MetaMask] Clicked "Import an existing wallet"');
    } else {
      // Some versions: click "Get started" first
      const getStarted = extPage.getByRole('button', { name: /get started/i }).first();
      if (await getStarted.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await getStarted.click();
        await extPage.waitForTimeout(500);
        const importBtn2 = extPage.getByRole('button', { name: /import.*wallet|import an existing/i }).first();
        await importBtn2.click({ timeout: 8_000 });
      }
    }

    await extPage.waitForTimeout(800);

    // ── Step 2: Analytics consent — "No thanks" ────────────────────────────
    const noThanks = extPage
      .getByRole('button', { name: /no thanks|i agree|agree/i })
      .first();
    if (await noThanks.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Prefer "No thanks" to skip analytics
      const noThanksBtn = extPage.getByRole('button', { name: /no thanks/i }).first();
      if (await noThanksBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await noThanksBtn.click();
      } else {
        await noThanks.click();
      }
      console.log('[MetaMask] Analytics consent dismissed');
    }

    await extPage.waitForTimeout(800);

    // ── Step 3: Enter seed phrase ──────────────────────────────────────────
    // MetaMask 13.x uses individual word inputs; older versions use a single textarea
    const wordInputs = extPage.locator('input[data-testid^="import-srp__srp-word"], input[id^="mnemonic-word"]');
    const textArea = extPage.locator('textarea[placeholder*="paste"], textarea[data-testid="import-srp__srp-word-0"]');

    const wordInputCount = await wordInputs.count().catch(() => 0);
    if (wordInputCount >= 12) {
      // Individual word inputs
      for (let i = 0; i < words.length; i++) {
        await wordInputs.nth(i).fill(words[i]);
      }
      console.log('[MetaMask] Seed phrase entered (individual inputs)');
    } else if (await textArea.isVisible({ timeout: 3_000 }).catch(() => false)) {
      // Single textarea
      await textArea.fill(env.walletSeedPhrase.trim());
      console.log('[MetaMask] Seed phrase entered (textarea)');
    } else {
      // Fallback: look for any visible word input by generic selector
      const genericInputs = extPage.locator('input[type="text"], input[type="password"]').filter({ hasNot: extPage.locator('[type="submit"]') });
      const count = await genericInputs.count().catch(() => 0);
      if (count >= words.length) {
        for (let i = 0; i < words.length; i++) {
          await genericInputs.nth(i).fill(words[i]);
        }
        console.log('[MetaMask] Seed phrase entered (generic inputs)');
      } else {
        throw new Error('[MetaMask] Could not find seed phrase input fields on onboarding page.');
      }
    }

    await extPage.waitForTimeout(500);

    // ── Step 4: Confirm seed phrase ────────────────────────────────────────
    const confirmSrp = extPage
      .getByRole('button', { name: /confirm.*recovery|confirm secret|confirm/i })
      .filter({ hasNotText: /cancel/i })
      .first();
    if (await confirmSrp.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await confirmSrp.click();
      console.log('[MetaMask] Seed phrase confirmed');
    }

    await extPage.waitForTimeout(800);

    // ── Step 5: Create password ────────────────────────────────────────────
    const pwInput = extPage.locator('input[id="create-password"], input[data-testid="create-password"], input[type="password"]').first();
    const pwConfirm = extPage.locator('input[id="confirm-password"], input[data-testid="confirm-password"], input[type="password"]').nth(1);

    if (await pwInput.isVisible({ timeout: 8_000 }).catch(() => false)) {
      await pwInput.fill(env.walletPassword);
      if (await pwConfirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await pwConfirm.fill(env.walletPassword);
      }

      // Check "I understand" checkbox if present
      const termsCheckbox = extPage
        .locator('input[type="checkbox"], [role="checkbox"]')
        .filter({ hasNotText: /cancel/i })
        .first();
      if (await termsCheckbox.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const isChecked = await termsCheckbox.isChecked().catch(() => false);
        if (!isChecked) {
          await termsCheckbox.click({ force: true });
        }
      }

      // Click "Import my wallet" or "Create a new wallet" or "Import"
      const createBtn = extPage
        .getByRole('button', { name: /import my wallet|import|create.*wallet|create|done/i })
        .filter({ hasNotText: /cancel/i })
        .first();
      if (await createBtn.isEnabled({ timeout: 5_000 }).catch(() => false)) {
        await createBtn.click();
        console.log('[MetaMask] Password set and wallet imported');
      }
    }

    await extPage.waitForTimeout(1_000);

    // ── Step 6: Complete onboarding (dismiss final success screens) ────────
    for (let i = 0; i < 5; i++) {
      const doneBtn = extPage
        .getByRole('button', { name: /got it|done|finish|next|complete/i })
        .first();
      if (await doneBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await doneBtn.click();
        await extPage.waitForTimeout(600);
      } else {
        break;
      }
    }

    console.log('[MetaMask] Onboarding complete — wallet imported successfully');
  }

  /**
   * Extract the 32-character extension ID from WALLET_EXTENSION_PATH.
   * Example: /path/to/Extensions/nkbihfbeogaeaoehlefnkodbefgpgknn/13.32.1.0_0
   * Returns: nkbihfbeogaeaoehlefnkodbefgpgknn
   */
  private extractExtensionId(extensionPath?: string): string | undefined {
    if (!extensionPath) return undefined;
    const match = extensionPath.match(/[/\\]([a-z]{32})[/\\]/i);
    return match ? match[1] : undefined;
  }

  /**
   * Check if a page is a chrome-extension:// page.
   */
  private isExtensionPage(page: Page): boolean {
    return page.url().startsWith('chrome-extension://');
  }

  /**
   * Unlock a MetaMask page if it shows the password input.
   */
  private async unlockPageIfNeeded(page: Page): Promise<void> {
    if (!env.walletPassword) return;
    if (page.isClosed()) return;
    
    await page.bringToFront().catch(() => undefined);
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    
    const passwordInput = page.locator('input[type="password"]').first();
    if (!(await passwordInput.isVisible({ timeout: 2000 }).catch(() => false))) {
      return;
    }
    
    await passwordInput.fill(env.walletPassword);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
  }

  /**
   * Dismiss Peach Terms & Policies dialog if present.
   */
  private async dismissTermsIfPresent(page: Page): Promise<void> {
    const dialog = page.locator('role=dialog[name="Terms & Policies"]');
    const isVisible = await dialog.isVisible({ timeout: 3000 }).catch(() => false);
    
    if (!isVisible) return;
    
    console.log('[MetaMask] Accepting Terms & Policies');
    const checkbox = dialog.locator('role=checkbox');
    await checkbox.check();
    const confirmBtn = dialog.getByRole('button', { name: /Confirm/i });
    await confirmBtn.click();
    await dialog.waitFor({ state: 'hidden', timeout: 8000 });
  }

  /**
   * Select MetaMask from the wallet connection modal.
   */
  private async selectMetaMaskFromModal(page: Page): Promise<void> {
    await page.bringToFront().catch(() => undefined);
    await page.waitForTimeout(1000); // Wait for modal animation
    
    // Wait for wallet modal (dialog) to appear
    const modal = page.locator('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"]').first();
    const modalVisible = await modal.isVisible({ timeout: 10_000 }).catch(() => false);
    
    if (!modalVisible) {
      console.log('[MetaMask] Wallet modal (dialog) not found');
      await page.screenshot({ path: 'debug-no-modal.png' }).catch(() => undefined);
      return;
    }
    
    console.log('[MetaMask] Wallet modal detected');
    await page.screenshot({ path: 'debug-modal-open.png' }).catch(() => undefined);
    
    // Find MetaMask option within the modal
    let metaMaskOption = modal.locator('text=/metamask/i').first();
    let metaMaskVisible = await metaMaskOption.isVisible({ timeout: 5_000 }).catch(() => false);
    
    if (!metaMaskVisible) {
      // Try finding by INSTALLED label (which is near MetaMask)
      const installedLabel = modal.getByText(/installed/i).first();
      if (await installedLabel.isVisible({ timeout: 2_000 }).catch(() => false)) {
        console.log('[MetaMask] Found INSTALLED label, looking for nearby MetaMask text');
        // Get the parent element containing both MetaMask text and INSTALLED label
        metaMaskOption = installedLabel.locator('xpath=ancestor::*[contains(text(), "MetaMask")]').first();
        metaMaskVisible = await metaMaskOption.isVisible({ timeout: 2_000 }).catch(() => false);
      }
    }
    
    if (!metaMaskVisible) {
      console.log('[MetaMask] MetaMask option not found in modal');
      await page.screenshot({ path: 'debug-modal-no-metamask.png' }).catch(() => undefined);
      return;
    }
    
    console.log('[MetaMask] MetaMask option found, attempting to click...');
    
    // Try multiple click strategies (restoring original approach)
    for (let attempt = 0; attempt < 5; attempt++) {
      const modalStillVisible = await modal.isVisible().catch(() => false);
      if (!modalStillVisible) {
        console.log('[MetaMask] Modal closed, click successful');
        break;
      }
      
      console.log(`[MetaMask] Click attempt ${attempt + 1}/5`);
      
      // Strategy 1: Click on the MetaMask row using Playwright
      await metaMaskOption.click({ force: true, timeout: 3000 }).catch((e) => {
        console.log(`[MetaMask] Direct click failed: ${e.message}`);
      });
      await page.waitForTimeout(800);
      
      if (!(await modal.isVisible().catch(() => false))) {
        console.log('[MetaMask] Modal closed after direct click');
        break;
      }
      
      // Strategy 2: Click the parent container
      const parent = metaMaskOption.locator('xpath=..').first();
      await parent.click({ force: true, timeout: 3000 }).catch((e) => {
        console.log(`[MetaMask] Parent click failed: ${e.message}`);
      });
      await page.waitForTimeout(800);
      
      if (!(await modal.isVisible().catch(() => false))) {
        console.log('[MetaMask] Modal closed after parent click');
        break;
      }
      
      // Strategy 3: Use JavaScript to simulate click with targeted selector
      await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"]');
        if (!modal) return;

        // 精确查找可点击的 MetaMask 容器，避免全量枚举 querySelectorAll('*')
        const clickable =
          modal.querySelector<HTMLElement>('button[data-testid*="metamask"]') ??
          modal.querySelector<HTMLElement>('[role="button"][data-testid*="metamask"]') ??
          (() => {
            // fallback: 找到第一个文本包含 MetaMask 的 button 或 role=button
            const candidates = Array.from(
              modal.querySelectorAll<HTMLElement>('button, [role="button"]')
            );
            return candidates.find((el) => /metamask/i.test(el.textContent ?? '')) ?? null;
          })();

        if (clickable) {
          clickable.click();
        }
      }).catch(() => undefined);
      
      await page.waitForTimeout(1000);
    }
    
    const finalModalVisible = await modal.isVisible().catch(() => false);
    if (!finalModalVisible) {
      console.log('[MetaMask] Modal successfully closed');
    } else {
      console.log('[MetaMask] Warning: Modal still visible after all attempts');
    }
  }

  /**
   * Handle MetaMask popup window (connection or transaction).
   * Based on cetus's withOptionalWalletPopup pattern.
   */
  private async withOptionalMetaMaskPopup(
    page: Page,
    action: () => Promise<void>
  ): Promise<void> {
    const context = page.context();
    const pagesBeforeAction = new Set(context.pages());
    
    // Execute the action (e.g., click button)
    await action();
    
    // Wait for popup
    const popup = await this.waitForActionableExtensionPage(page, pagesBeforeAction);
    if (!popup) {
      await page.bringToFront().catch(() => undefined);
      return;
    }
    
    await this.clickMetaMaskApprovalButton(popup);
    await page.bringToFront().catch(() => undefined);
  }

  /**
   * Wait for a MetaMask extension popup page to appear.
   *
   * MetaMask 有两种弹框模式：
   *   A. 新 page：真正打开一个新的 notification.html / popup.html 页面
   *   B. 复用 page：第2/3个连续弹框复用同一个 popup page，页面对象已在
   *      pagesBeforeAction 里，但内容变成了新的签名请求
   *
   * 策略：先找新页面（模式A），找不到再扫描已知 extension 页面内是否有
   * 可点击的审批按钮（模式B）。
   */
  private async waitForActionableExtensionPage(
    page: Page,
    pagesBeforeAction: Set<Page>
  ): Promise<Page | undefined> {
    const context = page.context();

    // Wait a bit for popup to appear
    await page.waitForTimeout(1500);

    console.log(`[MetaMask] Waiting for popup... (${pagesBeforeAction.size} pages before action)`);

    for (let attempt = 0; attempt < 14; attempt++) {
      // 每次取快照后立即赋值给局部变量，用完即丢，不在循环外持有引用
      const currentPages = context.pages();
      console.log(`[MetaMask] Attempt ${attempt + 1}/14: ${currentPages.length} total pages`);

      // ── 模式 A：新出现的 extension 页面 ──────────────────────────────
      for (const p of currentPages) {
        if (pagesBeforeAction.has(p)) continue;
        if (!this.isExtensionPage(p)) continue;
        if (p.isClosed()) continue;

        const url = p.url();
        if (
          url.includes('notification.html') ||
          url.includes('popup.html') ||
          url.includes('home.html')
        ) {
          console.log(`[MetaMask] Popup detected (new page): ${url}`);
          // currentPages 在下一次循环时会被 GC，已关闭的 Page 引用不会被持续持有
          return p;
        }
      }

      // ── 模式 B：复用的 extension 页面（已在 pagesBeforeAction 中）──
      for (const p of currentPages) {
        if (!pagesBeforeAction.has(p)) continue;
        if (!this.isExtensionPage(p)) continue;
        if (p.isClosed()) continue;

        const url = p.url();
        if (
          !url.includes('notification.html') &&
          !url.includes('popup.html') &&
          !url.includes('home.html')
        ) continue;

        const hasApproveBtn = await p
          .getByRole('button', {
            name: /connect|approve|confirm|sign|next|连接|批准|确认|签名|下一步/i,
          })
          .filter({ hasNotText: /reject|cancel|deny|拒绝|取消/i })
          .last()
          .isVisible({ timeout: 800 })
          .catch(() => false);

        if (hasApproveBtn) {
          console.log(`[MetaMask] Popup detected (reused page with approval button): ${url}`);
          return p;
        }
      }

      // 本轮 currentPages 引用在此处超出作用域，GC 可以回收已关闭的 Page 对象
      await page.waitForTimeout(700);
    }

    console.log('[MetaMask] No popup found after waiting');
    return undefined;
  }

  /**
   * Click the approve/confirm button in MetaMask popup.
   * Implements cetus-style retry loop with unlock handling.
   * Also handles onboarding flow if MetaMask is not yet set up.
   * Also handles risk warning dialog if it appears.
   */
  private async clickMetaMaskApprovalButton(popup: Page): Promise<void> {
    let activePage = popup;
    await activePage.bringToFront().catch(() => undefined);
    await activePage.waitForLoadState('domcontentloaded').catch(() => undefined);
    
    // Check if this is an onboarding popup (wallet not yet imported)
    await activePage.waitForTimeout(1_000);
    const onboardingVisible = await activePage
      .getByText(/import.*wallet|import an existing|get started|welcome to metamask|创建新钱包|导入现有钱包/i)
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    
    if (onboardingVisible) {
      console.log('[MetaMask] Onboarding detected in popup — auto-importing wallet from seed phrase');
      await this.runOnboardingImport(activePage);
      // After onboarding, the popup typically closes itself or shows a success screen
      // Wait a bit to ensure wallet is ready, then let the flow continue
      await activePage.waitForTimeout(2_000);
      return;
    }
    
    for (let attempt = 0; attempt < 25; attempt++) {
      if (activePage.isClosed()) {
        console.log('[MetaMask] Popup already closed, transaction complete');
        return;
      }
      
      // Unlock if needed
      await this.unlockPageIfNeeded(activePage);
      
      // Handle risk warning dialog if present (风险警告对话框)
      // Returns true if popup closed after handling
      const popupClosedAfterWarning = await this.handleRiskWarningIfPresent(activePage);
      if (popupClosedAfterWarning) {
        return;
      }
      
      // Check again if popup closed
      if (activePage.isClosed()) {
        console.log('[MetaMask] Popup closed after risk warning handling');
        return;
      }
      
      // After handling risk warning, wait a bit for UI to update
      await activePage.waitForTimeout(500).catch(() => {});
      
      // Look for approval button (support both English and Chinese)
      const approveBtn = activePage
        .getByRole('button', {
          name: /connect|approve|confirm|sign|next|连接|批准|确认|签名|下一步/i
        })
        .filter({ hasNotText: /reject|cancel|deny|拒绝|取消/i })
        .last();
      
      const visible = await approveBtn.isVisible({ timeout: 3_000 }).catch(() => false);
      if (visible) {
        const enabled = await approveBtn.isEnabled().catch(() => false);
        if (!enabled) {
          console.log(`[MetaMask] Approval button not enabled yet (attempt ${attempt + 1}/25)`);
          await activePage.waitForTimeout(700).catch(() => {});
          continue;
        }
        await approveBtn.click();
        console.log('[MetaMask] Approval button clicked');
        
        // For connection flow, may need to click "Connect" again after selecting accounts
        const finalConnectBtn = activePage.getByRole('button', { name: /^Connect$/i }).last();
        if (await finalConnectBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await finalConnectBtn.click();
          console.log('[MetaMask] Final connect button clicked');
        }
        
        await activePage.waitForTimeout(1000).catch(() => {});
        
        if (activePage.isClosed()) {
          console.log('[MetaMask] Popup closed after approval');
          return;
        }
        
        // Check if there are more buttons to click (don't exit too early)
        const hasMoreButtons = await activePage
          .getByRole('button', { name: /confirm|approve|确认|批准/i })
          .first()
          .isVisible({ timeout: 2000 })
          .catch(() => false);
        
        if (!hasMoreButtons) {
          console.log('[MetaMask] No more buttons to click, transaction submitted');
          return;
        }
        
        console.log('[MetaMask] More buttons detected, continuing loop');
        continue;
      }
      
      // Fallback button selector
      const fallbackBtn = activePage
        .locator('button')
        .filter({ hasText: /connect|approve|confirm|确认|批准/i })
        .filter({ hasNotText: /reject|cancel|拒绝|取消/i })
        .last();
      
      if (await fallbackBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await fallbackBtn.click();
        console.log('[MetaMask] Fallback button clicked');
        await activePage.waitForTimeout(600).catch(() => {});
        continue;
      }
      
      await activePage.waitForTimeout(1_000).catch(() => {});
    }
    
    console.warn('[MetaMask] Approval button not found after retries');
  }

  /**
   * Handle MetaMask security warning flow if present.
   *
   * MetaMask 对非受信任网站会弹出最多三层安全提示，必须按顺序处理完才能回到正常的"确认"按钮：
   *
   *   步骤 1 — 主交易页显示"查看提醒"（"View alerts"）红色按钮
   *            点击后弹出 alert-modal 对话框（data-testid="alert-modal"）
   *
   *   步骤 2 — "恶意网站" / "Malicious website" 对话框（弹层 1/2）
   *            勾选"我已知晓风险，但仍想继续" → 点"知道了"（"Got it"）
   *            对话框关闭后出现 步骤 3 对话框
   *
   *   步骤 3 — "您的资产可能面临风险" / "Your assets may be at risk" 对话框（弹层 2/2）
   *            勾选"我已知晓提醒并仍想继续" → 点红色"确认"（"Confirm"）
   *            对话框关闭后主交易页"确认"按钮变为可点击状态
   *
   * 关键：一旦 alert-modal 打开，背景层会拦截所有点击事件，必须先处理完 modal 内的
   * 所有操作，不能在 modal 打开期间尝试点击 modal 外部的任何按钮。
   *
   * Returns: true if popup closed after handling all warnings, false otherwise
   */
  private async handleRiskWarningIfPresent(popup: Page): Promise<boolean> {
    try {
      // ── 步骤 1：检测"查看提醒"（View alerts）红色按钮 ─────────────────────
      // 如果主页面有这个按钮，点击后才会弹出 alert-modal
      const viewAlertsBtn = popup
        .locator('button')
        .filter({ hasText: /查看提醒|view alerts/i })
        .first();
      const hasViewAlerts = await viewAlertsBtn.isVisible({ timeout: 1_500 }).catch(() => false);
      if (hasViewAlerts) {
        console.log('[MetaMask] "View alerts" button detected — clicking to open warning dialogs');
        await viewAlertsBtn.click();
        await popup.waitForTimeout(600).catch(() => {});
      }

      // ── 循环处理所有弹层（"恶意网站" → "您的资产可能面临风险" → ...）────────
      // 每次处理完一层后再检测是否还有下一层，最多处理 5 层防止死循环
      let layersHandled = 0;
      const maxLayers = 5;

      while (layersHandled < maxLayers) {
        const riskDialogVisible = await this.isRiskDialogVisible(popup);

        if (!riskDialogVisible) {
          if (layersHandled === 0 && !hasViewAlerts) {
            // 完全没有风险弹窗
            return false;
          }
          // 所有弹层都处理完了
          console.log(`[MetaMask] All risk warning layers handled (${layersHandled} layer(s))`);
          break;
        }

        layersHandled++;
        console.log(`[MetaMask] Risk warning dialog layer ${layersHandled} detected — handling...`);

        // ── 勾选复选框 ───────────────────────────────────────────────────────
        const checked = await this.checkRiskWarningCheckbox(popup);
        if (!checked) {
          console.log('[MetaMask] Warning: could not check risk warning checkbox');
        }

        // 给 UI 时间响应复选框勾选（按钮需要从禁用变为可用）
        await popup.waitForTimeout(500).catch(() => {});

        // ── 点击确认/知道了按钮 ───────────────────────────────────────────────
        const clicked = await this.clickRiskWarningConfirm(popup);
        if (!clicked) {
          console.log(`[MetaMask] Warning: could not click confirm button for layer ${layersHandled}`);
          return false;
        }

        // 等待弹层关闭，再检测下一层
        await popup.waitForTimeout(600).catch(() => {});

        if (popup.isClosed()) {
          console.log('[MetaMask] Popup closed after risk warning — transaction submitted');
          return true;
        }
      }

      return false;
    } catch (err) {
      console.log(`[MetaMask] Error handling risk warning: ${err}`);
      return false;
    }
  }

  /**
   * Check if a MetaMask risk warning dialog is currently visible.
   *
   * MetaMask 可能出现以下几种风险提示对话框，需要全部覆盖：
   *   1. data-testid="alert-modal" 容器（最可靠）
   *   2. "恶意网站" / "Malicious website" — 截图中这种直接弹出的第一层
   *   3. "您的资产可能面临风险" / "Your assets may be at risk" — 第二层
   *   4. 其他包含风险/欺诈关键词的文字
   */
  private async isRiskDialogVisible(popup: Page): Promise<boolean> {
    // 方法 1：data-testid="alert-modal"
    const alertModal = popup.locator('[data-testid="alert-modal"]').first();
    if (await alertModal.isVisible({ timeout: 1_000 }).catch(() => false)) {
      return true;
    }
    // 方法 2：覆盖所有已知的风险提示文字（含"恶意网站"）
    const riskText = popup.locator(
      'text=/恶意网站|您的资产可能面临风险|您的资产.*风险|此请求.*欺诈|malicious website|your assets.*risk|assets.*risk|this.*fraud/i'
    ).first();
    return await riskText.isVisible({ timeout: 1_000 }).catch(() => false);
  }

  /**
   * Click the checkbox once in the risk warning dialog, then wait for the
   * confirm button to become enabled — that is the only reliable signal that
   * the checkbox state was accepted by MetaMask's custom component.
   *
   * We intentionally do NOT loop or verify isChecked(): MetaMask's checkbox
   * is a custom React component whose checked state is not reflected via the
   * standard DOM property, so repeated clicks would toggle it off again.
   */
  private async checkRiskWarningCheckbox(popup: Page): Promise<boolean> {
    // 候选选择器（从精确到宽泛）
    const cbSelectors = [
      '[data-testid="alert-modal"] input[type="checkbox"]',
      '[data-testid="alert-modal"] [role="checkbox"]',
      'input[type="checkbox"]',
      '[role="checkbox"]',
    ];

    for (const sel of cbSelectors) {
      const cb = popup.locator(sel).first();
      if (!(await cb.isVisible({ timeout: 800 }).catch(() => false))) continue;

      // 只点击一次，不验证 isChecked()（自定义组件不可靠）
      await cb.click({ force: true }).catch(() => {});
      console.log(`[MetaMask] Risk warning checkbox clicked: ${sel}`);
      return true;
    }

    // 降级：点击包含复选框文字的 label 区域
    const label = popup
      .locator('label, [class*="checkbox"], [class*="Checkbox"]')
      .filter({ hasText: /知晓|acknowledge|继续|continue/i })
      .first();
    if (await label.isVisible({ timeout: 500 }).catch(() => false)) {
      await label.click({ force: true }).catch(() => {});
      console.log('[MetaMask] Risk warning label clicked (fallback)');
      return true;
    }

    return false;
  }

  /**
   * Wait for the confirm button in the risk warning dialog to become enabled,
   * then click it. The button becomes enabled only after the checkbox is checked.
   *
   * MetaMask 风险弹窗的确认按钮文字因层级和版本而异：
   *   - "知道了" / "Got it"   — "恶意网站"第一层弹窗
   *   - "确认"   / "Confirm"  — "您的资产可能面临风险"第二层弹窗
   *
   * Important: the alert-modal has TWO confirm buttons with the same testid —
   * one inside the modal (the one we want) and one in the page footer behind
   * the overlay (intercepted by the modal backdrop). We must click the one
   * INSIDE the modal, i.e. the FIRST match, not the last.
   *
   * Returns true if button was successfully clicked.
   */
  private async clickRiskWarningConfirm(popup: Page): Promise<boolean> {
    // 按优先级依次尝试定位 modal 内的确认按钮
    // 必须用 .first() —— modal 内的是第一个，页面底部被遮罩挡住的是最后一个
    const candidateSelectors = [
      // modal 容器内的确认按钮（最精确）
      '[data-testid="alert-modal"] [data-testid="confirm-footer-button"]',
      // modal 容器内的任意"确认/知道了"按钮
      '[data-testid="alert-modal"] button',
      // 全页面第一个 confirm-footer-button（modal 内的排在前面）
      '[data-testid="confirm-footer-button"]',
    ];

    const deadline = Date.now() + 6_000;

    for (const sel of candidateSelectors) {
      // 对于 "alert-modal button"，过滤出确认类文字、排除"拒绝/取消"
      // 同时覆盖"知道了"（第一层弹窗）和"确认"（第二层弹窗）
      const btn = sel === '[data-testid="alert-modal"] button'
        ? popup.locator(sel)
            .filter({ hasText: /^知道了$|^got it$|^确认$|^confirm$/i })
            .filter({ hasNotText: /拒绝|取消|reject|cancel/i })
            .first()
        : popup.locator(sel).first();

      if (!(await btn.isVisible({ timeout: 800 }).catch(() => false))) continue;

      // 等待按钮从禁用变为可用
      while (!(await btn.isEnabled().catch(() => false))) {
        if (Date.now() > deadline) break;
        await popup.waitForTimeout(200).catch(() => {});
      }

      if (!(await btn.isEnabled().catch(() => false))) {
        console.log(`[MetaMask] Confirm button still disabled for selector: ${sel}`);
        continue;
      }

      await btn.click({ force: true });
      console.log(`[MetaMask] Risk warning confirm clicked via: ${sel}`);
      return true;
    }

    console.log('[MetaMask] Confirm button not found or still disabled after timeout');
    return false;
  }

  /**
   * Click the reject/cancel button in MetaMask popup.
   */
  private async clickMetaMaskRejectionButton(popup: Page): Promise<void> {
    let activePage = popup;
    await activePage.bringToFront().catch(() => undefined);
    await activePage.waitForLoadState('domcontentloaded').catch(() => undefined);
    
    for (let attempt = 0; attempt < 25; attempt++) {
      if (activePage.isClosed()) {
        return;
      }
      
      await this.unlockPageIfNeeded(activePage);
      
      const rejectBtn = activePage
        .getByRole('button', { name: /reject|cancel|deny/i })
        .first();
      
      const visible = await rejectBtn.isVisible({ timeout: 3_000 }).catch(() => false);
      if (visible) {
        const enabled = await rejectBtn.isEnabled().catch(() => false);
        if (!enabled) {
          await activePage.waitForTimeout(700);
          continue;
        }
        await rejectBtn.click();
        console.log('[MetaMask] Transaction rejected');
        return;
      }
      
      await activePage.waitForTimeout(1_000);
    }
    
    console.warn('[MetaMask] Rejection button not found after retries');
  }
}
