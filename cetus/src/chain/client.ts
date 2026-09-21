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
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);

  // 私钥和 TEST_WALLET_ADDRESS 必须是同一个钱包，否则节点会拒绝交易：
  //   Invalid user signature: Required Signature from 0x... is absent
  //
  // extension 模式下不会暴露这个问题 —— 签名由插件用它自己的密钥完成，
  // WALLET_PRIVATE_KEY 压根没被用到。切到 injected 后私钥才真正参与签名，
  // 配错就会在「交易已广播但失败」这一步才报出来，且前端只显示
  // "Transaction failed"，看不出是配置问题。所以在这里提前拦住。
  const derived = keypair.toSuiAddress();
  if (derived !== env.testWalletAddress) {
    throw new Error(
      `WALLET_PRIVATE_KEY 与 TEST_WALLET_ADDRESS 不是同一个钱包：\n` +
      `  私钥推导出的地址   : ${derived}\n` +
      `  TEST_WALLET_ADDRESS: ${env.testWalletAddress}\n` +
      `injected 模式下交易会被节点拒绝（Invalid user signature）。\n` +
      `请把 TEST_WALLET_ADDRESS 改成 ${derived}，或换用对应的私钥。\n` +
      `校验命令: npm run check:wallet`
    );
  }

  return keypair;
}
