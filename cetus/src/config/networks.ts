import { env } from './env.js';

export function resolveRpcUrl(): string {
  return env.rpcUrl;
}
