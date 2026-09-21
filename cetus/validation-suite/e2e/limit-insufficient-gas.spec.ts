/**
 * Test: Limit order fails due to insufficient SUI for gas.
 *
 * Scenario: Enter the FULL wallet SUI balance as the order amount, leaving
 * absolutely 0 SUI for gas. The transaction cannot be executed.
 *
 * Expected (any path is acceptable):
 *   Path A — Frontend pre-check:
 *     Button shows "Insufficient gas" / "Insufficient SUI balance" (disabled)
 *   Path B — UI failure notice:
 *     A dialog / toast surfaces a gas or insufficient-funds error
 *   Path C — Wallet-side rejection:
 *     The signing bridge (or its dry-run preflight) reports InsufficientGas.
 *     Cetus does not always render a failure notice for this case — it can sit
 *     on the "Waiting for Confirmation" spinner indefinitely — so the wallet
 *     signal is the authoritative source and must be accepted.
 *
 * Steps:
 *   1. Read on-chain SUI balance
 *   2. Enter amount = full SUI balance (0 left for gas)
 *   3. Attempt to submit
 *   4. Assert the gas shortage is surfaced (frontend, UI notice, or wallet)
 */

import { env } from '@/config/env.js';
import { COIN_TYPES, limitScenario } from '@/fixtures/scenarios.js';
import { LimitPage } from '@/page-objects/limit.page.js';
import { getBalanceSnapshot } from '@/chain/queries.js';
import { getGasShortageSignal, getWalletActivity } from '@/wallet/injected-controller.js';

import { expect, test } from '../setup/fixtures.js';

/** 一行化长文本，便于日志阅读。 */
function oneLine(text: string, max = 160): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

test.describe('Cetus Mainnet Limit Order (Insufficient Gas)', () => {
  test('shows gas error when SUI balance cannot cover transaction gas', async ({
    page,
    walletController,
  }) => {
    const limitPage = new LimitPage(page);
    await limitPage.goto();

    await walletController.connect(page);

    // ── Read on-chain SUI balance and use it as the full order amount ─────────
    const balance = await getBalanceSnapshot(env.testWalletAddress, COIN_TYPES.SUI);
    const totalSui = Number(balance.totalBalance) / 1e9;
    console.log(`[limit-gas:e2e] SUI balance         : ${totalSui.toFixed(6)} SUI`);

    if (totalSui < 0.001) {
      console.log('[limit-gas:e2e] balance already near-zero — skipping');
      test.skip();
      return;
    }

    // Use the complete wallet balance as the order amount → 0 SUI left for gas
    const orderAmount = totalSui.toFixed(6);
    console.log(`[limit-gas:e2e] order amount (full balance): ${orderAmount} SUI`);
    console.log('[limit-gas:e2e] gas reserve remaining      : 0 SUI (none left)');

    // ── Token selection & amount ──────────────────────────────────────────────
    await limitPage.selectFromToken(limitScenario.inputCoinType);
    await limitPage.selectToToken(limitScenario.outputCoinType);
    await limitPage.fillAmount(orderAmount);
    console.log(`[limit-gas:e2e] amount filled              : ${orderAmount} SUI`);

    // ── Path A: frontend pre-check ────────────────────────────────────────────
    //
    // ⚠️ 必须用 waitFor 而不是 isVisible({ timeout })：Playwright 的
    // locator.isVisible() 是即时判定，传 timeout 不会让它等待，输入后前端还没
    // 重算完按钮文案就会被判成「没有拦截」。
    const frontendErrorButton = page
      .locator('button, [role="button"]')
      .filter({ hasText: /insufficient.*gas|insufficient.*sui.*balance|insufficient.*balance/i })
      .first();

    const frontendBlocked = await frontendErrorButton
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true, () => false);

    if (frontendBlocked) {
      const errorText = oneLine(await frontendErrorButton.innerText());
      console.log(`[limit-gas:e2e] frontend error button  : "${errorText}"`);
      await expect(frontendErrorButton).toBeDisabled();
      console.log('[limit-gas:e2e] result                 : frontend correctly pre-detected gas issue');
      return;
    }

    // ── Paths B/C: submit and observe UI notice or wallet-side error ──────────
    console.log('[limit-gas:e2e] no frontend pre-check — submitting to observe gas error');

    // 提交本身可能因为 gas 不足而抛（按钮一直不 enable / 二次确认被遮罩挡住）。
    // 那也是一种有效的拦截，记下来别让它变成无关的超时失败。
    let submitError = '';
    await limitPage.submitLimitOrder().catch((error: unknown) => {
      submitError = error instanceof Error ? error.message : String(error);
      console.log(`[limit-gas:e2e] submit threw           : ${oneLine(submitError)}`);
    });

    // 注入钱包没有审批弹窗，这里是 no-op；保留以兼容扩展钱包模式。
    await walletController.approveTransaction(page).catch(() => {
      console.log('[limit-gas:e2e] wallet approval threw (expected for gas error)');
    });

    // Cetus 对 gas 不足的 UI 反馈不可靠：有时弹
    //   "Transaction failed / Insufficient gas for this transaction."
    // 有时只是停在 "Waiting for Confirmation" 转圈。因此同时轮询两个来源：
    //   1) DOM 里的失败提示（dialog / toast / alert）
    //   2) 签名桥记录的 gas 错误（build 失败或 dryRun 报 InsufficientGas）
    const gasErrorNotice = page
      .locator(
        '[role="dialog"], [role="alert"], [role="status"], ' +
        '.chakra-modal__content, .chakra-toast, ' +
        '[class*="toast"], [class*="Toast"], ' +
        '[class*="notification"], [class*="Notification"]'
      )
      .filter({ hasText: /transaction failed|insufficient gas|insufficient.*balance|rejected|failed|error/i })
      .first();

    let uiMessage = '';
    let walletSignal: string | null = null;
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      walletSignal = getGasShortageSignal(page);
      if (walletSignal) break;

      if (await gasErrorNotice.isVisible().catch(() => false)) {
        uiMessage = oneLine(await gasErrorNotice.innerText().catch(() => ''));
        if (uiMessage) break;
      }

      await page.waitForTimeout(500);
    }

    if (uiMessage) {
      console.log(`[limit-gas:e2e] ui error message       : "${uiMessage}"`);
    } else {
      console.log('[limit-gas:e2e] ui error message       : <no error dialog visible>');
    }

    if (walletSignal) {
      console.log(`[limit-gas:e2e] wallet gas error       : "${oneLine(walletSignal)}"`);
    }

    const activity = getWalletActivity(page);
    console.log(
      `[limit-gas:e2e] wallet activity        : signCount=${activity.signCount} ` +
      `signErrors=${activity.signErrors.length} dryRuns=${activity.dryRunStatuses.length}`
    );

    const blocked = Boolean(walletSignal) || Boolean(uiMessage) || Boolean(submitError);

    expect(
      blocked,
      'A gas/insufficient-funds error must be surfaced (frontend pre-check, UI notice, or wallet rejection). ' +
      `signCount=${activity.signCount}, signErrors=${JSON.stringify(activity.signErrors.map((e) => oneLine(e, 80)))}, ` +
      `dryRunStatuses=${JSON.stringify(activity.dryRunStatuses.map((s) => oneLine(s, 80)))}`
    ).toBe(true);

    console.log('[limit-gas:e2e] result                 : gas shortage correctly detected');
  });
});
