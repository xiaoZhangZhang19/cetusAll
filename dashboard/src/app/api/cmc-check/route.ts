import { NextRequest, NextResponse } from 'next/server';

const CMC_BASE    = 'https://pro-api.coinmarketcap.com';
const CMC_API_KEY = '7cea08f6462b4d3791e5410036f7e9a8';

const CMC_HEADERS = {
  'X-CMC_PRO_API_KEY': CMC_API_KEY,
  'Accept': 'application/json',
};

/**
 * GET /api/cmc-check?platform=bsc&address=0x...&minLiquidity=10000&maxLastTradeSecs=3600
 *
 * Logic:
 *   1. Pool check  → CMC /v1/dex/token/pools
 *                    find top=true pools, pick max liqUsd
 *   2. Trade check → CMC /v1/dex/tokens/transactions (limit=1)
 *                    no data → immediate disqualify
 *                    swaps[0].ts (ms) → convert to seconds → check age
 *   3. qualified = tradeOk && liqOk
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const platform         = searchParams.get('platform') ?? 'bsc';
  const address          = searchParams.get('address') ?? '';
  const minLiquidity     = parseFloat(searchParams.get('minLiquidity') ?? '10000');
  const maxLastTradeSecs = parseFloat(searchParams.get('maxLastTradeSecs') ?? '3600');

  if (!address) {
    return NextResponse.json({ error: 'address is required' }, { status: 400 });
  }

  try {
    // ── 1. Pool check ─────────────────────────────────────────────────────────
    const poolRes = await fetch(
      `${CMC_BASE}/v1/dex/token/pools?platform=${encodeURIComponent(platform)}&address=${encodeURIComponent(address)}&limit=50`,
      { headers: CMC_HEADERS },
    );

    if (!poolRes.ok) {
      return NextResponse.json(
        { error: `pool API error: ${poolRes.status}`, qualified: false },
        { status: poolRes.status },
      );
    }

    const poolData = await poolRes.json();
    const pools: Array<{ top?: boolean; liqUsd?: number | string }> =
      poolData?.data ?? [];

    const topPools = pools.filter((p) => p.top === true);
    let maxLiqUsd = 0;
    for (const p of topPools) {
      const v = typeof p.liqUsd === 'string' ? parseFloat(p.liqUsd) : (p.liqUsd ?? 0);
      if (v > maxLiqUsd) maxLiqUsd = v;
    }

    // ── 2. Last trade check ───────────────────────────────────────────────────
    const txRes = await fetch(
      `${CMC_BASE}/v1/dex/tokens/transactions?platform=${encodeURIComponent(platform)}&address=${encodeURIComponent(address)}&limit=1`,
      { headers: CMC_HEADERS },
    );

    if (!txRes.ok) {
      return NextResponse.json(
        { error: `tx API error: ${txRes.status}`, qualified: false },
        { status: txRes.status },
      );
    }

    const txData = await txRes.json();
    const swaps: Array<{ ts?: number | string }> = txData?.data?.swaps ?? [];

    // No transactions at all → disqualify immediately
    if (swaps.length === 0) {
      return NextResponse.json({
        qualified: false,
        maxLiqUsd,
        lastTradeAgo: null,
        topPoolCount: topPools.length,
        tradeOk: false,
        liqOk: maxLiqUsd >= minLiquidity,
        noTrades: true,
      });
    }

    // ts is in milliseconds — normalise to seconds
    let lastTs = Number(swaps[0].ts ?? 0);
    if (lastTs > 1e12) lastTs = Math.floor(lastTs / 1000);
    const nowSecs      = Math.floor(Date.now() / 1000);
    const lastTradeAgo = lastTs > 0 ? nowSecs - lastTs : Infinity;

    // ── 3. Qualification ──────────────────────────────────────────────────────
    const tradeOk   = lastTradeAgo !== Infinity && lastTradeAgo < maxLastTradeSecs;
    const liqOk     = maxLiqUsd >= minLiquidity;
    const qualified = tradeOk && liqOk;

    return NextResponse.json({
      qualified,
      maxLiqUsd,
      lastTradeAgo: lastTradeAgo === Infinity ? null : lastTradeAgo,
      topPoolCount: topPools.length,
      tradeOk,
      liqOk,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg, qualified: false }, { status: 500 });
  }
}

