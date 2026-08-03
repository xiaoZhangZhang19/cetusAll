import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { triggerWorkflow } from '@/lib/github';
import { findTestById } from '@/lib/tests';
import path from 'path';
import { promises as fs, existsSync } from 'fs';

// Resolve npx/npm in a cross-platform way that works with nvm, fnm, and
// system Node on both macOS and Windows.
//
// The core problem on Windows:
//   - npm/npx are .cmd batch files → cannot be spawn'd or execFileSync'd directly (EINVAL)
//   - shell:true works around .cmd but breaks when the path contains spaces
// Solution: on Windows, call node.exe + the npm JS entry files directly.
// The entry files live at <nodeDir>/node_modules/npm/bin/{npm,npx}-cli.js for
// the official Windows installer.  We verify the path exists at startup so
// any misconfiguration surfaces immediately with a clear message.

const isWin    = process.platform === 'win32';
const nodeExec = process.execPath;                  // absolute path to node.exe / node
const nodeDir  = path.dirname(nodeExec);

// Windows: resolve cli.js paths once at module load time.
// macOS/Linux: these are never used.
const WIN_NPM_CLI = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const WIN_NPX_CLI = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');

if (isWin && !existsSync(WIN_NPM_CLI)) {
  console.warn(
    `[trigger] WARNING: npm-cli.js not found at ${WIN_NPM_CLI}. ` +
    `If npm is installed in a non-standard location, tests may fail.`,
  );
}

const spawnNPM = (args: string[], opts: object) => {
  if (isWin) {
    // Call node.exe directly — no .cmd, no shell, no path-with-spaces issue.
    return spawn(nodeExec, [WIN_NPM_CLI, ...args], opts as Parameters<typeof spawn>[2]);
  }
  // macOS/Linux: npm is a real executable; shell:true lets nvm/fnm shims resolve it.
  return spawn('npm', args, { ...(opts as object), shell: true } as Parameters<typeof spawn>[2]);
};

const spawnNPX = (args: string[], opts: object) => {
  if (isWin) {
    return spawn(nodeExec, [WIN_NPX_CLI, ...args], opts as Parameters<typeof spawn>[2]);
  }
  return spawn('npx', args, { ...(opts as object), shell: true } as Parameters<typeof spawn>[2]);
};

// Store running tests in memory (for simple implementation)
// In production, consider using Redis or a database
const runningTests = new Map<string, {
  process: ReturnType<typeof spawn>;
  status: 'running' | 'completed' | 'failed';
  output: string[];
  startTime: number;
  endTime?: number;
  testId: string;
}>();

/**
 * Returns an existing running entry for the given testId, or undefined.
 * Used to prevent launching a second Playwright/Chrome process when one is
 * already live (e.g. after a page refresh or a duplicate POST request).
 */
function findRunningByTestId(testId: string) {
  for (const [runId, run] of runningTests) {
    if (run.testId === testId && run.status === 'running') {
      return { runId, run };
    }
  }
  return null;
}

/**
 * Trigger test execution.
 * 
 * Modes:
 * - 'local': Execute test directly on this machine (extension mode)
 * - 'github': Triggers GitHub Actions (injected mode, CI environment)
 */
export async function POST(req: NextRequest) {
  try {
    const { testId, mode = 'local', project = 'cetus', testAllRoutes, peachRoutes, swapParams, clmmParams, farmParams, appUrl } = await req.json();
    if (!testId) {
      return NextResponse.json({ error: 'testId is required' }, { status: 400 });
    }

    // ── Prevent duplicate processes ──────────────────────────────────────────
    // If a process for the same testId is already running, return its runId so
    // the client can resume polling instead of spawning a second Chrome window.
    const existing = findRunningByTestId(testId);
    if (existing) {
      console.log(`[trigger] testId="${testId}" already running as ${existing.runId} — returning existing run`);
      return NextResponse.json({
        success: true,
        runId: existing.runId,
        testId,
        alreadyRunning: true,
      });
    }

    // ── Cetus route execution test (cetus-swap-route-execution) ─────────────
    if (project === 'cetus' && testId === 'cetus-swap-route-execution') {
      if (mode !== 'local') {
        return NextResponse.json({ error: 'Route execution test only supports local mode' }, { status: 400 });
      }

      const cetusRoot = path.resolve(process.cwd(), '..', 'cetus');
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const routes = Array.isArray(swapParams?.cetusRoutes) ? swapParams.cetusRoutes : [];

      console.log(`[${runId}] Starting Cetus route execution test | routes: ${routes.join(', ')}`);

      const env = {
        ...process.env,
        FORCE_COLOR: '0',
        // 路由列表：逗号分隔
        SELECTED_CETUS_ROUTES: routes.join(','),
        // 是否测试全部路由
        TEST_ALL_ROUTES: testAllRoutes === true ? 'true' : 'false',
        // 是否发送真实链上交易
        EXECUTE_SWAP: swapParams?.executeSwap === true ? 'true' : 'false',
      } as NodeJS.ProcessEnv;

      // Swap 参数（代币对、金额、滑点）
      if (appUrl)                  env.APP_URL                   = appUrl;
      if (swapParams?.inputType)   env.ROUTE_SWAP_INPUT_TYPE   = swapParams.inputType;
      if (swapParams?.outputType)  env.ROUTE_SWAP_OUTPUT_TYPE  = swapParams.outputType;
      if (swapParams?.amount)      env.ROUTE_SWAP_INPUT_AMOUNT_UI = swapParams.amount;
      if (swapParams?.slippage)    env.ROUTE_SWAP_SLIPPAGE     = swapParams.slippage;
      // Multi-coin pool: passed as JSON so the spec can pick per-route
      if (swapParams?.tokenPool)   env.ROUTE_SWAP_TOKEN_POOL   = swapParams.tokenPool;

      const specFile = 'validation-suite/e2e/swap-route-execution.spec.ts';

      const testProcess = spawnNPX(['playwright', 'test', specFile], {
        cwd: cetusRoot,
        env,
      });

      const output: string[] = [];
      testProcess.stdout?.on('data', (data) => {
        const text = data.toString();
        output.push(text);
        console.log(`[${runId}] stdout:`, text.trim());
      });
      testProcess.stderr?.on('data', (data) => {
        const text = data.toString();
        output.push(text);
        console.log(`[${runId}] stderr:`, text.trim());
      });
      testProcess.on('close', (code) => {
        const run = runningTests.get(runId);
        if (run) {
          run.status = code === 0 ? 'completed' : 'failed';
          run.endTime = Date.now();
          setTimeout(() => runningTests.delete(runId), 10 * 60 * 1000);
        }
      });
      testProcess.on('error', (err) => {
        const run = runningTests.get(runId);
        if (run) {
          run.status = 'failed';
          run.endTime = Date.now();
          run.output.push(`Error: ${err.message}`);
          setTimeout(() => runningTests.delete(runId), 10 * 60 * 1000);
        }
      });

      runningTests.set(runId, {
        process: testProcess,
        status: 'running',
        output,
        startTime: Date.now(),
        testId,
      });

      return NextResponse.json({ success: true, runId, testId, project: 'cetus', mode: 'local' });
    }

    // Peach project: separate handling
    if (project === 'peach') {
      if (mode !== 'local') {
        return NextResponse.json({ error: 'Peach tests only support local mode' }, { status: 400 });
      }
      const peachRoot = path.resolve(process.cwd(), '..', 'peach');
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const routes = Array.isArray(peachRoutes) ? peachRoutes : [];

      console.log(`[${runId}] Starting Peach test: ${testId} | routes: ${routes.join(', ')}`);

      // Build environment variables from swapParams
      // testAllRoutes=true  → TEST_ALL_ROUTES=true, PEACH_ROUTES empty (use all 24)
      // testAllRoutes=false → TEST_ALL_ROUTES=false, PEACH_ROUTES=selected routes (combined+individual)
      const env = {
        ...process.env,
        FORCE_COLOR: '0',
        PEACH_ROUTES: routes.join(','),
        TEST_ALL_ROUTES: testAllRoutes === true ? 'true' : 'false',
        // executeSwap controls whether real on-chain transactions are sent.
        // Defaults to 'false' (dry run) for safety; dashboard toggle sets it to 'true'.
        EXECUTE_SWAP: swapParams?.executeSwap === true ? 'true' : 'false',
      } as NodeJS.ProcessEnv;

      if (testId === 'peach-terminal') {
        // Terminal test uses dedicated env vars
        if (swapParams?.appUrl)           env.APP_URL               = swapParams.appUrl;
        if (swapParams?.payAmount)        env.TERMINAL_PAY_AMOUNT   = swapParams.payAmount;
        // fetchAllTokens=true → TERMINAL_TOKEN_COUNT=all（触发全量拉取）
        if (swapParams?.fetchAllTokens === true) {
          env.TERMINAL_TOKEN_COUNT = 'all';
        } else if (swapParams?.tokenCount) {
          env.TERMINAL_TOKEN_COUNT = String(swapParams.tokenCount);
        }
        if (swapParams?.usdThreshold)      env.USD_RATIO_THRESHOLD    = String(swapParams.usdThreshold);
        if (swapParams?.terminalTag)       env.TERMINAL_TAG           = swapParams.terminalTag;
        if (swapParams?.terminalDateType)  env.TERMINAL_DATE_TYPE     = swapParams.terminalDateType;
        if (swapParams?.useTokenlist === true) env.TERMINAL_USE_TOKENLIST = 'true';
        // Batch configuration
        if (swapParams?.batchSize !== undefined && swapParams.batchSize > 0) {
          env.TERMINAL_BATCH_SIZE = String(swapParams.batchSize);
          env.TERMINAL_BATCH_INDEX = String(swapParams?.batchIndex ?? 0);
        }
        // Custom token list: "name:address" lines separated by newlines or commas
        // Converted to TERMINAL_TOKENS="name:address,name:address,..." format
        if (swapParams?.customTokens) {
          env.TERMINAL_TOKENS = swapParams.customTokens
            .split(/[\n,]+/)
            .map((s: string) => s.trim())
            .filter((s: string) => s.length > 0)
            .join(',');
        }
        // API credentials are inherited from process.env (set in .env), not passed from dashboard
      } else if (testId === 'peach-route-change') {
        // Route change monitoring test: pass amount sequence and token pair
        if (swapParams?.routeChangeAmounts) env.ROUTE_CHANGE_AMOUNTS = swapParams.routeChangeAmounts;
        if (swapParams?.payToken)           env.SWAP_PAY_TOKEN        = swapParams.payToken;
        if (swapParams?.receiveToken)       env.SWAP_RECEIVE_TOKEN    = swapParams.receiveToken;
      } else if (testId === 'peach-slippage') {
        // Slippage warning validation test
        if (swapParams?.slippageValues)  env.SLIPPAGE_VALUES    = swapParams.slippageValues;
        if (swapParams?.warnLow)         env.SLIPPAGE_WARN_LOW  = swapParams.warnLow;
        if (swapParams?.warnHigh)        env.SLIPPAGE_WARN_HIGH = swapParams.warnHigh;
        if (swapParams?.warnOver)        env.SLIPPAGE_WARN_OVER = swapParams.warnOver;
      } else if (testId === 'peach-gas') {
        // Gas insufficient warning test
        if (swapParams?.gasTestAmount)   env.GAS_TEST_AMOUNT    = swapParams.gasTestAmount;
      } else if (testId === 'peach-limit') {
        // Limit order P0 test
        if (swapParams?.limitPayAmount)  env.LIMIT_PAY_AMOUNT   = swapParams.limitPayAmount;
        if (swapParams?.limitMinUsd)     env.LIMIT_MIN_USD      = String(swapParams.limitMinUsd);
      } else if (testId === 'peach-limit-price-guard') {
        // Limit price guard P0 test
        if (swapParams?.limitPayAmount)  env.LIMIT_PAY_AMOUNT   = swapParams.limitPayAmount;
        if (swapParams?.limitMinUsd)     env.LIMIT_MIN_USD      = String(swapParams.limitMinUsd);
        if (swapParams?.limitPriceRatio) env.LIMIT_PRICE_RATIO  = String(swapParams.limitPriceRatio);
      } else if (testId === 'peach-limit-price-direction') {
        // Limit price direction auto-detection test
        if (swapParams?.limitMinUsd)     env.LIMIT_MIN_USD      = String(swapParams.limitMinUsd);
      } else if (testId === 'peach-limit-price-mode') {
        // Limit price mode linkage test
        if (swapParams?.limitMinUsd)     env.LIMIT_MIN_USD      = String(swapParams.limitMinUsd);
      } else {
        // Swap route test uses SWAP_* env vars
        if (swapParams?.payToken)      env.SWAP_PAY_TOKEN         = swapParams.payToken;
        if (swapParams?.receiveToken)  env.SWAP_RECEIVE_TOKEN      = swapParams.receiveToken;
        if (swapParams?.payAmount)     env.SWAP_PAY_AMOUNT         = swapParams.payAmount;
        if (swapParams?.swapSlippage)  env.SWAP_SLIPPAGE           = swapParams.swapSlippage;
        // Multi-coin pool for per-route random selection
        if (swapParams?.tokenPool)     env.SWAP_TOKEN_POOL         = swapParams.tokenPool;
      }

      // Choose spec file based on testId
      const specFile = testId === 'peach-terminal'
        ? 'tests/e2e/terminal-token-swap.spec.ts'
        : testId === 'peach-route-change'
          ? 'tests/e2e/swap-route-change.spec.ts'
          : testId === 'peach-slippage'
            ? 'tests/e2e/swap-slippage.spec.ts'
            : testId === 'peach-gas'
              ? 'tests/e2e/swap-gas.spec.ts'
              : testId === 'peach-limit'
                ? 'tests/e2e/limit-order.spec.ts'
                : testId === 'peach-limit-price-guard'
                  ? 'tests/e2e/limit-price-guard.spec.ts'
                  : testId === 'peach-limit-price-direction'
                    ? 'tests/e2e/limit-price-direction.spec.ts'
                    : testId === 'peach-limit-price-mode'
                      ? 'tests/e2e/limit-price-mode.spec.ts'
                      : 'tests/e2e/swap-route-execution.spec.ts';

      const testProcess = spawnNPX(['playwright', 'test', specFile], {
        cwd: peachRoot,
        env,
      });

      const output: string[] = [];
      testProcess.stdout?.on('data', (data) => {
        const text = data.toString();
        output.push(text);
        console.log(`[${runId}] stdout:`, text.trim());
      });
      testProcess.stderr?.on('data', (data) => {
        const text = data.toString();
        output.push(text);
        console.log(`[${runId}] stderr:`, text.trim());
      });
      testProcess.on('close', (code) => {
        const run = runningTests.get(runId);
        if (run) {
          run.status = code === 0 ? 'completed' : 'failed';
          run.endTime = Date.now();
          // 自动清理：完成 10 分钟后释放内存
          setTimeout(() => runningTests.delete(runId), 10 * 60 * 1000);
        }
      });
      testProcess.on('error', (err) => {
        const run = runningTests.get(runId);
        if (run) {
          run.status = 'failed';
          run.endTime = Date.now();
          run.output.push(`Error: ${err.message}`);
          setTimeout(() => runningTests.delete(runId), 10 * 60 * 1000);
        }
      });

      runningTests.set(runId, {
        process: testProcess,
        status: 'running',
        output,
        startTime: Date.now(),
        testId,
      });

      return NextResponse.json({ success: true, runId, testId, project: 'peach', mode: 'local' });
    }

    // Cetus project
    const test = findTestById(testId);
    if (!test) {
      return NextResponse.json({ error: `Test "${testId}" not found` }, { status: 404 });
    }

    if (mode === 'local') {
      // Execute test directly from dashboard
      const projectRoot = path.resolve(process.cwd(), '..', 'cetus');
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      
      const scriptMap: Record<string, string> = {
        // Swap
        'swap': 'test:e2e:swap',
        'swap-route': 'test:e2e:swap:route',
        'swap-balance': 'test:e2e:swap:balance',
        'swap-precision': 'test:e2e:swap:precision',
        'swap-impact': 'test:e2e:swap:impact',
        'swap-dust': 'test:e2e:swap:dust',
        'swap-degradation': 'test:e2e:swap:degradation',
        'swap-slippage-warning': 'test:e2e:swap:slippage:warning',
        'swap-slippage-0.01': 'test:e2e:swap:slippage:0.01',
        'swap-rejection': 'test:e2e:swap:rejection',
        'merge-swap': 'test:e2e:merge-swap',
        
        // Limit Order
        'limit': 'test:e2e:limit',
        'limit-market': 'test:e2e:limit:market',
        'limit-below': 'test:e2e:limit:below',
        'limit-cancel': 'test:e2e:limit:cancel',
        'limit-history': 'test:e2e:limit:history',
        'limit-insufficient': 'test:e2e:limit:insufficient',
        'limit-zero': 'test:e2e:limit:0',
        'limit-connect': 'test:e2e:limit:connect',
        'limit-reject': 'test:e2e:limit:reject',
        'limit-expiry': 'test:e2e:limit:expiry',
        'limit-ui': 'test:e2e:limit:ui',
        'limit-dust': 'test:e2e:limit:dust',
        'limit-gas': 'test:e2e:limit:gas',
        'limit-tiny': 'test:e2e:limit:tiny',
        
        // DCA
        'dca-total': 'test:e2e:dca:total',
        'dca-per-order': 'test:e2e:dca:per-order',
        'dca-close': 'test:e2e:dca:close',
        
        // CLMM
        'clmm-open': 'test:e2e:clmm:open',
        'clmm-add': 'test:e2e:clmm:add',
        'clmm-create': 'test:e2e:clmm:create',
        'clmm-claim': 'test:e2e:clmm:claim',
        'clmm-zap': 'test:e2e:clmm:zap',
        'clmm-zap-increase': 'test:e2e:clmm:zap:increase',
        'clmm-zap-out': 'test:e2e:clmm:zap:out',
        'clmm-remove': 'test:e2e:clmm:remove',
        'clmm-swap': 'test:e2e:clmm:swap',
        // Farm
        'farm-stake': 'test:e2e:farm:stake',
        'farm-unstake': 'test:e2e:farm:unstake',
        'farm-claim': 'test:e2e:farm:claim',
        
        // DLMM
        'dlmm-open': 'test:e2e:dlmm:open',
        'dlmm-add': 'test:e2e:dlmm:add',
        'dlmm-create': 'test:e2e:dlmm:create',
        'dlmm-claim': 'test:e2e:dlmm:claim',
        'dlmm-zap': 'test:e2e:dlmm:zap',
        'dlmm-zap-increase': 'test:e2e:dlmm:zap:increase',
        'dlmm-zap-out': 'test:e2e:dlmm:zap:out',
        'dlmm-remove': 'test:e2e:dlmm:remove',
        
        // Margin
        'margin-open-long': 'test:e2e:margin:open:long',
        'margin-open-short': 'test:e2e:margin:open:short',
        'margin-close': 'test:e2e:margin:close',
        
        // DeepBook
        'deepbook-buy': 'test:e2e:deepbook:spot:buy',
        'deepbook-sell': 'test:e2e:deepbook:spot:sell',
        'deepbook-insufficient': 'test:e2e:deepbook:spot:insufficient',
        'deepbook-limit': 'test:e2e:deepbook:limit',
        'deepbook-cancel-all': 'test:e2e:deepbook:limit:cancel-all',
      };
      
      const script = scriptMap[testId] || 'test:e2e:swap';
      
      console.log(`[${runId}] Starting local test: ${testId} (${script})`);
      
      // Build env — inject clmmParams as env vars so the test spec picks them up
      const localEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' };
      if (appUrl) localEnv.APP_URL = appUrl;
      if (clmmParams && typeof clmmParams === 'object') {
        const p = clmmParams as Record<string, string>;
        if (p.SWAP_INPUT_TYPE)       localEnv.SWAP_INPUT_TYPE       = p.SWAP_INPUT_TYPE;
        if (p.SWAP_OUTPUT_TYPE)      localEnv.SWAP_OUTPUT_TYPE      = p.SWAP_OUTPUT_TYPE;
        if (p.SWAP_INPUT_AMOUNT_UI)  localEnv.SWAP_INPUT_AMOUNT_UI  = p.SWAP_INPUT_AMOUNT_UI;
        if (p.CLMM_POOL_BASE_TYPE)   localEnv.CLMM_POOL_BASE_SYMBOL  = p.CLMM_POOL_BASE_TYPE;
        if (p.CLMM_POOL_QUOTE_TYPE)  localEnv.CLMM_POOL_QUOTE_SYMBOL = p.CLMM_POOL_QUOTE_TYPE;
        if (p.CLMM_INPUT_TOKEN_TYPE) localEnv.CLMM_INPUT_TOKEN_SYMBOL = p.CLMM_INPUT_TOKEN_TYPE;
        if (p.CLMM_INPUT_AMOUNT_UI)  localEnv.CLMM_INPUT_AMOUNT_UI  = p.CLMM_INPUT_AMOUNT_UI;
        if (p.CLMM_ADD_MORE_AMOUNT_UI) localEnv.CLMM_ADD_MORE_AMOUNT_UI = p.CLMM_ADD_MORE_AMOUNT_UI;
        if (p.CLMM_ZAP_TOKEN_TYPE)   localEnv.CLMM_ZAP_TOKEN_SYMBOL = p.CLMM_ZAP_TOKEN_TYPE;
        if (p.CLMM_ZAP_AMOUNT_UI)    localEnv.CLMM_ZAP_AMOUNT_UI   = p.CLMM_ZAP_AMOUNT_UI;
        if (p.CLMM_REMOVE_TOKEN_TYPE) localEnv.CLMM_REMOVE_TOKEN_SYMBOL = p.CLMM_REMOVE_TOKEN_TYPE;
      }
      if (farmParams && typeof farmParams === 'object') {
        const fp = farmParams as Record<string, string>;
        if (fp.FARM_PAIR_LABEL) localEnv.FARM_PAIR_LABEL = fp.FARM_PAIR_LABEL;
      }

      // Start test process
      const testProcess = spawnNPM(['run', script], {
        cwd: projectRoot,
        env: localEnv,
      });
      
      const output: string[] = [];
      
      testProcess.stdout?.on('data', (data) => {
        const text = data.toString();
        output.push(text);
        console.log(`[${runId}] stdout:`, text.trim());
      });
      
      testProcess.stderr?.on('data', (data) => {
        const text = data.toString();
        output.push(text);
        console.log(`[${runId}] stderr:`, text.trim());
      });
      
      testProcess.on('close', (code) => {
        const test = runningTests.get(runId);
        if (test) {
          test.status = code === 0 ? 'completed' : 'failed';
          test.endTime = Date.now();
          console.log(`[${runId}] Test ${test.status} with exit code ${code}`);
          setTimeout(() => runningTests.delete(runId), 10 * 60 * 1000);
        }
      });
      
      testProcess.on('error', (err) => {
        console.error(`[${runId}] Process error:`, err);
        const test = runningTests.get(runId);
        if (test) {
          test.status = 'failed';
          test.endTime = Date.now();
          test.output.push(`Error: ${err.message}`);
          setTimeout(() => runningTests.delete(runId), 10 * 60 * 1000);
        }
      });
      
      // Store test info
      runningTests.set(runId, {
        process: testProcess,
        status: 'running',
        output,
        startTime: Date.now(),
        testId,
      });
      
      return NextResponse.json({ 
        success: true, 
        runId, 
        testId,
        mode: 'local',
        message: '测试已启动，浏览器窗口即将打开'
      });
    } else {
      // GitHub Actions (for injected mode / CI)
      const runId = await triggerWorkflow(test.script, testId);
      return NextResponse.json({ 
        success: true, 
        runId, 
        testId,
        mode: 'github' 
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Trigger error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET endpoint to retrieve test status
export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get('runId');
  
  if (!runId) {
    // Return all tests
    const tests = Array.from(runningTests.entries()).map(([id, test]) => ({
      runId: id,
      testId: test.testId,
      status: test.status,
      startTime: test.startTime,
      endTime: test.endTime,
      duration: test.endTime ? test.endTime - test.startTime : Date.now() - test.startTime,
    }));
    
    return NextResponse.json({ tests: tests.reverse().slice(0, 20) });
  }
  
  const test = runningTests.get(runId);
  if (!test) {
    return NextResponse.json({ error: 'Test run not found' }, { status: 404 });
  }
  
  const duration = test.endTime 
    ? test.endTime - test.startTime 
    : Date.now() - test.startTime;
  
  return NextResponse.json({
    runId,
    testId: test.testId,
    status: test.status,
    duration,
    output: test.output,
  });
}
