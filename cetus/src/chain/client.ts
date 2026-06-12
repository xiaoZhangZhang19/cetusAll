import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

import { env } from '@/config/env.js';
import { resolveRpcUrl } from '@/config/networks.js';

let clientSingleton: SuiJsonRpcClient | undefined;

export function getSuiClient(): SuiJsonRpcClient {
  if (!clientSingleton) {
    clientSingleton = new SuiJsonRpcClient({
      url: resolveRpcUrl(),
      network: env.network
    });
  }

  return clientSingleton;
}

export function getKeypairFromEnv(): Ed25519Keypair {
  const rawKey = env.walletPrivateKey ?? env.testWalletSecretKey;
  if (!rawKey) {
    throw new Error('WALLET_PRIVATE_KEY (or TEST_WALLET_SECRET_KEY) is not configured');
  }

  const { secretKey } = decodeSuiPrivateKey(rawKey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}
