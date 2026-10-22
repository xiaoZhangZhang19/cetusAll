/**
 * Peach 多链配置 —— 所有链相关常量的单一事实源。
 *
 * 加新链只改这个文件：路由名、URL 前缀、RPC、原生币语义、默认币对。
 * env.ts / balance-checker.ts / swap.page.ts / spec 都从这里取值，
 * 不再各自硬编码 BSC 的 56 / BNB / bsc-dataseed。
 *
 * ⚠️ dashboard/src/lib/peach-chains.ts 是本文件的前端副本，
 *    改路由名或默认币对时两边要同步。
 */

export interface ChainToken {
  label: string;
  address: string;
}

export interface PeachChainConfig {
  /** 稳定标识，Dashboard 通过 PEACH_CHAIN 环境变量传入 */
  key: string;
  label: string;
  chainId: number;
  /** 前端 URL 里的链前缀，例如 "/bsc"。导航必须带上，否则会被重定向到默认链 */
  urlPrefix: string;
  /** 主节点 + 备用节点。BalanceChecker 依次失败回退 */
  rpcUrls: string[];
  /** 原生币符号，用于日志和 gas 警告文案 */
  nativeSymbol: string;
  /**
   * 与原生币共享同一份余额的合约地址（小写）。
   *
   * ARC 的原生币就是 USDC：`0x3600…0000` 是它的 ERC-20 precompile 视图，
   * 读的是同一个余额（只是 6 位精度 vs 18 位 wei）。所以这两个地址
   * 必须视为同一资产 —— 既不能互相组成币对，也要在余额断言里
   * 一律按「gas 从中扣除」处理。
   *
   * BSC 上 WBNB 是真正独立的 ERC-20 合约（需要 wrap），不属于此列。
   */
  nativeAliases: string[];
  /** Liquidity Sources 弹窗里的来源名称。大小写以 UI 实际渲染为准 */
  routes: readonly string[];
  /** 未指定路由时的兜底单路由 */
  defaultRoute: string;
  defaultPay: ChainToken;
  defaultReceive: ChainToken;
  /**
   * 按「支付币种」覆盖 swap 金额，key 是代币地址（小写）。
   *
   * 统一用 0.001 对高单价币来说金额过大：cirBTC ≈ $82,000/枚，
   * 0.001 就是 $82 一笔，远超测试所需，而且很容易打穿小额池子的流动性。
   * 这里按币种配一个合适的数量级，哪个币作为 You Pay 就用它的值。
   *
   * 仅作为默认值：显式传 SWAP_PAY_AMOUNT 或币对里的 amountA/amountB 优先。
   */
  payAmountByToken?: Record<string, string>;
}

/** 各链通用的原生币占位地址（前端 URL 参数和 token 选择器都用它） */
export const NATIVE_PLACEHOLDER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

// ── BNB Smart Chain ─────────────────────────────────────────────────────────

/**
 * BSC 的 25 条流动性来源。
 *
 * "Peach PQF" 在弹窗里独立成组（"Other Quotes"），不属于 "Liquidity Sources"
 * 那一组，所以面板计数显示为 24/25 + 0/1 两行。selectRouteByName 按名称
 * 搜索后点行，与分组无关，照常可选。
 */
const BSC_ROUTES = [
  'Peach PQF',
  'Uniswap V2',
  'Uniswap V3',
  'Uniswap V4',
  'PancakeSwap V1',
  'PancakeSwap V2',
  'PancakeSwap V3',
  'PancakeSwap Stable',
  'PancakeSwap Infinity CL',
  'PancakeSwap Infinity LBAMM',
  'Thena V3',
  'Thena Fusion',
  'Lista Stable',
  'SushiSwap V2',
  'SushiSwap V3',
  'DODO',
  'Nomiswap Stable',
  'BiSwap',
  'ApeSwap',
  'BabySwap',
  'SquadSwap V2',
  'SquadSwap V3',
  'Wombat',
  'BakerySwap',
  'BabyDogeSwap',
] as const;

// ── ARC Mainnet ─────────────────────────────────────────────────────────────

/**
 * ARC Mainnet 的 16 条流动性来源，对应
 * GET https://api-arc.cipheron.org/arc-mainnet/router/status 的 providers。
 *
 * 两个来源在弹窗里是折叠分组的子项，不是顶层行：
 *   LAUNCHPAD → "Launchpad" 分组下的 "Peach Launchpad"
 *   PQF       → "Other Quotes" 分组下的 "Peach PQF"
 * 分组由 swap.page.ts 的 _expandSourceGroups() 统一展开（按 aria-expanded 幂等）。
 *
 * 其余 provider code 与 UI 名一一对应，仅大小写/空格写法可能有差异 ——
 * selectRouteByName 做了归一化匹配（去空格+小写），所以这里按常规写法填即可。
 */
const ARC_ROUTES = [
  // 分组子项（折叠态，由 _expandSourceGroups 展开）
  'Peach Launchpad',   // LAUNCHPAD  — "Launchpad" 分组
  'Peach PQF',         // PQF        — "Other Quotes" 分组
  // 顶层行，顺序与 UI 一致
  'Uniswap V2',        // UNISWAPV2
  'Uniswap V3',        // UNISWAPV3
  'Uniswap V4',        // UNISWAPV4
  'SushiSwap V2',      // SUSHISWAPV2
  'SushiSwap V3',      // SUSHISWAPV3
  'Aerodrome V3',      // AERODROMEV3
  'CircleWarp',        // WARPV2      — UI 名与 provider code 差异最大
  'AchSwap V2',        // ACHSWAPV2
  'AchSwap V3',        // ACHSWAPV3
  'JpegWorld V2',      // JPEGWORLDV2
  'Synthra V3',        // SYNTHRAV3
  'Topaz',             // TOPAZCL     — UI 上没有 "CL" 后缀
  'Arcade v3',         // ARCADEV3    — UI 用小写 v
  'Lunya',             // LUNYA
] as const;

// ── ARC Mainnet token 地址 ───────────────────────────────────────────────────
// USDC 既是原生币也有 ERC-20 precompile 视图（见 nativeAliases 说明）。
export const ARC_TOKENS = {
  USDC:   '0x3600000000000000000000000000000000000000',
  EURC:   '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1',
  cirBTC: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0',
} as const;

// ── BSC token 地址 ──────────────────────────────────────────────────────────
export const BSC_TOKENS = {
  BNB:  NATIVE_PLACEHOLDER,
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
} as const;

// ── 链表 ────────────────────────────────────────────────────────────────────

/**
 * 备用 BSC 公共节点：主节点限流/不可用时依次回退。
 *
 * 被移除的节点及原因（2026-09 本机实测）：
 *   - bsc.publicnode.com：把 eth_getTransactionReceipt 当 archive 请求拒掉（403）
 *   - bsc-dataseed.binance.org 等：本机 curl 直接超时
 */
const BSC_RPC_URLS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc.meowrpc.com',
  'https://1rpc.io/bnb',
  'https://bsc.drpc.org',
];

export const PEACH_CHAINS: Record<string, PeachChainConfig> = {
  bsc: {
    key: 'bsc',
    label: 'BNB Smart Chain',
    chainId: 56,
    urlPrefix: '/bsc',
    rpcUrls: BSC_RPC_URLS,
    nativeSymbol: 'BNB',
    // BSC 的 WBNB 是独立 ERC-20，需要显式 wrap，不与原生币共享余额
    nativeAliases: [NATIVE_PLACEHOLDER],
    routes: BSC_ROUTES,
    defaultRoute: 'Uniswap V3',
    defaultPay:     { label: 'BNB',  address: BSC_TOKENS.BNB },
    defaultReceive: { label: 'USDT', address: BSC_TOKENS.USDT },
  },

  'arc-mainnet': {
    key: 'arc-mainnet',
    label: 'ARC Mainnet',
    chainId: 5042,
    // /arc-mainnet/swap 会 308 跳到 /arc/swap，直接用最终路径避免一次重定向
    urlPrefix: '/arc',
    rpcUrls: ['https://arc-rpc.publicnode.com'],
    nativeSymbol: 'USDC',
    // 原生币就是 USDC：0x3600… 是它的 ERC-20 precompile 视图，同一份余额
    nativeAliases: [NATIVE_PLACEHOLDER, ARC_TOKENS.USDC],
    routes: ARC_ROUTES,
    defaultRoute: 'Uniswap V3',
    // 默认用 USDC→EURC：实测 16 条路由里有 9 条能报价，
    // 而 USDC→cirBTC 只有极少数路由有流动性（逐条模式几乎全军覆没）。
    defaultPay:     { label: 'USDC', address: ARC_TOKENS.USDC },
    defaultReceive: { label: 'EURC', address: ARC_TOKENS.EURC },
    payAmountByToken: {
      // cirBTC ≈ $82,000/枚，0.001 等于 $82 一笔。降到 0.000001（≈$0.08）
      [ARC_TOKENS.cirBTC.toLowerCase()]: '0.000001',
    },
  },
};

/** 默认链：不传 PEACH_CHAIN 且 E2E_CHAIN_ID 无法反查时使用 */
export const DEFAULT_CHAIN_KEY = 'bsc';

/**
 * 解析当前链配置。
 *
 * 优先级：显式 key（Dashboard 传的 PEACH_CHAIN）> chainId 反查 > 默认 BSC。
 * 未登记的 chainId 会回退默认链并告警，而不是静默跑错链。
 */
export function resolveChain(
  chainKey?: string,
  chainId?: number,
): PeachChainConfig {
  if (chainKey) {
    const byKey = PEACH_CHAINS[chainKey];
    if (byKey) return byKey;
    console.warn(`[chains] 未知的 PEACH_CHAIN="${chainKey}"，将改用 chainId / 默认链`);
  }

  if (chainId !== undefined) {
    const byId = Object.values(PEACH_CHAINS).find((c) => c.chainId === chainId);
    if (byId) return byId;
    console.warn(
      `[chains] chainId ${chainId} 没有登记，回退到 ${DEFAULT_CHAIN_KEY}。` +
      '请在 src/config/chains.ts 的 PEACH_CHAINS 里补充。',
    );
  }

  return PEACH_CHAINS[DEFAULT_CHAIN_KEY];
}

/**
 * 判断某个地址在当前链上是否与原生币共享余额。
 *
 * 用途有两处，都不能漏：
 *   1. 余额断言：gas 从这份余额里扣，收款方是它时净变化可能为负，跳过「增加」断言
 *   2. 币对合法性：ARC 上 0xeeee… 与 0x3600… 是同一资产，不能组成币对
 */
export function isNativeAsset(chain: PeachChainConfig, address: string): boolean {
  const a = address.toLowerCase();
  return chain.nativeAliases.some((alias) => alias.toLowerCase() === a);
}

/**
 * 取某个支付币种该用的 swap 金额。
 *
 * @param payAddress 作为 You Pay 的代币地址
 * @param fallback   没有按币种配置时的默认金额
 */
export function payAmountFor(
  chain: PeachChainConfig,
  payAddress: string,
  fallback: string,
): string {
  return chain.payAmountByToken?.[payAddress.toLowerCase()] ?? fallback;
}
