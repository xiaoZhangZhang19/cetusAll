import { env } from '@/config/env.js';
import { resolveRpcUrl } from '@/config/networks.js';

export default async function globalSetup() {
  process.env.TZ = 'UTC';
  console.log(`[globalSetup] app=${env.appUrl} rpc=${resolveRpcUrl()} walletMode=${env.walletMode}`);
}
