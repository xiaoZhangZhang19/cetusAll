/**
 * Peach 多链配置（Dashboard 侧副本）。
 *
 * ⚠️ peach/src/config/chains.ts 是运行时的事实源。
 *    改路由名、默认币对或预设币对时两边必须同步，否则 Dashboard 勾选的
 *    路由名会与测试进程里的不一致。
 */

export interface PeachChainToken {
  label: string;
  address: string;
}

export interface PeachPairPreset {
  labelA: string;
  addressA: string;
  labelB: string;
  addressB: string;
  /** A→B 方向的支付金额（留空则用全局 Swap 金额） */
  amountA?: string;
  /** B→A 方向的支付金额 */
  amountB?: string;
}

export interface PeachChainMeta {
  key: string;
  label: string;
  chainId: number;
  urlPrefix: string;
  nativeSymbol: string;
  /** 与原生币共享余额的地址（小写比对）。见 peach 侧 nativeAliases 说明 */
  nativeAliases: string[];
  routes: readonly string[];
  defaultPay: PeachChainToken;
  defaultReceive: PeachChainToken;
  /**
   * 按「支付币种」覆盖 swap 金额，key 是代币地址（小写）。
   *
   * 高单价币用统一的 0.001 金额过大：cirBTC ≈ $82,000/枚 → 单笔 $82。
   * 与 peach/src/config/chains.ts 的 payAmountByToken 保持一致。
   */
  payAmountByToken?: Record<string, string>;
  /** 多币种模式的候选池 */
  coins: PeachChainToken[];
  /** 多交易对模式的预设币对 */
  pairs: PeachPairPreset[];
}

export const NATIVE_PLACEHOLDER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

// ── BNB Smart Chain ─────────────────────────────────────────────────────────

/** BSC token 地址 */
export const BSC_TOKENS = {
  BNB:   NATIVE_PLACEHOLDER,
  WBNB:  '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  USDT:  '0x55d398326f99059fF775485246999027B3197955',
  USDC:  '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  USD1:  '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d',
  U:     '0xcE24439F2D9C6a2289F741120FE202248B666666',
  ASTER: '0x000Ae314E2A2172a039B26378814C252734f556A',
} as const;

type BscSymbol = keyof typeof BSC_TOKENS;

/** BSC 预设币对。每组依次执行 A→B、B→A */
const BSC_PAIR_SYMBOLS: Array<[BscSymbol, BscSymbol]> = [
  ['USD1', 'U'],
  ['USDT', 'USD1'],
  ['USDC', 'USD1'],
  ['ASTER', 'USD1'],
  ['U', 'BNB'],
  ['USDT', 'U'],
  ['USD1', 'BNB'],
  ['USDC', 'U'],
  ['USDT', 'BNB'],
  ['USDC', 'WBNB'],
  ['USDC', 'BNB'],
  ['USDT', 'USDC'],
];

/** BSC 的 25 条流动性来源。"Peach PQF" 在弹窗里独立成组（"Other Quotes"） */
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
 * ARC token 地址。
 *
 * ⚠️ USDC 既是原生币也有 ERC-20 precompile 视图（0x3600…）——
 *    它和 0xeeee… 读的是同一份余额，不能互相组成币对。
 */
export const ARC_TOKENS = {
  USDC:   '0x3600000000000000000000000000000000000000',
  EURC:   '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1',
  cirBTC: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0',
} as const;

type ArcSymbol = keyof typeof ARC_TOKENS;

/**
 * ARC 预设币对。原生币=USDC，所以不设 USDC/原生币这种自换自的组合。
 *
 * 按流动性排序（实测 0.001 金额、逐条路由）：
 *   USDC/EURC   9/16 条路由可报价 ← 最佳，放首位
 *   USDC/cirBTC 流动性稀薄，仅少数路由可报价
 *   EURC/cirBTC 同上
 * 逐条路由模式下建议只选 USDC/EURC；组合模式三组都能出价。
 */
const ARC_PAIR_SYMBOLS: Array<[ArcSymbol, ArcSymbol]> = [
  ['USDC', 'EURC'],
  ['USDC', 'cirBTC'],
  ['EURC', 'cirBTC'],
];

/**
 * ARC 按币种的支付金额。
 *
 * cirBTC ≈ $82,000/枚，用统一的 0.001 等于单笔 $82 —— 既超出测试所需，
 * 也容易打穿小额池子。0.000001 约合 $0.08，与其他币的量级相当。
 */
const ARC_PAY_AMOUNTS: Record<string, string> = {
  [ARC_TOKENS.cirBTC.toLowerCase()]: '0.000001',
};

/**
 * ARC Mainnet 的 16 条流动性来源，对应
 * GET https://api-arc.cipheron.org/arc-mainnet/router/status 的 providers。
 *
 * 前两条在弹窗里是折叠分组的子项（"Launchpad" / "Other Quotes"），
 * 由 peach 侧的 _expandSourceGroups() 自动展开。
 */
const ARC_ROUTES = [
  // 分组子项（折叠态）
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

// ── 链表 ────────────────────────────────────────────────────────────────────

/**
 * 展开预设币对，并按「支付币种」填入该方向的金额。
 *
 * 每个方向付的是不同的币：A→B 付 A，B→A 付 B。所以 cirBTC 只在它作为
 * 支付方的那个方向用 0.000001，反方向仍用正常金额。
 */
function toPairs<T extends string>(
  symbols: Array<[T, T]>,
  tokens: Record<T, string>,
  amountByToken: Record<string, string> = {},
): PeachPairPreset[] {
  const amt = (addr: string) => amountByToken[addr.toLowerCase()];
  return symbols.map(([a, b]) => ({
    labelA: a, addressA: tokens[a], amountA: amt(tokens[a]),
    labelB: b, addressB: tokens[b], amountB: amt(tokens[b]),
  }));
}

export const PEACH_CHAIN_LIST: PeachChainMeta[] = [
  {
    key: 'bsc',
    label: 'BNB Smart Chain',
    chainId: 56,
    urlPrefix: '/bsc',
    nativeSymbol: 'BNB',
    // BSC 的 WBNB 是独立 ERC-20，需要显式 wrap，不与原生币共享余额
    nativeAliases: [NATIVE_PLACEHOLDER],
    routes: BSC_ROUTES,
    defaultPay:     { label: 'BNB',  address: BSC_TOKENS.BNB },
    defaultReceive: { label: 'USDT', address: BSC_TOKENS.USDT },
    coins: [
      { label: 'BNB',  address: BSC_TOKENS.BNB },
      { label: 'USDT', address: BSC_TOKENS.USDT },
      { label: 'USDC', address: BSC_TOKENS.USDC },
    ],
    pairs: toPairs(BSC_PAIR_SYMBOLS, BSC_TOKENS),
  },
  {
    key: 'arc-mainnet',
    label: 'ARC Mainnet',
    chainId: 5042,
    // /arc-mainnet/swap 会 308 跳到 /arc/swap
    urlPrefix: '/arc',
    nativeSymbol: 'USDC',
    nativeAliases: [NATIVE_PLACEHOLDER, ARC_TOKENS.USDC],
    routes: ARC_ROUTES,
    // 实测 USDC→EURC 在 16 条路由里有 9 条能报价，cirBTC 的流动性稀薄得多
    defaultPay:     { label: 'USDC', address: ARC_TOKENS.USDC },
    defaultReceive: { label: 'EURC', address: ARC_TOKENS.EURC },
    coins: [
      { label: 'USDC',   address: ARC_TOKENS.USDC },
      { label: 'EURC',   address: ARC_TOKENS.EURC },
      { label: 'cirBTC', address: ARC_TOKENS.cirBTC },
    ],
    payAmountByToken: ARC_PAY_AMOUNTS,
    pairs: toPairs(ARC_PAIR_SYMBOLS, ARC_TOKENS, ARC_PAY_AMOUNTS),
  },
];

// ── 按路由配置币对（模式 R）────────────────────────────────────────────────

/** 一条路由规则里的单组币对 */
export interface RouteSpecPair {
  id: string;
  labelA: string;
  addressA: string;
  labelB: string;
  addressB: string;
  /** A→B 方向金额；留空则按币种自动解析 */
  amountA?: string;
  /** B→A 方向金额 */
  amountB?: string;
  /** 关掉则只跑 A→B，不跑回程（某些池子只有单边流动性） */
  bothDirections: boolean;
  /** 取消勾选则本轮不跑这组 */
  enabled: boolean;
}

/** 一条路由的完整规则 */
export interface RouteSpec {
  route: string;
  enabled: boolean;
  pairs: RouteSpecPair[];
}

/**
 * 为某条链生成初始的按路由规则：每条路由预填该链首选币对。
 *
 * 首选币对取 pairs[0]（已按流动性排序），用户只需改动需要特殊处理的那几条，
 * 不必 16 条路由逐个从零配置。
 */
export function defaultRouteSpecs(chain: PeachChainMeta): RouteSpec[] {
  const first = chain.pairs[0];
  return chain.routes.map((route) => ({
    route,
    enabled: true,
    pairs: first
      ? [{
          id: `${route}-0`,
          labelA: first.labelA, addressA: first.addressA,
          labelB: first.labelB, addressB: first.addressB,
          amountA: first.amountA, amountB: first.amountB,
          bothDirections: true,
          enabled: true,
        }]
      : [],
  }));
}

/**
 * 把 UI 规则转成 runner 的 SWAP_ROUTE_SPECS 载荷。
 * 过滤掉未勾选的路由与币对，并剔除空规则（选中了路由却没有币对等于空跑）。
 */
export function routeSpecsToPayload(specs: RouteSpec[]) {
  return specs
    .filter((s) => s.enabled)
    .map((s) => ({
      route: s.route,
      pairs: s.pairs
        .filter((p) => p.enabled && p.addressA.trim() && p.addressB.trim())
        .map((p) => ({
          labelA: p.labelA, addressA: p.addressA.trim(),
          labelB: p.labelB, addressB: p.addressB.trim(),
          // 留空表示交给 runner 按币种解析，不要传空字符串
          amountA: p.amountA?.trim() || undefined,
          amountB: p.amountB?.trim() || undefined,
          bothDirections: p.bothDirections,
        })),
    }))
    .filter((s) => s.pairs.length > 0);
}

/** 统计一份规则实际会产生多少次 swap（用于预估耗时） */
export function countRouteSpecSwaps(specs: RouteSpec[]): number {
  return routeSpecsToPayload(specs).reduce(
    (n, s) => n + s.pairs.reduce((m, p) => m + (p.bothDirections ? 2 : 1), 0),
    0,
  );
}

/** 取某支付币种该用的金额，没有按币种配置时返回 `fallback`。 */
export function payAmountFor(
  chain: PeachChainMeta,
  payAddress: string,
  fallback: string,
): string {
  return chain.payAmountByToken?.[payAddress.toLowerCase()] ?? fallback;
}

export const DEFAULT_PEACH_CHAIN_KEY = 'bsc';

export function getPeachChain(key: string): PeachChainMeta {
  return (
    PEACH_CHAIN_LIST.find((c) => c.key === key) ??
    PEACH_CHAIN_LIST.find((c) => c.key === DEFAULT_PEACH_CHAIN_KEY)!
  );
}

/** 某地址在该链上是否与原生币共享余额 */
export function isNativeAsset(chain: PeachChainMeta, address: string): boolean {
  const a = address.toLowerCase();
  return chain.nativeAliases.some((alias) => alias.toLowerCase() === a);
}

/** 两个地址在该链上是否是同一资产（不能组成币对） */
export function isSameAsset(
  chain: PeachChainMeta,
  a: string,
  b: string,
): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  return isNativeAsset(chain, a) && isNativeAsset(chain, b);
}
