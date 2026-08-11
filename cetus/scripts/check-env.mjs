import { config as loadEnv } from 'dotenv';

loadEnv();

// ─── Required keys (missing any → exit 1) ─────────────────────────────────────
const requiredKeys = [
  'APP_URL',
  'TEST_WALLET_ADDRESS',
  'SWAP_INPUT_TYPE',
  'SWAP_OUTPUT_TYPE'
];

// ─── Optional keys with defaults ──────────────────────────────────────────────
const optionalKeys = [
  { key: 'SUI_RPC_URL',               default: '(built-in endpoint from config/networks.ts)' },
  { key: 'SUI_NETWORK',               default: 'mainnet' },
  { key: 'DEFAULT_SLIPPAGE_BPS',      default: '100' },
  { key: 'SWAP_INPUT_AMOUNT_UI',      default: '0.1' },
  { key: 'WALLET_EXTENSION_PATH',     default: '(not set – extension wallet disabled)' },
  { key: 'WALLET_PASSWORD',           default: '(not set)' },
  { key: 'MEOW_DECIMAL',              default: '5' },
  { key: 'SBOX_DECIMAL',              default: '9' },
  { key: 'FIND_ROUTER_URL_PATTERN',   default: 'https://api-sui.cetus.zone/router_v3/find_routes**' }
];

// ─── Check required ────────────────────────────────────────────────────────────
const missing = requiredKeys.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error('❌  Missing required environment variables:');
  missing.forEach((key) => console.error(`   - ${key}`));
  process.exit(1);
}

// ─── Summarise configuration ───────────────────────────────────────────────────
console.log('✅  Required environment variables are present.\n');

console.log('── Core ────────────────────────────────────');
console.log(`  APP_URL               = ${process.env.APP_URL}`);
console.log(`  SUI_RPC_URL           = ${process.env.SUI_RPC_URL ?? '(built-in endpoint, no override)'}`);
console.log(`  SUI_NETWORK           = ${process.env.SUI_NETWORK ?? 'mainnet (default)'}`);
console.log(`  TEST_WALLET_ADDRESS   = ${process.env.TEST_WALLET_ADDRESS}`);

console.log('\n── Swap ────────────────────────────────────');
console.log(`  SWAP_INPUT_TYPE       = ${process.env.SWAP_INPUT_TYPE}`);
console.log(`  SWAP_OUTPUT_TYPE      = ${process.env.SWAP_OUTPUT_TYPE}`);
console.log(`  SWAP_INPUT_AMOUNT_UI  = ${process.env.SWAP_INPUT_AMOUNT_UI ?? '0.1 (default)'}`);
console.log(`  DEFAULT_SLIPPAGE_BPS  = ${process.env.DEFAULT_SLIPPAGE_BPS ?? '100 (default)'}`);

console.log('\n── Token Decimals ──────────────────────────');
console.log(`  MEOW_DECIMAL          = ${process.env.MEOW_DECIMAL ?? '5 (default)'}`);
console.log(`  SBOX_DECIMAL          = ${process.env.SBOX_DECIMAL ?? '9 (default)'}`);

console.log('\n── Router Degradation ──────────────────────');
console.log(`  FIND_ROUTER_URL_PATTERN = ${process.env.FIND_ROUTER_URL_PATTERN ?? 'https://api-sui.cetus.zone/router_v3/find_routes** (default)'}`);

console.log('\n── Wallet ──────────────────────────────────');
console.log(`  WALLET_EXTENSION      = ${process.env.WALLET_EXTENSION ?? 'slush (default)'}`);
console.log(`  WALLET_DISPLAY_NAME   = ${process.env.WALLET_DISPLAY_NAME ?? 'Slush Wallet (default)'}`);
console.log(`  WALLET_EXTENSION_PATH = ${process.env.WALLET_EXTENSION_PATH ?? '(not set)'}`);
console.log(`  WALLET_USER_DATA_DIR  = ${process.env.WALLET_USER_DATA_DIR ?? '.playwright-wallet-profile (default)'}`);
console.log(`  WALLET_PASSWORD       = ${process.env.WALLET_PASSWORD ? '(set)' : '(not set)'}`);

// ─── Warn about optional-but-important keys ────────────────────────────────────
const warnings = [];
if (!process.env.WALLET_EXTENSION_PATH) {
  warnings.push('WALLET_EXTENSION_PATH is not set — wallet extension auto-load is disabled.');
}
if (!process.env.WALLET_PASSWORD) {
  warnings.push('WALLET_PASSWORD is not set — wallet unlock may require manual intervention.');
}

if (warnings.length > 0) {
  console.log('\n⚠️  Warnings:');
  warnings.forEach((w) => console.warn(`   - ${w}`));
}

console.log('\n✅  Environment check complete.');
