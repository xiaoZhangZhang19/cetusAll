import { AggregatorClient, CETUS, CETUSDLMM, Env as AggregatorEnv } from '@cetusprotocol/aggregator-sdk';

import { getSuiClient } from '@/chain/client.js';
import { env } from '@/config/env.js';
import { retry } from '@/utils/retry.js';

const DEFAULT_PROVIDERS = [CETUS, CETUSDLMM];

let aggregatorClientSingleton: AggregatorClient | undefined;

function toAggregatorEnv() {
  return env.network === 'testnet' ? AggregatorEnv.Testnet : AggregatorEnv.Mainnet;
}

function getAggregatorClient() {
  if (!aggregatorClientSingleton) {
    aggregatorClientSingleton = new AggregatorClient({
      client: getSuiClient(),
      env: toAggregatorEnv()
    });
  }

  return aggregatorClientSingleton;
}

function toAtomicUnits(amountUi: string, decimals: number) {
  const normalized = amountUi.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid UI amount: ${amountUi}`);
  }

  const [whole, fraction = ''] = normalized.split('.');
  const paddedFraction = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  const atomic = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, '');
  return atomic || '0';
}

function atomicToUiNumber(amount: string, decimals: number) {
  const raw = BigInt(amount);
  return Number(raw) / 10 ** decimals;
}

export async function getReferencePriceFromAggregator(params: {
  fromCoinType: string;
  targetCoinType: string;
  fromDecimals: number;
  targetDecimals: number;
  inputAmountUi?: string;
  providers?: string[];
}) {
  const {
    fromCoinType,
    targetCoinType,
    fromDecimals,
    targetDecimals,
    inputAmountUi = '1',
    providers = DEFAULT_PROVIDERS
  } = params;

  const aggregatorClient = getAggregatorClient();
  const amount = toAtomicUnits(inputAmountUi, fromDecimals);
  const inputAmount = Number(inputAmountUi);

  if (!Number.isFinite(inputAmount) || inputAmount <= 0) {
    throw new Error(`Invalid inputAmountUi for quote: ${inputAmountUi}`);
  }

  const router = await retry(async () => {
    const result = await aggregatorClient.findRouters({
      from: fromCoinType,
      target: targetCoinType,
      amount,
      byAmountIn: true,
      providers
    });

    if (!result || result.insufficientLiquidity) {
      throw new Error(`No aggregator route for ${fromCoinType} -> ${targetCoinType}`);
    }

    return result;
  }, 5, 2_000);

  const amountOutUi = atomicToUiNumber(router.amountOut.toString(), targetDecimals);
  const price = amountOutUi / inputAmount;

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid aggregator price for ${fromCoinType} -> ${targetCoinType}: ${price}`);
  }

  return price;
}
