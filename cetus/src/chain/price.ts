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
 * 单个取价源的超时。
 *
 * 源是并发竞速的（见 getSuiPriceUsd），所以这个值只决定「全部源都挂掉时
 * 多久报错」，不会因为某个源被墙而串行累加等待。
 */
const SOURCE_TIMEOUT_MS = 6_000;

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/** 从 Pyth Hermes 取价。部分网络环境下该端点会返回 401，由回退链接手。 */
async function fromPythHermes(): Promise<number> {
  const client = new HermesClient(HERMES_ENDPOINT);
  const updates = await client.getLatestPriceUpdates([FEED_IDS.SUI_USD]);
  const parsed = updates.parsed?.[0];
  if (!parsed) {
    throw new Error('Hermes returned no data');
  }
  const { price, expo } = parsed.price;
  return parseInt(price, 10) * Math.pow(10, expo);
}

/**
 * 取价源回退链：任一源给出正数即采用。
 *
 * 只有 Pyth 一个源时，端点被网关拦掉（401）会让所有依赖它的用例在第一步直接红，
 * 而测试真正需要的只是一个「当前 SUI 市价」量级，因此并列几个公开行情源。
 */
const PRICE_SOURCES: ReadonlyArray<{ name: string; read: () => Promise<number> }> = [
  { name: 'pyth-hermes', read: fromPythHermes },
  {
    name: 'binance',
    read: async () => {
      const data = (await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT')) as { price?: string };
      return Number(data.price);
    },
  },
  {
    name: 'okx',
    read: async () => {
      const data = (await fetchJson('https://www.okx.com/api/v5/market/ticker?instId=SUI-USDT')) as {
        data?: Array<{ last?: string }>;
      };
      return Number(data.data?.[0]?.last);
    },
  },
  {
    // api.binance.com 在部分出口被阻断，但官方公开镜像 binance.vision 通常可达。
    name: 'binance-vision',
    read: async () => {
      const data = (await fetchJson(
        'https://data-api.binance.vision/api/v3/ticker/price?symbol=SUIUSDT'
      )) as { price?: string };
      return Number(data.price);
    },
  },
  {
    name: 'gate',
    read: async () => {
      const data = (await fetchJson(
        'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=SUI_USDT'
      )) as Array<{ last?: string }>;
      return Number(data?.[0]?.last);
    },
  },
  {
    name: 'coingecko',
    read: async () => {
      const data = (await fetchJson(
        'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd'
      )) as { sui?: { usd?: number } };
      return Number(data.sui?.usd);
    },
  },
];

/** 进程内缓存，同一个用例里多次取价不重复打行情接口。 */
const CACHE_TTL_MS = 60_000;
let cached: { price: number; at: number } | null = null;

/**
 * 获取当前 SUI/USD 价格。
 *
 * 所有源并发竞速，第一个返回正数的即采用。之前是串行回退，一旦前面的源被网络
 * 阻断（只能等到超时），累计等待会接近甚至超过用例超时；并发后总耗时由最快的
 * 可用源决定，全挂时也只等一个 SOURCE_TIMEOUT_MS。
 */
export async function getSuiPriceUsd(): Promise<number> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.price;
  }

  const failures: string[] = [];
  const attempts = PRICE_SOURCES.map(async (source) => {
    try {
      const priceUsd = await source.read();
      if (Number.isFinite(priceUsd) && priceUsd > 0) {
        return { name: source.name, price: priceUsd };
      }
      failures.push(`${source.name}: invalid value ${priceUsd}`);
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      failures.push(`${source.name}: ${message}`);
    }
    // 失败的源永不 settle，交给 Promise.any 之外的 allSettled 收尾。
    throw new Error(source.name);
  });

  try {
    const winner = await Promise.any(attempts);
    console.log(`[price] SUI/USD = $${winner.price.toFixed(4)} (source: ${winner.name})`);
    cached = { price: winner.price, at: Date.now() };
    return winner.price;
  } catch {
    throw new Error(`[price] 所有 SUI/USD 取价源均不可用：\n  ${failures.join('\n  ')}`);
  }
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
