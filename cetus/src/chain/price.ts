import { HermesClient } from '@pythnetwork/hermes-client';

const HERMES_ENDPOINT = 'https://hermes.pyth.network';

/**
 * Pyth Network price feed IDs (mainnet).
 * Source: https://pyth.network/price-feeds
 */
const FEED_IDS = {
  SUI_USD: '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
} as const;

/**
 * Fetches the current SUI/USD price from Pyth Network via Hermes.
 * Throws if the feed is unavailable or the returned price is non-positive.
 */
export async function getSuiPriceUsd(): Promise<number> {
  const client = new HermesClient(HERMES_ENDPOINT);

  const updates = await client.getLatestPriceUpdates([FEED_IDS.SUI_USD]);
  const parsed = updates.parsed?.[0];
  if (!parsed) {
    throw new Error('[price] Pyth Hermes returned no data for SUI/USD');
  }

  const { price, expo } = parsed.price;
  const priceUsd = parseInt(price, 10) * Math.pow(10, expo);
  if (priceUsd <= 0) {
    throw new Error(`[price] Invalid SUI/USD price from Pyth: ${priceUsd}`);
  }

  return priceUsd;
}

/**
 * Returns the SUI input amount needed to represent ~$5 USD,
 * calculated as ceil(5 / suiPrice).
 */
export async function calcSuiAmountForFiveDollars(): Promise<string> {
  const price = await getSuiPriceUsd();
  const amount = Math.ceil(5 / price);
  return String(amount);
}
