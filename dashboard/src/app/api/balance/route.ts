import { NextRequest, NextResponse } from 'next/server';

const BSC_RPC_URL =
  process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org/';

// Chainlink BNB/USD price feed on BSC mainnet
// Returns 8-decimal fixed-point price, e.g. 59055929000 = $590.55929
const CHAINLINK_BNB_USD = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';
// latestRoundData() selector: 0xfeaf968c
const LATEST_ROUND_DATA_SELECTOR = '0xfeaf968c';

/**
 * GET /api/balance
 * GET /api/balance?address=0x...   (override env address)
 *
 * Queries the BNB (native) balance of a wallet address on BSC
 * using eth_getBalance JSON-RPC, and also fetches the current BNB/USD
 * price from the Chainlink on-chain oracle.
 *
 * Address resolution order:
 *   1. ?address= query param (explicit override)
 *   2. WALLET_ADDRESS env var (from dashboard/.env)
 */
export async function GET(req: NextRequest) {
  // Resolve address: query param > env var
  const paramAddress = req.nextUrl.searchParams.get('address');
  const address = paramAddress || process.env.WALLET_ADDRESS || '';

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json(
      { error: 'No wallet address available. Set WALLET_ADDRESS in .env or pass ?address=0x...' },
      { status: 400 },
    );
  }

  try {
    // ── Parallel: balance + BNB price ──────────────────────────────────
    const [rpcRes, priceRes] = await Promise.all([
      fetch(BSC_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getBalance',
          params: [address, 'latest'],
        }),
        signal: AbortSignal.timeout(10_000),
      }),
      fetch(BSC_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'eth_call',
          params: [{ to: CHAINLINK_BNB_USD, data: LATEST_ROUND_DATA_SELECTOR }, 'latest'],
        }),
        signal: AbortSignal.timeout(10_000),
      }),
    ]);

    if (!rpcRes.ok) {
      throw new Error(`RPC request failed with status ${rpcRes.status}`);
    }

    const data = await rpcRes.json() as { result?: string; error?: { message: string } };

    if (data.error) {
      throw new Error(data.error.message);
    }

    // result is a hex string in wei, e.g. "0x4563918244f40000"
    const weiHex = data.result ?? '0x0';
    const weiBigInt = BigInt(weiHex);

    // Convert wei → BNB (18 decimals), max 6 decimal places
    const bnbWhole = weiBigInt / BigInt(1e12);           // drop last 12 digits
    const bnbValue  = Number(bnbWhole) / 1e6;            // 18-12=6 decimal precision
    const bnbFormatted = bnbValue.toFixed(6).replace(/\.?0+$/, '') || '0';

    // ── Parse Chainlink BNB/USD price ──────────────────────────────────
    let bnbPriceUsd: string | undefined;
    if (priceRes.ok) {
      const priceData = await priceRes.json() as { result?: string };
      const hex = priceData.result;
      if (hex && hex !== '0x') {
        // latestRoundData returns (roundId, answer, startedAt, updatedAt, answeredInRound)
        // each 32 bytes. answer is at offset 32 bytes (second slot).
        // Strip "0x", take bytes 64–127 (second 32-byte word) for the answer field.
        const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
        const answerHex = clean.slice(64, 128); // second 32-byte word
        if (answerHex) {
          const rawPrice = BigInt('0x' + answerHex);
          // Chainlink BNB/USD has 8 decimals
          const price = Number(rawPrice) / 1e8;
          if (price > 0) bnbPriceUsd = price.toFixed(2);
        }
      }
    }

    return NextResponse.json({
      address,
      balanceWei: weiHex,
      balanceBNB: bnbFormatted,
      ...(bnbPriceUsd ? { bnbPriceUsd } : {}),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
