import { env } from '@/config/env.js';

// ─── Token constants ───────────────────────────────────────────────────────────

export const COIN_TYPES = {
  SUI: '0x2::sui::SUI',
  USDC: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  CETUS: '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS',
  MEOW: '0x06b145d0322e389d6225f336ab57bba4c67e4e701bd6c6bc959d90675900a17e::meow::MEOW',
  SBOX: '0xbff8dc60d3f714f678cd4490ff08cabbea95d308c6de47a150c79cc875e0c7c6::sbox::SBOX'
} as const;

/** Token decimal mapping used for amount conversion. */
export const TOKEN_DECIMALS: Record<string, number> = {
  [COIN_TYPES.SUI]: 9,
  [COIN_TYPES.USDC]: 6,
  [COIN_TYPES.CETUS]: 9,
  [COIN_TYPES.MEOW]: env.meowDecimal,
  [COIN_TYPES.SBOX]: env.sboxDecimal
};

// ─── Route test scenarios ──────────────────────────────────────────────────────

/** Route test: SUI → MEOW (single pool direct route) */
export const routeSinglePoolScenario = {
  fromCoin: COIN_TYPES.SUI,
  toCoin: COIN_TYPES.MEOW,
  fromSymbol: 'SUI',
  toSymbol: 'MEOW',
  testAmount: '1'
};

/** Route test: SUI → USDC (multi-pool route, behavior may vary by amount) */
export const routeMultiPoolScenario = {
  fromCoin: COIN_TYPES.SUI,
  toCoin: COIN_TYPES.USDC,
  fromSymbol: 'SUI',
  toSymbol: 'USDC',
  testAmounts: ['1', '10', '50'] as const
};

// ─── High price impact scenario ────────────────────────────────────────────────

/** High price impact test: extremely large SBOX → SUI swap */
export const highImpactScenario = {
  fromCoin: COIN_TYPES.SBOX,
  toCoin: COIN_TYPES.SUI,
  fromSymbol: 'SBOX',
  toSymbol: 'SUI',
  largeAmount: '111111111111111111',
  expectedDeviationThreshold: 50 // expect price deviation > 50%
};

// ─── Decimal precision scenario ────────────────────────────────────────────────

/** Precision test: USDC (6 decimals) → SUI (9 decimals) */
export const decimalPrecisionScenario = {
  inputCoinType: COIN_TYPES.USDC,
  outputCoinType: COIN_TYPES.SUI,
  inputDecimal: 6,
  outputDecimal: 9,
  inputAmountUi: '0.1' // 使用更大金额减少价格影响，同时仍能测试精度
};

/**
 * Merge Swap scenario: SUI + USDC → CETUS
 * URL: /merge-swap
 * Input 1: 0.1 SUI
 * Input 2: 0.1 USDC
 * Output: CETUS
 */
export const mergeSwapScenario = {
  path: '/merge-swap',
  inputCoinType1: COIN_TYPES.SUI,
  inputCoinType2: COIN_TYPES.USDC,
  outputCoinType: COIN_TYPES.CETUS,
  inputSymbol1: 'SUI',
  inputSymbol2: 'USDC',
  outputSymbol: 'CETUS',
  inputAmountUi1: '0.1',
  inputAmountUi2: '0.1',
  inputDecimal1: 9,
  inputDecimal2: 6,
  outputDecimal: 9
};

export const swapScenario = {
  path: '/swap',
  fromTokenSymbol: env.swapFromTokenSymbol,
  toTokenSymbol: env.swapToTokenSymbol,
  inputAmountUi: env.swapInputAmountUi,
  slippageBpsUi: String(env.defaultSlippageBps),
  inputCoinType: env.swapInputType,
  outputCoinType: env.swapOutputType
};

export const limitScenario = {
  path: '/limit',
  inputAmountUi: env.limitInputAmountUi,
  inputCoinType: env.limitInputType,
  outputCoinType: env.limitOutputType
};

export const dcaScenario = {
  path: '/dca',
  inputCoinType: env.limitInputType,
  outputCoinType: env.limitOutputType
};

export const marginScenario = {
  path: '/margin',
  baseSymbol: env.marginBaseSymbol,
  quoteSymbol: env.marginQuoteSymbol,
  inputCoinType: env.marginInputType,
  outputCoinType: env.marginOutputType,
  targetNotionalUsd: env.marginTargetNotionalUsd
};

export const clmmScenario = {
  path: '/pools',
  baseSymbol: env.clmmPoolBaseSymbol,
  quoteSymbol: env.clmmPoolQuoteSymbol,
  inputTokenSymbol: env.clmmInputTokenSymbol,
  inputAmountUi: env.clmmInputAmountUi
};

/**
 * Add more liquidity to an existing CLMM position.
 * Flow: My Positions → CLMM filter → find pair → click "+" → position-detail/increase page
 */
export const clmmZapInScenario = {
  path: '/pools',
  baseSymbol: env.clmmPoolBaseSymbol,
  quoteSymbol: env.clmmPoolQuoteSymbol,
  zapTokenSymbol: env.clmmZapTokenSymbol,
  inputAmountUi: env.clmmZapAmountUi
};

export const clmmAddMoreScenario = {
  path: '/pools?tab=positions',
  baseSymbol: env.clmmPoolBaseSymbol,
  quoteSymbol: env.clmmPoolQuoteSymbol,
  inputTokenSymbol: env.clmmInputTokenSymbol,
  inputAmountUi: env.clmmAddMoreAmountUi
};

/**
 * Add more liquidity to an existing DLMM position.
 * Flow: My Positions → DLMM filter → find pair → click "+" → position-detail/increase page
 */
export const dlmmAddMoreScenario = {
  path: '/pools?tab=positions',
  baseSymbol: env.dlmmPoolBaseSymbol,
  quoteSymbol: env.dlmmPoolQuoteSymbol,
  inputTokenSymbol: env.dlmmPoolBaseSymbol, // DLMM 使用 base symbol（SUI）
  inputAmountUi: env.dlmmAddMoreAmountUi
};

export const dlmmZapInScenario = {
  path: '/pools?tab=dlmm_pools',
  baseSymbol: env.dlmmPoolBaseSymbol,
  quoteSymbol: env.dlmmPoolQuoteSymbol,
  zapTokenSymbol: env.dlmmZapTokenSymbol,
  inputAmountUi: env.dlmmZapAmountUi
};

export const dlmmZapIncreaseScenario = {
  path: '/pools?tab=positions',
  baseSymbol: env.dlmmPoolBaseSymbol,
  quoteSymbol: env.dlmmPoolQuoteSymbol,
  zapTokenSymbol: env.dlmmZapTokenSymbol,
  inputAmountUi: env.dlmmZapAmountUi
};

export const dlmmScenario = {
  path: '/pools?tab=dlmm_pools',
  baseSymbol: env.dlmmPoolBaseSymbol,
  quoteSymbol: env.dlmmPoolQuoteSymbol,
  inputAmountUi: env.dlmmInputAmountUi
};

export const clmmRemoveScenario = {
  path: '/pools?tab=positions',
  baseSymbol: env.clmmPoolBaseSymbol,
  quoteSymbol: env.clmmPoolQuoteSymbol,
  removeTokenSymbol: env.clmmRemoveTokenSymbol
};

export const dlmmRemoveScenario = {
  path: '/pools?tab=positions',
  baseSymbol: env.dlmmPoolBaseSymbol,
  quoteSymbol: env.dlmmPoolQuoteSymbol,
  removeTokenSymbol: env.dlmmRemoveTokenSymbol
};

export const dlmmZapOutScenario = {
  path: '/pools?tab=positions',
  baseSymbol: env.dlmmPoolBaseSymbol,
  quoteSymbol: env.dlmmPoolQuoteSymbol,
  removeTokenSymbol: env.dlmmRemoveTokenSymbol
};
