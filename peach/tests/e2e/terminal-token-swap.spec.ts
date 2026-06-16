/**
 * Test: Terminal Top-20 Token Swap Validation
 *
 * 测试流程：
 *   1. 进入 Peach Terminal 页面（/terminal），收集排名前 20 的代币
 *   2. 对每个代币：
 *      a. 通过搜索框导航到代币 swap 页面
 *      b. 【仅第一个代币】打开设置，全选所有流动性路由（后续代币保持不变）
 *      c. 输入 0.0001 BNB 作为 You Pay 金额
 *      d. 等待报价并读取 You Pay / You Receive 的 USD 价值
 *      e. 若 receiveUSD < payUSD × USD_RATIO_THRESHOLD（默认 0.5），
 *         则终止当前 swap，标记该代币为"价值异常"跳过
 *      f. 若无路由（"No route found"），标记为 skipped
 *      g. 否则执行真实 swap 并等待链上确认
 *   3. 打印全部 20 个代币的测试报告
 *
 * 环境变量（.env 或命令行）：
 *   TERMINAL_TOKEN_COUNT   – 要测试的代币数量（默认 20）
 *   TERMINAL_PAY_AMOUNT    – You Pay 金额（默认 0.0001）
 *   USD_RATIO_THRESHOLD    – USD 价值比率下限（默认 0.5 = 50%）
 *   EXECUTE_SWAP           – 是否执行真实交易（默认 false，即 dry run）
 *
 * 运行命令：
 *   cd peach && npm run test:e2e:terminal
 */

import { TerminalPage, type TerminalSwapResult } from '../../src/page-objects/terminal.page.js';
import { env } from '../../src/config/env.js';
import { test, expect } from '../setup/fixtures.js';

// ── 配置 ───────────────────────────────────────────────────────────────────
const TOKEN_COUNT       = parseInt(process.env.TERMINAL_TOKEN_COUNT ?? '20', 10);
const PAY_AMOUNT        = process.env.TERMINAL_PAY_AMOUNT    ?? '0.0001';
const USD_RATIO         = parseFloat(process.env.USD_RATIO_THRESHOLD ?? '0.5');
const EXECUTE_SWAP      = process.env.EXECUTE_SWAP === 'true';  // default false（安全默认值）
const APP_URL           = env.appUrl;                           // https://peach-swap.vercel.app

// 单个代币测试超时（秒）：收集路由 + 执行 swap + 链上确认
const PER_TOKEN_TIMEOUT_MS = 120_000;
// 全部代币总超时 = 每代币 × 代币数 + 准备时间
const TOTAL_TIMEOUT_MS = TOKEN_COUNT * PER_TOKEN_TIMEOUT_MS + 120_000;

// ──────────────────────────────────────────────────────────────────────────

test.describe('Peach Terminal – Top Token Swap Validation', () => {
  test.setTimeout(TOTAL_TIMEOUT_MS);

  test('collect top tokens and validate swap for each', async ({ workerPage: page, workerMetamask: metamask }) => {
    const terminal = new TerminalPage(page);
    const results: TerminalSwapResult[] = [];

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Peach Terminal – Top Token Swap Validation');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  App URL:        ${APP_URL}`);
    console.log(`  Token count:    ${TOKEN_COUNT}`);
    console.log(`  Pay amount:     ${PAY_AMOUNT} BNB`);
    console.log(`  USD threshold:  ${USD_RATIO * 100}% (skip if receive < ${USD_RATIO * 100}% of pay)`);
    console.log(`  Execute swap:   ${EXECUTE_SWAP ? 'YES (real tx)' : 'NO (dry run)'}`);
    console.log('───────────────────────────────────────────────────────────');

    // ── Step 1: 进入 Terminal ────────────────────────────────────────────
    await terminal.goto(APP_URL);

    // ── Step 2: 连接 MetaMask（含解锁 + reload）────────────────────────
    console.log('\n[Step 2/3] Connecting MetaMask wallet...');
    await metamask.connect(page);
    // metamask.connect() reloads the page — wait for token list to re-render
    await terminal.waitForTokenListReady();

    // ── Step 3: 收集前 N 个代币 ──────────────────────────────────────────
    console.log(`\n[Step 3/3] Collecting top ${TOKEN_COUNT} tokens from terminal...`);
    const tokens = await terminal.collectTopTokens(TOKEN_COUNT);

    if (tokens.length === 0) {
      throw new Error('[Test] Failed to collect any tokens from the terminal page');
    }

    console.log(`\n  Collected ${tokens.length} tokens:`);
    tokens.forEach(t => console.log(`    #${t.rank}  ${t.symbol}`));

    // ── Step 4: 逐个执行 swap ─────────────────────────────────────────────
    console.log(`\n[Step 4/4] Running swap test for each token...\n`);

    let routesSelectedOnce = false;

    for (const token of tokens) {
      const result = await _testTokenSwap(terminal, metamask, token, {
        payAmount: PAY_AMOUNT,
        usdThreshold: USD_RATIO,
        executeSwap: EXECUTE_SWAP,
        selectAllRoutesFirst: !routesSelectedOnce,
        onRoutesSelected: () => { routesSelectedOnce = true; },
      });

      results.push(result);

      // Brief pause between tokens
      await page.waitForTimeout(2000).catch(() => {});

      // If the page was closed by MetaMask interaction, navigate back to the app
      // so subsequent tokens can still run.
      const isAlive = await page.evaluate(() => true).catch(() => false);
      if (!isAlive) {
        console.log('[Test] Main page was closed — trying to recover...');
        try {
          // Find another non-extension page in the context
          const ctx = page.context();
          const livePage = ctx.pages().find(
            p => p !== page && !p.url().startsWith('chrome-extension://')
          );
          if (livePage) {
            console.log(`[Test] Recovered page: ${livePage.url()}`);
            // Re-assign terminal's page reference
            (terminal as unknown as { page: typeof page }).page = livePage;
          } else {
            console.log('[Test] No live page found in context, remaining tokens will fail');
          }
        } catch (e) {
          console.log(`[Test] Recovery failed: ${e}`);
        }
      }
    }

    // ── Final Report ──────────────────────────────────────────────────────
    _printReport(results);

    // ── Assertions ────────────────────────────────────────────────────────
    expect(results.length, 'Should have tested at least 1 token').toBeGreaterThan(0);

    const errors  = results.filter(r => r.status === 'error');
    const failed  = results.filter(r => r.status === 'failed');

    if (errors.length > 0) {
      const detail = errors.map(r => `  #${r.rank} ${r.symbol}: ${r.reason?.slice(0, 120) ?? 'unknown'}`).join('\n');
      throw new Error(
        `${errors.length} token(s) encountered errors:\n${detail}`
      );
    }
    if (failed.length > 0) {
      const detail = failed.map(r => `  #${r.rank} ${r.symbol}: ${r.reason?.slice(0, 120) ?? 'swap failed'}`).join('\n');
      throw new Error(
        `${failed.length} token(s) failed on-chain:\n${detail}`
      );
    }
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Execute the full swap test lifecycle for one token.
 */
async function _testTokenSwap(
  terminal: TerminalPage,
  metamask: import('../../src/wallet/metamask-controller.js').MetaMaskController,
  token: { symbol: string; rank: number },
  opts: {
    payAmount: string;
    usdThreshold: number;
    executeSwap: boolean;
    /** 导航完成后是否执行一次全选路由操作（只传 true 一次） */
    selectAllRoutesFirst?: boolean;
    /** 路由全选成功后的回调，通知外层标记 routesSelectedOnce = true */
    onRoutesSelected?: () => void;
  },
): Promise<TerminalSwapResult> {
  const { symbol, rank } = token;
  const start = Date.now();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  #${rank}  ${symbol}`);
  console.log(`${'─'.repeat(60)}`);

  try {
    // a. Navigate to token swap page via global search
    console.log(`  → [a] navigating to token page...`);
    await terminal.searchAndNavigateToToken(symbol);

    // b. Enter pay amount first (stabilizes the swap widget before settings are opened)
    console.log(`  → [b] entering pay amount ${opts.payAmount}...`);
    await terminal.enterPayAmount(opts.payAmount);

    // c. 仅第一次：全选所有流动性路由（等 swap widget 稳定后再打开设置）
      if (opts.selectAllRoutesFirst) {
        console.log(`  → [c-routes] selecting all liquidity sources (first time, after widget stable)...`);
        try {
          // 等待 Swap Tools 工具栏出现（设置按钮的宿主），再打开设置
          // waitForSwapToolbar 返回 false 表示工具栏不存在，直接跳过路由选择
          const toolbarReady = await terminal.waitForSwapToolbar();
          if (!toolbarReady) {
            console.log(`  → [c-routes] ⚠ Swap Tools toolbar not available on this page, skipping route selection`);
            opts.onRoutesSelected?.();
          } else {
            await terminal.openSettings();
            await terminal.openLiquiditySources();
            await terminal.selectAllSources();
            await terminal.confirmSettingsChanges();
            console.log(`  → [c-routes] ✓ All liquidity sources selected`);
            opts.onRoutesSelected?.();
            // Re-enter amount to refresh quote based on new routes
            console.log(`  → [c-routes] Re-entering pay amount after route change...`);
            await terminal.enterPayAmount(opts.payAmount);
          }
        } catch (e) {
          console.log(`  → [c-routes] ⚠ Route selection failed: ${e}. Will retry on next token.`);
          // 不调用 onRoutesSelected()，让下一个 token 继续尝试
        }
      }

    // d. Check for "No route" first
    console.log(`  → [d] checking route availability...`);    if (await terminal.hasNoRoute()) {
      console.log(`  #${rank} ${symbol}  →  ERROR (no route)`);
      return {
        symbol, rank, status: 'error',
        reason: 'No Available Route',
        durationMs: Date.now() - start,
      };
    }

    // e. Read USD values
    console.log(`  → [e] reading USD values...`);
    const usdValues = await terminal.getSwapUsdValues();
    console.log(`  → [e] pay=${usdValues.payUsdText} receive=${usdValues.receiveUsdText}`);

    // f. Check USD ratio — skip if suspicious
    console.log(`  → [f] checking USD ratio...`);
    if (terminal.isUsdValueSuspicious(usdValues, opts.usdThreshold)) {
      const ratio = usdValues.payUsd && usdValues.receiveUsd
        ? (usdValues.receiveUsd / usdValues.payUsd * 100).toFixed(1)
        : 'n/a';
      const reason =
        `USD value too low: pay=${usdValues.payUsdText} receive=${usdValues.receiveUsdText} ratio=${ratio}%`;
      console.log(`  #${rank} ${symbol}  →  SKIPPED (${reason})`);
      return {
        symbol, rank, status: 'skipped',
        reason,
        payUsd: usdValues.payUsd,
        receiveUsd: usdValues.receiveUsd,
        durationMs: Date.now() - start,
      };
    }

    if (!opts.executeSwap) {
      // Dry run: quote verified successfully → treat as PASSED
      const durationMs = Date.now() - start;
      console.log(`\n  ✅ #${rank} ${symbol}  →  PASSED  (${(durationMs / 1000).toFixed(1)}s) [dry run — quote only]`);
      return {
        symbol, rank, status: 'passed',
        payUsd: usdValues.payUsd,
        receiveUsd: usdValues.receiveUsd,
        durationMs,
      };
    }

    // g. Execute the swap
    console.log(`  → [g] clicking Buy button...`);
    await terminal.executeBuy(metamask);
    console.log(`  → [g] MetaMask confirmed, waiting for on-chain result...`);

    // h. Wait for success
    const success = await terminal.waitForSwapSuccess(
      PER_TOKEN_TIMEOUT_MS - 30_000,
      symbol,
    );

    const durationMs = Date.now() - start;
    if (success) {
      console.log(`\n  ✅ #${rank} ${symbol}  →  PASSED  (${(durationMs / 1000).toFixed(1)}s)`);
      return {
        symbol, rank, status: 'passed',
        payUsd: usdValues.payUsd,
        receiveUsd: usdValues.receiveUsd,
        durationMs,
      };
    } else {
      console.log(`\n  ❌ #${rank} ${symbol}  →  FAILED  (${(durationMs / 1000).toFixed(1)}s)`);
      return {
        symbol, rank, status: 'failed',
        reason: 'Swap transaction did not succeed on-chain',
        payUsd: usdValues.payUsd,
        receiveUsd: usdValues.receiveUsd,
        durationMs,
      };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - start;
    console.log(`\n  ⚠️  #${rank} ${symbol}  →  ERROR  (${(durationMs / 1000).toFixed(1)}s)`);
    console.log(`      ${msg.slice(0, 200)}`);
    return {
      symbol, rank, status: 'error',
      reason: msg.slice(0, 300),
      durationMs,
    };
  }
}

/**
 * Print a formatted summary report at the end of the test.
 */
function _printReport(results: TerminalSwapResult[]): void {
  const passed  = results.filter(r => r.status === 'passed');
  const failed  = results.filter(r => r.status === 'failed');
  const skipped = results.filter(r => r.status === 'skipped');
  const errors  = results.filter(r => r.status === 'error');

  console.log('\n');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  TERMINAL TOKEN SWAP REPORT');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Total:    ${results.length}`);
  console.log(`  ✅ Passed:  ${passed.length}`);
  console.log(`  ❌ Failed:  ${failed.length}`);
  console.log(`  ⏭️  Skipped: ${skipped.length}`);
  console.log(`  ⚠️  Errors:  ${errors.length}`);
  console.log('────────────────────────────────────────────────────────────');

  for (const r of results) {
    const icon = r.status === 'passed' ? '✅' :
                 r.status === 'failed' ? '❌' :
                 r.status === 'skipped' ? '⏭️ ' : '⚠️ ';
    const dur = r.durationMs ? `(${(r.durationMs / 1000).toFixed(1)}s)` : '';
    const usd = (r.payUsd !== undefined && r.receiveUsd !== undefined && r.payUsd !== null)
      ? `pay=$${r.payUsd?.toFixed(3)} recv=$${r.receiveUsd?.toFixed(3)}`
      : '';
    const reason = r.reason ? `  → ${r.reason.slice(0, 80)}` : '';
    console.log(`  ${icon} #${String(r.rank).padStart(2)}  ${r.symbol.padEnd(12)} ${dur.padEnd(10)} ${usd}${reason}`);
  }

  console.log('════════════════════════════════════════════════════════════');

  // Marker lines for dashboard log parsing
  if (failed.length === 0 && errors.length === 0) {
    console.log('##TERMINAL_ALL_PASSED##');
  } else {
    console.log(`##TERMINAL_RESULT## passed=${passed.length} failed=${failed.length} skipped=${skipped.length} errors=${errors.length}`);
  }
}
