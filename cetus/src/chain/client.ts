import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

import { env } from '@/config/env.js';
import { resolveRpcUrl } from '@/config/networks.js';

// ── Managed SuiClient (fixture-scoped) ──────────────────────────────────────
//
// Prefer using createSuiClient() + destroy() via the workerSuiClient fixture
// (fixtures.ts) so the underlying HTTP keep-alive agent is released after each
// worker run, preventing memory growth in long test sessions.
//
// The module-level singleton below is kept for backward compatibility with
// non-fixture call sites (e.g. chain/queries.ts helpers called outside tests).
//
// NOTE: The official Sui public fullnode (fullnode.mainnet.sui.io) has deprecated
// its JSON-RPC interface. Working endpoints per network are built into
// config/networks.ts, so no .env setup is required; SUI_RPC_URL is an optional
// override for self-hosted or paid nodes.

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

/**
 * Create a fresh SuiJsonRpcClient instance.
 * Caller is responsible for calling destroy() when done to release the
 * internal HTTP connection pool and any background polling handles.
 */
export function createSuiClient(): SuiJsonRpcClient {
  return new SuiJsonRpcClient({
    url: resolveRpcUrl(),
    network: env.network
  });
}

/**
 * Release the connection pool held by a SuiJsonRpcClient.
 * SuiJsonRpcClient does not expose a public destroy() method, but the
 * underlying transport can be shut down by calling the internal transport's
 * destroy if available, or by clearing the module-level singleton so GC
 * can collect it.
 */
export function destroySuiClient(client: SuiJsonRpcClient): void {
  try {
    const anyClient = client as unknown as Record<string, unknown>;
    const transport = anyClient['transport'] ?? anyClient['rpcClient'] ?? anyClient['client'];
    if (transport && typeof (transport as Record<string, unknown>)['destroy'] === 'function') {
      (transport as { destroy(): void }).destroy();
    }
  } catch {
    // Ignore — not all SDK versions expose a destroy path.
  }

  if (client === clientSingleton) {
    clientSingleton = undefined;
  }
}

export function getKeypairFromEnv(): Ed25519Keypair {
  const rawKey = env.walletPrivateKey ?? env.testWalletSecretKey;
  if (!rawKey) {
    throw new Error('WALLET_PRIVATE_KEY (or TEST_WALLET_SECRET_KEY) is not configured');
  }

  const { secretKey } = decodeSuiPrivateKey(rawKey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}
