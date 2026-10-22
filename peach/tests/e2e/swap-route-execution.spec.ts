/**
 * Test: Swap Route Execution
 *
 * 综合测试：连接钱包，选择指定的流动性路由，执行实际的 swap 交易。
 * 用于验证特定路由在真实链上环境中的工作状态。
 *
 * 测试流程：
 *   1. 连接钱包到 Peach Protocol
 *   2. 根据传参选择指定的流动性路由
 *   3. 输入 swap 金额（BNB → USDT）
 *   4. 验证获得有效报价
 *   5. 执行实际的 swap 交易
 *   6. 验证交易成功提交
 *
 * 前置条件：
 *   1. .env 里配好 E2E_PRIVATE_KEY / E2E_RPC_URL / E2E_CHAIN_ID
 *   2. 测试钱包持有足够的原生币（用于 swap 和 gas）
 *   3. E2E_CHAIN_ID 与前端默认网络一致
 *   ⚠️ 注入钱包会无人工确认地直接广播交易，只用测试专用钱包
 *
 * 环境变量配置（.env）：
 *   E2E_PRIVATE_KEY        – 测试钱包私钥（0x + 64 位十六进制）
 *   E2E_RPC_URL            – RPC 节点，用于广播交易和余额查询
 *   E2E_CHAIN_ID           – 链 ID，必须与前端默认网络一致
 *   WALLET_ADDRESS         – 预期的钱包地址（可选，留空时由私钥推导）
 *   PEACH_ROUTES           – 要测试的路由列表（逗号分隔）
 *   SWAP_PAY_AMOUNT        – swap 金额（默认 0.001）。不设时，高单价币会按
 *                            chains.ts 的 payAmountByToken 自动用更小的数量级
 *                            （如 cirBTC ≈ $82,000/枚 → 0.000001）；
 *                            显式设置则一律使用该值，不再按币种覆盖
 *   SWAP_PAY_TOKEN         – You Pay 代币地址（默认 BNB）
 *   SWAP_RECEIVE_TOKEN     – You Receive 代币地址（默认 USDT）
 *   EXECUTE_SWAP           – 是否执行真实交易（默认 false，测试时设为 true）
 *   SWAP_SLIPPAGE          – 滑点百分比（默认 0.5），在选路由前设置
 *   SWAP_TOKEN_POOL        – 多币种模式：JSON [{label,address}]，每条路由随机选两个币种
 *   SWAP_PAIR_POOL         – 多交易对模式：JSON [{labelA,addressA,labelB,addressB}]，
 *                            每条路由依次执行 A→B、B→A，每次单独校验 swap 是否成功
 *                            （优先级高于 SWAP_TOKEN_POOL）
 *   SWAP_ROUTE_SPECS       – 按路由配置币对：JSON [{route,pairs:[{labelA,addressA,
 *                            labelB,addressB,amountA?,amountB?,bothDirections?}]}]
 *                            每条路由只跑自己清单里的币对，解决不同协议支持的
 *                            交易对不一样的问题。优先级最高（覆盖下面两个池子），
 *                            且不做路由组合执行
 *   SWAP_PAIR_COMBINED_ROUTES – 多交易对模式下是否组合执行路由（默认 true）
 *                            true  → 一次性选中全部路由，每个方向只做一次 swap
 *                            false → 逐条路由分别执行全部方向（需显式设为 "false"）
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
import type { E2EWalletController } from '../../src/wallet/e2e-wallet-controller.js';
import { env, chain, isNative, payAmountForToken, PEACH_ROUTES } from '../../src/config/env.js';
import { test, expect } from '../setup/fixtures.js';
import { BalanceQueryError, type BalanceChecker } from '../../src/utils/balance-checker.js';

/**
 * 查询余额，RPC 不可用时返回 null 而不是抛错。
 *
 * 关键：链上查询失败 ≠ 余额为 0。此前失败会被当成 0，导致 swap 明明成功
 * （UI 出现 Success 弹窗）却因为「before=0, after=0，pay 未减少」判为失败。
 * 返回 null 时调用方应跳过余额断言，仅以 UI 成功弹窗为准。
 */
async function readBalanceOrNull(
  balanceChecker: BalanceChecker,
  tokenAddress: string,
  walletAddress: string,
  tag = '',
): Promise<string | null> {
  try {
    return await balanceChecker.getBalance(tokenAddress, walletAddress);
  } catch (err) {
    const msg = err instanceof BalanceQueryError ? err.message
      : err instanceof Error ? err.message : String(err);
    console.log(`${tag}⚠️  Balance query unavailable for ${tokenAddress.slice(0, 10)}…: ${msg}`);
    return null;
  }
}

// 默认币对跟着当前链走（BSC: BNB→USDT，ARC: USDC→EURC）
const DEFAULT_PAY_AMOUNT = '0.001';
const SWAP_PAY_AMOUNT = process.env.SWAP_PAY_AMOUNT ?? DEFAULT_PAY_AMOUNT;

/**
 * 用户是否真的「刻意指定」了金额 —— 指定了就不再按币种覆盖。
 *
 * ⚠️ 不能只判断 SWAP_PAY_AMOUNT 是否存在：.env 和 Dashboard 都会无条件带上
 * 这个变量（值通常就是默认的 0.001），那等于永久关掉按币种覆盖 ——
 * 实测 cirBTC→USDC 因此用了 0.001，换出 82 USDC（≈$82 一笔）。
 * 只有当它与默认值不同时，才说明是用户主动改的。
 */
const PAY_AMOUNT_EXPLICIT =
  !!process.env.SWAP_PAY_AMOUNT &&
  process.env.SWAP_PAY_AMOUNT.trim() !== DEFAULT_PAY_AMOUNT;

/**
 * 解析某个方向该用的支付金额。
 *
 * 优先级：按路由规则里的 amountA|amountB / 币对里的 amountA|amountB（= override）
 *       > 显式 SWAP_PAY_AMOUNT（与默认值不同时）
 *       > 链配置里按币种的默认值（payAmountByToken）
 *       > 全局默认 0.001
 *
 * 存在按币种配置的原因：cirBTC ≈ $82,000/枚，统一用 0.001 等于 $82 一笔，
 * 既超出测试需要，也容易打穿小额池子的流动性。
 */
function resolvePayAmount(payAddress: string, override?: string): string {
  const explicit = (override ?? '').trim();
  if (explicit) return explicit;
  if (PAY_AMOUNT_EXPLICIT) return SWAP_PAY_AMOUNT;

  const byToken = payAmountForToken(payAddress, SWAP_PAY_AMOUNT);
  if (byToken !== SWAP_PAY_AMOUNT) {
    console.log(`[amount] ${payAddress.slice(0, 10)}… 使用按币种金额 ${byToken}（默认 ${SWAP_PAY_AMOUNT}）`);
  }
  return byToken;
}
const SWAP_PAY_TOKEN = process.env.SWAP_PAY_TOKEN ?? chain.defaultPay.address;
const SWAP_RECEIVE_TOKEN = process.env.SWAP_RECEIVE_TOKEN ?? chain.defaultReceive.address;
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

// ── Multi-pair mode (SWAP_PAIR_POOL) ────────────────────────────────────────
// Each entry describes one trading pair; every pair is executed in both
// directions (A→B, then B→A) sequentially, per route.
// amountA / amountB are optional per-direction overrides for SWAP_PAY_AMOUNT.
interface PairEntry {
  labelA: string; addressA: string;
  labelB: string; addressB: string;
  amountA?: string; amountB?: string;
}
interface SwapDirection {
  fromLabel: string; fromAddress: string;
  toLabel: string;   toAddress: string;
  amount: string;
  /**
   * 该方向属于第几组币对，用于 marker 里的 pairIdx。
   *
   * 不能统一按 Math.floor(flatIndex / 2) 推算 —— 按路由模式允许单向币对
   * （bothDirections=false），一旦出现单向，后续所有方向的推算值就会错位，
   * Dashboard 会把结果贴到错误的格子上。
   */
  pairIdx: number;
}
// 多交易对模式下的路由执行方式：
//   true  → 一次性选中全部路由，每个方向只做一次组合 swap（不再逐条路由跑，默认）
//   false → 逐条路由分别执行全部方向
// 默认 true：与 Dashboard 开关默认值保持一致；显式设为 "false" 才逐条执行。
const PAIR_COMBINED_ROUTES = (process.env.SWAP_PAIR_COMBINED_ROUTES ?? 'true') !== 'false';

const RAW_PAIR_POOL = process.env.SWAP_PAIR_POOL ?? '';
const PAIR_POOL: PairEntry[] = (() => {
  if (!RAW_PAIR_POOL) return [];
  try {
    const parsed = JSON.parse(RAW_PAIR_POOL) as PairEntry[];
    return Array.isArray(parsed)
      ? parsed.filter((p) => p?.addressA && p?.addressB)
      : [];
  } catch { return []; }
})();

// ── 模式 R：按路由配置币对（SWAP_ROUTE_SPECS）─────────────────────────────
//
// 每条路由带自己的币对清单，解决「不同协议支持的交易对不一样」：
// 比如 cirBTC 只在少数路由有池子，给它们单独配，其余路由只跑 USDC/EURC，
// 省掉「这条路由本来就没这个池子」这类与缺陷无关的失败噪声。
//
// 格式（JSON）：
//   [{"route":"Uniswap V4","pairs":[
//      {"labelA":"USDC","addressA":"0x36..","labelB":"cirBTC","addressB":"0x17..",
//       "amountB":"0.000001","bothDirections":true}]}]
//
// 优先级高于 SWAP_PAIR_POOL / SWAP_TOKEN_POOL。
// 本模式下不做「路由组合执行」—— 每条路由币对不同，无法一次性全选。
interface RouteSpecPair {
  labelA: string; addressA: string;
  labelB: string; addressB: string;
  amountA?: string; amountB?: string;
  /** false 时只跑 A→B，不跑回程 */
  bothDirections?: boolean;
}
interface RouteSpec {
  route: string;
  pairs: RouteSpecPair[];
}

const RAW_ROUTE_SPECS = process.env.SWAP_ROUTE_SPECS ?? '';
const ROUTE_SPECS: RouteSpec[] = (() => {
  if (!RAW_ROUTE_SPECS) return [];
  try {
    const parsed = JSON.parse(RAW_ROUTE_SPECS) as RouteSpec[];
    if (!Array.isArray(parsed)) return [];
    // 过滤掉没有有效币对的规则：留着它们只会让路由被选中却无事可做
    return parsed
      .filter((s) => s?.route && Array.isArray(s.pairs))
      .map((s) => ({
        route: String(s.route).trim(),
        pairs: s.pairs.filter((p) => p?.addressA && p?.addressB),
      }))
      .filter((s) => s.route && s.pairs.length > 0);
  } catch (err) {
    console.log(`⚠️  SWAP_ROUTE_SPECS 解析失败，忽略该配置: ${err instanceof Error ? err.message : err}`);
    return [];
  }
})();
const USE_ROUTE_SPECS = ROUTE_SPECS.length > 0;

/**
 * 同一资产不能组成币对。
 *
 * ARC 上原生币就是 USDC，`0xeeee…`（原生占位）和 `0x3600…`（ERC-20
 * precompile 视图）读的是同一份余额。两者组成币对会是「自己换自己」：
 * 前端会自动翻转，实际跑的方向与期望不符，而余额断言还可能因为 gas
 * 扣减而误判。提前拦掉比事后排查便宜得多。
 */
function isSameAsset(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  return isNative(a) && isNative(b);
}

/** Flatten pairs into an ordered list of one-way swaps: A→B, B→A, next pair… */
function expandPairDirections(pairs: PairEntry[]): SwapDirection[] {
  const out: SwapDirection[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (isSameAsset(p.addressA, p.addressB)) {
      console.log(
        `⚠️  跳过币对 ${p.labelA}/${p.labelB}：两侧在 ${chain.label} 上是同一资产` +
        `（原生币 = ${chain.nativeSymbol}）`,
      );
      continue;
    }
    // 两个方向各按自己的「支付币种」取金额：A→B 付 A，B→A 付 B。
    // cirBTC 在哪个方向作为支付方，那个方向就自动用 0.000001。
    out.push({
      fromLabel: p.labelA || p.addressA.slice(0, 6), fromAddress: p.addressA,
      toLabel:   p.labelB || p.addressB.slice(0, 6), toAddress:   p.addressB,
      amount:    resolvePayAmount(p.addressA, p.amountA),
      pairIdx:   i,
    });
    out.push({
      fromLabel: p.labelB || p.addressB.slice(0, 6), fromAddress: p.addressB,
      toLabel:   p.labelA || p.addressA.slice(0, 6), toAddress:   p.addressA,
      amount:    resolvePayAmount(p.addressB, p.amountB),
      pairIdx:   i,
    });
  }
  return out;
}

/**
 * 把一条路由规则展开成有序的单向 swap 列表。
 *
 * 与 expandPairDirections 的区别：这里支持 bothDirections=false（只跑 A→B），
 * 因为某些池子只有单边流动性，跑回程纯属浪费时间。
 */
function expandRouteSpecDirections(spec: RouteSpec): SwapDirection[] {
  const out: SwapDirection[] = [];
  for (let i = 0; i < spec.pairs.length; i++) {
    const p = spec.pairs[i];
    if (isSameAsset(p.addressA, p.addressB)) {
      console.log(
        `⚠️  [${spec.route}] 跳过币对 ${p.labelA}/${p.labelB}：` +
        `两侧在 ${chain.label} 上是同一资产（原生币 = ${chain.nativeSymbol}）`,
      );
      continue;
    }
    out.push({
      fromLabel: p.labelA || p.addressA.slice(0, 6), fromAddress: p.addressA,
      toLabel:   p.labelB || p.addressB.slice(0, 6), toAddress:   p.addressB,
      amount:    resolvePayAmount(p.addressA, p.amountA),
      pairIdx:   i,
    });
    // 默认双向，显式设为 false 才只跑单向
    if (p.bothDirections !== false) {
      out.push({
        fromLabel: p.labelB || p.addressB.slice(0, 6), fromAddress: p.addressB,
        toLabel:   p.labelA || p.addressA.slice(0, 6), toAddress:   p.addressA,
        amount:    resolvePayAmount(p.addressB, p.amountB),
        pairIdx:   i,
      });
    }
  }
  return out;
}

/** Marker payloads are pipe/hash delimited — strip those chars from free text. */
function sanitizeMarker(text: string): string {
  return text.replace(/[|#\r\n]+/g, ' ').trim();
}
// TEST_ALL_ROUTES - 是否测试所有路由（每个路由单独执行一次 swap）
// 开启后自动强制 EXECUTE_SWAP=true，因为全路由测试的目的就是验证链上真实可用性
const TEST_ALL_ROUTES = process.env.TEST_ALL_ROUTES === 'true';
// SWAP_SLIPPAGE - 在选路由之前设置的滑点值（百分比，如 "0.5" "1.0" "2.5"）
// 不设置则跳过滑点设置步骤，使用页面默认值
const SWAP_SLIPPAGE = process.env.SWAP_SLIPPAGE ?? '';

// 链上查询用的 RPC。与注入钱包共用同一份链配置，避免两者指向不同的链
// 导致「交易发到 A 链、余额查 B 链」这种看不出来的错配。
const CHAIN_RPC_URL = env.e2eRpcUrl;

test.describe('Peach Swap – Route Execution Test', () => {
  test('selects route and executes swap transaction', async ({
    workerPage: page,
    workerWallet: wallet,
    workerBalanceChecker: balanceChecker,
  }) => {
    // ── 决定测试模式 ───────────────────────────────────────────────────────
    // TEST_ALL_ROUTES=true  → 逐条测试全部路由（不需要选路由）
    // TEST_ALL_ROUTES=false → 组合模式：先多路由组合 swap，再逐条 swap
    // 无任何配置         → 默认 Uniswap V3 单次 swap
    // ──────────────────────────────────────────────────────────────────────
    let routesToTest: string[];
    let testMode: string;

    if (USE_ROUTE_SPECS) {
      // 模式 R：路由清单由规则本身决定，忽略 PEACH_ROUTES / TEST_ALL_ROUTES
      routesToTest = ROUTE_SPECS.map((s) => s.route);
      const totalSwaps = ROUTE_SPECS.reduce(
        (n, s) => n + expandRouteSpecDirections(s).length, 0,
      );
      testMode = `ROUTE_SPECS: ${ROUTE_SPECS.length} route(s) with per-route pairs, ${totalSwaps} swap(s)`;
    } else if (TEST_ALL_ROUTES) {
      // 全部路由逐条模式（不依赖 PEACH_ROUTES 选择）
      routesToTest = [...PEACH_ROUTES];
      testMode = `ALL_ROUTES: ${PEACH_ROUTES.length} routes, one swap each`;
    } else if (env.selectedRoutes.length > 0) {
      // 组合模式：选中路由组合 + 逐条
      routesToTest = env.selectedRoutes;
      testMode = `COMBINED: ${routesToTest.length} selected routes (combined swap → per-route swap)`;
    } else {
      // 默认
      routesToTest = [chain.defaultRoute];
      testMode = `DEFAULT: ${chain.defaultRoute} single swap`;
    }

    // 超时时间：全路由模式 2 小时，组合模式按路由数×2 分钟，默认 5 分钟
    const baseTimeoutMs = TEST_ALL_ROUTES
      ? 7200_000
      : routesToTest.length > 1
      ? routesToTest.length * 2 * 60_000 * 2 // combined + per-route × 2 min each
      : 300_000;
    // 多交易对模式：组合执行时总共只跑 2×pairs 次 swap；逐条执行时每条路由都要跑一遍
    let timeoutMs: number;
    if (USE_ROUTE_SPECS) {
      // 按路由规则：总 swap 数是各路由自己的方向数之和，不是统一的 routes×pairs。
      // 每次 swap 预留 3 分钟，外加 5 分钟启动/连钱包余量。
      const totalSwaps = ROUTE_SPECS.reduce(
        (n, s) => n + expandRouteSpecDirections(s).length, 0,
      );
      timeoutMs = totalSwaps * 180_000 + 300_000;
    } else if (PAIR_POOL.length > 0 && PAIR_COMBINED_ROUTES) {
      // 每次 swap 预留 3 分钟，外加 5 分钟启动/连钱包余量
      timeoutMs = PAIR_POOL.length * 2 * 180_000 + 300_000;
    } else if (PAIR_POOL.length > 0) {
      timeoutMs = baseTimeoutMs * PAIR_POOL.length * 2;
    } else {
      timeoutMs = baseTimeoutMs;
    }
    timeoutMs = Math.min(timeoutMs, 21600_000);
    test.setTimeout(timeoutMs);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Peach Protocol - Route Execution Test');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Chain:         ${chain.label} (chainId=${chain.chainId}, prefix=${chain.urlPrefix})`);
    console.log(`Native:        ${chain.nativeSymbol}`);
    console.log(`RPC:           ${CHAIN_RPC_URL}`);
    console.log(`Mode:          ${testMode}`);
    console.log(`Routes:        ${routesToTest.join(', ')}`);
    console.log(`Routes Count:  ${routesToTest.length}`);
    console.log(
      `Swap Amount:   ${SWAP_PAY_AMOUNT}` +
      (PAY_AMOUNT_EXPLICIT ? ' (SWAP_PAY_AMOUNT 显式指定，按币种覆盖已禁用)' : ''),
    );
    if (!PAY_AMOUNT_EXPLICIT && chain.payAmountByToken) {
      const overrides = Object.entries(chain.payAmountByToken)
        .map(([addr, amt]) => `${addr.slice(0, 8)}…=${amt}`)
        .join(', ');
      console.log(`Amount/token:  ${overrides}`);
    }
    console.log(`Execute Swap:  ${EXECUTE_SWAP ? 'YES (Real transaction)' : 'NO (Dry run)'}`);
    console.log(`Slippage:      ${SWAP_SLIPPAGE ? SWAP_SLIPPAGE + '%' : '(default)'}`);
    if (USE_ROUTE_SPECS) {
      console.log(`Route Specs:   ${ROUTE_SPECS.length} route(s), each with its own pairs`);
      console.log(`Route Exec:    SEQUENTIAL — 每条路由币对不同，不做组合执行`);
      for (const s of ROUTE_SPECS) {
        const dirs = expandRouteSpecDirections(s);
        console.log(`  · ${s.route} (${dirs.length} swap${dirs.length === 1 ? '' : 's'}):`);
        for (const d of dirs) {
          console.log(`      ${d.fromLabel} → ${d.toLabel}  (amount ${d.amount})`);
        }
      }
    } else if (PAIR_POOL.length > 0) {
      const dirs = expandPairDirections(PAIR_POOL);
      console.log(`Pair Mode:     ${PAIR_POOL.length} pair(s) → ${dirs.length} swaps ${PAIR_COMBINED_ROUTES ? 'total (routes combined)' : 'per route'}`);
      console.log(`Route Exec:    ${PAIR_COMBINED_ROUTES ? 'COMBINED — all routes selected at once' : 'SEQUENTIAL — one route at a time'}`);
      for (const p of PAIR_POOL) {
        console.log(`  · ${p.labelA}/${p.labelB}: ${p.labelA}→${p.labelB}, ${p.labelB}→${p.labelA}`);
      }
    } else {
      console.log(`Pay Token:     ${SWAP_PAY_TOKEN}`);
      console.log(`Receive Token: ${SWAP_RECEIVE_TOKEN}`);
    }
    console.log(`Available:     ${PEACH_ROUTES.length} routes total`);
    console.log('───────────────────────────────────────────────────────────');

    const swapPage = new SwapPage(page);

    // ═══════════════════════════════════════════════════════════════════════
    // Step 1: 导航到页面并连接钱包
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n[Step 1/5] Navigating and connecting wallet...');
    await swapPage.goto();
    await wallet.connect(page);

    // 验证钱包地址。
    // 注入钱包的地址由私钥直接推导，不必再从 UI 文本里反解析。
    let walletAddress = env.walletAddress || wallet.address;
    
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

    // ── 链上 RPC 连通性探测 ────────────────────────────────────────────────
    // 提前暴露 RPC 不可用，避免后续每个方向都静默跳过余额校验却看不出原因。
    if (EXECUTE_SWAP && walletAddress) {
      const reachable = await balanceChecker.isReachable();
      if (reachable) {
        console.log(`\n✓ On-chain RPC reachable — balance verification enabled`);
      } else {
        console.log(`\n⚠️  On-chain RPC unreachable (${CHAIN_RPC_URL})`);
        console.log('   Balance verification will be skipped; swap results rely on the UI success dialog.');
        console.log('   Set a working E2E_RPC_URL in .env to re-enable on-chain checks.');
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 根据模式分发执行
    // ═══════════════════════════════════════════════════════════════════════
    if (USE_ROUTE_SPECS) {
      // 模式 R：按路由配置币对。每条路由只跑自己清单里的币对
      await testRouteSpecs(
        swapPage, page, wallet, walletAddress, balanceChecker,
      );
    } else if (PAIR_POOL.length > 0 && PAIR_COMBINED_ROUTES) {
      // 模式 P：多交易对 + 路由组合执行
      // 一次性选中全部路由，然后依次跑完所有交易对方向，不再逐条路由重复
      await testPairsWithCombinedRoutes(
        swapPage, page, wallet, routesToTest, walletAddress, balanceChecker,
      );
    } else if (TEST_ALL_ROUTES) {
      // 模式 A：全部路由，每条各做一次 swap
      await testAllRoutesSequentially(swapPage, page, wallet, routesToTest, walletAddress, false, balanceChecker);
    } else if (routesToTest.length > 1) {
      // 模式 B：组合模式（2+ 条路由）
      //   B-1. 先同时选中全部选中路由，做一次组合 swap
      //   B-2. 再逐条单独 swap
      console.log('\n📋 COMBINED MODE');
      console.log(`##COMBINED_ROUTES:${routesToTest.join(',')}##`);

      console.log('  Phase 1: Combined swap with all selected routes');
      console.log('##COMBINED_RUNNING##');
      try {
        // When pair pool is active, use the first pair's A→B direction for the
        // combined swap; when token pool is active, pick a random pair instead.
        let combinedPayToken     = SWAP_PAY_TOKEN;
        let combinedReceiveToken = SWAP_RECEIVE_TOKEN;
        if (PAIR_POOL.length > 0) {
          const first = expandPairDirections(PAIR_POOL)[0];
          combinedPayToken     = first.fromAddress;
          combinedReceiveToken = first.toAddress;
          console.log(`  🔁 Combined pair direction: ${first.fromLabel} → ${first.toLabel}`);
        } else if (TOKEN_POOL.length >= 2) {
          const pair = pickTwoRandom(TOKEN_POOL);
          if (pair) {
            combinedPayToken     = pair[0].address;
            combinedReceiveToken = pair[1].address;
            console.log(`  🎲 Combined random token pair: ${pair[0].label} → ${pair[1].label}`);
          }
        }
        await testSingleRoute(swapPage, page, wallet, routesToTest, walletAddress, balanceChecker, combinedPayToken, combinedReceiveToken);
        console.log('##COMBINED_PASSED##');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`##COMBINED_FAILED:${msg}##`);
        throw err;
      }

      console.log('\n  Phase 2: Individual swap per route');
      // Phase 2 always re-selects tokens per route (token pool mode picks randomly each time)
      await testAllRoutesSequentially(swapPage, page, wallet, routesToTest, walletAddress, false, balanceChecker);
    } else {
      // 模式 C：单路由（默认或只选了 1 条）
      // 同样走 testAllRoutesSequentially，保证输出统一的 Route "X" PASSED/FAILED
      // 标记，Dashboard 才能正确解析并更新路由状态格子
      await testAllRoutesSequentially(swapPage, page, wallet, routesToTest, walletAddress, false, balanceChecker);
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
  wallet: E2EWalletController,
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
  // 返回值是「实际选中数」：被前端下线的路由（搜不到）会自动跳过，
  // 所以只断言至少选到 1 条，不能拿 routesToTest.length 硬比。
  const selectedCount = await swapPage.selectRoutes(routesToTest as unknown as string[]);

    expect(
      selectedCount,
      `Should have selected at least 1 of ${routesToTest.length} route(s)`,
    ).toBeGreaterThan(0);

    if (selectedCount !== routesToTest.length) {
      console.log(`⏭ ${routesToTest.length - selectedCount} route(s) unavailable in UI — skipped`);
    }
    console.log(`✓ Selected routes: ${selectedCount}/${routesToTest.length}`);

    // 确认设置更改
    await swapPage.confirmSettingsChanges();
    console.log('✓ Settings confirmed');

    // ═══════════════════════════════════════════════════════════════════════
    // Step 3: 选择代币对并输入 swap 金额
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`\n[Step 3/5] Selecting tokens and fetching quote...`);
    console.log(`Pay:     ${payToken}`);
    console.log(`Receive: ${receiveToken}`);

    // 一次性设好币对，避免中间态同币触发前端自动翻转
    await swapPage.selectPair(payToken, receiveToken);

    // 金额按支付币种解析：高单价币（cirBTC）用更小的数量级
    const payAmount = resolvePayAmount(payToken);
    console.log(`Amount: ${payAmount}`);
    await swapPage.enterPayAmount(payAmount);
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

    console.log(`✓ Quote received: ${payAmount} → ${receiveAmount}`);
    console.log(`  Pay: ${payToken}`);
    console.log(`  Receive: ${receiveAmount} (${receiveToken})`);
    console.log(`  Route: ${routesToTest.join(', ')}`);

    // 计算简单的价格比率
    const exchangeRate = receiveValue / parseFloat(payAmount);
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
        await swapPage.executeSwap(wallet);
        
        // 等待成功对话框
        console.log('\n⏳ Waiting for transaction confirmation...');
        const swapResult1 = await swapPage.waitForSwapSuccess(180_000, routesToTest.join(', '), wallet);
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
        
        const payBalanceBefore = await readBalanceOrNull(balanceChecker, payToken, walletAddress, '  ');
        const receiveBalanceBefore = await readBalanceOrNull(balanceChecker, receiveToken, walletAddress, '  ');
        
        console.log(`  Pay token (${payToken}): ${payBalanceBefore ?? 'n/a'}`);
        console.log(`  Receive token (${receiveToken}): ${receiveBalanceBefore ?? 'n/a'}`);

        // 执行 swap，executeSwap 会自动检测弹窗类型：
        //   - 首次 approve 的 ERC-20 代币 → "Approve and Swap"（2 个钱包动作：授权 + swap）
        //   - 已有 Permit2 授权的代币（如 USDT）→ "Confirm Swap"（1 个钱包动作：仅 swap）
        await swapPage.executeSwap(wallet);

        // 等待成功对话框
        console.log('\n⏳ Waiting for transaction confirmation...');
        const swapResult2 = await swapPage.waitForSwapSuccess(180_000, routesToTest.join(', '), wallet);
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
        const payBalanceAfter = await readBalanceOrNull(balanceChecker, payToken, walletAddress, '  ');
        const receiveBalanceAfter = await readBalanceOrNull(balanceChecker, receiveToken, walletAddress, '  ');
        
        console.log(`  Pay token (${payToken}): ${payBalanceAfter ?? 'n/a'}`);
        console.log(`  Receive token (${receiveToken}): ${receiveBalanceAfter ?? 'n/a'}`);

        // RPC 查不到余额时跳过链上校验：swap 已由 UI 成功弹窗确认，
        // 不能因为查询失败把成功的交易判成失败。
        const balancesComparable =
          payBalanceBefore !== null && payBalanceAfter !== null &&
          receiveBalanceBefore !== null && receiveBalanceAfter !== null;

        if (!balancesComparable) {
          console.log('\n⚠️  On-chain balance verification skipped (RPC unavailable) — swap confirmed via UI success dialog');
        } else {

        // 验证余额变化
        const payBefore = parseFloat(payBalanceBefore);
        const payAfter = parseFloat(payBalanceAfter);
        const receiveBefore = parseFloat(receiveBalanceBefore);
        const receiveAfter = parseFloat(receiveBalanceAfter);

        const payDecreased = payAfter < payBefore;
        const receiveIncreased = receiveAfter > receiveBefore;

        const payDiff = payBefore - payAfter;
        const receiveDiff = receiveAfter - receiveBefore;

        // 收款币与原生币共享余额时，gas 也从这份余额扣除，净值可能反而下降，
        // 跳过增加断言。ARC 上 USDC 就是原生币（0x3600… 是其 precompile 视图）。
        const receiveIsNative = isNative(receiveToken);

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
        const expectedPayAmount = parseFloat(payAmount);
        const payDiffRatio = Math.abs(payDiff - expectedPayAmount) / expectedPayAmount;
        
        // 允许 5% 的误差（因为有 gas 费用）
        if (payDiffRatio > 0.05) {
          console.log(`⚠️  Warning: Pay amount difference (${payDiff.toFixed(8)}) differs significantly from expected (${expectedPayAmount})`);
        } else {
          console.log(`✓ Pay amount matches expected: ~${expectedPayAmount}`);
        }
        
        console.log('\n✓ Balance changes verified successfully');
        }
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
    console.log(`✓ Quote:       ${payAmount} → ${receiveAmount}`);

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

// 原生币判定统一走 isNative()（链配置里的 nativeAliases），
// 不再比对单个硬编码地址 —— ARC 上原生币有两个等价地址表示。

/**
 * 执行单个方向的 swap（选币 → 报价 → 可选链上交易 → 余额校验）。
 * 成功返回报价信息；任何一步失败都抛错，由调用方记录为该方向失败。
 */
async function executeOneDirection(
  swapPage: SwapPage,
  page: any,
  wallet: E2EWalletController,
  balanceChecker: BalanceChecker,
  walletAddress: string | undefined,
  route: string,
  dir: SwapDirection,
  tag: string,
): Promise<{ quote: string; exchangeRate: string }> {
  console.log(`\n${tag} ${dir.fromLabel} → ${dir.toLabel}  (amount ${dir.amount})`);

  // 必须用 selectPair 一次性设好两个槽位：拆成两次 selectToken 会出现
  // sell==buy 的中间态，前端自动翻转后实际跑的方向会跟期望不符
  // （实测：要测 U→USD1，页面上却是 BNB→USDT）。
  // 传 label 让 page object 校验槽位实际渲染的币种，选错时直接报错。
  await swapPage.selectPair(
    dir.fromAddress, dir.toAddress,
    dir.fromLabel,   dir.toLabel,
  );

  await swapPage.enterPayAmount(dir.amount);
  const quote = await swapPage.getReceiveAmount();
  if (!quote || parseFloat(quote) <= 0) {
    throw new Error(`No valid quote for ${dir.fromLabel}→${dir.toLabel} on route "${route}"`);
  }
  const exchangeRate = (parseFloat(quote) / parseFloat(dir.amount)).toFixed(6);
  console.log(`${tag} ✓ Quote: ${dir.amount} → ${quote} (rate 1 : ${exchangeRate})`);

  if (!EXECUTE_SWAP) {
    console.log(`${tag} 🔍 Dry run — quote only, no on-chain tx`);
    return { quote, exchangeRate };
  }

  let payBefore: string | null = null, receiveBefore: string | null = null;
  if (walletAddress) {
    payBefore     = await readBalanceOrNull(balanceChecker, dir.fromAddress, walletAddress, `${tag} `);
    receiveBefore = await readBalanceOrNull(balanceChecker, dir.toAddress,   walletAddress, `${tag} `);
    console.log(`${tag} Balances before — pay: ${payBefore ?? 'n/a'}, receive: ${receiveBefore ?? 'n/a'}`);
  }

  await swapPage.executeSwap(wallet);

  const SWAP_SUCCESS_TIMEOUT = 180_000;
  const swapResult = await swapPage.waitForSwapSuccess(
    SWAP_SUCCESS_TIMEOUT,
    `${route} ${dir.fromLabel}→${dir.toLabel}`,
    wallet,
  );
  if (!swapResult.success) {
    if (swapResult.reason === 'on-chain-failure') {
      throw new Error(`On-chain TX failed (${dir.fromLabel}→${dir.toLabel}): ${swapResult.errorText ?? 'Transaction failed'}`);
    }
    throw new Error(`Swap timed out (${dir.fromLabel}→${dir.toLabel}, waited ${SWAP_SUCCESS_TIMEOUT / 1000}s)`);
  }
  console.log(`${tag} ✓ Swap confirmed on-chain`);

  if (!walletAddress) return { quote, exchangeRate };

  console.log(`${tag} Waiting 10s for balance update...`);
  await page.waitForTimeout(10_000);
  const payAfter     = await readBalanceOrNull(balanceChecker, dir.fromAddress, walletAddress, `${tag} `);
  const receiveAfter = await readBalanceOrNull(balanceChecker, dir.toAddress,   walletAddress, `${tag} `);

  // 收款币与原生币共享余额时，gas 从同一余额扣除，净变化可能为负 → 跳过增加断言
  const receiveIsNative = isNative(dir.toAddress);

  // 任一侧查询不到就跳过该侧断言：swap 已由 UI 成功弹窗确认，
  // 不能因为 RPC 查不到余额而把成功的交易判成失败。
  const payComparable     = payBefore !== null && payAfter !== null;
  const receiveComparable = receiveBefore !== null && receiveAfter !== null;

  const decreased = payComparable     && parseFloat(payAfter!)     < parseFloat(payBefore!);
  const increased = receiveComparable && parseFloat(receiveAfter!) > parseFloat(receiveBefore!);

  console.log(`${tag} 💰 Pay:     ${payBefore ?? 'n/a'} → ${payAfter ?? 'n/a'}  (${
    !payComparable ? '⚠ balance query unavailable — assertion skipped'
                   : decreased ? '✓ decreased' : '✗ no decrease'})`);
  console.log(`${tag} 💰 Receive: ${receiveBefore ?? 'n/a'} → ${receiveAfter ?? 'n/a'}  (${
    !receiveComparable ? '⚠ balance query unavailable — assertion skipped'
      : receiveIsNative ? 'native token, gas included — skipping increase check'
      : increased ? '✓ increased' : '✗ no increase'})`);

  if (!payComparable || !receiveComparable) {
    console.log(`${tag} ⚠️  On-chain balance verification skipped (RPC unavailable) — swap confirmed via UI success dialog`);
    return { quote, exchangeRate };
  }

  if (!decreased) {
    throw new Error(
      `Balance check failed (${dir.fromLabel}→${dir.toLabel}): pay token did not decrease ` +
      `(before=${payBefore}, after=${payAfter})`
    );
  }
  if (!receiveIsNative && !increased) {
    throw new Error(
      `Balance check failed (${dir.fromLabel}→${dir.toLabel}): receive token did not increase ` +
      `(before=${receiveBefore}, after=${receiveAfter})`
    );
  }
  return { quote, exchangeRate };
}

/**
 * 多交易对模式：在当前已选中的路由下依次执行全部方向（A→B、B→A、下一对…）。
 * 每个方向单独判定 swap 是否成功，失败不中断后续方向，最后汇总。
 *
 * @param label          用于日志与 marker 的标识（逐条模式=路由名，组合模式=组合标识）
 * @param routesToRestore 方向失败刷新页面后需要重新选回的路由集合
 */
async function runPairDirectionsForRoute(
  swapPage: SwapPage,
  page: any,
  wallet: E2EWalletController,
  balanceChecker: BalanceChecker,
  walletAddress: string | undefined,
  route: string,
  directions: SwapDirection[],
  routesToRestore: string[] = [route],
  reuseRouteSelection = false,
): Promise<{ passed: number; failed: number; firstQuote?: string; firstRate?: string; errors: string[] }> {
  let passed = 0;
  const errors: string[] = [];
  let firstQuote: string | undefined;
  let firstRate:  string | undefined;

  for (let d = 0; d < directions.length; d++) {
    const dir = directions[d];
    const pairIdx = dir.pairIdx;
    const tag = `[${route} · ${d + 1}/${directions.length}]`;
    const dirStart = Date.now();

    // 页面/浏览器已关闭时后续方向不可能成功，继续跑只会刷出一堆
    // "Target page, context or browser has been closed"，掩盖真正的首个失因。
    if (page.isClosed?.()) {
      const remaining = directions.length - d;
      const msg = `aborted: page closed (${remaining} direction(s) skipped)`;
      errors.push(msg);
      console.log(`${tag} ⛔ ${msg}`);
      break;
    }

    console.log(`##PAIR_START:${route}|${pairIdx}|${d}|${dir.fromLabel}|${dir.toLabel}##`);
    try {
      const r = await executeOneDirection(
        swapPage, page, wallet, balanceChecker, walletAddress, route, dir, tag,
      );
      passed++;
      if (firstQuote === undefined) { firstQuote = r.quote; firstRate = r.exchangeRate; }
      const secs = ((Date.now() - dirStart) / 1000).toFixed(1);
      console.log(`##PAIR_PASSED:${route}|${pairIdx}|${d}|${dir.fromLabel}|${dir.toLabel}|${r.quote}|${secs}##`);
      console.log(`${tag} ✅ ${dir.fromLabel}→${dir.toLabel} PASSED (${secs}s)`);
    } catch (err: unknown) {
      const msg = sanitizeMarker(err instanceof Error ? err.message : String(err));
      errors.push(`${dir.fromLabel}→${dir.toLabel}: ${msg}`);
      const secs = ((Date.now() - dirStart) / 1000).toFixed(1);
      console.log(`##PAIR_FAILED:${route}|${pairIdx}|${d}|${dir.fromLabel}|${dir.toLabel}|${msg}|${secs}##`);
      console.log(`${tag} ❌ ${dir.fromLabel}→${dir.toLabel} FAILED: ${msg} (${secs}s)`);

      // 方向失败后先尝试软恢复（关弹窗 + 清金额），保住已选路由，避免刷新后
      // 重新勾选全部路由。软恢复不可行才退回整页刷新 + 重选路由。
      try {
        const softOk = reuseRouteSelection && await swapPage.softResetAfterFailure();
        if (!softOk) {
          await page.reload({ waitUntil: 'networkidle' });
          await page.waitForTimeout(2000);
          if (SWAP_SLIPPAGE) await swapPage.setSlippage(SWAP_SLIPPAGE);
          // 刷新会重置路由选择，需要重新选回本次测试的路由集合
          // ensureRoutesSelected 会先读当前计数，已匹配则跳过重复勾选
          await swapPage.ensureRoutesSelected(routesToRestore);
        } else if (SWAP_SLIPPAGE) {
          // 软恢复保留了页面状态，滑点无需重设；仅在弹窗被强关时才可能丢失
          console.log(`${tag} Soft reset kept slippage & route selection`);
        }
      } catch {
        // 忽略恢复过程中的错误，交由下一个方向的断言暴露问题
      }
    }
  }

  return { passed, failed: errors.length, firstQuote, firstRate, errors };
}

/** 组合路由模式下用于日志/marker 的固定标识，dashboard 依此归组显示。 */
const COMBINED_ROUTE_LABEL = '__COMBINED__';

/**
 * 多交易对 + 路由组合执行模式：
 * 一次性选中全部路由，然后依次跑完所有交易对方向，每个方向只做一次 swap。
 */
async function testPairsWithCombinedRoutes(
  swapPage: SwapPage,
  page: any,
  wallet: E2EWalletController,
  routes: string[],
  walletAddress: string | undefined,
  balanceChecker: BalanceChecker,
) {
  const directions = expandPairDirections(PAIR_POOL);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  PAIR MODE — COMBINED ROUTES`);
  console.log(`  Routes selected together: ${routes.length}`);
  console.log(`  Pairs: ${PAIR_POOL.length} × 2 directions = ${directions.length} swaps total`);
  console.log(`  Mode: ${EXECUTE_SWAP ? '⚠️  REAL on-chain swap' : '🔍 Dry run — quote only'}`);
  console.log(`${'═'.repeat(60)}`);

  console.log(`##PAIR_COMBINED_MODE##`);
  console.log(`##PAIR_PLAN:${PAIR_POOL.map((p) => `${p.labelA}/${p.labelB}`).join(',')}##`);
  console.log(`##COMBINED_ROUTES:${routes.join(',')}##`);
  console.log('##COMBINED_RUNNING##');

  // 滑点要在选路由之前设置
  if (SWAP_SLIPPAGE) {
    console.log(`\n[Setup] Setting slippage to ${SWAP_SLIPPAGE}%...`);
    await swapPage.setSlippage(SWAP_SLIPPAGE);
  } else {
    console.log('\n[Setup] Slippage: using page default');
  }

  console.log(`\n[Setup] Selecting all ${routes.length} route(s) at once (one time only)...`);
  // 被前端下线的路由搜不到时自动跳过，只要还有至少一条可选就继续测；
  // 全部都不存在才算失败（那说明面板结构变了，不是个别路由下线）。
  const selectedCount = await swapPage.selectRoutes(routes);
  if (selectedCount === 0) {
    const msg = `None of the ${routes.length} requested route(s) exist in the UI`;
    console.log(`##COMBINED_FAILED:${sanitizeMarker(msg)}##`);
    throw new Error(msg);
  }
  await swapPage.confirmSettingsChanges();
  if (selectedCount !== routes.length) {
    console.log(`⏭ ${routes.length - selectedCount} route(s) unavailable in UI — skipped`);
  }
  console.log(`✓ Selected routes: ${selectedCount}/${routes.length}`);
  console.log('  ↳ Selection is reused for every pair — no re-selection between pairs');

  // reuseRouteSelection=true：全部路由已一次性选好，后续交易对直接复用，
  // 方向失败时优先软恢复，不再重复勾选全部路由。
  const outcome = await runPairDirectionsForRoute(
    swapPage, page, wallet, balanceChecker, walletAddress,
    COMBINED_ROUTE_LABEL, directions, routes, true,
  );

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  PAIR COMBINED-ROUTES REPORT`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Routes:  ${routes.length} (selected together)`);
  console.log(`  Total swaps: ${directions.length}`);
  console.log(`  ✅ Passed:  ${outcome.passed}`);
  console.log(`  ❌ Failed:  ${outcome.failed}`);
  console.log(`${'═'.repeat(60)}\n`);

  if (outcome.failed > 0) {
    const msg = `${outcome.failed}/${directions.length} pair swaps failed — ${outcome.errors.join('; ')}`;
    console.log(`##COMBINED_FAILED:${sanitizeMarker(msg)}##`);
    throw new Error(msg);
  }
  console.log('##COMBINED_PASSED##');
}

/**
 * 模式 R：按路由配置币对。
 *
 * 每条路由只跑自己规则里的币对，解决「不同协议支持的交易对不一样」——
 * 过去所有路由共用一套币对，没池子的组合必然失败，一轮下来大半失败都是
 * 「这条路由本来就没这个池子」的噪声，淹没真正的缺陷。
 *
 * 复用 runPairDirectionsForRoute，marker 格式与多交易对模式完全一致，
 * Dashboard 的结果解析无需改动。
 */
async function testRouteSpecs(
  swapPage: SwapPage,
  page: any,
  wallet: E2EWalletController,
  walletAddress: string | undefined,
  balanceChecker: BalanceChecker,
) {
  const totalSwaps = ROUTE_SPECS.reduce(
    (n, s) => n + expandRouteSpecDirections(s).length, 0,
  );

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ROUTE SPECS MODE — per-route pairs`);
  console.log(`  Routes: ${ROUTE_SPECS.length}   Total swaps: ${totalSwaps}`);
  console.log(`  Mode: ${EXECUTE_SWAP ? '⚠️  REAL on-chain swap' : '🔍 Dry run — quote only'}`);
  console.log(`${'═'.repeat(60)}`);

  console.log('##ROUTE_SPECS_MODE##');
  console.log(`##ROUTE_SPECS_PLAN:${ROUTE_SPECS.map((s) => `${s.route}:${expandRouteSpecDirections(s).length}`).join(',')}##`);

  // 滑点要在选路由之前设置
  if (SWAP_SLIPPAGE) {
    console.log(`\n[Setup] Setting slippage to ${SWAP_SLIPPAGE}%...`);
    await swapPage.setSlippage(SWAP_SLIPPAGE);
  } else {
    console.log('\n[Setup] Slippage: using page default');
  }

  const results: RouteResult[] = [];

  for (let i = 0; i < ROUTE_SPECS.length; i++) {
    const spec = ROUTE_SPECS[i];
    const route = spec.route;
    const directions = expandRouteSpecDirections(spec);
    const startMs = Date.now();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  [${i + 1}/${ROUTE_SPECS.length}] ${route} — ${directions.length} swap(s)`);
    console.log(`${'─'.repeat(60)}`);

    if (directions.length === 0) {
      // 规则里所有币对都被同资产检查剔除了
      const durationMs = Date.now() - startMs;
      results.push({ route, status: 'skipped', error: 'no valid pairs in spec', durationMs });
      console.log(`⏭ Route "${route}" SKIPPED: 规则里没有有效币对`);
      continue;
    }

    try {
      // 每条路由单独选中（不组合）——  币对各不相同，无法一次性全选
      const selectedCount = await swapPage.selectRoutes([route]);
      if (selectedCount !== 1) {
        // 0 selected 时弹窗关不掉，遮罩会拦截后续点击，刷新是唯一可靠复位
        await recoverByReload(swapPage, page, '  ');
        const durationMs = Date.now() - startMs;
        results.push({ route, status: 'skipped', error: 'route unavailable in UI', durationMs });
        console.log(`\n⏭ Route "${route}" SKIPPED: 该路由在 UI 中不存在（可能已下线）`);
        continue;
      }
      await swapPage.confirmSettingsChanges();
      console.log(`✓ Route "${route}" selected`);

      const outcome = await runPairDirectionsForRoute(
        swapPage, page, wallet, balanceChecker, walletAddress, route, directions,
      );
      const durationMs = Date.now() - startMs;

      if (outcome.failed > 0) {
        results.push({
          route,
          status: 'failed',
          error: `${outcome.failed}/${directions.length} swaps failed — ${outcome.errors.join('; ')}`,
          durationMs,
        });
        console.log(`\n❌ Route "${route}" FAILED  (${outcome.passed}/${directions.length} passed, ${(durationMs / 1000).toFixed(1)}s)`);
      } else {
        results.push({
          route,
          status: 'passed',
          quote: outcome.firstQuote,
          exchangeRate: outcome.firstRate,
          durationMs,
        });
        console.log(`\n✅ Route "${route}" PASSED  (${outcome.passed}/${directions.length} swaps, ${(durationMs / 1000).toFixed(1)}s)`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ route, status: 'failed', error: msg, durationMs: Date.now() - startMs });
      console.log(`\n❌ Route "${route}" FAILED: ${msg}`);
    }

    // 下一条路由要换币对，刷新页面保证干净起点
    try {
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(2_000);
      if (SWAP_SLIPPAGE) await swapPage.setSlippage(SWAP_SLIPPAGE);
    } catch { /* 恢复失败交由下一条路由的断言暴露 */ }
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const passed  = results.filter((r) => r.status === 'passed');
  const failed  = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ROUTE SPECS REPORT`);
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
      console.log(`  ${icon} ${r.route.padEnd(20)} quote=${r.quote}  (${time})`);
    } else {
      console.log(`  ${icon} ${r.route.padEnd(20)} ${r.error}  (${time})`);
    }
  }
  console.log(`${'═'.repeat(60)}\n`);

  // 全部路由都在 UI 中不存在 → 面板结构可能变了，必须失败
  if (skipped.length === results.length && results.length > 0) {
    throw new Error(
      `All ${results.length} route(s) were unavailable — ` +
      'Liquidity Sources 面板可能已改版，请检查路由名称与选择器。',
    );
  }
  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${results.length} route(s) failed: ` +
      failed.map((r) => `"${r.route}"`).join(', '),
    );
  }
}

/**
 * 刷新页面复位，并把滑点重新设回去。
 * 用于弹窗卡在无法关闭的状态（如 0 selected）时的兜底恢复。
 */
async function recoverByReload(swapPage: SwapPage, page: any, tag = ''): Promise<void> {
  try {
    console.log(`${tag}Reloading page to reset the stuck settings dialog...`);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2_000);
    if (SWAP_SLIPPAGE) await swapPage.setSlippage(SWAP_SLIPPAGE);
  } catch (err) {
    console.log(`${tag}⚠ Reload recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function testAllRoutesSequentially(
  swapPage: SwapPage,
  page: any,
  wallet: E2EWalletController,
  routes: string[],
  walletAddress: string | undefined,
  skipTokenSelection = false,
  balanceChecker: BalanceChecker,
) {
  const results: RouteResult[] = [];
  // 多交易对模式优先于多币种模式
  const pairDirections = PAIR_POOL.length > 0 ? expandPairDirections(PAIR_POOL) : [];
  const usePairPool = pairDirections.length > 0;
  // When token pool has 2+ entries, always re-pick tokens per route (ignore skipTokenSelection)
  const useTokenPool = !usePairPool && TOKEN_POOL.length >= 2;

  // In non-pool mode: first iteration skips token selection only if Phase 1 already selected them.
  // In pool mode: always re-select, so tokensSelected starts as false regardless.
  let tokensSelected = !useTokenPool && !usePairPool && skipTokenSelection;
  let pageReloaded = false;

  if (usePairPool) {
    console.log(`##PAIR_PLAN:${PAIR_POOL.map((p) => `${p.labelA}/${p.labelB}`).join(',')}##`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Starting sequential test for ${routes.length} routes`);
  if (usePairPool) {
    console.log(`  Pair mode: ${PAIR_POOL.length} pair(s) × 2 directions = ${pairDirections.length} swaps per route`);
  }
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
      // 路由被前端下线时搜不到，selectRoutes 返回 0 —— 这不是路由故障，
      // 记为 skipped 并继续下一条，而不是 failed。
      const selectedCount = await swapPage.selectRoutes([route]);
      if (selectedCount !== 1) {
        // 一条都没选上时弹窗停在 0 selected 的状态，前端不允许这样关闭
        // （Confirm Changes 禁用，Escape / Close 也关不掉），遮罩层会一直留在
        // 页面上拦截后续所有点击。刷新是唯一可靠的复位手段。
        await recoverByReload(swapPage, page, '  ');
        tokensSelected = false;
        pageReloaded = true;

        const durationMs = Date.now() - startMs;
        results.push({ route, status: 'skipped', error: 'route unavailable in UI', durationMs });
        // ##ROUTE_SKIPPED## 已由 selectRouteByName 输出，dashboard 据此标灰该格子
        console.log(`\n⏭ Route "${route}" SKIPPED: 该路由在 UI 中不存在（可能已下线）  (${(durationMs / 1000).toFixed(1)}s)`);
        continue;
      }
      await swapPage.confirmSettingsChanges();
      console.log(`✓ Route "${route}" selected`);

      // ── 多交易对模式：依次跑完该路由下所有 pair 的两个方向 ──────────────
      if (usePairPool) {
        const outcome = await runPairDirectionsForRoute(
          swapPage, page, wallet, balanceChecker, walletAddress, route, pairDirections,
        );
        const durationMs = Date.now() - startMs;
        // 刷新可能发生在方向失败恢复中，下一条路由重新选币最稳妥
        tokensSelected = false;
        pageReloaded = true;

        if (outcome.failed > 0) {
          throw new Error(
            `${outcome.failed}/${pairDirections.length} pair swaps failed — ${outcome.errors.join('; ')}`
          );
        }
        results.push({
          route,
          status: 'passed',
          quote: outcome.firstQuote,
          exchangeRate: outcome.firstRate,
          durationMs,
        });
        console.log(
          `\n✅ Route "${route}" PASSED  (${outcome.passed}/${pairDirections.length} pair swaps, ${(durationMs / 1000).toFixed(1)}s)`
        );
        continue;
      }

      // ── Step B: 选择代币并获取报价 ──────────────────────────────────────
      // 当启用 token pool 时，每条路由随机选两个不同 token
      let routePayToken     = SWAP_PAY_TOKEN;
      let routeReceiveToken = SWAP_RECEIVE_TOKEN;
      if (useTokenPool) {
        const pair = pickTwoRandom(TOKEN_POOL);
        if (pair) {
          routePayToken     = pair[0].address;
          routeReceiveToken = pair[1].address;
          console.log(`\n[Route ${i + 1}]  Random token pair: ${pair[0].label} → ${pair[1].label}`);
        }
        // Token pool mode: always re-select tokens for each route
        await swapPage.selectPair(routePayToken, routeReceiveToken);
        pageReloaded = false;
      } else if (!tokensSelected || pageReloaded) {
        if (pageReloaded) {
          console.log(`\n[Route ${i + 1}] Re-selecting tokens after page reload...`);
        } else {
          console.log(`\n[Route ${i + 1}] Selecting tokens for the first time...`);
        }
        await swapPage.selectPair(routePayToken, routeReceiveToken);
        tokensSelected = true;
        pageReloaded = false;
      } else {
        console.log(`\n[Route ${i + 1}] Fetching quote (reusing existing token pair)...`);
      }
      // 金额按本路由实际的支付币种解析（多币种模式下每条路由的币对都不同）
      const routePayAmount = resolvePayAmount(routePayToken);
      await swapPage.enterPayAmount(routePayAmount);
      const receiveAmount = await swapPage.getReceiveAmount();

      if (!receiveAmount || parseFloat(receiveAmount) <= 0) {
        throw new Error(`No valid quote for route "${route}"`);
      }
      const exchangeRate = (parseFloat(receiveAmount) / parseFloat(routePayAmount)).toFixed(6);
      console.log(`✓ Quote: ${routePayAmount} → ${receiveAmount} (rate: 1 : ${exchangeRate})`);

      if (EXECUTE_SWAP) {
        // ── Step C: 查询交易前余额 ─────────────────────────────────────────
        let payBefore: string | null = null, payAfter: string | null = null;
        let receiveBefore: string | null = null, receiveAfter: string | null = null;
        if (walletAddress) {
          console.log(`\n[Route ${i + 1}] Checking balances before swap...`);
          payBefore     = await readBalanceOrNull(balanceChecker, routePayToken,     walletAddress, '  ');
          receiveBefore = await readBalanceOrNull(balanceChecker, routeReceiveToken, walletAddress, '  ');
          console.log(`  Pay:     ${payBefore ?? 'n/a'}`);
          console.log(`  Receive: ${receiveBefore ?? 'n/a'}`);
        }

        // ── Step D: 执行真实 swap ──────────────────────────────────────────
        console.log(`\n[Route ${i + 1}] Executing swap (real on-chain transaction)...`);
        // executeSwap 自动检测按钮类型并等待对应次数的钱包动作
        await swapPage.executeSwap(wallet);

        const SWAP_SUCCESS_TIMEOUT = 180_000;
        const swapResult = await swapPage.waitForSwapSuccess(SWAP_SUCCESS_TIMEOUT, `Route ${i + 1}/${routes.length}`, wallet);
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
          payAfter     = await readBalanceOrNull(balanceChecker, routePayToken,     walletAddress, '  ');
          receiveAfter = await readBalanceOrNull(balanceChecker, routeReceiveToken, walletAddress, '  ');

          // RPC 查不到余额时跳过断言，避免把成功的 swap 判成失败
          const comparable = payBefore !== null && payAfter !== null &&
                             receiveBefore !== null && receiveAfter !== null;
          const decreased = comparable && parseFloat(payAfter!)     < parseFloat(payBefore!);
          const increased = comparable && parseFloat(receiveAfter!) > parseFloat(receiveBefore!);

          // 收款币与原生币共享余额时，同一笔交易的 gas 也从这份余额扣除，
          // 净值可能反而下降，因此不做增加断言，只验证 pay token 确实减少。
          const receiveIsNative = isNative(routeReceiveToken);

          console.log(`\n💰 Balance changes:`);
          console.log(`  Pay:     ${payBefore ?? 'n/a'} → ${payAfter ?? 'n/a'}  (${
            !comparable ? '⚠ query unavailable' : decreased ? '✓ decreased' : '✗ no decrease'})`);
          if (!comparable) {
            console.log(`  Receive: ${receiveBefore ?? 'n/a'} → ${receiveAfter ?? 'n/a'}  (⚠ query unavailable)`);
          } else if (receiveIsNative) {
            const receiveDiff = parseFloat(receiveAfter!) - parseFloat(receiveBefore!);
            console.log(`  Receive: ${receiveBefore} → ${receiveAfter}  (native token, gas included, net Δ=${receiveDiff.toFixed(8)} — skipping increase check)`);
          } else {
            console.log(`  Receive: ${receiveBefore} → ${receiveAfter}  (${increased ? '✓ increased' : '✗ no increase'})`);
          }

          if (!comparable) {
            console.log('  ⚠️  On-chain balance verification skipped (RPC unavailable) — swap confirmed via UI success dialog');
          } else if (!decreased) {
            throw new Error(
              `Balance check failed for route "${route}": pay token did not decrease ` +
              `(before=${payBefore}, after=${payAfter})`
            );
          } else if (!receiveIsNative && !increased) {
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
          payBefore:     payBefore     ?? undefined,
          payAfter:      payAfter      ?? undefined,
          receiveBefore: receiveBefore ?? undefined,
          receiveAfter:  receiveAfter  ?? undefined,
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
      console.log(`  ${icon} ${r.route.padEnd(30)} skipped: ${r.error ?? 'n/a'}  (${time})`);
    }
  }

  console.log(`${'═'.repeat(60)}\n`);

  // 全部路由都在 UI 中不存在 → 说明面板结构变了，不是个别路由下线，必须失败
  if (skipped.length === results.length && results.length > 0) {
    throw new Error(
      `All ${results.length} route(s) were unavailable in the UI — ` +
      'Liquidity Sources 面板可能已改版，请检查路由名称与选择器。',
    );
  }

  // 如果有失败的路由，让测试失败并打印失败列表
  if (failed.length > 0) {
    const failedNames = failed.map((r) => `"${r.route}"`).join(', ');
    throw new Error(
      `${failed.length}/${results.length} routes failed: ${failedNames}`
    );
  }
}
