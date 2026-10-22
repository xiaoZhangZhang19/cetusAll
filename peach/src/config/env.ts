import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  resolveChain,
  isNativeAsset,
  payAmountFor,
  PEACH_CHAINS,
  type PeachChainConfig,
} from './chains.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (dotenv handles quoted values, inline comments, etc.)
config({ path: resolve(__dirname, '../../.env') });

const get = (key: string, fallback = '') => process.env[key] ?? fallback;

// ── 当前链 ──────────────────────────────────────────────────────────────────
//
// PEACH_CHAIN（Dashboard 传入，如 "arc-mainnet"）优先；没传时按 E2E_CHAIN_ID
// 反查。两者都没有就回退 BSC —— 即旧有行为，所以不配新变量时完全向后兼容。
const rawChainKey = get('PEACH_CHAIN').trim();
const rawChainId  = get('E2E_CHAIN_ID').trim();

/** 当前链的完整配置。所有链相关常量都应从这里取，不要再硬编码。 */
export const chain: PeachChainConfig = resolveChain(
  rawChainKey || undefined,
  rawChainId ? parseInt(rawChainId, 10) : undefined,
);

/**
 * 当前链的 RPC 列表。
 *
 * 优先级：E2E_RPC_URL（显式覆盖）> E2E_RPC_URL_<KEY>（按链配）> 链配置内置。
 * 按链配的变量名把 key 转成大写下划线：arc-mainnet → E2E_RPC_URL_ARC_MAINNET。
 */
function resolveRpcUrls(c: PeachChainConfig): string[] {
  const explicit = get('E2E_RPC_URL').trim();
  if (explicit) return [explicit, ...c.rpcUrls.filter((u) => u !== explicit)];

  const perChainKey = `E2E_RPC_URL_${c.key.toUpperCase().replace(/-/g, '_')}`;
  const perChain = get(perChainKey).trim();
  if (perChain) return [perChain, ...c.rpcUrls.filter((u) => u !== perChain)];

  return [...c.rpcUrls];
}

const rpcUrls = resolveRpcUrls(chain);

/**
 * 当前链的流动性来源名称列表。
 *
 * 过去这是 BSC 的硬编码常量，现在跟着链走。导入方无需改动。
 */
export const PEACH_ROUTES: readonly string[] = chain.routes;

export type PeachRoute = string;

export const env = {
  appUrl: get('APP_URL', 'https://test-peachswap.vercel.app'),
  headless: get('HEADLESS', 'false') !== 'false',
  playwrightTimeoutMs: parseInt(get('PLAYWRIGHT_TIMEOUT_MS', '60000'), 10),
  actionTimeoutMs: parseInt(get('ACTION_TIMEOUT_MS', '15000'), 10),

  /** 当前链配置（与顶层 `chain` 同一对象，便于 `env.chain` 的调用习惯） */
  chain,

  // Routes to select, passed from dashboard or .env
  selectedRoutes: get('PEACH_ROUTES', '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean),

  // ── E2E Wallet（注入式钱包）配置 ────────────────────────────────────────
  // 页面里注入一个假的 EIP-1193 provider，不装扩展、不需要助记词和解锁密码，
  // 签名由 Node 侧的 ethers 完成。
  // 详见 src/wallet/bridge.ts 与 src/wallet/inject/provider.js。
  e2ePrivateKey: get('E2E_PRIVATE_KEY'),

  /** 主 RPC（bridge 用它广播交易）。永远是 rpcUrls[0] */
  e2eRpcUrl: rpcUrls[0] ?? '',
  /** 全部候选 RPC（BalanceChecker 依次失败回退） */
  e2eRpcUrls: rpcUrls,
  /** 链 ID 跟着链配置走，不再单独解析 E2E_CHAIN_ID */
  e2eChainId: chain.chainId,

  // 钱包地址（可选）。留空时由私钥推导，无需手工维护。
  walletAddress: get('WALLET_ADDRESS'),
};

/** 当前链在 URL 里的路径前缀，例如 "/bsc"。 */
export const chainPrefix: string = chain.urlPrefix;

/**
 * 拼出带链前缀的页面路径：chainPath('/swap') → "/bsc/swap"。
 *
 * peach 前端把链放在路径里（/bsc/swap、/arc/swap）。不带前缀的 /swap 会被
 * 重定向到「前端默认链」而不是我们注入的链，结果 header 只显示
 * "Switch to ..." 而拿不到钱包地址。所以所有导航都必须显式带前缀。
 */
export function chainPath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${chainPrefix}${normalized}`;
}

/** 当前链上该地址是否与原生币共享余额（gas 从中扣除）。 */
export function isNative(address: string): boolean {
  return isNativeAsset(chain, address);
}

/**
 * 取该支付币种该用的 swap 金额，没有按币种配置时返回 `fallback`。
 *
 * 高单价币（如 cirBTC ≈ $82,000/枚）用统一的 0.001 会变成 $82 一笔，
 * 既超出测试需要也容易打穿小池子。见 chains.ts 的 payAmountByToken。
 */
export function payAmountForToken(payAddress: string, fallback: string): string {
  return payAmountFor(chain, payAddress, fallback);
}

// 启动时把解析结果打出来：跑错链是最难排查的问题，开头一行日志能省很多时间。
console.log(
  `[env] Chain: ${chain.label} (key=${chain.key}, chainId=${chain.chainId}, ` +
  `prefix=${chain.urlPrefix}, native=${chain.nativeSymbol}, routes=${chain.routes.length})`,
);
console.log(`[env] RPC: ${rpcUrls[0]}${rpcUrls.length > 1 ? ` (+${rpcUrls.length - 1} fallback)` : ''}`);

if (rawChainId && parseInt(rawChainId, 10) !== chain.chainId) {
  console.warn(
    `[env] ⚠ E2E_CHAIN_ID=${rawChainId} 与解析出的链 ${chain.key} (chainId=${chain.chainId}) 不一致。` +
    `PEACH_CHAIN="${rawChainKey}" 优先生效 —— 请确认这是预期行为。`,
  );
}

export { PEACH_CHAINS };
