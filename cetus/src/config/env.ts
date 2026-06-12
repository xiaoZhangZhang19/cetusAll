import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

function resolveWalletExtensionPath(configuredPath?: string): string | undefined {
  if (!configuredPath) {
    return undefined;
  }

  if (existsSync(configuredPath)) {
    return configuredPath;
  }

  const normalizedPath = configuredPath.replace(/[\\/]+$/, '');
  const extensionRoot = path.dirname(normalizedPath);
  if (!existsSync(extensionRoot)) {
    return configuredPath;
  }

  const versionDirs = readdirSync(extensionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));

  const latestVersionDir = versionDirs.at(-1);
  return latestVersionDir ? path.join(extensionRoot, latestVersionDir) : configuredPath;
}

const envSchema = z.object({
  APP_URL: z.string().url().default('https://app.cetus.zone'),
  SUI_RPC_URL: z.string().url().default('https://fullnode.mainnet.sui.io:443'),
  SUI_NETWORK: z.enum(['localnet', 'devnet', 'testnet', 'mainnet']).default('mainnet'),
  // z.coerce.boolean() treats the string "false" as true (non-empty string).
  // Use a custom transform that correctly maps "false"/"0"/"" → false.
  HEADLESS: z.string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  PLAYWRIGHT_TIMEOUT_MS: z.coerce.number().default(120_000),
  EXPECT_TIMEOUT_MS: z.coerce.number().default(15_000),
  ACTION_TIMEOUT_MS: z.coerce.number().default(15_000),
  DEFAULT_SLIPPAGE_BPS: z.coerce.number().default(100),
  TEST_WALLET_ADDRESS: z.string().min(3, 'TEST_WALLET_ADDRESS is required'),
  TEST_WALLET_SECRET_KEY: z.string().min(10).optional(),
  SWAP_INPUT_TYPE: z.string().min(3, 'SWAP_INPUT_TYPE is required'),
  SWAP_OUTPUT_TYPE: z.string().min(3, 'SWAP_OUTPUT_TYPE is required'),
  SWAP_FROM_TOKEN_SYMBOL: z.string().default('SUI'),
  SWAP_TO_TOKEN_SYMBOL: z.string().default('USDC'),
  SWAP_INPUT_AMOUNT_UI: z.string().default('0.1'),
  LIMIT_INPUT_TYPE: z.string().default('0x2::sui::SUI'),
  LIMIT_OUTPUT_TYPE: z.string().default('0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'),
  LIMIT_INPUT_AMOUNT_UI: z.string().default('5.5'),
  MARGIN_BASE_SYMBOL: z.string().optional(),
  MARGIN_QUOTE_SYMBOL: z.string().optional(),
  MARGIN_INPUT_TYPE: z.string().optional(),
  MARGIN_OUTPUT_TYPE: z.string().optional(),
  MARGIN_TARGET_NOTIONAL_USD: z.coerce.number().default(5),
  CLMM_POOL_BASE_SYMBOL: z.string().default('SUI'),
  CLMM_POOL_QUOTE_SYMBOL: z.string().default('USDC'),
  CLMM_INPUT_TOKEN_SYMBOL: z.string().default('SUI'),
  CLMM_INPUT_AMOUNT_UI: z.string().default('0.1'),
  CLMM_ADD_MORE_AMOUNT_UI: z.string().default('0.01'),
  CLMM_ZAP_TOKEN_SYMBOL: z.string().default('SUI'),
  CLMM_ZAP_AMOUNT_UI: z.string().default('0.01'),
  CLMM_REMOVE_TOKEN_SYMBOL: z.string().default('SUI'),
  DLMM_POOL_BASE_SYMBOL: z.string().default('SUI'),
  DLMM_POOL_QUOTE_SYMBOL: z.string().default('USDC'),
  DLMM_INPUT_AMOUNT_UI: z.string().default('0.1'),
  DLMM_ADD_MORE_AMOUNT_UI: z.string().default('0.01'),
  DLMM_REMOVE_TOKEN_SYMBOL: z.string().default('SUI'),
  DLMM_ZAP_TOKEN_SYMBOL: z.string().default('SUI'),
  DLMM_ZAP_AMOUNT_UI: z.string().default('0.01'),
  WALLET_MODE: z.enum(['extension', 'injected']).default('extension'),
  // WALLET_PRIVATE_KEY is the primary key for injected mode.
  // TEST_WALLET_SECRET_KEY is kept for backward compatibility.
  WALLET_PRIVATE_KEY: z.string().min(10).optional(),
  WALLET_EXTENSION: z.enum(['suiet', 'slush', 'sui-wallet', 'martian', 'ethos']).default('slush'),
  WALLET_DISPLAY_NAME: z.string().default('Slush'),
  WALLET_PASSWORD: z.string().optional(),
  WALLET_EXTENSION_PATH: z.string().optional(),
  WALLET_USER_DATA_DIR: z.string().default('.playwright-wallet-profile'),
  // Token decimals (allow override for non-standard tokens)
  MEOW_DECIMAL: z.coerce.number().default(5),
  SBOX_DECIMAL: z.coerce.number().default(9),
  // findRouter API pattern used for degradation interception
  // Confirmed Cetus endpoint: https://api-sui.cetus.zone/router_v3/find_routes
  FIND_ROUTER_URL_PATTERN: z.string().default('https://api-sui.cetus.zone/router_v3/find_routes**')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(`Invalid environment variables:\n${issues}`);
}

export const env = {
  appUrl: parsed.data.APP_URL,
  rpcUrl: parsed.data.SUI_RPC_URL,
  network: parsed.data.SUI_NETWORK,
  headless: parsed.data.HEADLESS,
  playwrightTimeoutMs: parsed.data.PLAYWRIGHT_TIMEOUT_MS,
  expectTimeoutMs: parsed.data.EXPECT_TIMEOUT_MS,
  actionTimeoutMs: parsed.data.ACTION_TIMEOUT_MS,
  defaultSlippageBps: parsed.data.DEFAULT_SLIPPAGE_BPS,
  testWalletAddress: parsed.data.TEST_WALLET_ADDRESS,
  testWalletSecretKey: parsed.data.TEST_WALLET_SECRET_KEY,
  swapInputType: parsed.data.SWAP_INPUT_TYPE,
  swapOutputType: parsed.data.SWAP_OUTPUT_TYPE,
  swapFromTokenSymbol: parsed.data.SWAP_FROM_TOKEN_SYMBOL,
  swapToTokenSymbol: parsed.data.SWAP_TO_TOKEN_SYMBOL,
  swapInputAmountUi: parsed.data.SWAP_INPUT_AMOUNT_UI,
  limitInputType: parsed.data.LIMIT_INPUT_TYPE,
  limitOutputType: parsed.data.LIMIT_OUTPUT_TYPE,
  limitInputAmountUi: parsed.data.LIMIT_INPUT_AMOUNT_UI,
  marginBaseSymbol: parsed.data.MARGIN_BASE_SYMBOL ?? parsed.data.SWAP_FROM_TOKEN_SYMBOL,
  marginQuoteSymbol: parsed.data.MARGIN_QUOTE_SYMBOL ?? parsed.data.SWAP_TO_TOKEN_SYMBOL,
  marginInputType: parsed.data.MARGIN_INPUT_TYPE ?? parsed.data.SWAP_INPUT_TYPE,
  marginOutputType: parsed.data.MARGIN_OUTPUT_TYPE ?? parsed.data.SWAP_OUTPUT_TYPE,
  marginTargetNotionalUsd: parsed.data.MARGIN_TARGET_NOTIONAL_USD,
  clmmPoolBaseSymbol: parsed.data.CLMM_POOL_BASE_SYMBOL,
  clmmPoolQuoteSymbol: parsed.data.CLMM_POOL_QUOTE_SYMBOL,
  clmmInputTokenSymbol: parsed.data.CLMM_INPUT_TOKEN_SYMBOL,
  clmmInputAmountUi: parsed.data.CLMM_INPUT_AMOUNT_UI,
  clmmAddMoreAmountUi: parsed.data.CLMM_ADD_MORE_AMOUNT_UI,
  clmmZapTokenSymbol: parsed.data.CLMM_ZAP_TOKEN_SYMBOL,
  clmmZapAmountUi: parsed.data.CLMM_ZAP_AMOUNT_UI,
  clmmRemoveTokenSymbol: parsed.data.CLMM_REMOVE_TOKEN_SYMBOL,
  dlmmPoolBaseSymbol: parsed.data.DLMM_POOL_BASE_SYMBOL,
  dlmmPoolQuoteSymbol: parsed.data.DLMM_POOL_QUOTE_SYMBOL,
  dlmmInputAmountUi: parsed.data.DLMM_INPUT_AMOUNT_UI,
  dlmmAddMoreAmountUi: parsed.data.DLMM_ADD_MORE_AMOUNT_UI,
  dlmmRemoveTokenSymbol: parsed.data.DLMM_REMOVE_TOKEN_SYMBOL,
  dlmmZapTokenSymbol: parsed.data.DLMM_ZAP_TOKEN_SYMBOL,
  dlmmZapAmountUi: parsed.data.DLMM_ZAP_AMOUNT_UI,
  walletMode: parsed.data.WALLET_MODE,
  walletPrivateKey: parsed.data.WALLET_PRIVATE_KEY ?? parsed.data.TEST_WALLET_SECRET_KEY,
  walletExtension: parsed.data.WALLET_EXTENSION,
  walletDisplayName: parsed.data.WALLET_DISPLAY_NAME,
  walletPassword: parsed.data.WALLET_PASSWORD,
  walletExtensionPath: resolveWalletExtensionPath(parsed.data.WALLET_EXTENSION_PATH),
  walletUserDataDir: parsed.data.WALLET_USER_DATA_DIR,
  meowDecimal: parsed.data.MEOW_DECIMAL,
  sboxDecimal: parsed.data.SBOX_DECIMAL,
  findRouterUrlPattern: parsed.data.FIND_ROUTER_URL_PATTERN
};
