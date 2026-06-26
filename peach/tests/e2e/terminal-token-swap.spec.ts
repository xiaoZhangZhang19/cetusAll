/**
 * Test: Terminal Top-20 Token Swap Validation
 *
 * 测试流程：
 *   1. 调用 coin_list API（可通过 TERMINAL_TAG 指定 tag）获取代币列表（含合约地址）
 *   2. 进入 Peach swap 页面（/tokens/<address>），跳过 Terminal UI 滚动收集
 *   3. 对每个代币：
 *      a. 直接通过地址 URL 导航到代币 swap 页面
 *      b. 【仅第一个代币】打开设置，全选所有流动性路由（后续代币保持不变）
 *      c. 输入 0.0001 BNB 作为 You Pay 金额
 *      d. 等待报价并读取 You Pay / You Receive 的 USD 价值
 *      e. 若 receiveUSD < payUSD × USD_RATIO_THRESHOLD（默认 0.5），
 *         则终止当前 swap，标记该代币为"价值异常"跳过
 *      f. 若无路由（"No route found"），标记为 skipped
 *      g. 否则执行真实 swap 并等待链上确认
 *   4. 打印全部代币的测试报告
 *
 * 环境变量（.env 或命令行）：
 *   TERMINAL_TOKEN_COUNT    – 要测试的代币数量（默认 20）
 *   TERMINAL_PAY_AMOUNT     – You Pay 金额（默认 0.0001）
 *   USD_RATIO_THRESHOLD     – USD 价值比率下限（默认 0.5 = 50%）
 *   EXECUTE_SWAP            – 是否执行真实交易（默认 false，即 dry run）
 *   TERMINAL_USE_TOKENLIST  – 使用 tokenlist API 代替 coin_list（默认 false）
 *   TERMINAL_TAG            – coin_list API 的 tag 过滤参数（默认 trending）
 *   TERMINAL_DATE_TYPE      – 时间窗口，仅 gainer-loser 有效（默认 24h）
 *   TERMINAL_API_BASE       – API 基础地址（默认 https://api.cipheron.org）
 *   TERMINAL_API_USER       – HTTP Basic Auth 用户名
 *   TERMINAL_API_PASS       – HTTP Basic Auth 密码
 *   TERMINAL_BATCH_SIZE     – 每批测试的代币数量（默认不限制，测试所有）
 *   TERMINAL_BATCH_INDEX    – 当前批次索引，从 0 开始（默认 0）
 *
 * 运行命令：
 *   # 测试所有代币
 *   cd peach && npm run test:e2e:terminal
 *
 *   # 分批测试（每批200个代币）
 *   TERMINAL_BATCH_SIZE=200 TERMINAL_BATCH_INDEX=0 npm run test:e2e:terminal  # 第1批（0-199）
 *   TERMINAL_BATCH_SIZE=200 TERMINAL_BATCH_INDEX=1 npm run test:e2e:terminal  # 第2批（200-399）
 *   TERMINAL_BATCH_SIZE=200 TERMINAL_BATCH_INDEX=2 npm run test:e2e:terminal  # 第3批（400-599）
 */

import { TerminalPage, type TerminalSwapResult } from '../../src/page-objects/terminal.page.js';
import { env } from '../../src/config/env.js';
import { test, expect } from '../setup/fixtures.js';

// ── 配置 ───────────────────────────────────────────────────────────────────
const TOKEN_COUNT_RAW    = process.env.TERMINAL_TOKEN_COUNT ?? '20';
const FETCH_ALL_TOKENS   = TOKEN_COUNT_RAW.toLowerCase() === 'all';
const TOKEN_COUNT        = FETCH_ALL_TOKENS ? Infinity : parseInt(TOKEN_COUNT_RAW, 10);
const PAY_AMOUNT         = process.env.TERMINAL_PAY_AMOUNT    ?? '0.0001';
const USD_RATIO          = parseFloat(process.env.USD_RATIO_THRESHOLD ?? '0.5');
const EXECUTE_SWAP       = process.env.EXECUTE_SWAP === 'true';  // default false（安全默认值）
const APP_URL            = env.appUrl;                           // https://demo.peach.ag                           
const TERMINAL_TAG       = process.env.TERMINAL_TAG       ?? 'trending';
const TERMINAL_DATE_TYPE = process.env.TERMINAL_DATE_TYPE ?? '24h';
const TERMINAL_API_BASE  = process.env.TERMINAL_API_BASE  ?? 'https://api.cipheron.org';
const TERMINAL_API_USER  = process.env.TERMINAL_API_USER  ?? 'peach';
const TERMINAL_API_PASS  = process.env.TERMINAL_API_PASS  ?? 'VncP3WpLyDHPWczf';

// 使用 tokenlist API 代替 coin_list API（设置为 true 时优先级高于 TERMINAL_TAG）
const USE_TOKENLIST = process.env.TERMINAL_USE_TOKENLIST === 'true';

// 指定代币列表（逗号分隔），设置后跳过 API 收集流程，直接测试这些代币（仅 symbol，无地址）
// 示例：TERMINAL_TOKENS=GOT,PEPE,BTC
const SPECIFIED_TOKENS: string[] =
  process.env.TERMINAL_TOKENS
    ? process.env.TERMINAL_TOKENS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : [];

// 分批测试配置
const BATCH_SIZE_RAW  = process.env.TERMINAL_BATCH_SIZE;
const BATCH_SIZE      = BATCH_SIZE_RAW ? parseInt(BATCH_SIZE_RAW, 10) : undefined;
const BATCH_INDEX     = parseInt(process.env.TERMINAL_BATCH_INDEX ?? '0', 10);

// 单个代币测试超时（秒）：收集路由 + 执行 swap + 链上确认
const PER_TOKEN_TIMEOUT_MS = 120_000;
// 全部代币总超时 = 每代币 × 代币数 + 准备时间
// FETCH_ALL 模式下预留 500 个代币的空间
// 如果设置了批次大小，则使用批次大小来计算超时
const effectiveCount = SPECIFIED_TOKENS.length > 0 ? SPECIFIED_TOKENS.length
  : BATCH_SIZE && BATCH_SIZE > 0 ? BATCH_SIZE
  : FETCH_ALL_TOKENS ? 500
  : TOKEN_COUNT;
const TOTAL_TIMEOUT_MS = effectiveCount * PER_TOKEN_TIMEOUT_MS + 120_000;

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
    if (SPECIFIED_TOKENS.length > 0) {
      console.log(`  Mode:           SPECIFIED (${SPECIFIED_TOKENS.length} token(s))`);
      console.log(`  Tokens:         ${SPECIFIED_TOKENS.join(', ')}`);
    } else if (USE_TOKENLIST) {
      console.log(`  Mode:           API tokenlist`);
      console.log(`  Token count:    ${FETCH_ALL_TOKENS ? 'ALL' : TOKEN_COUNT}`);
    } else if (FETCH_ALL_TOKENS) {
      console.log(`  Mode:           ALL tokens (tag=${TERMINAL_TAG}, date_type=${TERMINAL_DATE_TYPE})`);
    } else {
      console.log(`  Mode:           API coin_list (tag=${TERMINAL_TAG}, date_type=${TERMINAL_DATE_TYPE})`);
      console.log(`  Token count:    ${TOKEN_COUNT}`);
    }
    console.log(`  Pay amount:     ${PAY_AMOUNT} BNB`);
    console.log(`  USD threshold:  ${USD_RATIO * 100}% (skip if receive < ${USD_RATIO * 100}% of pay)`);
    console.log(`  Execute swap:   ${EXECUTE_SWAP ? 'YES (real tx)' : 'NO (dry run)'}`);
    if (BATCH_SIZE && BATCH_SIZE > 0) {
      console.log(`  Batch mode:     YES (size=${BATCH_SIZE}, index=${BATCH_INDEX})`);
    } else {
      console.log(`  Batch mode:     NO (testing all tokens)`);
    }
    console.log('───────────────────────────────────────────────────────────');

    // ── Step 1: 获取代币列表（含合约地址） ─────────────────────────────────
    let tokens: { symbol: string; rank: number; address?: string }[];

    if (SPECIFIED_TOKENS.length > 0) {
      console.log(`\n[Step 1/2] Using specified token(s): ${SPECIFIED_TOKENS.join(', ')}`);
      tokens = SPECIFIED_TOKENS.map((symbol, i) => ({ symbol, rank: i + 1 }));
    } else if (USE_TOKENLIST) {
      if (FETCH_ALL_TOKENS) {
        console.log(`\n[Step 1/2] Fetching ALL tokens from tokenlist API...`);
        tokens = await _fetchAllTokenList(TERMINAL_API_BASE, TERMINAL_API_USER, TERMINAL_API_PASS);
      } else {
        console.log(`\n[Step 1/2] Fetching top ${TOKEN_COUNT} tokens from tokenlist API...`);
        tokens = await _fetchTokenList(TERMINAL_API_BASE, TOKEN_COUNT, TERMINAL_API_USER, TERMINAL_API_PASS);
      }
    } else if (FETCH_ALL_TOKENS) {
      console.log(`\n[Step 1/2] Fetching ALL tokens from coin_list API (tag=${TERMINAL_TAG}, date_type=${TERMINAL_DATE_TYPE})...`);
      tokens = await _fetchAllCoinList(TERMINAL_API_BASE, TERMINAL_TAG, TERMINAL_DATE_TYPE, TERMINAL_API_USER, TERMINAL_API_PASS);
    } else {
      console.log(`\n[Step 1/2] Fetching top ${TOKEN_COUNT} tokens from coin_list API (tag=${TERMINAL_TAG}, date_type=${TERMINAL_DATE_TYPE})...`);
      tokens = await _fetchCoinList(TERMINAL_API_BASE, TERMINAL_TAG, TERMINAL_DATE_TYPE, TOKEN_COUNT, TERMINAL_API_USER, TERMINAL_API_PASS);
    }

    if (tokens.length === 0) {
      throw new Error('[Test] Failed to fetch any tokens from coin_list API');
    }

    console.log(`\n  Fetched ${tokens.length} tokens (before batching)`);

    // ── 分批处理 ──────────────────────────────────────────────────────────
    let tokensToTest = tokens;
    if (BATCH_SIZE && BATCH_SIZE > 0) {
      const startIdx = BATCH_INDEX * BATCH_SIZE;
      const endIdx = startIdx + BATCH_SIZE;
      tokensToTest = tokens.slice(startIdx, endIdx);
      
      const totalBatches = Math.ceil(tokens.length / BATCH_SIZE);
      console.log(`\n  ── Batch Configuration ──`);
      console.log(`  Total tokens:     ${tokens.length}`);
      console.log(`  Batch size:       ${BATCH_SIZE}`);
      console.log(`  Current batch:    ${BATCH_INDEX + 1}/${totalBatches} (index ${BATCH_INDEX})`);
      console.log(`  Testing range:    ${startIdx + 1}-${Math.min(endIdx, tokens.length)} (${tokensToTest.length} tokens)`);
      console.log(`  ─────────────────────────`);
      
      if (tokensToTest.length === 0) {
        console.log(`\n  ⚠️  Batch ${BATCH_INDEX} is empty (start index ${startIdx} >= total ${tokens.length})`);
        console.log(`  This batch has no tokens to test.`);
      }
    }

    console.log(`\n  Tokens to test in this run (${tokensToTest.length}):`);
    tokensToTest.forEach(t => console.log(`    #${t.rank}  ${t.symbol}${t.address ? `  (${t.address})` : ''}`));

    // ── Step 2: 连接 MetaMask（含解锁）──────────────────────────────────
    console.log('\n[Step 2/2] Connecting MetaMask wallet...');
    // Navigate to app first so MetaMask has a page to connect to
    await terminal.goto(APP_URL);
    await metamask.connect(page);
    await terminal.waitForTokenListReady();

    // ── Step 3: 逐个执行 swap（从最后一个开始，配合降序显示实现从上至下的进度）────────
    console.log(`\n[Step 3/3] Running swap test for each token (from #${tokensToTest.length} to #1)...\n`);

    let routesSelectedOnce = false;

    // Execute tokens in reverse order (from last to first) for top-to-bottom progress
    for (let i = tokensToTest.length - 1; i >= 0; i--) {
      const token = tokensToTest[i];
      const result = await _testTokenSwap(terminal, metamask, token, {
        payAmount: PAY_AMOUNT,
        usdThreshold: USD_RATIO,
        executeSwap: EXECUTE_SWAP,
        appUrl: APP_URL,
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
  token: { symbol: string; rank: number; address?: string },
  opts: {
    payAmount: string;
    usdThreshold: number;
    executeSwap: boolean;
    appUrl: string;
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
    // a. Navigate to token swap page:
    //    When address is known, navigate directly via URL (/swap/<address>) — this is
    //    more reliable than the search flow and works even for tokens not indexed in
    //    Peach's global search (e.g. tokens from the tokenlist API).
    //    Fall back to searching by symbol if no address is available.
    console.log(`  → [a] navigating to token page...`);
    if (token.address) {
      await terminal.navigateToTokenByAddress(opts.appUrl, token.address, symbol);
    } else {
      await terminal.searchAndNavigateToToken(symbol);
    }

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
  if (BATCH_SIZE && BATCH_SIZE > 0) {
    console.log(`  (Batch ${BATCH_INDEX}: ${BATCH_SIZE * BATCH_INDEX + 1}-${BATCH_SIZE * (BATCH_INDEX + 1)})`);
  }
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

// ── coin_list API ──────────────────────────────────────────────────────────

/**
 * Fetch the token list from the coin_list API.
 *
 * API: GET /v1/bsc/pro/coin_list?tag=&date_type=&sort_field=&desc=&page=&page_size=
 *
 * tag values: new | trending | gainer-loser
 * date_type:  1h | 4h | 24h  (required for gainer-loser; ignored for new)
 *
 * @param apiBase   Base URL, e.g. "https://api.peach-swap.app"
 * @param tag       new | trending | gainer-loser
 * @param dateType  1h | 4h | 24h
 * @param pageSize  Number of tokens to return (maps to page_size, page=1)
 */
async function _fetchCoinList(
  apiBase: string,
  tag: string,
  dateType: string,
  pageSize: number,
  apiUser = '',
  apiPass = '',
): Promise<{ symbol: string; rank: number; address: string }[]> {
  // Build base params (sort defaults per tag)
  const params = new URLSearchParams({ tag, date_type: dateType });
  if (tag === 'trending') {
    params.set('sort_field', 'rank');  params.set('desc', 'false');
  } else if (tag === 'new') {
    params.set('sort_field', 'age');   params.set('desc', 'true');
  } else if (tag === 'gainer-loser') {
    const sfMap: Record<string, string> = { '1h': 'pc1h', '4h': 'pc4h', '24h': 'pc24h' };
    params.set('sort_field', sfMap[dateType] ?? 'pc24h');
    params.set('desc', 'true');
  }

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (apiUser || apiPass) {
    headers['Authorization'] = `Basic ${Buffer.from(`${apiUser}:${apiPass}`).toString('base64')}`;
  }

  // API uses limit+offset pagination (not page+page_size)
  const BATCH = 20;
  const tokens: { symbol: string; rank: number; address: string }[] = [];

  for (let offset = 0; tokens.length < pageSize; offset += BATCH) {
    params.set('limit',  String(BATCH));
    params.set('offset', String(offset));
    const url = `${apiBase}/v1/bsc/pro/coin_list?${params.toString()}`;
    console.log(`[coin_list] GET ${url}`);

    let json: unknown;
    let retries = 3;
    while (retries > 0) {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        json = await res.json();
        break; // Success, exit retry loop
      } catch (err) {
        retries--;
        if (retries === 0) {
          throw new Error(`[coin_list] API request failed at offset=${offset} after 3 retries: ${err}`);
        }
        console.log(`[coin_list] Request failed, retrying (${retries} attempts left)...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
      }
    }

    // Rate limiting: wait between requests to avoid overwhelming the API
    if (offset > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const dataObj = (json as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    const raw: unknown[] = Array.isArray(dataObj?.coin_list)
      ? (dataObj.coin_list as unknown[])
      : Array.isArray(dataObj) ? dataObj
      : Array.isArray(json)   ? json
      : [];

    if (raw.length === 0) { console.log(`[coin_list] No more data at offset=${offset}`); break; }

    for (const item of raw) {
      if (tokens.length >= pageSize) break;
      const obj = item as Record<string, unknown>;
      const address = String(obj.address ?? obj.token_address ?? obj.contract_address ?? '').trim();
      const symbol  = String(obj.symbol  ?? obj.name ?? '').trim();
      if (!address || !symbol) continue;
      // Deduplicate by address
      if (tokens.some(t => t.address.toLowerCase() === address.toLowerCase())) continue;
      tokens.push({ symbol, rank: tokens.length + 1, address });
    }

    // Fewer results than requested → no more pages
    if (raw.length < BATCH) { console.log(`[coin_list] Last batch (${raw.length} items)`); break; }
  }

  console.log(`[coin_list] Total fetched: ${tokens.length} tokens`);
  return tokens;
}

/**
 * Fetch ALL tokens from the coin_list API (no upper-bound limit).
 * Paginates until the API returns an empty page or a page smaller than BATCH.
 *
 * @param maxTokens  Safety cap to prevent infinite loops (default 10 000)
 */
async function _fetchAllCoinList(
  apiBase: string,
  tag: string,
  dateType: string,
  apiUser = '',
  apiPass = '',
  maxTokens = 10_000,
): Promise<{ symbol: string; rank: number; address: string }[]> {
  const params = new URLSearchParams({ tag, date_type: dateType });
  if (tag === 'trending') {
    params.set('sort_field', 'rank');  params.set('desc', 'false');
  } else if (tag === 'new') {
    params.set('sort_field', 'age');   params.set('desc', 'true');
  } else if (tag === 'gainer-loser') {
    const sfMap: Record<string, string> = { '1h': 'pc1h', '4h': 'pc4h', '24h': 'pc24h' };
    params.set('sort_field', sfMap[dateType] ?? 'pc24h');
    params.set('desc', 'true');
  }

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (apiUser || apiPass) {
    headers['Authorization'] = `Basic ${Buffer.from(`${apiUser}:${apiPass}`).toString('base64')}`;
  }

  const BATCH = 20;
  const tokens: { symbol: string; rank: number; address: string }[] = [];

  for (let offset = 0; tokens.length < maxTokens; offset += BATCH) {
    params.set('limit',  String(BATCH));
    params.set('offset', String(offset));
    const url = `${apiBase}/v1/bsc/pro/coin_list?${params.toString()}`;
    console.log(`[coin_list/all] GET ${url}`);

    let json: unknown;
    let retries = 3;
    while (retries > 0) {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        json = await res.json();
        break; // Success, exit retry loop
      } catch (err) {
        retries--;
        if (retries === 0) {
          throw new Error(`[coin_list/all] API request failed at offset=${offset} after 3 retries: ${err}`);
        }
        console.log(`[coin_list/all] Request failed, retrying (${retries} attempts left)...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
      }
    }

    // Rate limiting: wait between requests
    if (offset > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const dataObj = (json as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    const raw: unknown[] = Array.isArray(dataObj?.coin_list)
      ? (dataObj.coin_list as unknown[])
      : Array.isArray(dataObj) ? dataObj
      : Array.isArray(json)   ? json
      : [];

    if (raw.length === 0) {
      console.log(`[coin_list/all] No more data at offset=${offset}, total: ${tokens.length}`);
      break;
    }

    for (const item of raw) {
      const obj = item as Record<string, unknown>;
      const address = String(obj.address ?? obj.token_address ?? obj.contract_address ?? '').trim();
      const symbol  = String(obj.symbol  ?? obj.name ?? '').trim();
      if (!address || !symbol) continue;
      if (tokens.some(t => t.address.toLowerCase() === address.toLowerCase())) continue;
      tokens.push({ symbol, rank: tokens.length + 1, address });
    }

    if (raw.length < BATCH) {
      console.log(`[coin_list/all] Last batch (${raw.length} items), total: ${tokens.length}`);
      break;
    }
  }

  console.log(`[coin_list/all] Total fetched: ${tokens.length} tokens`);
  return tokens;
}

// ── tokenlist API ──────────────────────────────────────────────────────────

/**
 * Fetch the token list from the tokenlist API.
 *
 * API: GET /v1/bsc/tokenlist?page=1&page_size=50
 *
 * @param apiBase   Base URL, e.g. "https://api.cipheron.org"
 * @param pageSize  Number of tokens to return
 */
async function _fetchTokenList(
  apiBase: string,
  pageSize: number,
  apiUser = '',
  apiPass = '',
): Promise<{ symbol: string; rank: number; address: string }[]> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (apiUser || apiPass) {
    headers['Authorization'] = `Basic ${Buffer.from(`${apiUser}:${apiPass}`).toString('base64')}`;
  }

  const PAGE_SIZE = 50; // API 默认分页大小
  const tokens: { symbol: string; rank: number; address: string }[] = [];

  for (let page = 1; tokens.length < pageSize; page++) {
    const url = `${apiBase}/v1/bsc/tokenlist?page=${page}&page_size=${PAGE_SIZE}`;
    console.log(`[tokenlist] GET ${url}`);

    let json: unknown;
    let retries = 3;
    while (retries > 0) {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        json = await res.json();
        break; // Success, exit retry loop
      } catch (err) {
        retries--;
        if (retries === 0) {
          throw new Error(`[tokenlist] API request failed at page=${page} after 3 retries: ${err}`);
        }
        console.log(`[tokenlist] Request failed, retrying (${retries} attempts left)...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
      }
    }

    // Rate limiting: wait between requests to avoid overwhelming the API
    if (page > 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const dataObj = (json as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    const raw: unknown[] = Array.isArray(dataObj?.list)
      ? (dataObj.list as unknown[])
      : Array.isArray(dataObj) ? dataObj
      : Array.isArray(json)   ? json
      : [];

    if (raw.length === 0) { 
      console.log(`[tokenlist] No more data at page=${page}`); 
      break; 
    }

    for (const item of raw) {
      if (tokens.length >= pageSize) break;
      const obj = item as Record<string, unknown>;
      let address = String(obj.address ?? obj.token_address ?? obj.contract_address ?? '').trim();
      const symbol  = String(obj.symbol  ?? obj.name ?? '').trim();
      if (!address || !symbol) continue;
      
      // Validate and fix BSC address format (should be 42 chars: 0x + 40 hex digits)
      if (address.startsWith('0x')) {
        // If address is longer than 42 chars, truncate to 42
        if (address.length > 42) {
          const truncated = address.slice(0, 42);
          console.log(`[tokenlist] ⚠ Truncating invalid address ${address} → ${truncated}`);
          address = truncated;
        }
        // If address is valid length, keep it
        if (address.length === 42) {
          // Deduplicate by address
          if (tokens.some(t => t.address.toLowerCase() === address.toLowerCase())) continue;
          tokens.push({ symbol, rank: tokens.length + 1, address });
        } else {
          console.log(`[tokenlist] ⚠ Skipping invalid address ${address} (length ${address.length})`);
        }
      }
    }

    // Fewer results than requested → no more pages
    if (raw.length < PAGE_SIZE) { 
      console.log(`[tokenlist] Last page (${raw.length} items)`); 
      break; 
    }
  }

  console.log(`[tokenlist] Total fetched: ${tokens.length} tokens`);
  return tokens;
}

/**
 * Fetch ALL tokens from the tokenlist API (no upper-bound limit).
 * Paginates until the API returns an empty page or a page smaller than PAGE_SIZE.
 *
 * @param maxTokens  Safety cap to prevent infinite loops (default 10 000)
 */
async function _fetchAllTokenList(
  apiBase: string,
  apiUser = '',
  apiPass = '',
  maxTokens = 10_000,
): Promise<{ symbol: string; rank: number; address: string }[]> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (apiUser || apiPass) {
    headers['Authorization'] = `Basic ${Buffer.from(`${apiUser}:${apiPass}`).toString('base64')}`;
  }

  const PAGE_SIZE = 50;
  const tokens: { symbol: string; rank: number; address: string }[] = [];

  for (let page = 1; tokens.length < maxTokens; page++) {
    const url = `${apiBase}/v1/bsc/tokenlist?page=${page}&page_size=${PAGE_SIZE}`;
    console.log(`[tokenlist/all] GET ${url}`);

    let json: unknown;
    let retries = 3;
    while (retries > 0) {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        json = await res.json();
        break; // Success, exit retry loop
      } catch (err) {
        retries--;
        if (retries === 0) {
          throw new Error(`[tokenlist/all] API request failed at page=${page} after 3 retries: ${err}`);
        }
        console.log(`[tokenlist/all] Request failed, retrying (${retries} attempts left)...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
      }
    }

    // Rate limiting: wait between requests
    if (page > 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const dataObj = (json as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    const raw: unknown[] = Array.isArray(dataObj?.list)
      ? (dataObj.list as unknown[])
      : Array.isArray(dataObj) ? dataObj
      : Array.isArray(json)   ? json
      : [];

    if (raw.length === 0) {
      console.log(`[tokenlist/all] No more data at page=${page}, total: ${tokens.length}`);
      break;
    }

    for (const item of raw) {
      const obj = item as Record<string, unknown>;
      let address = String(obj.address ?? obj.token_address ?? obj.contract_address ?? '').trim();
      const symbol  = String(obj.symbol  ?? obj.name ?? '').trim();
      if (!address || !symbol) continue;
      
      // Validate and fix BSC address format (should be 42 chars: 0x + 40 hex digits)
      if (address.startsWith('0x')) {
        // If address is longer than 42 chars, truncate to 42
        if (address.length > 42) {
          const truncated = address.slice(0, 42);
          console.log(`[tokenlist/all] ⚠ Truncating invalid address ${address} → ${truncated}`);
          address = truncated;
        }
        // If address is valid length, keep it
        if (address.length === 42) {
          // Deduplicate by address
          if (tokens.some(t => t.address.toLowerCase() === address.toLowerCase())) continue;
          tokens.push({ symbol, rank: tokens.length + 1, address });
        } else {
          console.log(`[tokenlist/all] ⚠ Skipping invalid address ${address} (length ${address.length})`);
        }
      }
    }

    if (raw.length < PAGE_SIZE) {
      console.log(`[tokenlist/all] Last page (${raw.length} items), total: ${tokens.length}`);
      break;
    }
  }

  console.log(`[tokenlist/all] Total fetched: ${tokens.length} tokens`);
  return tokens;
}
