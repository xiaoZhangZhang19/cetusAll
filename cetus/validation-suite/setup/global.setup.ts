import { env } from '@/config/env.js';

export default async function globalSetup() {
  process.env.TZ = 'UTC';
  console.log(`[globalSetup] app=${env.appUrl} rpc=${env.rpcUrl} walletMode=${env.walletMode}`);
}
