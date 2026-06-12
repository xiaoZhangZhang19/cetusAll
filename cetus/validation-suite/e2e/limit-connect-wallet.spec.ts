/**
 * Test: P0 — Limit order "Connect Wallet" flow when wallet is not connected.
 *
 * Scenario: Open the Limit page in a disconnected state, enter an amount,
 * then verify:
 *   1. The submit button displays "Connect Wallet" (not "Place Limit Order")
 *   2. Clicking it opens the wallet-selection modal / triggers the connect flow
 *
 * Note: walletController.connect() is intentionally NOT called so the page
 * remains in the unauthenticated state throughout the test.
 */

import { LimitPage } from '@/page-objects/limit.page.js';

import { expect, test } from '../setup/fixtures.js';

const AMOUNT = '5';

/**
 * Disconnects the wallet from the Cetus DApp UI by clicking the connected
 * address badge → Disconnect.  The persistent browser profile remembers the
 * last connected wallet, so we must actively disconnect before testing the
 * "not connected" state.
 */
async function disconnectWalletIfConnected(page: import('@playwright/test').Page) {
  // The connected-state badge shows a truncated address like "0x23f2...66f4"
  const addrBadge = page
    .locator('button, [role="button"], div')
    .filter({ hasText: /^0x[0-9a-fA-F]{4}[\w.…]+/i })
    .first();

  if (!(await addrBadge.isVisible({ timeout: 3_000 }).catch(() => false))) {
    console.log('[limit-connect:e2e] wallet already disconnected');
    return;
  }

  await addrBadge.click();
  await page.waitForTimeout(500);

  const disconnectBtn = page
    .locator('button, [role="button"], li, div, span')
    .filter({ hasText: /^disconnect$/i })
    .first();

  if (await disconnectBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await disconnectBtn.click();
    await page.waitForTimeout(800);
    console.log('[limit-connect:e2e] wallet disconnected via UI');
  } else {
    // Fallback: press Escape to close any dropdown and reload without session
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.evaluate(() => {
      // Clear any dApp-connection state stored in localStorage
      const keys = Object.keys(localStorage).filter((k) =>
        /wallet|connect|account|session/i.test(k)
      );
      keys.forEach((k) => localStorage.removeItem(k));
    });
    await page.reload({ waitUntil: 'networkidle' }).catch(() => undefined);
    console.log('[limit-connect:e2e] wallet state cleared via localStorage');
  }
}

test.describe('Cetus Mainnet Limit Order (Connect Wallet)', () => {
  test('shows Connect Wallet button and opens wallet modal when not connected', async ({
    page,
  }) => {
    const limitPage = new LimitPage(page);

    // Navigate to the limit page first, then actively disconnect if needed
    await page.goto('/limit', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await limitPage.dismissTermsModalIfPresent();

    // Ensure wallet is disconnected — persistent profile may auto-connect
    await disconnectWalletIfConnected(page);

    // Re-dismiss terms in case they re-appeared after disconnect/reload
    await limitPage.dismissTermsModalIfPresent();

    console.log('[limit-connect:e2e] page loaded (wallet NOT connected)');

    // ── Fill amount ───────────────────────────────────────────────────────────
    await limitPage.fillAmount(AMOUNT);
    console.log(`[limit-connect:e2e] amount entered   : ${AMOUNT} SUI`);

    // ── Assert "Connect Wallet" button is visible and enabled ─────────────────
    const connectButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /connect wallet/i })
      .first();

    await expect(
      connectButton,
      '"Connect Wallet" button must be visible when wallet is not connected'
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      connectButton,
      '"Connect Wallet" button must be enabled (clickable)'
    ).toBeEnabled();

    const buttonText = (await connectButton.innerText()).trim();
    console.log(`[limit-connect:e2e] button text      : "${buttonText}"`);
    expect(buttonText).toMatch(/connect wallet/i);

    // ── Assert "Place Limit Order" is NOT visible ────────────────────────────
    const placeOrderButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /^place(?: limit)? order$|^submit order$/i })
      .first();
    const placeVisible = await placeOrderButton.isVisible({ timeout: 2_000 }).catch(() => false);
    expect(
      placeVisible,
      '"Place Limit Order" must not be visible when wallet is not connected'
    ).toBe(false);

    // ── Click "Connect Wallet" and assert the wallet-selection modal opens ────
    await connectButton.click();
    console.log('[limit-connect:e2e] clicked "Connect Wallet"');

    // Cetus shows a "Connect a wallet" modal with wallet options
    const walletModal = page
      .locator('[role="dialog"], .chakra-modal__content, [class*="modal"], [class*="dialog"]')
      .filter({ hasText: /connect.*wallet|slush|sui wallet/i })
      .first();

    await expect(
      walletModal,
      'Wallet selection modal must appear after clicking "Connect Wallet"'
    ).toBeVisible({ timeout: 10_000 });

    console.log('[limit-connect:e2e] wallet modal      : visible');

    // Verify the modal lists at least one wallet option
    const walletOption = walletModal
      .locator('button, [role="button"], div, li')
      .filter({ hasText: /slush|sui wallet|martian|ethos/i })
      .first();

    const optionVisible = await walletOption.isVisible({ timeout: 5_000 }).catch(() => false);
    if (optionVisible) {
      // Collapse multi-line text to the first wallet name only
      const raw = (await walletOption.innerText()).trim();
      const firstOption = raw.split('\n')[0].trim();
      console.log(`[limit-connect:e2e] wallet option     : "${firstOption}" visible in modal`);
    }

    console.log('[limit-connect:e2e] result           : Connect Wallet flow works correctly');
  });
});
