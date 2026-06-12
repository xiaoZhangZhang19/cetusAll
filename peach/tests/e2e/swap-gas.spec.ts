/**
 * Test: Swap Gas Insufficient Warning Validation
 *
 * Gas 不足提示验证：输入一个超过钱包余额（或接近全部余额）的 BNB 数量，
 * 验证页面出现 "Must have 0.00005 BNB or more left in wallet for gas fee." 警告文案。
 * 本测试不执行真实交易。
 *
 * 测试流程：
 *   1. 连接 MetaMask 钱包
 *   2. 读取当前 BNB 余额
 *   3. 输入指定金额（默认使用 GAS_TEST_AMOUNT，或自动计算为余额本身）
 *   4. 等待页面响应，读取 gas 警告文案
 *   5. 验证文案包含期望关键词
 *
 * 环境变量配置（.env）：
 *   GAS_TEST_AMOUNT  – You Pay 填入的 BNB 数量（默认自动读取余额作为金额）
 *
 * 运行命令：
 *   npx playwright test tests/e2e/swap-gas.spec.ts
 *
 *   # 手动指定测试金额
 *   GAS_TEST_AMOUNT="0.021" npx playwright test tests/e2e/swap-gas.spec.ts
 */

import { SwapPage } from '../../src/page-objects/swap.page.js';
import { test, expect } from '../setup/fixtures.js';

// 期望的 gas 警告文案关键词
const EXPECTED_GAS_KEYWORD = 'Must have 0.00005 BNB or more left in wallet for gas fee.';

// 默认代币对（BNB → USDT）
const PAY_TOKEN     = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const RECEIVE_TOKEN = '0x55d398326f99059fF775485246999027B3197955';

test.describe('Peach Swap – Gas Insufficient Warning Validation', () => {
  test('shows gas fee warning when pay amount exceeds available balance', async ({
    page,
    metamask,
  }) => {
    test.setTimeout(180_000);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Peach Protocol – Gas Insufficient Warning Test');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Expected: "${EXPECTED_GAS_KEYWORD}"`);
    console.log('───────────────────────────────────────────────────────────');

    const swapPage = new SwapPage(page);

    // ── Step 1: 导航并连接钱包 ────────────────────────────────────────────
    console.log('\n[Step 1] Navigating and connecting wallet...');
    await swapPage.goto();
    await metamask.connect(page);
    await expect(page.locator('text=/0x[a-fA-F0-9]{3,}/i').first()).toBeVisible({ timeout: 10000 });
    console.log('✓ Wallet connected');

    // ── Step 2: 选择代币对（BNB → USDT）──────────────────────────────────
    console.log('\n[Step 2] Selecting token pair BNB → USDT...');
    await swapPage.selectToken('pay', PAY_TOKEN);
    await swapPage.selectToken('receive', RECEIVE_TOKEN);
    console.log('✓ Token pair selected');

    // ── Step 3: 读取 BNB 余额 ────────────────────────────────────────────
    console.log('\n[Step 3] Reading BNB balance...');
    const balance = await swapPage.getBnbBalance();
    console.log(`  BNB Balance: ${balance ?? 'unknown'}`);
    console.log(`##GAS_BALANCE:${balance ?? 0}##`);

    // 决定测试金额：优先用环境变量，否则用余额本身（触发 gas 不足）
    const envAmount = process.env.GAS_TEST_AMOUNT;
    let testAmount: string;
    if (envAmount && !isNaN(parseFloat(envAmount))) {
      testAmount = envAmount;
      console.log(`  Using env GAS_TEST_AMOUNT: ${testAmount}`);
    } else if (balance !== null && balance > 0) {
      // 用全部余额——留 0 给 gas，必然触发警告
      testAmount = balance.toString();
      console.log(`  Using full balance as amount: ${testAmount}`);
    } else {
      // fallback: 随便填一个很大的数
      testAmount = '999';
      console.log(`  Balance unknown, using fallback amount: ${testAmount}`);
    }

    // ── Step 4: 输入金额，等待 gas 警告出现 ──────────────────────────────
    console.log(`\n[Step 4] Entering pay amount: ${testAmount}...`);
    await swapPage.enterPayAmount(testAmount);
    // 等待 UI 响应（gas 警告需要报价完成后才显示）
    await page.waitForTimeout(3000);

    // ── Step 5: 读取 gas 警告文案 ─────────────────────────────────────────
    console.log('\n[Step 5] Reading gas warning...');
    const gasWarning = await swapPage.getGasWarning();
    console.log(`  Gas warning text: "${gasWarning}"`);

    const matched = gasWarning.toLowerCase().includes('gas') ||
                    gasWarning.toLowerCase().includes('left in wallet') ||
                    gasWarning.includes('0.00005');

    console.log(`  Expected keyword: "${EXPECTED_GAS_KEYWORD}"`);
    console.log(`  Match: ${matched ? '✅ YES' : '❌ NO'}`);

    // 输出结构化日志（供 dashboard 解析）
    console.log(`##GAS_RESULT:amount=${testAmount},matched=${matched},warning=${gasWarning.replace(/,/g, ';')}##`);

    // ── 汇总 ─────────────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  GAS WARNING VALIDATION REPORT');
    console.log(`${'═'.repeat(60)}`);
    console.log(`  Pay amount:   ${testAmount} BNB`);
    console.log(`  BNB balance:  ${balance ?? 'unknown'}`);
    console.log(`  Warning text: "${gasWarning}"`);
    console.log(`  Result:       ${matched ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`${'═'.repeat(60)}\n`);

    expect(
      matched,
      `Expected gas warning to contain "gas fee" related text, got: "${gasWarning}"`,
    ).toBe(true);
  });
});
