import { config as loadEnv } from 'dotenv';

loadEnv();

// ─── Required keys (missing any → exit 1) ─────────────────────────────────────
const requiredKeys = [
  'APP_URL',
  'TEST_WALLET_ADDRESS',
  'WALLET_PRIVATE_KEY',
  'SWAP_INPUT_TYPE',
  'SWAP_OUTPUT_TYPE'
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

console.log('\n── Wallet (injected, no browser extension) ──');
console.log(`  WALLET_PRIVATE_KEY    = ${process.env.WALLET_PRIVATE_KEY ? '(set)' : '(not set)'}`);
console.log(`  WALLET_DRY_RUN        = ${process.env.WALLET_DRY_RUN ?? 'false (default)'}`);

const warnings = [];
if (process.env.WALLET_DRY_RUN === 'true' || process.env.WALLET_DRY_RUN === '1') {
  warnings.push(
    'WALLET_DRY_RUN=true — 交易只签名不广播。依赖前端成功提示的用例（如 swap.spec.ts）会失败。'
  );
}

if (warnings.length > 0) {
  console.log('\n⚠️  Warnings:');
  warnings.forEach((w) => console.warn(`   - ${w}`));
}

console.log('\n运行 `npm run check:wallet` 校验私钥与地址是否匹配。');
console.log('\n✅  Environment check complete.');
