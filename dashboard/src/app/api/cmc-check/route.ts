import { NextRequest, NextResponse } from 'next/server';

const CMC_API_KEY = '7cea08f6462b4d3791e5410036f7e9a8';
const CMC_BASE    = 'https://pro-api.coinmarketcap.com';

/**
 * GET /api/cmc-check?platform=bsc&address=0x...&minLiquidity=10000&maxLastTradeSecs=3600
 *
 * Logic:
 *   1. Call /v1/dex/token/pools  → find pools where top=true, pick the one with highest liqUsd
 *   2. Call /v1/dex/liquidity-change/list (limit=1) → get most-recent trade timestamp (data.lcs[0].ts)
 *   3. Return qualified=true only when:
 *        lastTradeAgo < maxLastTradeSecs  AND  maxTopLiqUsd >= minLiquidity
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const platform        = searchParams.get('platform') ?? 'bsc';
  const address         = searchParams.get('address') ?? '';
  const minLiquidity    = parseFloat(searchParams.get('minLiquidity') ?? '10000');
  const maxLastTradeSecs = parseFloat(searchParams.get('maxLastTradeSecs') ?? '3600');

  if (!address) {
    return NextResponse.json({ error: 'address is required' }, { status: 400 });
  }

  const headers = {
    'X-CMC_PRO_API_KEY': CMC_API_KEY,
    Accept: 'application/json',
  };

  try {
    // ── 1. Pool check ────────────────────────────────────────────────────────
    const poolRes = await fetch(
      `${CMC_BASE}/v1/dex/token/pools?platform=${encodeURIComponent(platform)}&address=${encodeURIComponent(address)}&limit=50`,
      { headers },
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

    // Filter top=true pools, pick max liqUsd
    const topPools = pools.filter((p) => p.top === true);
    let maxLiqUsd = 0;
    for (const p of topPools) {
      const v = typeof p.liqUsd === 'string' ? parseFloat(p.liqUsd) : (p.liqUsd ?? 0);
      if (v > maxLiqUsd) maxLiqUsd = v;
    }

    // ── 2. Last trade check ──────────────────────────────────────────────────
    const listRes = await fetch(
      `${CMC_BASE}/v1/dex/liquidity-change/list?platform=${encodeURIComponent(platform)}&address=${encodeURIComponent(address)}&sortType=desc&limit=1`,
      { headers },
    );

    if (!listRes.ok) {
      return NextResponse.json(
        { error: `list API error: ${listRes.status}`, qualified: false },
        { status: listRes.status },
      );
    }

    const listData   = await listRes.json();
    const lcs: Array<{ ts?: number | string }> = listData?.data?.lcs ?? [];
    let lastTs = lcs.length > 0 ? Number(lcs[0].ts ?? 0) : 0;
    // ts may be in milliseconds (13-digit) — normalise to seconds
    if (lastTs > 1e12) lastTs = Math.floor(lastTs / 1000);
    const nowSecs    = Math.floor(Date.now() / 1000);
    const lastTradeAgo = lastTs > 0 ? nowSecs - lastTs : Infinity;

    // ── 3. Qualification check ───────────────────────────────────────────────
    const tradeOk = lastTradeAgo < maxLastTradeSecs;
    const liqOk   = maxLiqUsd >= minLiquidity;
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
