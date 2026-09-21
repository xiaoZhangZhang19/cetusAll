import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (dotenv handles quoted values, inline comments, etc.)
config({ path: resolve(__dirname, '../../.env') });

const get = (key: string, fallback = '') => process.env[key] ?? fallback;

export const PEACH_ROUTES = [
  // Peach 自有报价源。在 Liquidity Sources 弹窗里它独立成组（"Other Quotes"），
  // 不属于 "Liquidity Sources" 那一组，所以面板计数会显示成 24/25 + 0/1 两行。
  // selectRouteByName 是按名称搜索后点行，与分组无关，因此照常可选。
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

export type PeachRoute = typeof PEACH_ROUTES[number];

export const env = {
  appUrl: get('APP_URL', 'https://test-peachswap.vercel.app'),
  headless: get('HEADLESS', 'false') !== 'false',
  playwrightTimeoutMs: parseInt(get('PLAYWRIGHT_TIMEOUT_MS', '60000'), 10),
  actionTimeoutMs: parseInt(get('ACTION_TIMEOUT_MS', '15000'), 10),
  // Routes to select, passed from dashboard or .env
  selectedRoutes: get('PEACH_ROUTES', '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean),
  
  // ── E2E Wallet（注入式钱包）配置 ────────────────────────────────────────
  // 页面里注入假的 EIP-1193 provider，不装扩展、不需要助记词和解锁密码：
  // 页面里注入一个假的 EIP-1193 provider，签名由 Node 侧的 ethers 完成。
  // 详见 src/wallet/bridge.ts 与 src/wallet/inject/provider.js。
  e2ePrivateKey: get('E2E_PRIVATE_KEY'),
  e2eRpcUrl: get('E2E_RPC_URL'),
  e2eChainId: parseInt(get('E2E_CHAIN_ID', '56'), 10),

  // 钱包地址（可选）。留空时由私钥推导，无需手工维护。
  walletAddress: get('WALLET_ADDRESS'),
};

/**
 * chainId → 前端 URL 里的链前缀。
 *
 * peach 前端把链放在路径里（/bsc/swap、/arc-testnet/terminal）。
 * 不带前缀的 /swap 会被重定向到「前端默认链」而不是我们注入的链，
 * 结果 header 只显示 "Switch to ..." 而拿不到钱包地址。
 * 所以所有导航都必须显式带上与 E2E_CHAIN_ID 对应的前缀。
 */
const CHAIN_PREFIX_BY_ID: Record<number, string> = {
  56: '/bsc',
  5042002: '/arc-testnet',
};

/** 当前链在 URL 里的路径前缀，例如 "/bsc"。未知链回退为空字符串。 */
export const chainPrefix: string = CHAIN_PREFIX_BY_ID[env.e2eChainId] ?? '';

if (!CHAIN_PREFIX_BY_ID[env.e2eChainId]) {
  console.warn(
    `[env] chainId ${env.e2eChainId} 没有登记 URL 前缀，导航将使用不带前缀的路径，` +
    '前端可能重定向到它的默认链。请在 src/config/env.ts 的 CHAIN_PREFIX_BY_ID 里补充。',
  );
}

/** 拼出带链前缀的页面路径：chainPath('/swap') → "/bsc/swap"。 */
export function chainPath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${chainPrefix}${normalized}`;
}
