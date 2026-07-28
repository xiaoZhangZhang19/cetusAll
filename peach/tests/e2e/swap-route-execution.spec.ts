/**
 * Test: Swap Route Execution with MetaMask Wallet
 *
 * 综合测试：连接 MetaMask 钱包，选择指定的流动性路由，执行实际的 swap 交易。
 * 用于验证特定路由在真实链上环境中的工作状态。
 *
 * 测试流程：
 *   1. 连接 MetaMask 钱包到 Peach Protocol
 *   2. 根据传参选择指定的流动性路由
 *   3. 输入 swap 金额（BNB → USDT）
 *   4. 验证获得有效报价
 *   5. 执行实际的 swap 交易
 *   6. 验证交易成功提交
 *
 * 前置条件：
 *   1. MetaMask 扩展已安装并配置（WALLET_EXTENSION_PATH）
 *   2. 测试钱包已导入（通过 WALLET_SEED_PHRASE）
 *   3. 测试钱包持有足够的 BNB（用于 swap 和 gas）
 *   4. 测试钱包已连接到 BNB Smart Chain
 *
 * 环境变量配置（.env）：
 *   WALLET_EXTENSION_PATH  – MetaMask 扩展文件夹路径
 *   WALLET_SEED_PHRASE     – 钱包助记词（仅用测试钱包！）
 *   WALLET_PASSWORD        – MetaMask 解锁密码
 *   WALLET_ADDRESS         – 预期的钱包地址（可选，用于断言）
 *   PEACH_ROUTES           – 要测试的路由列表（逗号分隔）
 *   SWAP_PAY_AMOUNT        – swap 金额（默认 0.001）
 *   SWAP_PAY_TOKEN         – You Pay 代币地址（默认 BNB）
 *   SWAP_RECEIVE_TOKEN     – You Receive 代币地址（默认 USDT）
 *   EXECUTE_SWAP           – 是否执行真实交易（默认 false，测试时设为 true）
 *   SWAP_SLIPPAGE          – 滑点百分比（默认 0.5），在选路由前设置
 *
 * 默认 Token 地址：
 *   BNB:  0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
 *   USDT: 0x55d398326f99059fF775485246999027B3197955
 *
 * 运行命令：
 *   # 仅验证报价（不执行交易）
 *   npm run test:e2e:swap:execute
 *
 *   # 执行实际交易
 *   EXECUTE_SWAP=true npm run test:e2e:swap:execute
 *
 *   # 指定特定路由测试
 *   PEACH_ROUTES="Uniswap V3,PancakeSwap V3" EXECUTE_SWAP=true npm run test:e2e:swap:execute
 *
 *   # 指定自定义代币对测试
 *   SWAP_PAY_TOKEN="0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" \
 *   SWAP_RECEIVE_TOKEN="0x55d398326f99059fF775485246999027B3197955" \
 *   npm run test:e2e:swap:execute
 *
 *   # 指定滑点（选路由之前设置）
 *   SWAP_SLIPPAGE="1.0" EXECUTE_SWAP=true npm run test:e2e:swap:execute
 */

import { SwapPage } from '../../src/page-objects/swap.page.js';
import { env, PEACH_ROUTES } from '../../src/config/env.js';
import { test, expect } from '../setup/fixtures.js';
import type { BalanceChecker } from '../../src/utils/balance-checker.js';

// 默认 Token 地址配置（BNB Smart Chain）
const DEFAULT_TOKEN_ADDRESSES = {
  BNB:  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  USDT: '0x55d398326f99059fF775485246999027B3197955',
} as const;

// 测试参数配置
const SWAP_PAY_AMOUNT = process.env.SWAP_PAY_AMOUNT ?? '0.001';
const SWAP_PAY_TOKEN = process.env.SWAP_PAY_TOKEN ?? DEFAULT_TOKEN_ADDRESSES.BNB;
const SWAP_RECEIVE_TOKEN = process.env.SWAP_RECEIVE_TOKEN ?? DEFAULT_TOKEN_ADDRESSES.USDT;
// EXECUTE_SWAP 默认 false（安全默认值）。dashboard 开关或 EXECUTE_SWAP=true 才发送真实链上交易
const EXECUTE_SWAP = process.env.EXECUTE_SWAP === 'true';

// Token pool for per-route random selection
// Format: JSON array of { label, address } objects, e.g.:
//   '[{"label":"BNB","address":"0xeeee..."},{"label":"USDT","address":"0x55d3..."}]'
// When set, each route picks two distinct tokens at random.
interface PoolToken { label: string; address: string; }
const RAW_TOKEN_POOL = process.env.SWAP_TOKEN_POOL ?? '';
const TOKEN_POOL: PoolToken[] = (() => {
  if (!RAW_TOKEN_POOL) return [];
  try { return JSON.parse(RAW_TOKEN_POOL) as PoolToken[]; } catch { return []; }
})();

function pickTwoRandom(pool: PoolToken[]): [PoolToken, PoolToken] | null {
  if (pool.length < 2) return null;
  const i = Math.floor(Math.random() * pool.length);
  let j = Math.floor(Math.random() * (pool.length - 1));
  if (j >= i) j++;
  return [pool[i], pool[j]];
}
// TEST_ALL_ROUTES - 是否测试所有 24 个路由（每个路由单独执行一次 swap）
// 开启后自动强制 EXECUTE_SWAP=true，因为全路由测试的目的就是验证链上真实可用性
const TEST_ALL_ROUTES = process.env.TEST_ALL_ROUTES === 'true';
// SWAP_SLIPPAGE - 在选路由之前设置的滑点值（百分比，如 "0.5" "1.0" "2.5"）
// 不设置则跳过滑点设置步骤，使用页面默认值
const SWAP_SLIPPAGE = process.env.SWAP_SLIPPAGE ?? '';

// BSC RPC URL（可以通过环境变量配置）
const BSC_RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/';

test.describe('Peach Swap – Route Execution Test', () => {
  test('selects route and executes swap transaction', async ({
    workerPage: page,
    workerMetamask: metamask,
    workerBalanceChecker: balanceChecker,
  }) => {
    // ── 决定测试模式 ───────────────────────────────────────────────────────
    // TEST_ALL_ROUTES=true  → 逐条测试全部 24 条（不需要选路由）
    // TEST_ALL_ROUTES=false → 组合模式：先多路由组合 swap，再逐条 swap
    // 无任何配置         → 默认 Uniswap V3 单次 swap
    // ──────────────────────────────────────────────────────────────────────
    let routesToTest: string[];
    let testMode: string;

    if (TEST_ALL_ROUTES) {
      // 全部路由逐条模式（不依赖 PEACH_ROUTES 选择）
      routesToTest = [...PEACH_ROUTES];
      testMode = `ALL_ROUTES: ${PEACH_ROUTES.length} routes, one swap each`;
    } else if (env.selectedRoutes.length > 0) {
      // 组合模式：选中路由组合 + 逐条
      routesToTest = env.selectedRoutes;
      testMode = `COMBINED: ${routesToTest.length} selected routes (combined swap → per-route swap)`;
    } else {
      // 默认
      routesToTest = ['Uniswap V3'];
      testMode = 'DEFAULT: Uniswap V3 single swap';
    }

    // 超时时间：全路由模式 2 小时，组合模式按路由数×2 分钟，默认 5 分钟
    const timeoutMs = TEST_ALL_ROUTES
      ? 7200_000
      : routesToTest.length > 1
      ? routesToTest.length * 2 * 60_000 * 2 // combined + per-route × 2 min each
      : 300_000;
    test.setTimeout(timeoutMs);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Peach Protocol - Route Execution Test');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Mode:          ${testMode}`);
    console.log(`Routes:        ${routesToTest.join(', ')}`);
    console.log(`Routes Count:  ${routesToTest.length}`);
    console.log(`Swap Amount:   ${SWAP_PAY_AMOUNT}`);
    console.log(`Execute Swap:  ${EXECUTE_SWAP ? 'YES (Real transaction)' : 'NO (Dry run)'}`);
    console.log(`Slippage:      ${SWAP_SLIPPAGE ? SWAP_SLIPPAGE + '%' : '(default)'}`);
    console.log(`Pay Token:     ${SWAP_PAY_TOKEN}`);
    console.log(`Receive Token: ${SWAP_RECEIVE_TOKEN}`);
    console.log(`Available:     ${PEACH_ROUTES.length} routes total`);
    console.log('───────────────────────────────────────────────────────────');

    const swapPage = new SwapPage(page);

    // ═══════════════════════════════════════════════════════════════════════
    // Step 1: 导航到页面并连接钱包
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[Step 1/5] Navigating and connecting wallet...');
    await swapPage.goto();
    await metamask.connect(page);

    // 验证钱包地址
    let walletAddress = env.walletAddress;
    
    if (walletAddress) {
      const addrShort = walletAddress.slice(0, 6).toLowerCase();
      await expect(
        page.locator(`text=/${addrShort}/i`).first(),
      ).toBeVisible({ timeout: 10000 });
      console.log(`✓ Wallet connected: ${walletAddress}`);
    } else {
      await expect(
        page.locator('text=/0x[a-fA-F0-9]{3,}/i').first(),
      ).toBeVisible({ timeout: 10000 });
      console.log('✓ Wallet connected successfully');
      
      const fullAddressLocator = page.locator('text=/0x[a-fA-F0-9]{40}/i').first();
      const fullAddressText = await fullAddressLocator.textContent({ timeout: 3000 }).catch(() => null);
      
      if (fullAddressText) {
        const match = fullAddressText.match(/0x[a-fA-F0-9]{40}/i);
        if (match) {
          walletAddress = match[0];
          console.log(`  ✓ Extracted wallet address: ${walletAddress}`);
          (env as any).walletAddress = walletAddress;
        }
      }
      
      if (!walletAddress) {
        console.log('  Attempting to extract address from wallet button...');
        const walletBtn = page.locator('button, div').filter({ hasText: /0x[a-fA-F0-9]{3,}/i }).first();
        const btnText = await walletBtn.textContent({ timeout: 3000 }).catch(() => null);
        
        if (btnText) {
          const shortMatch = btnText.match(/0x[a-fA-F0-9]{4,}/i);
          if (shortMatch) {
            console.log(`  Found shortened address: ${shortMatch[0]}`);
            console.log('  ⚠️  Cannot extract full address from UI');
          }
        }
      }
      
      if (!walletAddress) {
        console.log('\n⚠️  Warning: Could not extract wallet address from UI');
        console.log('   Please set WALLET_ADDRESS in your .env file for balance verification');
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 根据模式分发执行
    // ═══════════════════════════════════════════════════════════════════════
    if (TEST_ALL_ROUTES) {
      // 模式 A：全部 24 条路由，每条各做一次 swap
      await testAllRoutesSequentially(swapPage, page, metamask, routesToTest, walletAddress, false, balanceChecker);
    } else if (routesToTest.length > 1) {
      // 模式 B：组合模式（2+ 条路由）
      //   B-1. 先同时选中全部选中路由，做一次组合 swap
      //   B-2. 再逐条单独 swap
      console.log('\n📋 COMBINED MODE');
      console.log(`##COMBINED_ROUTES:${routesToTest.join(',')}##`);

      console.log('  Phase 1: Combined swap with all selected routes');
      console.log('##COMBINED_RUNNING##');
      try {
        // When token pool is active, pick a random pair for the combined swap
        let combinedPayToken     = SWAP_PAY_TOKEN;
        let combinedReceiveToken = SWAP_RECEIVE_TOKEN;
        if (TOKEN_POOL.length >= 2) {
          const pair = pickTwoRandom(TOKEN_POOL);
          if (pair) {
            combinedPayToken     = pair[0].address;
            combinedReceiveToken = pair[1].address;
            console.log(`  🎲 Combined random token pair: ${pair[0].label} → ${pair[1].label}`);
          }
        }
        await testSingleRoute(swapPage, page, metamask, routesToTest, walletAddress, balanceChecker, combinedPayToken, combinedReceiveToken);
        console.log('##COMBINED_PASSED##');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`##COMBINED_FAILED:${msg}##`);
        throw err;
      }

      console.log('\n  Phase 2: Individual swap per route');
      // Phase 2 always re-selects tokens per route (token pool mode picks randomly each time)
      await testAllRoutesSequentially(swapPage, page, metamask, routesToTest, walletAddress, false, balanceChecker);
    } else {
      // 模式 C：单路由（默认或只选了 1 条）
      // 同样走 testAllRoutesSequentially，保证输出统一的 Route "X" PASSED/FAILED
      // 标记，Dashboard 才能正确解析并更新路由状态格子
      await testAllRoutesSequentially(swapPage, page, metamask, routesToTest, walletAddress, false, balanceChecker);
    }
  });
});

/**
 * 测试单个或选定的路由（原有逻辑）
 * payToken / receiveToken 可选覆盖，用于 token pool 随机模式
 */
async function testSingleRoute(
  swapPage: SwapPage,
  page: any,
  metamask: any,
  routesToTest: string[],
  walletAddress: string | undefined,
  balanceChecker: BalanceChecker,
  payToken  = SWAP_PAY_TOKEN,
  receiveToken = SWAP_RECEIVE_TOKEN,
) {
  // ═══════════════════════════════════════════════════════════════════════
  // Step 1.5: 设置滑点（在选路由之前）
  // ═══════════════════════════════════════════════════════════════════════
  if (SWAP_SLIPPAGE) {
    console.log(`\n[Step 1.5] Setting slippage to ${SWAP_SLIPPAGE}%...`);
    await swapPage.setSlippage(SWAP_SLIPPAGE);
    console.log(`✓ Slippage set to ${SWAP_SLIPPAGE}%`);
  } else {
    console.log('\n[Step 1.5] Slippage: using page default (SWAP_SLIPPAGE not set)');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Step 2: 选择指定的流动性路由
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n[Step 2/5] Selecting ${routesToTest.length} route(s)...`);
  const selectedCount = await swapPage.selectRoutes(routesToTest as unknown as string[]);
    
    expect(
      selectedCount,
      `Should have selected ${routesToTest.length} route(s)`,
    ).toBe(routesToTest.length);
    
    console.log(`✓ Selected routes: ${routesToTest.join(', ')}`);

    // 确认设置更改
    await swapPage.confirmSettingsChanges();
    console.log('✓ Settings confirmed');

    // ═══════════════════════════════════════════════════════════════════════
    // Step 3: 选择代币对并输入 swap 金额
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`\n[Step 3/5] Selecting tokens and fetching quote...`);
    console.log(`Pay:     ${payToken}`);
    console.log(`Receive: ${receiveToken}`);

    // 设置 You Pay 和 You Receive 代币（先检查当前代币，已正确则跳过）
    await swapPage.selectToken('pay', payToken);
    await swapPage.selectToken('receive', receiveToken);

    console.log(`Amount: ${SWAP_PAY_AMOUNT}`);
    await swapPage.enterPayAmount(SWAP_PAY_AMOUNT);
    const receiveAmount = await swapPage.getReceiveAmount();

    // 验证报价
    expect(
      receiveAmount,
      'Route should return a valid quote',
    ).toBeTruthy();

    const receiveValue = parseFloat(receiveAmount || '0');
    expect(
      receiveValue,
      'Receive amount should be greater than 0',
    ).toBeGreaterThan(0);

    console.log(`✓ Quote received: ${SWAP_PAY_AMOUNT} → ${receiveAmount}`);
    console.log(`  Pay: ${payToken}`);
    console.log(`  Receive: ${receiveAmount} (${receiveToken})`);
    console.log(`  Route: ${routesToTest.join(', ')}`);

    // 计算简单的价格比率
    const exchangeRate = receiveValue / parseFloat(SWAP_PAY_AMOUNT);
    console.log(`  Exchange rate: 1 : ${exchangeRate.toFixed(6)}`);

    // ═══════════════════════════════════════════════════════════════════════
    // Step 4: 执行 swap 交易
    // ═══════════════════════════════════════════════════════════════════════
    if (EXECUTE_SWAP) {
      console.log('\n[Step 4/5] Executing swap transaction...');
      console.log('⚠️  Real on-chain transaction — this will cost gas!');

      // 确保我们有钱包地址
      const walletAddress = env.walletAddress;
      if (!walletAddress) {
        console.log('\n⚠️  Skipping balance verification - wallet address not available');
        console.log('   To enable balance verification, set WALLET_ADDRESS in your .env file');
        console.log('   Example: WALLET_ADDRESS=0x1234567890abcdef1234567890abcdef12345678');
        
        // 仍然执行 swap，但跳过余额验证
        // executeSwap 会自动检测 "Approve and Swap" / "Confirm Swap" 两种弹窗
        await swapPage.executeSwap(metamask);
        
        // 等待成功对话框
        console.log('\n⏳ Waiting for transaction confirmation...');
        const swapResult1 = await swapPage.waitForSwapSuccess(180_000, routesToTest.join(', '));
        if (!swapResult1.success) {
          const msg = swapResult1.reason === 'on-chain-failure'
            ? `On-chain transaction failed: ${swapResult1.errorText ?? 'Transaction failed'}`
            : 'Swap timed out waiting for confirmation';
          throw new Error(msg);
        }
        expect(swapResult1.success, 'Swap should complete successfully').toBe(true);
        console.log('✓ Swap transaction completed successfully');
      } else {
        // 有钱包地址，执行完整的余额验证流程
        console.log('\n📊 Checking on-chain balances before swap...');
        console.log(`  Wallet: ${walletAddress}`);
        
        const payBalanceBefore = await balanceChecker.getBalance(payToken, walletAddress);
        const receiveBalanceBefore = await balanceChecker.getBalance(receiveToken, walletAddress);
        
        console.log(`  Pay token (${payToken}): ${payBalanceBefore}`);
        console.log(`  Receive token (${receiveToken}): ${receiveBalanceBefore}`);

        // 执行 swap，executeSwap 会自动检测弹窗类型：
        //   - 首次 approve 的 ERC-20 代币 → "Approve and Swap"（2 次 MetaMask 确认）
        //   - 已有 Permit2 授权的代币（如 USDT）→ "Confirm Swap"（1 次 MetaMask 确认）
        await swapPage.executeSwap(metamask);

        // 等待成功对话框
        console.log('\n⏳ Waiting for transaction confirmation...');
        const swapResult2 = await swapPage.waitForSwapSuccess(180_000, routesToTest.join(', '));
        if (!swapResult2.success) {
          const msg = swapResult2.reason === 'on-chain-failure'
            ? `On-chain transaction failed: ${swapResult2.errorText ?? 'Transaction failed'}`
            : 'Swap timed out waiting for confirmation';
          throw new Error(msg);
        }
        expect(swapResult2.success, 'Swap should complete successfully').toBe(true);
        console.log('✓ Swap transaction completed successfully');

        // 等待区块确认，让余额更新
        console.log('\n⏳ Waiting for balance updates (10 seconds)...');
        await page.waitForTimeout(10000);

        // 检查交易后的余额
        console.log('\n📊 Checking on-chain balances after swap...');
        const payBalanceAfter = await balanceChecker.getBalance(payToken, walletAddress);
        const receiveBalanceAfter = await balanceChecker.getBalance(receiveToken, walletAddress);
        
        console.log(`  Pay token (${payToken}): ${payBalanceAfter}`);
        console.log(`  Receive token (${receiveToken}): ${receiveBalanceAfter}`);

        // 验证余额变化
        const payBefore = parseFloat(payBalanceBefore);
        const payAfter = parseFloat(payBalanceAfter);
        const receiveBefore = parseFloat(receiveBalanceBefore);
        const receiveAfter = parseFloat(receiveBalanceAfter);

        const payDecreased = payAfter < payBefore;
        const receiveIncreased = receiveAfter > receiveBefore;

        const payDiff = payBefore - payAfter;
        const receiveDiff = receiveAfter - receiveBefore;

        // 当 receive token 是原生代币（BNB）时，gas 费也从 BNB 扣除，
        // 收到的 BNB 可能被 gas 抵消后净值反而下降，跳过增加断言。
        const receiveIsNative = receiveToken.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

        console.log('\n💰 Balance changes:');
        console.log(`  Pay token:     ${payBefore.toFixed(8)} → ${payAfter.toFixed(8)}`);
        console.log(`                 ${payDecreased ? `✓ Decreased by ${payDiff.toFixed(8)}` : '✗ No decrease'}`);
        console.log(`  Receive token: ${receiveBefore.toFixed(8)} → ${receiveAfter.toFixed(8)}`);
        if (receiveIsNative) {
          console.log(`                 native token — net Δ=${receiveDiff.toFixed(8)} (gas included, skipping increase check)`);
        } else {
          console.log(`                 ${receiveIncreased ? `✓ Increased by ${receiveDiff.toFixed(8)}` : '✗ No increase'}`);
        }

        // 验证余额变化
        expect(payDecreased, `Pay token balance should decrease. Before: ${payBefore}, After: ${payAfter}`).toBe(true);
        if (!receiveIsNative) {
          expect(receiveIncreased, `Receive token balance should increase. Before: ${receiveBefore}, After: ${receiveAfter}`).toBe(true);
        }
        
        // 验证变化量是否合理（pay amount 应该接近设定的金额）
        const expectedPayAmount = parseFloat(SWAP_PAY_AMOUNT);
        const payDiffRatio = Math.abs(payDiff - expectedPayAmount) / expectedPayAmount;
        
        // 允许 5% 的误差（因为有 gas 费用）
        if (payDiffRatio > 0.05) {
          console.log(`⚠️  Warning: Pay amount difference (${payDiff.toFixed(8)}) differs significantly from expected (${expectedPayAmount})`);
        } else {
          console.log(`✓ Pay amount matches expected: ~${expectedPayAmount}`);
        }
        
        console.log('\n✓ Balance changes verified successfully');
      }
    } else {
      console.log('\n[Step 4/5] 🔍 Dry run — skipping on-chain transaction');
      console.log('  (Set EXECUTE_SWAP=true or enable the dashboard toggle to send real transactions)');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Step 5: 验证结果
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[Step 5/5] Test validation...');
    console.log(`✓ Token pair:  ${payToken}`);
    console.log(`               → ${receiveToken}`);
    console.log(`✓ Route:       ${routesToTest.join(', ')}`);
    console.log(`✓ Quote:       ${SWAP_PAY_AMOUNT} → ${receiveAmount}`);

    if (EXECUTE_SWAP) {
      console.log('✓ Swap transaction executed on-chain');
    } else {
      console.log('✓ Dry run completed — quote verified, no on-chain transaction');
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  ✓ All tests passed');
    console.log('═══════════════════════════════════════════════════════════\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 执行所有路由的顺序测试
// ─────────────────────────────────────────────────────────────────────────────

interface RouteResult {
  route:         string;
  status:        'passed' | 'failed' | 'skipped';
  quote?:        string;
  exchangeRate?: string;
  payBefore?:    string;
  payAfter?:     string;
  receiveBefore?: string;
  receiveAfter?: string;
  error?:        string;
  durationMs:    number;
}

async function testAllRoutesSequentially(
  swapPage: SwapPage,
  page: any,
  metamask: any,
  routes: string[],
  walletAddress: string | undefined,
  skipTokenSelection = false,
  balanceChecker: BalanceChecker,
) {
  const results: RouteResult[] = [];
  // When token pool has 2+ entries, always re-pick tokens per route (ignore skipTokenSelection)
  const useTokenPool = TOKEN_POOL.length >= 2;

  // In non-pool mode: first iteration skips token selection only if Phase 1 already selected them.
  // In pool mode: always re-select, so tokensSelected starts as false regardless.
  let tokensSelected = !useTokenPool && skipTokenSelection;
  let pageReloaded = false;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Starting sequential test for ${routes.length} routes`);
  console.log(`  Mode: ${EXECUTE_SWAP ? '⚠️  REAL on-chain swap per route' : '🔍 Dry run — quote only, no on-chain tx'}`);
  console.log(`${'═'.repeat(60)}`);

  // ── 在开始路由循环之前先设置滑点（如果配置了的话）──────────────────────
  if (SWAP_SLIPPAGE) {
    console.log(`\n[Setup] Setting slippage to ${SWAP_SLIPPAGE}% before route loop...`);
    await swapPage.setSlippage(SWAP_SLIPPAGE);
    console.log(`✓ Slippage set to ${SWAP_SLIPPAGE}%`);
  } else {
    console.log('\n[Setup] Slippage: using page default (SWAP_SLIPPAGE not set)');
  }

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    const startMs = Date.now();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  [${i + 1}/${routes.length}] Testing route: ${route}`);
    console.log(`${'─'.repeat(60)}`);

    try {
      // ── Step A: 选择路由 ────────────────────────────────────────────────
      console.log(`\n[Route ${i + 1}] Selecting route...`);
      const selectedCount = await swapPage.selectRoutes([route]);
      if (selectedCount !== 1) {
        throw new Error(`Expected to select 1 route but got ${selectedCount}`);
      }
      await swapPage.confirmSettingsChanges();
      console.log(`✓ Route "${route}" selected`);

      // ── Step B: 选择代币并获取报价 ──────────────────────────────────────
      // 当启用 token pool 时，每条路由随机选两个不同 token
      let routePayToken     = SWAP_PAY_TOKEN;
      let routeReceiveToken = SWAP_RECEIVE_TOKEN;
      if (useTokenPool) {
        const pair = pickTwoRandom(TOKEN_POOL);
        if (pair) {
          routePayToken     = pair[0].address;
          routeReceiveToken = pair[1].address;
          console.log(`\n[Route ${i + 1}] 🎲 Random token pair: ${pair[0].label} → ${pair[1].label}`);
        }
        // Token pool mode: always re-select tokens for each route
        await swapPage.selectToken('pay',     routePayToken);
        await swapPage.selectToken('receive', routeReceiveToken);
        pageReloaded = false;
      } else if (!tokensSelected || pageReloaded) {
        if (pageReloaded) {
          console.log(`\n[Route ${i + 1}] Re-selecting tokens after page reload...`);
        } else {
          console.log(`\n[Route ${i + 1}] Selecting tokens for the first time...`);
        }
        await swapPage.selectToken('pay',     routePayToken);
        await swapPage.selectToken('receive', routeReceiveToken);
        tokensSelected = true;
        pageReloaded = false;
      } else {
        console.log(`\n[Route ${i + 1}] Fetching quote (reusing existing token pair)...`);
      }
      await swapPage.enterPayAmount(SWAP_PAY_AMOUNT);
      const receiveAmount = await swapPage.getReceiveAmount();

      if (!receiveAmount || parseFloat(receiveAmount) <= 0) {
        throw new Error(`No valid quote for route "${route}"`);
      }
      const exchangeRate = (parseFloat(receiveAmount) / parseFloat(SWAP_PAY_AMOUNT)).toFixed(6);
      console.log(`✓ Quote: ${SWAP_PAY_AMOUNT} → ${receiveAmount} (rate: 1 : ${exchangeRate})`);

      if (EXECUTE_SWAP) {
        // ── Step C: 查询交易前余额 ─────────────────────────────────────────
        let payBefore = '', payAfter = '', receiveBefore = '', receiveAfter = '';
        if (walletAddress) {
          console.log(`\n[Route ${i + 1}] Checking balances before swap...`);
          payBefore     = await balanceChecker.getBalance(routePayToken,     walletAddress);
          receiveBefore = await balanceChecker.getBalance(routeReceiveToken, walletAddress);
          console.log(`  Pay:     ${payBefore}`);
          console.log(`  Receive: ${receiveBefore}`);
        }

        // ── Step D: 执行真实 swap ──────────────────────────────────────────
        console.log(`\n[Route ${i + 1}] Executing swap (real on-chain transaction)...`);
        // executeSwap 自动检测弹窗类型并处理对应次数的 MetaMask 确认
        await swapPage.executeSwap(metamask);

        const SWAP_SUCCESS_TIMEOUT = 180_000;
        const swapResult = await swapPage.waitForSwapSuccess(SWAP_SUCCESS_TIMEOUT, `Route ${i + 1}/${routes.length}`);
        if (!swapResult.success) {
          if (swapResult.reason === 'on-chain-failure') {
            throw new Error(`On-chain TX failed: ${swapResult.errorText ?? 'Transaction failed'}`);
          }
          throw new Error(`Swap timed out (waited ${SWAP_SUCCESS_TIMEOUT / 1000}s)`);
        }
        console.log(`✓ Swap confirmed on-chain`);

        // ── Step E: 查询交易后余额并校验 ──────────────────────────────────
        if (walletAddress) {
          console.log(`\n[Route ${i + 1}] Waiting 10s for balance update...`);
          await page.waitForTimeout(10_000);
          payAfter     = await balanceChecker.getBalance(routePayToken,     walletAddress);
          receiveAfter = await balanceChecker.getBalance(routeReceiveToken, walletAddress);

          const decreased = parseFloat(payAfter)     < parseFloat(payBefore);
          const increased = parseFloat(receiveAfter) > parseFloat(receiveBefore);

          // 当 receive token 是原生代币（BNB）时，同一笔交易的 gas 费也从 BNB 扣除，
          // 导致收到的 BNB 可能被 gas 抵消后净值反而下降，因此不对原生代币做增加断言，
          // 只验证 pay token 确实减少即可。
          const receiveIsNative = routeReceiveToken.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
          // 当 pay token 是原生代币时，gas 从 BNB 扣除，pay 余额减少已包含 gas，仍可断言减少。
          const payIsNative = routePayToken.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

          console.log(`\n💰 Balance changes:`);
          console.log(`  Pay:     ${payBefore} → ${payAfter}  (${decreased ? '✓ decreased' : '✗ no decrease'})`);
          if (receiveIsNative) {
            const receiveDiff = parseFloat(receiveAfter) - parseFloat(receiveBefore);
            console.log(`  Receive: ${receiveBefore} → ${receiveAfter}  (native token, gas included, net Δ=${receiveDiff.toFixed(8)} — skipping increase check)`);
          } else {
            console.log(`  Receive: ${receiveBefore} → ${receiveAfter}  (${increased ? '✓ increased' : '✗ no increase'})`);
          }

          if (!decreased) {
            throw new Error(
              `Balance check failed for route "${route}": pay token did not decrease ` +
              `(before=${payBefore}, after=${payAfter})`
            );
          }
          if (!receiveIsNative && !increased) {
            throw new Error(
              `Balance check failed for route "${route}": receive token did not increase ` +
              `(before=${receiveBefore}, after=${receiveAfter})`
            );
          }
        }

        results.push({
          route,
          status: 'passed',
          quote: receiveAmount,
          exchangeRate,
          payBefore,    payAfter,
          receiveBefore, receiveAfter,
          durationMs: Date.now() - startMs,
        });
        console.log(`\n✅ Route "${route}" PASSED  (${((Date.now() - startMs) / 1000).toFixed(1)}s)`);

      } else {
        // ── Dry run: 仅验证报价，不发链上交易 ─────────────────────────────
        const durationMs = Date.now() - startMs;
        results.push({
          route,
          status: 'passed',
          quote: receiveAmount,
          exchangeRate,
          durationMs,
        });
        console.log(`\n✅ Route "${route}" PASSED  (quote only, ${(durationMs / 1000).toFixed(1)}s)`);
      }

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        route,
        status: 'failed',
        error: msg,
        durationMs: Date.now() - startMs,
      });
      console.log(`\n❌ Route "${route}" FAILED: ${msg}  (${((Date.now() - startMs) / 1000).toFixed(1)}s)`);

      // 失败后刷新页面，继续下一个路由
      try {
        console.log('  Reloading page before next route...');
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);
        // 刷新后 token 选择状态丢失，下一个路由需要重新选 token
        tokensSelected = false;
        pageReloaded = true;
        // 刷新后重新设置滑点（如果配置了的话）
        if (SWAP_SLIPPAGE) {
          console.log(`  Re-setting slippage to ${SWAP_SLIPPAGE}% after page reload...`);
          await swapPage.setSlippage(SWAP_SLIPPAGE);
          console.log(`  ✓ Slippage re-set to ${SWAP_SLIPPAGE}%`);
        }
      } catch (_) {
        // 忽略刷新错误
      }
    }
  }

  // ── 汇总报告 ────────────────────────────────────────────────────────────
  const passed  = results.filter((r) => r.status === 'passed');
  const failed  = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ALL ROUTES TEST REPORT`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Total:   ${results.length}`);
  console.log(`  ✅ Passed:  ${passed.length}`);
  console.log(`  ❌ Failed:  ${failed.length}`);
  console.log(`  ⏭️  Skipped: ${skipped.length}`);
  console.log(`${'─'.repeat(60)}`);

  for (const r of results) {
    const icon = r.status === 'passed' ? '✅' : r.status === 'failed' ? '❌' : '⏭️ ';
    const time = `${(r.durationMs / 1000).toFixed(1)}s`;
    if (r.status === 'passed') {
      console.log(`  ${icon} ${r.route.padEnd(30)} quote=${r.quote}  rate=1:${r.exchangeRate}  (${time})`);
    } else if (r.status === 'failed') {
      console.log(`  ${icon} ${r.route.padEnd(30)} ERROR: ${r.error}  (${time})`);
    } else {
      console.log(`  ${icon} ${r.route.padEnd(30)} skipped  (${time})`);
    }
  }

  console.log(`${'═'.repeat(60)}\n`);

  // 如果有失败的路由，让测试失败并打印失败列表
  if (failed.length > 0) {
    const failedNames = failed.map((r) => `"${r.route}"`).join(', ');
    throw new Error(
      `${failed.length}/${results.length} routes failed: ${failedNames}`
    );
  }
}
