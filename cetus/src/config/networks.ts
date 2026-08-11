import { env } from './env.js';

import type { SuiNetwork } from './env.js';

/**
 * Built-in JSON-RPC endpoints.
 *
 * The official Sui public fullnodes (fullnode.*.sui.io) have deprecated their
 * JSON-RPC interface and now only serve gRPC / GraphQL, so mainnet points at a
 * third-party node that still speaks JSON-RPC. Keeping these in code means a
 * fresh clone works without any .env setup.
 */
const DEFAULT_RPC_ENDPOINTS: Record<SuiNetwork, string> = {
  mainnet: 'https://sui-rpc.publicnode.com',
  testnet: 'https://sui-testnet-rpc.publicnode.com',
  devnet: 'https://fullnode.devnet.sui.io:443',
  localnet: 'http://127.0.0.1:9000'
};

/** Hosts that no longer answer JSON-RPC requests; overrides pointing here are ignored. */
const DEPRECATED_RPC_HOSTS = new Set([
  'fullnode.mainnet.sui.io',
  'fullnode.testnet.sui.io'
]);

let deprecationWarned = false;

function isDeprecatedEndpoint(url: string): boolean {
  try {
    return DEPRECATED_RPC_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function resolveRpcUrl(): string {
  const fallbackUrl = DEFAULT_RPC_ENDPOINTS[env.network];
  const overrideUrl = env.rpcUrl;

  if (!overrideUrl) {
    return fallbackUrl;
  }

  if (isDeprecatedEndpoint(overrideUrl)) {
    if (!deprecationWarned) {
      deprecationWarned = true;
      console.warn(
        `[config] SUI_RPC_URL=${overrideUrl} has deprecated JSON-RPC support; ` +
          `falling back to ${fallbackUrl}. Remove SUI_RPC_URL from .env to silence this.`
      );
    }
    return fallbackUrl;
  }

  return overrideUrl;
}

export { DEFAULT_RPC_ENDPOINTS };
