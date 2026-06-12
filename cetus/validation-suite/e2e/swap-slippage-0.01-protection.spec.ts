import { env } from '@/config/env.js';
import { getBalanceSnapshot } from '@/chain/queries.js';
import { COIN_TYPES, TOKEN_DECIMALS } from '@/fixtures/scenarios.js';
import { SwapPage } from '@/page-objects/swap.page.js';
import { retry } from '@/utils/retry.js';

import { expect, test } from '../setup/fixtures.js';

/**
 * P0: slippage 0.01% 保护验证 — SUI → USDC 0.1 SUI
 *
 * 测试逻辑：
 * 1. 设置 slippage = 0.01%
 * 2. 执行 0.1 SUI → USDC swap
 * 3. 双结果判断：
 *    - 成交成功 → SDK 验证实际收到的 USDC ≥ minAmountOut（偏差 ≤ 0.01%）
 *    - 成交失败 → 前端显示 "Transaction failed / Exceeded price slippage"
 *                 即说明链上滑点保护已生效（tx revert）
 */

const INPUT_COIN  = COIN_TYPES.SUI;
const OUTPUT_COIN = COIN_TYPES.USDC;
const INPUT_AMOUNT_UI = '0.1';
const SLIPPAGE_PCT = '0.01';          // 0.01%
const SLIPPAGE_RATIO = 0.0001;        // 0.01% as decimal

/** 打开 Settings 弹窗，填写自定义滑点并保存 */
async function setSlippageViaModal(page: import('@playwright/test').Page, pct: string) {
  // 等待 swap 面板加载完成
  await page.getByText('Aggregator Mode').waitFor({ state: 'visible', timeout: 10_000 });

  // 滑点设置按钮：有 aria-haspopup="dialog" 且文字为纯百分比（排除钱包地址按钮）
  const settingsBtn = page
    .locator('[aria-haspopup="dialog"]')
    .filter({ hasText: /^\d+(\.\d+)?%$/ });
  await settingsBtn.click();

  const modal = page.locator('[role="dialog"]').filter({ hasText: 'Settings' }).first();
  await expect(modal).toBeVisible({ timeout: 5_000 });

  // 填写 Custom 输入框
  const input = modal.locator('input[placeholder="0.0"]').first();
  await input.fill(pct);
  await expect(input).toHaveValue(pct);

  // 保存使设置生效，弹窗关闭
  const saveBtn = modal.getByRole('button', { name: /^save$/i });
  await saveBtn.click();
  await expect(modal).toBeHidden({ timeout: 5_000 });

  console.log(`[slippage-protection] Slippage set to ${pct}% and saved`);
}

test.describe('Slippage 0.01% Protection (SUI → USDC)', () => {
  test('0.01% slippage triggers revert or passes within tolerance', async ({ page, walletController }) => {
    const outputDecimal = TOKEN_DECIMALS[OUTPUT_COIN] ?? 6;

    const swapPage = new SwapPage(page);
    await swapPage.goto('/swap');
    await walletController.connect(page);

    // Step 1: 设置滑点为 0.01%
    await setSlippageViaModal(page, SLIPPAGE_PCT);
    await page.waitForTimeout(500);

    // Step 2: 选择交易对，填写金额
    await swapPage.selectFromToken(INPUT_COIN);
    await swapPage.selectToToken(OUTPUT_COIN);
    await swapPage.fillAmount(INPUT_AMOUNT_UI);
    await page.waitForTimeout(2_000);

    // Step 3: 读取报价并计算 minAmountOut
    const expectedOutput = await swapPage.getExpectedOutputAmount(outputDecimal);
    const minAmountOut =
      (expectedOutput * BigInt(Math.floor((1 - SLIPPAGE_RATIO) * 1_000_000))) / BigInt(1_000_000);

    console.log(`[slippage-protection] Input: ${INPUT_AMOUNT_UI} SUI → USDC`);
    console.log(`[slippage-protection] Slippage: ${SLIPPAGE_PCT}%`);
    console.log(`[slippage-protection] Quote (expected output): ${expectedOutput} (raw, ${outputDecimal} decimals)`);
    console.log(`[slippage-protection] minAmountOut: ${minAmountOut} (raw)`);
    console.log(`[slippage-protection] minAmountOut: ${Number(minAmountOut) / 10 ** outputDecimal} USDC`);

    // Step 4: 记录 swap 前的 USDC 余额
    const beforeSnapshot = await getBalanceSnapshot(env.testWalletAddress, OUTPUT_COIN);
    console.log(`[slippage-protection] USDC balance before: ${beforeSnapshot.totalBalance} (raw)`);

    // Step 5: 提交 swap，钱包签名
    await swapPage.submitSwap();
    await walletController.approveTransaction(page);
    console.log('[slippage-protection] Transaction submitted and approved, waiting for outcome...');

    // Step 6: 等待链上结果（成功 or 滑点超限 revert）
    const successLocator  = page.getByText(/success|completed|submitted|view in explorer/i).first();
    const slippageErrLocator = page.getByText(/exceeded price slippage/i).first();
    const txFailedLocator    = page.getByText(/transaction failed/i).first();

    // 最多等 60s，逐秒轮询两种结果
    let outcome: 'success' | 'revert' | 'timeout' = 'timeout';
    for (let i = 0; i < 60; i++) {
      const [isSuccess, isSlippageErr, isTxFailed] = await Promise.all([
        successLocator.isVisible().catch(() => false),
        slippageErrLocator.isVisible().catch(() => false),
        txFailedLocator.isVisible().catch(() => false),
      ]);

      if (isSuccess)                    { outcome = 'success'; break; }
      if (isSlippageErr || isTxFailed)  { outcome = 'revert';  break; }
      await page.waitForTimeout(1_000);
    }

    console.log(`[slippage-protection] Outcome: ${outcome}`);

    // Step 7: 根据结果分支断言
    if (outcome === 'success') {
      // ── 成交成功：SDK 验证实际收到的 USDC ≥ minAmountOut ──
      console.log('[slippage-protection] Swap succeeded — verifying received amount via SDK...');

      const afterSnapshot = await retry(async () => {
        const snap = await getBalanceSnapshot(env.testWalletAddress, OUTPUT_COIN);
        if (snap.totalBalance <= beforeSnapshot.totalBalance) {
          throw new Error('Waiting for USDC balance to increase');
        }
        return snap;
      }, 24, 5_000);

      const actualReceived = afterSnapshot.totalBalance - beforeSnapshot.totalBalance;
      const actualDeviationPct =
        Math.abs(Number(actualReceived) - Number(expectedOutput)) / Number(expectedOutput) * 100;

      console.log(`[slippage-protection] Actual received: ${actualReceived} (raw)`);
      console.log(`[slippage-protection] Actual received: ${Number(actualReceived) / 10 ** outputDecimal} USDC`);
      console.log(`[slippage-protection] Deviation from quote: ${actualDeviationPct.toFixed(4)}%`);

      // 断言：实际收到 ≥ minAmountOut（滑点保护生效）
      expect(actualReceived).toBeGreaterThanOrEqual(minAmountOut);
      console.log(`[slippage-protection] ✓ actualReceived(${actualReceived}) >= minAmountOut(${minAmountOut})`);

      // 断言：偏差在 0.01% 容忍度内（含 0.01% 余量）
      expect(actualDeviationPct).toBeLessThanOrEqual(SLIPPAGE_RATIO * 100 + 0.01);
      console.log(`[slippage-protection] ✓ Deviation ${actualDeviationPct.toFixed(4)}% within ${SLIPPAGE_PCT}% slippage bound`);

    } else if (outcome === 'revert') {
      // ── 交易因滑点超限被 revert：前端提示"Exceeded price slippage" ──
      // 这正是链上滑点保护生效的表现
      console.log('[slippage-protection] Swap reverted due to slippage — verifying UI error message...');

      await expect(
        txFailedLocator,
        'Should show "Transaction failed" dialog'
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        slippageErrLocator,
        'Should show "Exceeded price slippage" error'
      ).toBeVisible({ timeout: 5_000 });

      console.log('[slippage-protection] ✓ UI correctly shows "Transaction failed / Exceeded price slippage"');
      console.log('[slippage-protection] ✓ On-chain slippage protection triggered (tx reverted as expected)');

    } else {
      // 超时：既没有成功也没有失败提示
      throw new Error(
        '[slippage-protection] Timed out waiting for transaction outcome (neither success nor slippage error appeared within 60s)'
      );
    }

    console.log(`[slippage-protection] ✓ Test passed — outcome: ${outcome}`);
  });
});
