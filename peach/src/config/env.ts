import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (dotenv handles quoted values, inline comments, etc.)
config({ path: resolve(__dirname, '../../.env') });

const get = (key: string, fallback = '') => process.env[key] ?? fallback;

export const PEACH_ROUTES = [
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
  appUrl: get('APP_URL', 'https://demo.peach.ag'),
  headless: get('HEADLESS', 'false') !== 'false',
  playwrightTimeoutMs: parseInt(get('PLAYWRIGHT_TIMEOUT_MS', '60000'), 10),
  actionTimeoutMs: parseInt(get('ACTION_TIMEOUT_MS', '15000'), 10),
  // Routes to select, passed from dashboard or .env
  selectedRoutes: get('PEACH_ROUTES', '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean),
  
  // ── MetaMask wallet configuration ──────────────────────────────────────
  walletPassword: get('WALLET_PASSWORD'),
  walletSeedPhrase: get('WALLET_SEED_PHRASE'),
  walletExtensionPath: get('WALLET_EXTENSION_PATH'),
  walletUserDataDir: get('WALLET_USER_DATA_DIR', '.playwright-wallet-profile'),
  walletAddress: get('WALLET_ADDRESS'),
};
