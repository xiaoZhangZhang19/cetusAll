import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { Transaction } from '@mysten/sui/transactions';

import { env } from '@/config/env.js';
import { getSuiClient, getKeypairFromEnv } from '@/chain/client.js';
import type { WalletController } from './controller.js';

/** The wallet name shown in Cetus's wallet picker modal. */
export const INJECTED_WALLET_NAME = 'Playwright Wallet';

/**
 * Exposes three Node.js signing functions onto the page window so that the
 * injected wallet script can bridge signing requests back to the test process.
 *
 * Must be called once per page, ideally right after the page is created in
 * the `page` fixture (before any navigation).
 */
export async function setupSigningBridge(page: Page): Promise<void> {
  // Sign a transaction and return bytes + signature (no broadcast).
  await page.exposeFunction(
    '__pw_sign_transaction',
    async (txJSON: string): Promise<{ bytes: string; signature: string }> => {
      const keypair = getKeypairFromEnv();
      const client = getSuiClient();
      const tx = Transaction.from(txJSON);
      const { bytes, signature } = await keypair.signTransaction(
        await tx.build({ client })
      );
      return { bytes, signature };
    }
  );

  // Sign and broadcast a transaction, returning the full SuiTransactionBlockResponse.
  await page.exposeFunction(
    '__pw_sign_and_execute',
    async (txJSON: string): Promise<Record<string, unknown>> => {
      const keypair = getKeypairFromEnv();
      const client = getSuiClient();
      const tx = Transaction.from(txJSON);
      const result = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
      });
      // Serialize to a plain object so Playwright's JSON bridge can transfer it.
      return result as unknown as Record<string, unknown>;
    }
  );

  // Sign a personal message (EIP-191 equivalent on Sui).
  await page.exposeFunction(
    '__pw_sign_message',
    async (msgB64: string): Promise<{ bytes: string; signature: string }> => {
      const keypair = getKeypairFromEnv();
      const msgBytes = Buffer.from(msgB64, 'base64');
      const { bytes, signature } = await keypair.signPersonalMessage(msgBytes);
      return { bytes, signature };
    }
  );
}

/**
 * WalletController implementation for the injected programmatic wallet.
 *
 * Unlike ExtensionWalletController:
 *  - No browser extension or profile is required.
 *  - Signing is handled transparently by the Node.js bridge (setupSigningBridge).
 *  - approveTransaction is a no-op — the injected wallet auto-approves.
 */
export class InjectedWalletController implements WalletController {
  async connect(page: Page): Promise<void> {
    await this.dismissCetusTermsIfPresent(page);
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // Short-circuit if wallet already connected (address prefix visible on page)
    const addrPrefix = env.testWalletAddress.slice(0, 6);
    const connectedAddr = page.getByText(new RegExp(addrPrefix, 'i')).first();
    if (await connectedAddr.isVisible().catch(() => false)) {
      return;
    }

    const connectBtn = page
      .locator('button, [role="button"]')
      .filter({ hasText: /connect wallet|connect/i })
      .first();

    const btnVisible = await connectBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!btnVisible) {
      return;
    }

    await connectBtn.click();
    await this.selectWalletFromModal(page);

    // Wait for the "Connect a wallet" dialog to fully close before proceeding.
    // An unclosed dialog leaves a chakra-portal overlay that blocks subsequent clicks.
    const connectModal = page.locator('[role="dialog"]').filter({ hasText: /connect a wallet/i });
    await connectModal.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);

    // Extra safety: wait for all chakra-portal stacks to clear.
    await page
      .waitForFunction(() => {
        const portals = Array.from(document.querySelectorAll('.chakra-portal'));
        return portals.every((p) => !p.querySelector('[role="dialog"], .chakra-modal__content'));
      }, { timeout: 8_000 })
      .catch(() => undefined);

    await page.waitForTimeout(300);
  }

  /** No-op: the injected wallet auto-approves transactions via the Node.js bridge. */
  async approveTransaction(_page: Page): Promise<void> {}

  /** No-op: just execute the action; no popup to handle. */
  async approveTransactionForAction(_page: Page, action: () => Promise<void>): Promise<void> {
    await action();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async selectWalletFromModal(page: Page): Promise<void> {
    await page.bringToFront().catch(() => undefined);

    const modalTitle = page.getByText(/connect a wallet/i).first();
    const modalVisible = await modalTitle.isVisible({ timeout: 10_000 }).catch(() => false);
    if (!modalVisible) {
      console.log('[wallet] Connect modal not visible, skipping wallet selection');
      return;
    }

    console.log('[wallet] Connect modal visible, checking for Other Wallets section');

    // Expand "Other Wallets" section if present (Playwright Wallet may be hidden inside).
    const otherWalletsBtn = page.getByText(/other wallets/i).first();
    const hasOtherWallets = await otherWalletsBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    console.log(`[wallet] Other Wallets section visible: ${hasOtherWallets}`);
    
    if (hasOtherWallets) {
      await otherWalletsBtn.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(800);
      console.log('[wallet] Clicked Other Wallets to expand');
    }

    // Playwright Wallet should now be visible in the expanded list.
    const walletText = page.getByText(INJECTED_WALLET_NAME, { exact: false }).first();
    const walletVisible = await walletText.isVisible({ timeout: 8_000 }).catch(() => false);
    console.log(`[wallet] "${INJECTED_WALLET_NAME}" visible: ${walletVisible}`);
    
    if (!walletVisible) {
      // Wallet injection failed — close modal and return (test will fail later with clear error).
      console.log(`[wallet] ERROR: "${INJECTED_WALLET_NAME}" not found in wallet list, closing modal`);
      await page.keyboard.press('Escape').catch(() => undefined);
      return;
    }

    console.log(`[wallet] Found "${INJECTED_WALLET_NAME}", attempting to click`);


    // Click the wallet entry (up to 3 attempts).
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await modalTitle.isVisible().catch(() => false))) break;

      // Direct coordinate click.
      const box = await walletText.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(300);
      }

      if (!(await modalTitle.isVisible().catch(() => false))) break;

      // Force-click the nearest clickable ancestor.
      const card = walletText.locator('xpath=ancestor::*[self::button or self::div][1]');
      await card.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(300);

      if (!(await modalTitle.isVisible().catch(() => false))) break;

      // Synthetic events as a last resort.
      const walletNameStr = INJECTED_WALLET_NAME;
      await page.evaluate((name) => {
        const root =
          document.querySelector('[role="dialog"]') ??
          document.querySelector('.chakra-modal__content') ??
          document.body;
        const candidates = Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], div, li'));
        const el = candidates.find((c) =>
          (c.textContent ?? '').trim().toLowerCase().includes(name.toLowerCase())
        );
        if (!el) return;
        ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) =>
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
        );
      }, walletNameStr).catch(() => undefined);

      await page.waitForTimeout(500);
    }

    // Wait up to 15 s for the modal to close after connection.
    await modalTitle.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
  }

  private async dismissCetusTermsIfPresent(page: Page): Promise<void> {
    const confirmButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /^confirm$/i })
      .last();

    const confirmVisible = await confirmButton.isVisible().catch(() => false);
    if (!confirmVisible) {
      return;
    }

    await page.bringToFront().catch(() => undefined);
    await page.waitForTimeout(500);

    for (let attempt = 0; attempt < 5; attempt++) {
      if (!(await confirmButton.isVisible().catch(() => false))) {
        return;
      }

      if (!(await confirmButton.isEnabled().catch(() => false))) {
        const agreeText = page.getByText(/agree to the terms/i).first();
        let checkboxX: number | undefined;
        if (await agreeText.isVisible().catch(() => false)) {
          const box = await agreeText.boundingBox().catch(() => null);
          if (box) {
            checkboxX = Math.max(0, box.x - 14);
            await page.mouse.click(checkboxX, box.y + box.height / 2);
            await page.waitForTimeout(250);
          }
          await agreeText.click({ force: true }).catch(() => undefined);
        }

        await page
          .evaluate(() => {
            const modalRoot =
              Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], .chakra-modal__content')).find((el) =>
                /terms|agree to the terms|suivision|suiscan/i.test(el.textContent ?? '')
              ) ?? document.body;

            const clickNearest = (pattern: RegExp) => {
              const candidate = Array.from(modalRoot.querySelectorAll<HTMLElement>('button, [role="button"], div, span')).find(
                (el) => pattern.test((el.textContent ?? '').trim())
              );
              if (!candidate) return;
              (candidate.closest('button, [role="button"], div') as HTMLElement | null)?.click();
            };

            clickNearest(/agree to the terms/i);
            clickNearest(/^suivision$/i);
            clickNearest(/^suiscan$/i);
          })
          .catch(() => undefined);
        await page.waitForTimeout(300);

        if (!(await confirmButton.isEnabled().catch(() => false))) {
          const suiVisionText = page.getByText(/^suivision$/i).first();
          const box = await suiVisionText.boundingBox().catch(() => null);
          if (box && checkboxX !== undefined) {
            await page.mouse.click(checkboxX, box.y + box.height / 2);
            await page.waitForTimeout(250);
          }
        }
      }

      if (await confirmButton.isEnabled().catch(() => false)) {
        await confirmButton.click({ force: true }).catch(() => undefined);
        await confirmButton.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
        return;
      }
    }
  }

}
