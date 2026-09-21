import { env } from '@/config/env.js';
import { getBalanceSnapshot } from '@/chain/queries.js';
import { swapScenario, TOKEN_DECIMALS } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';

import { expect, test } from '../setup/fixtures.js';

/** 「余额不足」类文案的统一匹配规则（按钮文案与内联提示共用）。 */
const INSUFFICIENT_PATTERN = /insufficient.*balance|not enough|exceeds balance/i;

test.describe('Swap Insufficient Balance', () => {
  /**
   * 超额金额 + 等额边界两个校验合并在同一个页面会话内完成。
   *
   * 合并原因：两者都只读取 UI 表单状态、不上链，拆成两个 test 会各自
   * goto + connect 一次，白白多付一次页面加载和钱包连接的时间。
   *
   * P0：输入金额大于钱包余额时，Swap 按钮必须置灰（或出现错误提示），
   *     且不弹出钱包签名框。
   * P1：输入金额恰好等于钱包余额时，不应出现余额不足提示（边界值）。
   */
  test('blocks excess amount and allows exact balance', async ({ page, walletController }) => {
    const swapPage = new SwapPage(page);
    await swapPage.goto(swapScenario.path);
    await walletController.connect(page);

    await swapPage.selectFromToken(swapScenario.inputCoinType);
    await swapPage.selectToToken(swapScenario.outputCoinType);

    // 链上真实余额：超额与等额两个用例共用这一次查询
    const snapshot = await getBalanceSnapshot(env.testWalletAddress, swapScenario.inputCoinType);
    const decimal = TOKEN_DECIMALS[swapScenario.inputCoinType] ?? 9;
    const balanceUi = Number(snapshot.totalBalance) / 10 ** decimal;
    const excessAmount = (balanceUi * 1.5).toFixed(decimal);
    const exactAmount = balanceUi.toFixed(decimal);

    console.log(`[insufficient] Wallet balance: ${balanceUi} ${swapScenario.fromTokenSymbol}`);

    // ── Phase 1: 超额金额必须被拦截 ────────────────────────────────────────────
    console.log(`[insufficient] Phase 1 - excess amount: ${excessAmount} ${swapScenario.fromTokenSymbol}`);
    await swapPage.fillAmount(excessAmount);

    const swapButton = page.getByRole('button', { name: /^swap!?$/i }).first();
    const insufficientMsg = page.getByText(INSUFFICIENT_PATTERN).first();

    // 不 sleep 2s：轮询等「按钮置灰」或「出现余额不足提示」任一成立即继续。
    // 拦截态一般在输入后几百毫秒内就出现，固定等待是白等；
    // 真的没拦截时，轮询到 10s 超时再按 false 断言失败，语义不变。
    let isDisabled = false;
    let hasErrorMsg = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      isDisabled = await swapButton.isDisabled({ timeout: 1_000 }).catch(() => false);
      hasErrorMsg = await insufficientMsg.isVisible({ timeout: 500 }).catch(() => false);
      if (isDisabled || hasErrorMsg) break;
      await page.waitForTimeout(200);
    }

    console.log(`[insufficient] Button disabled: ${isDisabled}`);
    console.log(`[insufficient] Error message visible: ${hasErrorMsg}`);

    if (hasErrorMsg) {
      const msgText = await insufficientMsg.innerText().catch(() => '');
      console.log(`[insufficient] ✓ Error message: "${msgText}"`);
    }

    // 两种拦截形式至少出现一种
    expect(
      isDisabled || hasErrorMsg,
      'Swap must be blocked when the amount exceeds the wallet balance'
    ).toBe(true);

    // ── Phase 2: 等额金额不应被拦截（边界值）──────────────────────────────────
    console.log(`[insufficient] Phase 2 - exact balance: ${exactAmount} ${swapScenario.fromTokenSymbol}`);
    await swapPage.fillAmount(exactAmount);

    // 同一页面内复用时不能只 sleep 固定时长：Phase 1 的余额不足提示要等
    // Cetus 用新金额重新校验后才会消失，轮询到它消失（或超时）再断言。
    const cleared = await waitForInsufficientCleared(page, swapPage, 15_000);

    expect(
      cleared,
      'No insufficient-balance hint may remain when the amount equals the wallet balance'
    ).toBe(true);
    console.log('[insufficient] ✓ No insufficient-balance error when using exact balance');
  });
});

/**
 * 轮询等待「余额不足」状态消失。
 *
 * 同时看内联提示和主按钮文案：Cetus 在余额不足时把按钮文案直接改成
 * "Insufficient SUI Balance"，只看内联提示会漏判。
 */
async function waitForInsufficientCleared(
  page: import('@playwright/test').Page,
  swapPage: SwapPage,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const insufficientMsg = page.getByText(INSUFFICIENT_PATTERN).first();
  let lastButtonText = '';

  while (Date.now() < deadline) {
    const msgVisible = await insufficientMsg.isVisible({ timeout: 500 }).catch(() => false);
    lastButtonText = await swapPage.readActionButtonText().catch(() => '');
    const buttonBlocked = INSUFFICIENT_PATTERN.test(lastButtonText);

    if (!msgVisible && !buttonBlocked) return true;
    await page.waitForTimeout(500);
  }

  console.warn(`[insufficient] still blocked after ${timeoutMs}ms, button text = "${lastButtonText}"`);
  return false;
}
