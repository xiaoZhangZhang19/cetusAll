/**
 * Test: Cetus Swap – Route Execution (Aggregator Batch Selection)
 *
 * 功能：批量选择 Aggregator 路由，分别执行单条路由 swap 测试和组合路由 swap 测试。
 *
 * 三种运行模式（通过环境变量控制）：
 *
 *   模式 A — 组合 + 逐条（默认推荐）
 *     SELECTED_CETUS_ROUTES=Kriya V2,Kriya V3,Aftermath
 *     TEST_ALL_ROUTES=false（默认）
 *     → Phase 1: 同时选中全部指定路由，执行一次 combined swap
 *     → Phase 2: 逐条单独选择每条路由，各执行一次 swap
 *
 *   模式 B — 全路由逐条
 *     TEST_ALL_ROUTES=true
 *     → 遍历 CETUS_ROUTES 中所有 28 条路由，每条各执行一次 swap
 *
 *   模式 C — 单路由（默认）
 *     不配置 SELECTED_CETUS_ROUTES
 *     → 仅测试 DeepBook V3 单路由
 *
 * 真实交易开关：
 *   EXECUTE_SWAP=false（默认）：dry-run，只验证报价，不发送链上交易
 *   EXECUTE_SWAP=true         ：发送真实链上交易（消耗 gas）
 *
 * 示例运行命令：
 *   # dry-run，测试指定路由
 *   SELECTED_CETUS_ROUTES=Kriya V2,Kriya V3,Aftermath,Magma PropAMM npx playwright test swap-route-execution
 *
 *   # 真实交易，测试指定路由
 *   SELECTED_CETUS_ROUTES="Kriya V2,Kriya V3" EXECUTE_SWAP=true npx playwright test swap-route-execution
 *
 *   # 全路由逐条（dry-run）
 *   TEST_ALL_ROUTES=true npx playwright test swap-route-execution
 *
 *   # 自定义代币对和滑点
 *   ROUTE_SWAP_INPUT_TYPE="0x2::sui::SUI" \
 *   ROUTE_SWAP_OUTPUT_TYPE="0xdba...::usdc::USDC" \
 *   ROUTE_SWAP_SLIPPAGE="1.0" \
 *   EXECUTE_SWAP=true \
 *   npx playwright test swap-route-execution
 */

import { env } from '@/config/env.js';
import { CETUS_ROUTES } from '@/config/routes.js';
import { SwapPage } from '@/page-objects/swap.page.js';
import { getBalanceSnapshot, getTransactionResult } from '@/chain/queries.js';
import { retry } from '@/utils/retry.js';
import { expect, test } from '../setup/fixtures.js';

// ── 测试参数（优先读取 env，env 已在 config/env.ts 中解析） ────────────────────

const SWAP_INPUT_TYPE    = env.routeSwapInputType;
const SWAP_OUTPUT_TYPE   = env.routeSwapOutputType;
const SWAP_AMOUNT        = env.routeSwapInputAmountUi;
const EXECUTE_SWAP       = env.executeSwap;
const TEST_ALL_ROUTES    = env.testAllRoutes;
const SWAP_SLIPPAGE      = env.routeSwapSlippage;

// Token pool for per-route random selection
// Format: JSON array of { label, coinType } objects passed via ROUTE_SWAP_TOKEN_POOL env var
interface PoolToken { label: string; coinType: string; }
const RAW_TOKEN_POOL = process.env.ROUTE_SWAP_TOKEN_POOL ?? '';
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

// 从 coinType 中提取 symbol，用于日志显示
function symbolFromCoinType(coinType: string): string {
  return coinType.split('::').pop() ?? coinType;
}

const FROM_SYMBOL = symbolFromCoinType(SWAP_INPUT_TYPE);
const TO_SYMBOL   = symbolFromCoinType(SWAP_OUTPUT_TYPE);

// ── 路由结果类型 ──────────────────────────────────────────────────────────────

interface RouteResult {
  route:      string;
  status:     'passed' | 'failed' | 'skipped';
  quote?:     string;
  rate?:      string;
  digest?:    string;
  error?:     string;
  durationMs: number;
}

// ── 主测试套件 ────────────────────────────────────────────────────────────────

test.describe('Cetus Swap – Route Execution Test', () => {
  test('selects routes and executes swap per route + combined', async ({
    page,
    walletController,
    workerSuiClient: _suiClient, // ensure fixture lifecycle is managed by Playwright
  }) => {
    // ── 决定测试模式 ──────────────────────────────────────────────────────────
    let routesToTest: string[];
    let testMode: string;

    if (TEST_ALL_ROUTES) {
      routesToTest = [...CETUS_ROUTES];
      testMode = `ALL_ROUTES: ${CETUS_ROUTES.length} routes, one swap each`;
    } else if (env.selectedCetusRoutes.length > 0) {
      routesToTest = env.selectedCetusRoutes;
      testMode = `COMBINED: ${routesToTest.length} selected routes (combined → per-route)`;
    } else {
      routesToTest = ['DeepBook V3'];
      testMode = 'DEFAULT: DeepBook V3 single swap';
    }

    // 超时：全路由 3 小时，组合模式按条数估算，默认 5 分钟
    const timeoutMs = TEST_ALL_ROUTES
      ? 10_800_000
      : routesToTest.length > 1
      ? routesToTest.length * 3 * 60_000 * 2
      : 300_000;
    test.setTimeout(timeoutMs);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Cetus Protocol - Route Execution Test');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Mode:          ${testMode}`);
    console.log(`Routes:        ${routesToTest.join(', ')}`);
    console.log(`Routes Count:  ${routesToTest.length}`);
    console.log(`Swap Amount:   ${SWAP_AMOUNT} ${FROM_SYMBOL}`);
    console.log(`Token Pair:    ${FROM_SYMBOL} → ${TO_SYMBOL}`);
    console.log(`Execute Swap:  ${EXECUTE_SWAP ? 'YES (Real transaction)' : 'NO (Dry run)'}`);
    console.log(`Slippage:      ${SWAP_SLIPPAGE ? SWAP_SLIPPAGE + '%' : '(default)'}`);
    console.log(`Total Routes:  ${CETUS_ROUTES.length} available`);
    console.log('───────────────────────────────────────────────────────────');

    const swapPage = new SwapPage(page);

    // ── Step 1: 导航并连接钱包 ────────────────────────────────────────────────
    console.log('\n[Step 1] Navigating to swap page and connecting wallet...');
    await swapPage.goto('/swap');
    await walletController.connect(page);
    console.log(`✓ Wallet connected: ${env.testWalletAddress}`);

    // ── 根据模式分发执行 ──────────────────────────────────────────────────────
    if (TEST_ALL_ROUTES) {
      // 全路由逐条
      await runPerRouteSequential(swapPage, page, routesToTest, walletController, false);
    } else if (routesToTest.length > 1) {
      // 多路由：先 combined，再逐条
      console.log('\n📋 COMBINED MODE');
      console.log(`##COMBINED_ROUTES:${routesToTest.join(',')}##`);

      console.log('\n  Phase 1: Combined swap (all selected routes simultaneously)');
      console.log('##COMBINED_RUNNING##');
      try {
        // When token pool is active, pick a random pair for the combined swap
        let combinedInput  = SWAP_INPUT_TYPE;
        let combinedOutput = SWAP_OUTPUT_TYPE;
        if (TOKEN_POOL.length >= 2) {
          const pair = pickTwoRandom(TOKEN_POOL);
          if (pair) {
            combinedInput  = pair[0].coinType;
            combinedOutput = pair[1].coinType;
            console.log(`  🎲 Combined random token pair: ${pair[0].label} → ${pair[1].label}`);
          }
        }
        await runSingleSwapTest(swapPage, page, routesToTest, walletController, combinedInput, combinedOutput);
        console.log('##COMBINED_PASSED##');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`##COMBINED_FAILED:${msg}##`);
        throw err;
      }

      console.log('\n  Phase 2: Per-route swap (one route at a time)');
      // Phase 2 always re-selects tokens per route (pool mode picks randomly each time)
      await runPerRouteSequential(swapPage, page, routesToTest, walletController, false);
    } else {
      // 单路由
      await runPerRouteSequential(swapPage, page, routesToTest, walletController, false);
    }
  });
});

// ── 辅助函数：执行单次 swap（用于 combined 阶段）────────────────────────────

async function runSingleSwapTest(
  swapPage: SwapPage,
  page: any,
  routes: string[],
  walletController: any,
  inputType  = SWAP_INPUT_TYPE,
  outputType = SWAP_OUTPUT_TYPE,
): Promise<void> {
  // 1. 设置滑点
  if (SWAP_SLIPPAGE) {
    await swapPage.fillSlippageBps(String(parseFloat(SWAP_SLIPPAGE) * 100));
    console.log(`✓ Slippage set: ${SWAP_SLIPPAGE}%`);
  }

  // 2. 打开 Aggregator Settings，先清空所有路由，再选中指定路由
  console.log(`\n[Combined] Opening Aggregator Settings...`);
  await swapPage.openAggregatorSettings();

  console.log(`[Combined] Clearing all routes first...`);
  await swapPage.disableAllRoutes();

  console.log(`[Combined] Selecting ${routes.length} routes: ${routes.join(', ')}`);
  const count = await swapPage.selectCetusRoutes(routes);
  expect(count, `Should select ${routes.length} routes`).toBe(routes.length);

  await swapPage.confirmAggregatorSettings();
  console.log(`✓ ${count} routes selected and confirmed`);

  // 3. 选择代币，输入金额
  const fromSymbol = inputType.split('::').pop() ?? inputType;
  const toSymbol   = outputType.split('::').pop() ?? outputType;
  await swapPage.selectFromToken(inputType);
  await swapPage.selectToToken(outputType);
  await swapPage.fillAmount(SWAP_AMOUNT);

  // 检测流动性不足错误
  if (await swapPage.hasInsufficientLiquidity()) {
    throw new Error(`Insufficient liquidity for this trade (routes: "${routes.join(', ')}")`);
  }

  const receiveText = await swapPage.readReceiveAmountText();
  const receiveVal  = parseFloat(receiveText.replace(/,/g, ''));

  if (await swapPage.hasInsufficientLiquidity()) {
    throw new Error(`Insufficient liquidity for this trade (routes: "${routes.join(', ')}")`);
  }

  expect(receiveVal, 'Combined route should return a valid quote').toBeGreaterThan(0);
  console.log(`✓ Quote: ${SWAP_AMOUNT} ${fromSymbol} → ${receiveText} ${toSymbol}`);

  // 4. 执行或 dry-run
  if (EXECUTE_SWAP) {
    await executeOnChainSwap(swapPage, page, walletController, routes.join('+'));
    // 关闭成功弹窗，避免遮挡 Phase 2 的操作
    await swapPage.dismissSuccessDialog();
  } else {
    console.log('🔍 Dry-run — skipping on-chain transaction');
  }
}

// ── 辅助函数：逐条路由顺序测试 ───────────────────────────────────────────────

async function runPerRouteSequential(
  swapPage: SwapPage,
  page: any,
  routes: string[],
  walletController: any,
  skipFirstTokenSelection: boolean,
): Promise<void> {
  const results: RouteResult[] = [];
  const useTokenPool = TOKEN_POOL.length >= 2;
  // Always re-select tokens for every route, regardless of pool mode.
  // skipFirstTokenSelection is ignored — every round picks fresh tokens.
  void skipFirstTokenSelection;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Per-route sequential test: ${routes.length} routes`);
  console.log(`  Mode: ${EXECUTE_SWAP ? '⚠️  REAL on-chain swap' : '🔍 Dry-run (quote only)'}`);
  console.log(`${'═'.repeat(60)}`);

  // 在循环前设置一次滑点
  if (SWAP_SLIPPAGE) {
    await swapPage.fillSlippageBps(String(parseFloat(SWAP_SLIPPAGE) * 100));
    console.log(`[Setup] Slippage set to ${SWAP_SLIPPAGE}%`);
  }

  for (let i = 0; i < routes.length; i++) {
    const route    = routes[i];
    const startMs  = Date.now();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  [${i + 1}/${routes.length}] Route: ${route}`);
    console.log(`${'─'.repeat(60)}`);

    try {
      // A. 打开 Aggregator Settings，先清空所有已选路由，再仅勾选当前路由
      console.log(`\n[Route ${i + 1}] Opening Aggregator Settings...`);
      await swapPage.openAggregatorSettings();

      console.log(`[Route ${i + 1}] Clearing all routes...`);
      await swapPage.disableAllRoutes();

      console.log(`[Route ${i + 1}] Selecting route: ${route}`);
      const selected = await swapPage.selectCetusRoutes([route]);
      if (selected !== 1) {
        throw new Error(`Expected to select 1 route but got ${selected}`);
      }
      await swapPage.confirmAggregatorSettings();
      console.log(`✓ Route "${route}" selected`);

      // B. 每条路由都重新选代币（pool 模式随机选，非 pool 模式使用固定配置）
      if (useTokenPool) {
        const pair = pickTwoRandom(TOKEN_POOL);
        if (pair) {
          console.log(`\n[Route ${i + 1}] 🎲 Random token pair: ${pair[0].label} → ${pair[1].label}`);
          await swapPage.selectFromToken(pair[0].coinType);
          await swapPage.selectToToken(pair[1].coinType);
        } else {
          await swapPage.selectFromToken(SWAP_INPUT_TYPE);
          await swapPage.selectToToken(SWAP_OUTPUT_TYPE);
        }
      } else {
        console.log(`\n[Route ${i + 1}] Selecting token pair: ${FROM_SYMBOL} → ${TO_SYMBOL}`);
        await swapPage.selectFromToken(SWAP_INPUT_TYPE);
        await swapPage.selectToToken(SWAP_OUTPUT_TYPE);
      }

      // C. 输入金额并获取报价
      await swapPage.fillAmount(SWAP_AMOUNT);

      // 检测流动性不足错误（在读取报价之前，因为流动性不足时 receive 字段会是空/0）
      if (await swapPage.hasInsufficientLiquidity()) {
        throw new Error(`Insufficient liquidity for this trade (route: "${route}")`);
      }

      const receiveText = await swapPage.readReceiveAmountText();
      const receiveVal  = parseFloat(receiveText.replace(/,/g, ''));

      // 读取金额后再检测一次（UI 可能延迟显示错误）
      if (await swapPage.hasInsufficientLiquidity()) {
        throw new Error(`Insufficient liquidity for this trade (route: "${route}")`);
      }

      if (!receiveText || receiveVal <= 0) {
        throw new Error(`No valid quote for route "${route}"`);
      }
      const rate = (receiveVal / parseFloat(SWAP_AMOUNT)).toFixed(6);
      console.log(`✓ Quote: ${SWAP_AMOUNT} → ${receiveText} (rate: 1:${rate})`);

      // D. 执行或 dry-run
      let digest: string | undefined;
      if (EXECUTE_SWAP) {
        digest = await executeOnChainSwap(swapPage, page, walletController, route);
        // 关闭 "Transaction Completed" 成功弹窗，避免遮挡下一条路由的操作
        await swapPage.dismissSuccessDialog();
      } else {
        console.log(`🔍 Dry-run — skipping on-chain transaction`);
      }

      const durationMs = Date.now() - startMs;
      results.push({ route, status: 'passed', quote: receiveText, rate, digest, durationMs });
      const tag = `Route "${route}" PASSED`;
      console.log(`\n✅ ${tag}  (${(durationMs / 1000).toFixed(1)}s)`);
      console.log(`##Route "${route}" PASSED##`);

    } catch (err: unknown) {
      const msg      = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startMs;
      results.push({ route, status: 'failed', error: msg, durationMs });
      console.log(`\n❌ Route "${route}" FAILED: ${msg}  (${(durationMs / 1000).toFixed(1)}s)`);
      console.log(`##Route "${route}" FAILED:${msg}##`);

      // 失败后刷新页面，继续下一条
      try {
        console.log('  Reloading page before next route...');
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(2_000);
        if (SWAP_SLIPPAGE) {
          await swapPage.fillSlippageBps(String(parseFloat(SWAP_SLIPPAGE) * 100));
        }
      } catch (_) {
        // 忽略刷新错误
      }
    }
  }

  // 汇总报告
  printRouteReport(results);

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    const names = failed.map((r) => `"${r.route}"`).join(', ');
    throw new Error(`${failed.length}/${results.length} routes failed: ${names}`);
  }
}

// ── 辅助函数：执行真实链上交易 ───────────────────────────────────────────────

async function executeOnChainSwap(
  swapPage: SwapPage,
  page: any,
  walletController: any,
  routeLabel: string,
): Promise<string | undefined> {
  console.log(`\n⚠️  Executing real on-chain transaction for: ${routeLabel}`);

  // 提交 swap
  await swapPage.submitSwap();
  await walletController.approveTransaction(page);
  await swapPage.expectSuccess();

  // 读取 tx digest 并记录，不等待链上确认
  const digest = await swapPage.readDigest();
  if (digest) {
    console.log(`✓ TX submitted: ${digest}`);
  }

  return digest;
}

// ── 辅助函数：打印汇总报告 ────────────────────────────────────────────────────

function printRouteReport(results: RouteResult[]): void {
  const passed  = results.filter((r) => r.status === 'passed');
  const failed  = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ROUTE EXECUTION TEST REPORT`);
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
      const quoteStr = r.quote ? `quote=${r.quote}` : '';
      const rateStr  = r.rate  ? `rate=1:${r.rate}` : '';
      console.log(`  ${icon} ${r.route.padEnd(20)} ${quoteStr}  ${rateStr}  (${time})`);
    } else if (r.status === 'failed') {
      console.log(`  ${icon} ${r.route.padEnd(20)} ERROR: ${r.error}  (${time})`);
    } else {
      console.log(`  ${icon} ${r.route.padEnd(20)} skipped  (${time})`);
    }
  }

  console.log(`${'═'.repeat(60)}\n`);
}
