'use client';

import { useState, useRef, useEffect } from 'react';
import { PEACH_ROUTES, PEACH_GROUPS, PEACH_SWAP_TESTS, PEACH_TERMINAL_CONFIG, PEACH_TERMINAL_TAGS, PEACH_TERMINAL_DATE_TYPES } from '@/lib/tests';

type Status = 'idle' | 'running' | 'completed' | 'failed';

type RouteStatus = 'pending' | 'running' | 'passed' | 'failed';

interface RouteResult {
  status: RouteStatus;
  quote?: string;
  duration?: string;
  error?: string;
  /** 'on-chain' = TX reverted on-chain; 'timeout' = waited too long; undefined = unknown */
  failureKind?: 'on-chain' | 'timeout';
}

interface CombinedPhase {
  status: RouteStatus;
  routes: string[];
  error?: string;
}

interface RunState {
  status: Status;
  runId?: string;
  output?: string[];
  errorMsg?: string;
  duration?: number;
}

/** Parse the Phase-1 combined-swap status from log text. */
function parseCombinedPhase(text: string): CombinedPhase | null {
  // ##COMBINED_ROUTES:route1,route2##
  const routesMatch = /##COMBINED_ROUTES:([^#]+)##/.exec(text);
  if (!routesMatch) return null;

  const routes = routesMatch[1].split(',').map((r) => r.trim());

  if (/##COMBINED_PASSED##/.test(text)) return { status: 'passed', routes };
  const failedMatch = /##COMBINED_FAILED:([^#]*)##/.exec(text);
  if (failedMatch) return { status: 'failed', routes, error: failedMatch[1].trim() };
  if (/##COMBINED_RUNNING##/.test(text)) return { status: 'running', routes };

  return { status: 'pending', routes };
}

/** Parse route pass/fail/running events from accumulated log text. */
function parseRouteResults(text: string): Record<string, RouteResult> {
  const results: Record<string, RouteResult> = {};
  let m: RegExpExecArray | null;

  // Route started: "Testing route: Uniswap V3"
  const reStarted = /Testing route:\s*(.+)/g;
  while ((m = reStarted.exec(text)) !== null) {
    const name = m[1].trim();
    if (!results[name]) results[name] = { status: 'running' };
  }

  // Route passed: `✅ Route "Uniswap V3" PASSED  (2.3s)`
  const rePassed = /Route "([^"]+)" PASSED[^\n]*\(([^)]+)\)/g;
  while ((m = rePassed.exec(text)) !== null) {
    results[m[1]] = { status: 'passed', duration: m[2] };
  }

  // Route failed: `❌ Route "Uniswap V3" FAILED: some msg  (1.5s)`
  const reFailed = /Route "([^"]+)" FAILED(?:: ([^\n(]+))?\s*\(([^)]+)\)/g;
  while ((m = reFailed.exec(text)) !== null) {
    const errorMsg = m[2]?.trim();
    // Determine failure kind from the error message
    let failureKind: RouteResult['failureKind'];
    if (errorMsg) {
      if (/on-chain tx failed|on-chain transaction failed|Transaction failed|Something went wrong/i.test(errorMsg)) {
        failureKind = 'on-chain';
      } else if (/timed out|timeout/i.test(errorMsg)) {
        failureKind = 'timeout';
      }
    }
    results[m[1]] = { status: 'failed', error: errorMsg, duration: m[3], failureKind };
  }

  return results;
}

export default function PeachSection() {
  // ── Global: real transaction toggle (default OFF for safety) ─────────────
  const [executeSwap, setExecuteSwap] = useState(false);
  // ── Terminal: separate real transaction toggle ────────────────────────────
  const [termExecuteSwap, setTermExecuteSwap] = useState(false);

  const [testAllRoutes, setTestAllRoutes] = useState(false);
  const [selectedRoutes, setSelectedRoutes] = useState<string[]>([...PEACH_ROUTES]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [runState, setRunState] = useState<RunState>({ status: 'idle' });
  const [showOutput, setShowOutput] = useState(false);
  const [routeResults, setRouteResults] = useState<Record<string, RouteResult>>({});
  const [combinedPhase, setCombinedPhase] = useState<CombinedPhase | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const accOutputRef = useRef(''); // accumulated raw output for parsing

  // Swap parameters
  const [payToken, setPayToken] = useState('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  const [receiveToken, setReceiveToken] = useState('0x55d398326f99059fF775485246999027B3197955');
  const [payAmount, setPayAmount] = useState('0.001');
  const [swapSlippage, setSwapSlippage] = useState('');

  // ── Terminal test state ────────────────────────────────────────────────
  const [terminalRun, setTerminalRun] = useState<RunState>({ status: 'idle' });
  const [terminalShowOutput, setTerminalShowOutput] = useState(false);
  const terminalPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const terminalAccRef = useRef('');

  // ── Route Change test state ────────────────────────────────────────────
  const [rcAmounts, setRcAmounts] = useState('0.001,0.01,0.1');
  const [rcPayToken, setRcPayToken] = useState('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  const [rcReceiveToken, setRcReceiveToken] = useState('0x55d398326f99059fF775485246999027B3197955');
  const [rcRunState, setRcRunState] = useState<RunState>({ status: 'idle' });
  const [rcShowOutput, setRcShowOutput] = useState(false);
  const [rcResults, setRcResults] = useState<Array<{
    amount: string;
    routeCount: number;
    quote: string;
    exchangeRate: string;
    error?: string;
  }>>([]);
  const [rcHasChange, setRcHasChange] = useState<boolean | null>(null);
  const rcPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rcAccRef = useRef('');

  // ── Slippage test state ────────────────────────────────────────────────
  const [slippageValues, setSlippageValues] = useState('0.05,2.5,20');
  const [slippageRunState, setSlippageRunState] = useState<RunState>({ status: 'idle' });
  const [slippageShowOutput, setSlippageShowOutput] = useState(false);
  const [slippageResults, setSlippageResults] = useState<Array<{
    value: string;
    label: string;
    warningText: string;
    expectedKeyword: string;
    matched: boolean;
    confirmDisabled?: boolean;
    error?: string;
  }>>([]);
  const slippagePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const slippageAccRef = useRef('');

  // ── Gas insufficient test state ────────────────────────────────────────
  const [gasTestAmount, setGasTestAmount] = useState('');
  const [gasBalance, setGasBalance] = useState<string | null>(null);
  const [gasBalanceLoading, setGasBalanceLoading] = useState(false);
  const [gasRunState, setGasRunState] = useState<RunState>({ status: 'idle' });
  const [gasShowOutput, setGasShowOutput] = useState(false);
  const [gasResult, setGasResult] = useState<{
    amount: string; matched: boolean; warningText: string; error?: string;
  } | null>(null);
  const gasPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gasAccRef = useRef('');

  // ── Limit Order test state ─────────────────────────────────────────────
  const [limitMinUsd, setLimitMinUsd] = useState('5');
  const [limitBnbPrice, setLimitBnbPrice] = useState<string | null>(null);
  const [limitBnbLoading, setLimitBnbLoading] = useState(false);
  const [limitRunState, setLimitRunState] = useState<RunState>({ status: 'idle' });
  const [limitShowOutput, setLimitShowOutput] = useState(false);
  const [limitResult, setLimitResult] = useState<{
    passed: boolean;
    payAmount?: string;
    usdValue?: string;
    bnbPrice?: string;
    error?: string;
  } | null>(null);
  const limitPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const limitAccRef = useRef('');

  // ── Limit Price Guard test state ───────────────────────────────────────
  const [pgMinUsd, setPgMinUsd] = useState('5');
  const [pgPriceRatio, setPgPriceRatio] = useState('0.949');
  const [pgBnbPrice, setPgBnbPrice] = useState<string | null>(null);
  const [pgBnbLoading, setPgBnbLoading] = useState(false);
  const [pgRunState, setPgRunState] = useState<RunState>({ status: 'idle' });
  const [pgShowOutput, setPgShowOutput] = useState(false);
  const [pgResult, setPgResult] = useState<{
    passed: boolean;
    textMatches?: boolean;
    isDisabled?: boolean;
    triggerPrice?: string;
    marketPrice?: string;
    error?: string;
  } | null>(null);
  const pgPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pgAccRef = useRef('');

  // ── Limit Price Direction test state ──────────────────────────────────
  const [pdMinUsd, setPdMinUsd] = useState('5');
  const [pdBnbPrice, setPdBnbPrice] = useState<string | null>(null);
  const [pdBnbLoading, setPdBnbLoading] = useState(false);
  const [pdRunState, setPdRunState] = useState<RunState>({ status: 'idle' });
  const [pdShowOutput, setPdShowOutput] = useState(false);
  const [pdResult, setPdResult] = useState<{
    passed: boolean;
    belowPassed?: boolean;
    abovePassed?: boolean;
    marketPrice?: string;
    error?: string;
  } | null>(null);
  const pdPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pdAccRef = useRef('');

  // ── Limit Price Mode Linkage test state ───────────────────────────────
  const [pmMinUsd, setPmMinUsd] = useState('5');
  const [pmBnbPrice, setPmBnbPrice] = useState<string | null>(null);
  const [pmBnbLoading, setPmBnbLoading] = useState(false);
  const [pmRunState, setPmRunState] = useState<RunState>({ status: 'idle' });
  const [pmShowOutput, setPmShowOutput] = useState(false);
  const [pmResult, setPmResult] = useState<{
    passed: boolean;
    sc1?: boolean; sc2?: boolean; sc3?: boolean; sc4?: boolean;
    market?: string;
    error?: string;
  } | null>(null);
  const pmPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pmAccRef = useRef('');

  // Terminal test config (user-adjustable)
  const [termAppUrl,       setTermAppUrl]       = useState<string>('https://demo.peach.ag');
  const [termAppUrlApplied, setTermAppUrlApplied] = useState<string>('https://demo.peach.ag');
  const [termTokenCount,   setTermTokenCount]   = useState<number>(PEACH_TERMINAL_CONFIG.tokenCount);
  const [termPayAmount,    setTermPayAmount]    = useState<string>(PEACH_TERMINAL_CONFIG.payAmount);
  const [termUsdRatio,     setTermUsdRatio]     = useState<number>(PEACH_TERMINAL_CONFIG.usdThreshold);
  const [termTag,          setTermTag]          = useState<string>(PEACH_TERMINAL_CONFIG.tag);
  const [termDateType,     setTermDateType]     = useState<string>(PEACH_TERMINAL_CONFIG.dateType);
  const [termFetchAll,     setTermFetchAll]     = useState<boolean>(false);
  const [termUseTokenlist, setTermUseTokenlist] = useState<boolean>(PEACH_TERMINAL_CONFIG.useTokenlist);
  const [termBatchSize,    setTermBatchSize]    = useState<number>(PEACH_TERMINAL_CONFIG.batchSize);
  const [termBatchIndex,   setTermBatchIndex]   = useState<number>(PEACH_TERMINAL_CONFIG.batchIndex);
  const [termTotalTokens,  setTermTotalTokens]  = useState<number>(0);
  const [termTotalBatches, setTermTotalBatches] = useState<number>(0);
  const [termFetchingCount, setTermFetchingCount] = useState<boolean>(false);
  // Custom token list: each line is "name:address", e.g. "PEPE:0xabc...123"
  const [termCustomTokens, setTermCustomTokens] = useState<string>('');

  // ── Liquidity & Last-Trade Checker (standalone panel) ─────────────────────
  type LiqCheckStatus = 'idle' | 'running' | 'done';
  type LiqTokenResult = {
    sym: string;
    address: string;
    status: 'pending' | 'checking' | 'qualified' | 'disqualified' | 'error';
    maxLiqUsd?: number;
    lastTradeAgo?: number | null;
    tradeOk?: boolean;
    liqOk?: boolean;
    errorMsg?: string;
  };
  const [liqCheckTokens,     setLiqCheckTokens]     = useState<string>('');
  const [liqMinLiquidity,    setLiqMinLiquidity]    = useState<number>(10000);
  const [liqMaxLastTradeSecs,setLiqMaxLastTradeSecs] = useState<number>(3600);
  const [liqCheckStatus,     setLiqCheckStatus]     = useState<LiqCheckStatus>('idle');
  const [liqResults,         setLiqResults]         = useState<LiqTokenResult[]>([]);  // Token results: symbol → status + metadata
  type TokenStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'error';
  interface TokenResult {
    status: TokenStatus;
    rank?: number;
    reason?: string;
    payUsd?: string;
    receiveUsd?: string;
    address?: string;
  }
  const [tokenResults, setTokenResults] = useState<Record<string, TokenResult>>({});

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Reset batch counts when batch size is cleared
  useEffect(() => {
    if (termBatchSize === 0) {
      setTermTotalTokens(0);
      setTermTotalBatches(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termBatchSize]);

  const filteredRoutes = PEACH_ROUTES.filter((r) =>
    r.toLowerCase().includes(search.toLowerCase())
  );

  const clearResults = () => {
    setRouteResults({});
    setCombinedPhase(null);
    setRunState({ status: 'idle' });
  };

  const toggleRoute = (route: string) => {
    setSelectedRoutes((prev) =>
      prev.includes(route) ? prev.filter((r) => r !== route) : [...prev, route]
    );
    clearResults();
  };

  const selectAll = () => { setSelectedRoutes([...PEACH_ROUTES]); clearResults(); };
  const clearAll  = () => { setSelectedRoutes([]); clearResults(); };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const pollStatus = (runId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/trigger?runId=${runId}&project=peach`);
        if (!res.ok) return;
        const data = await res.json();

        // Accumulate output and merge parsed results into existing state.
        // We merge (not replace) so routes not yet seen in logs stay 'pending'.
        accOutputRef.current = (data.output ?? []).join('');
        const parsed = parseRouteResults(accOutputRef.current);
        if (Object.keys(parsed).length > 0) {
          setRouteResults((prev) => ({ ...prev, ...parsed }));
        }
        const cp = parseCombinedPhase(accOutputRef.current);
        if (cp) setCombinedPhase(cp);

        if (data.status === 'running') return;

        stopPolling();
        setRunState({
          status: data.status === 'completed' ? 'completed' : 'failed',
          runId,
          output: data.output ?? [],
          duration: data.duration,
        });
      } catch {
        // ignore polling errors
      }
    }, 2000);
  };

  const handleRun = async () => {
    if (!testAllRoutes && selectedRoutes.length === 0) {
      alert('请至少选择一条路由后再运行，或开启「测试全部路由」');
      return;
    }

    setRunState({ status: 'running' });
    setShowOutput(false);
    accOutputRef.current = '';

    // Pre-populate pending state for routes we're about to test
    const routesToShow = testAllRoutes ? [...PEACH_ROUTES] : selectedRoutes;
    setRouteResults(
      Object.fromEntries(routesToShow.map((r) => [r, { status: 'pending' as RouteStatus }]))
    );

    // Show combined-swap pending card immediately when in COMBINED mode
    if (!testAllRoutes && selectedRoutes.length > 1) {
      setCombinedPhase({ status: 'pending', routes: selectedRoutes });
    } else {
      setCombinedPhase(null);
    }

    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testId: 'peach-swap-route',
          project: 'peach',
          mode: 'local',
          testAllRoutes,
          peachRoutes: testAllRoutes ? [] : selectedRoutes,
          swapParams: {
            payToken,
            receiveToken,
            payAmount,
            executeSwap,
            swapSlippage,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setRunState({ status: 'failed', errorMsg: data.error ?? '启动失败' });
        return;
      }
      setRunState((prev) => ({ ...prev, runId: data.runId }));
      pollStatus(data.runId);
    } catch (err) {
      setRunState({ status: 'failed', errorMsg: String(err) });
    }
  };

  // ── Terminal handlers ──────────────────────────────────────────────────
  const stopTerminalPolling = () => {
    if (terminalPollRef.current) {
      clearInterval(terminalPollRef.current);
      terminalPollRef.current = null;
    }
  };

  /** Parse terminal test log into per-token results. */
  const parseTokenResults = (text: string): Record<string, {
    status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'error';
    rank?: number;
    reason?: string;
  }> => {
    const results: Record<string, { status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'error'; rank?: number; reason?: string }> = {};
    let m: RegExpExecArray | null;

    // Token symbol: any non-whitespace sequence (fallback log-based extraction)
    const SYM = '([^\\s→]+)';

    // Step headers: "  #1  H" — collect all started tokens with their rank
    const rankedTokens: Array<{ rank: number; sym: string }> = [];
    const reHeader = new RegExp(`^\\s*#(\\d+)\\s+${SYM}\\s*$`, 'gm');
    while ((m = reHeader.exec(text)) !== null) {
      const rank = parseInt(m[1], 10);
      const sym  = m[2].trim();
      rankedTokens.push({ rank, sym });
      if (!results[sym]) results[sym] = { status: 'pending', rank };
    }

    // Passed: "✅ #1 H  →  PASSED  (23.1s)"
    const rePassed = new RegExp(`✅[^#\\n]*#(\\d+)\\s+${SYM}\\s+→\\s+PASSED`, 'g');
    while ((m = rePassed.exec(text)) !== null) {
      results[m[2]] = { status: 'passed', rank: parseInt(m[1], 10) };
    }

    // Failed: "❌ #1 H  →  FAILED"
    const reFailed = new RegExp(`❌[^#\\n]*#(\\d+)\\s+${SYM}\\s+→\\s+FAILED`, 'g');
    while ((m = reFailed.exec(text)) !== null) {
      results[m[2]] = { status: 'failed', rank: parseInt(m[1], 10) };
    }

    // Skipped: "⏭  #1 H  →  SKIPPED (reason)"
    const reSkipped = new RegExp(`⏭[^\\n]*#(\\d+)\\s+${SYM}\\s+→\\s+SKIPPED([^\\n]*)`, 'g');
    while ((m = reSkipped.exec(text)) !== null) {
      const reason = m[3].replace(/[()]/g, '').trim();
      results[m[2]] = { status: 'skipped', rank: parseInt(m[1], 10), reason };
    }

    // Error: "⚠  #1 H  →  ERROR"
    const reError = new RegExp(`⚠[^\\n]*#(\\d+)\\s+${SYM}\\s+→\\s+ERROR`, 'g');
    while ((m = reError.exec(text)) !== null) {
      results[m[2]] = { status: 'error', rank: parseInt(m[1], 10) };
    }

    // Mark the last started token that doesn't yet have a final status as 'running'
    const FINAL = new Set(['passed', 'failed', 'skipped', 'error']);
    if (rankedTokens.length > 0) {
      const last = rankedTokens[rankedTokens.length - 1];
      if (!FINAL.has(results[last.sym]?.status ?? '')) {
        results[last.sym] = { status: 'running', rank: last.rank };
      }
    }

    return results;
  };

  const pollTerminalStatus = (runId: string) => {
    stopTerminalPolling();
    terminalPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/trigger?runId=${runId}&project=peach`);
        if (!res.ok) return;
        const data = await res.json();

        terminalAccRef.current = (data.output ?? []).join('');
        const parsed = parseTokenResults(terminalAccRef.current);
        if (Object.keys(parsed).length > 0) {
          // Merge: preserve address from pre-loaded state when log parsing overwrites a token
          setTokenResults((prev) => {
            const merged = { ...prev };
            for (const [sym, result] of Object.entries(parsed)) {
              merged[sym] = { address: prev[sym]?.address, ...result };
            }
            return merged;
          });
        }

        if (data.status === 'running') return;
        stopTerminalPolling();

        // Force-finalize any token still in 'running' or 'pending' state.
        // Also determine the true final status based on token results —
        // if any token is failed/error, show as failed even if the process exited 0.
        setTokenResults((prev) => {
          const next = { ...prev };
          for (const sym of Object.keys(next)) {
            if (next[sym].status === 'running' || next[sym].status === 'pending') {
              next[sym] = { ...next[sym], status: 'error', reason: '测试结束时仍未有结果' };
            }
          }
          const hasRealFailure = Object.values(next).some(
            (r) => r.status === 'failed' || r.status === 'error',
          );
          const trueStatus = hasRealFailure ? 'failed'
            : data.status === 'completed' ? 'completed'
            : 'failed';
          setTerminalRun({
            status: trueStatus,
            runId,
            output: data.output ?? [],
            duration: data.duration,
          });
          return next;
        });
      } catch {
        // ignore
      }
    }, 2000);
  };

  // Apply APP URL configuration and reset wallet profile
  const handleApplyAppUrl = async () => {
    if (!termAppUrl || !termAppUrl.trim()) {
      alert('请输入有效的应用地址');
      return;
    }
    
    const confirmed = confirm(
      `应用新地址将会：\n` +
      `1. 设置测试地址为: ${termAppUrl}\n` +
      `2. 删除钱包配置文件夹 (.playwright-wallet-profile)\n` +
      `3. 下次测试时需要重新授权钱包\n\n` +
      `确定要应用吗？`
    );
    
    if (!confirmed) return;
    
    try {
      // Call API to delete wallet profile
      const res = await fetch('/api/wallet-profile', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'peach' }),
      });
      
      if (!res.ok) {
        const data = await res.json();
        alert(`删除钱包配置失败: ${data.error || '未知错误'}`);
        return;
      }
      
      // Apply the new URL
      setTermAppUrlApplied(termAppUrl);
      alert(`✓ 已应用新地址: ${termAppUrl}\n✓ 已删除钱包配置文件\n\n下次测试时会使用新地址并重新授权钱包`);
    } catch (err) {
      alert(`操作失败: ${err}`);
    }
  };

  /** Call the cmc-check proxy to determine if a token is qualified. */
  const checkTokenQualified = async (address: string, minLiquidity: number, maxLastTradeSecs: number): Promise<boolean> => {
    try {
      const params = new URLSearchParams({
        platform: 'bsc',
        address,
        minLiquidity: String(minLiquidity),
        maxLastTradeSecs: String(maxLastTradeSecs),
      });
      const res = await fetch(`/api/cmc-check?${params}`);
      if (!res.ok) return false;
      const data = await res.json();
      return data.qualified === true;
    } catch {
      return false;
    }
  };

  /** Standalone liquidity & last-trade checker handler */
  const handleLiqCheck = async () => {
    const lines = liqCheckTokens.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) { alert('请输入至少一个代币，格式: 名称:合约地址'); return; }

    const parsed: LiqTokenResult[] = [];
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const sym  = line.slice(0, idx).trim();
      const addr = line.slice(idx + 1).trim();
      if (!sym || !addr.startsWith('0x')) continue;
      parsed.push({ sym, address: addr, status: 'pending' });
    }
    if (parsed.length === 0) { alert('未解析到有效代币，格式应为: 名称:0x合约地址'); return; }

    setLiqCheckStatus('running');
    setLiqResults(parsed.map(t => ({ ...t, status: 'pending' })));

    const BATCH = 5;
    for (let i = 0; i < parsed.length; i += BATCH) {
      const chunk = parsed.slice(i, i + BATCH);
      await Promise.all(chunk.map(async (token) => {
        setLiqResults(prev => prev.map(t =>
          t.address === token.address ? { ...t, status: 'checking' } : t
        ));
        try {
          const params = new URLSearchParams({
            platform: 'bsc',
            address: token.address,
            minLiquidity: String(liqMinLiquidity),
            maxLastTradeSecs: String(liqMaxLastTradeSecs),
          });
          const res = await fetch(`/api/cmc-check?${params}`);
          const data = await res.json();
          setLiqResults(prev => prev.map(t =>
            t.address === token.address ? {
              ...t,
              status: data.qualified ? 'qualified' : 'disqualified',
              maxLiqUsd: data.maxLiqUsd,
              lastTradeAgo: data.lastTradeAgo,
              tradeOk: data.tradeOk,
              liqOk: data.liqOk,
            } : t
          ));
        } catch (err) {
          setLiqResults(prev => prev.map(t =>
            t.address === token.address ? { ...t, status: 'error', errorMsg: String(err) } : t
          ));
        }
      }));
    }
    setLiqCheckStatus('done');
  };

  // Fetch token count for batch calculation
  const fetchTokenCount = async () => {
    if (termBatchSize === 0) {
      return; // No need to fetch if batch size is 0
    }
    
    setTermFetchingCount(true);
    try {
      const seenSymbols = new Set<string>();
      let validCount = 0;
      
      if (termUseTokenlist) {
        // Fetch from tokenlist API - count valid unique tokens
        const pageSize = 50;
        let page = 1;
        let hasMore = true;
        
        while (hasMore && validCount < 10000) { // safety limit
          try {
            const r = await fetch(
              `https://api.cipheron.org/v1/bsc/tokenlist?page=${page}&page_size=${pageSize}`,
              { headers: { Authorization: 'Basic ' + btoa('peach:VncP3WpLyDHPWczf') } },
            );
            if (!r.ok) {
              console.warn(`[fetchTokenCount] tokenlist API returned ${r.status}`);
              break;
            }
            const d = await r.json();
            const list: { symbol?: string; address?: string }[] = d?.data?.list ?? d?.data ?? [];
            
            if (list.length === 0) {
              hasMore = false;
            } else {
              // Count valid unique tokens
              for (const item of list) {
                const sym = String(item.symbol || '').trim();
                if (!sym) continue; // Skip empty symbols
                if (seenSymbols.has(sym)) continue; // Skip duplicates
                
                // Validate address for tokenlist
                if (item.address && item.address.startsWith('0x')) {
                  if (item.address.length !== 42) continue; // Skip invalid addresses
                }
                
                seenSymbols.add(sym);
                validCount++;
              }
              
              if (list.length < pageSize) {
                hasMore = false;
              }
              page++;
            }
          } catch (fetchErr) {
            console.error(`[fetchTokenCount] tokenlist fetch error:`, fetchErr);
            break;
          }
        }
      } else {
        // Fetch from coin_list API - count valid unique tokens
        const params = new URLSearchParams({
          tag:        termTag,
          date_type:  termDateType,
          sort_field: termTag === 'trending' ? 'rank' : termTag === 'new' ? 'age'
                      : ({ '1h': 'pc1h', '4h': 'pc4h', '24h': 'pc24h' } as Record<string,string>)[termDateType] ?? 'pc24h',
          desc:       termTag === 'trending' ? 'false' : 'true',
          limit:      '20',
          offset:     '0',
        });

        let offset = 0;
        let hasMore = true;
        
        while (hasMore && validCount < 10000) { // safety limit
          try {
            params.set('limit', '20');
            params.set('offset', String(offset));
            const r = await fetch(
              `https://api.cipheron.org/v1/bsc/pro/coin_list?${params}`,
              { headers: { Authorization: 'Basic ' + btoa('peach:VncP3WpLyDHPWczf') } },
            );
            if (!r.ok) {
              console.warn(`[fetchTokenCount] coin_list API returned ${r.status}`);
              break;
            }
            const d = await r.json();
            const page: { symbol?: string }[] = d?.data?.coin_list ?? d?.data ?? [];
            
            if (page.length === 0) {
              hasMore = false;
            } else {
              // Count valid unique tokens
              for (const item of page) {
                const sym = String(item.symbol || '').trim();
                if (!sym) continue;
                if (seenSymbols.has(sym)) continue;
                
                seenSymbols.add(sym);
                validCount++;
              }
              
              if (page.length < 20) {
                hasMore = false;
              }
              offset += 20;
            }
          } catch (fetchErr) {
            console.error(`[fetchTokenCount] coin_list fetch error:`, fetchErr);
            break;
          }
        }
      }
      
      setTermTotalTokens(validCount);
      
      // Calculate total batches based on valid token count
      if (termBatchSize > 0) {
        const batches = Math.ceil(validCount / termBatchSize);
        setTermTotalBatches(batches);
      } else {
        setTermTotalBatches(0);
      }
      
      console.log(`[fetchTokenCount] Found ${validCount} valid unique tokens`);
    } catch (err) {
      console.error('[fetchTokenCount] Failed to fetch token count:', err);
      setTermTotalTokens(0);
      setTermTotalBatches(0);
    } finally {
      setTermFetchingCount(false);
    }
  };

  const handleTerminalRun = async () => {
    setTerminalRun({ status: 'running' });
    setTerminalShowOutput(false);
    terminalAccRef.current = '';
    setTokenResults({});


    // ── Pre-fetch token list to initialise token cards immediately ──────────
    try {
      const allCoins: { symbol: string; address?: string }[] = [];

      // If custom token list is provided, skip API fetch and parse directly
      if (termCustomTokens.trim()) {
        const lines = termCustomTokens.trim().split('\n');
        for (const line of lines) {
          const colonIdx = line.indexOf(':');
          if (colonIdx === -1) continue;
          const sym = line.slice(0, colonIdx).trim();
          const addr = line.slice(colonIdx + 1).trim();
          if (sym) allCoins.push({ symbol: sym, address: addr || undefined });
        }
        const initial: Record<string, TokenResult> = {};
        let rank = 1;
        for (const c of allCoins) {
          const sym = String(c.symbol).trim();
          if (!sym) continue;
          initial[sym] = { status: 'pending', rank: rank++, address: c.address };
        }
        setTokenResults(initial);
      } else {

      // In batch mode, always fetch all tokens; otherwise use termTokenCount or fetchAll setting
      const maxCoins = termBatchSize > 0 || termFetchAll ? 10_000 : termTokenCount;

      if (termUseTokenlist) {
        // ── Fetch from tokenlist API ──
        const pageSize = 50;
        let page = 1;

        while (allCoins.length < maxCoins) {
          const r = await fetch(
            `https://api.cipheron.org/v1/bsc/tokenlist?page=${page}&page_size=${pageSize}`,
            { headers: { Authorization: 'Basic ' + btoa('peach:VncP3WpLyDHPWczf') } },
          );
          if (!r.ok) break;
          const d = await r.json();
          const list: { symbol: string; address?: string }[] = d?.data?.list ?? d?.data ?? [];
          if (list.length === 0) break;
          
          // Validate and fix addresses before adding to allCoins
          for (const item of list) {
            if (item.address && item.address.startsWith('0x')) {
              // BSC addresses should be 42 chars (0x + 40 hex digits)
              if (item.address.length > 42) {
                console.log(`[tokenlist] Truncating address ${item.address} → ${item.address.slice(0, 42)}`);
                item.address = item.address.slice(0, 42);
              } else if (item.address.length < 42) {
                console.log(`[tokenlist] Skipping invalid address ${item.address} (length ${item.address.length})`);
                continue;
              }
            }
            allCoins.push(item);
          }
          
          if (list.length < pageSize) break;
          page++;
        }
      } else {
        // ── Fetch from coin_list API ──
        const params = new URLSearchParams({
          tag:        termTag,
          date_type:  termDateType,
          sort_field: termTag === 'trending' ? 'rank' : termTag === 'new' ? 'age'
                      : ({ '1h': 'pc1h', '4h': 'pc4h', '24h': 'pc24h' } as Record<string,string>)[termDateType] ?? 'pc24h',
          desc:       termTag === 'trending' ? 'false' : 'true',
          limit:      '20',
          offset:     '0',
        });

        let offset = 0;

        while (allCoins.length < maxCoins) {
          params.set('limit', '20');
          params.set('offset', String(offset));
          const r = await fetch(
            `https://api.cipheron.org/v1/bsc/pro/coin_list?${params}`,
            { headers: { Authorization: 'Basic ' + btoa('peach:VncP3WpLyDHPWczf') } },
          );
          if (!r.ok) break;
          const d = await r.json();
          const page: { symbol: string; address?: string }[] = d?.data?.coin_list ?? d?.data ?? [];
          if (page.length === 0) break;
          allCoins.push(...page);
          if (page.length < 20) break;
          offset += 20;
        }
      }

      const initial: Record<string, TokenResult> = {};
      const seen = new Set<string>();
      
      // Determine which coins to show based on mode
      if (termBatchSize > 0) {
        // Batch mode: collect exactly batchSize valid tokens for this batch
        // Skip invalid/duplicate tokens and collect the next valid one
        let collected = 0;
        let targetStart = termBatchIndex * termBatchSize;
        let scanned = 0;
        
        for (const c of allCoins) {
          const sym = String(c.symbol).trim();
          if (!sym) continue; // Skip empty symbols
          if (seen.has(sym)) continue; // Skip duplicates
          
          // Count this as a valid token
          if (scanned >= targetStart) {
            // This token is in our batch range
            seen.add(sym);
            // Assign sequential rank starting from 1 for this batch
            initial[sym] = { status: 'pending', rank: collected + 1, address: c.address };
            collected++;
            if (collected >= termBatchSize) break;
          }
          scanned++;
        }
        
        console.log(`[Batch ${termBatchIndex}] Collected ${collected} valid tokens (scanned ${scanned + 1} total)`);
      } else if (termFetchAll) {
        // Fetch all mode: show all valid coins
        let rank = 1;
        for (const c of allCoins) {
          const sym = String(c.symbol).trim();
          if (!sym || seen.has(sym)) continue;
          seen.add(sym);
          initial[sym] = { status: 'pending', rank: rank++, address: c.address };
        }
      } else {
        // Regular mode: show first N valid coins
        let rank = 1;
        for (const c of allCoins) {
          if (rank > termTokenCount) break;
          const sym = String(c.symbol).trim();
          if (!sym || seen.has(sym)) continue;
          seen.add(sym);
          initial[sym] = { status: 'pending', rank: rank++, address: c.address };
        }
      }
      
      setTokenResults(initial);
      } // end else (no customTokens)
    } catch {
      // non-fatal: token cards will fill in from log parsing as fallback
    }

    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testId: 'peach-terminal',
          project: 'peach',
          mode: 'local',
          testAllRoutes: false,
          peachRoutes: [],
          swapParams: {
            appUrl:           termAppUrlApplied,
            payAmount:        termPayAmount,
            tokenCount:       (termFetchAll || termBatchSize > 0) ? undefined : termTokenCount,
            fetchAllTokens:   termFetchAll || termBatchSize > 0,
            usdThreshold:     termUsdRatio,
            executeSwap:      termExecuteSwap,
            terminalTag:      termTag,
            terminalDateType: termDateType,
            useTokenlist:     termUseTokenlist,
            batchSize:        termBatchSize,
            batchIndex:       termBatchIndex,
            customTokens:     termCustomTokens.trim() || undefined,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setTerminalRun({ status: 'failed', errorMsg: data.error ?? '启动失败' });
        return;
      }
      setTerminalRun((prev) => ({ ...prev, runId: data.runId }));
      pollTerminalStatus(data.runId);
    } catch (err) {
      setTerminalRun({ status: 'failed', errorMsg: String(err) });
    }
  };

  const statusColor = {
    idle: 'text-slate-400',
    running: 'text-yellow-400',
    completed: 'text-green-400',
    failed: 'text-red-400',
  }[runState.status];

  const statusLabel = {
    idle: '',
    running: '⏳ 测试运行中...',
    completed: '✓ 测试通过',
    failed: '✗ 测试失败',
  }[runState.status];

  // ── Route Change: parse results from log text ──────────────────────────
  const parseRcResults = (text: string) => {
    const items: typeof rcResults = [];
    // error 内容可能包含空格，用 [^#]* 匹配到 ## 结束
    const re = /##ROUTE_CHANGE_RESULT:amount=([^,]+),routeCount=(\d+),quote=([^,]+),rate=([^,#\n]+)(?:,error=([^#]*))?##/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      items.push({
        amount: m[1].trim(),
        routeCount: parseInt(m[2], 10),
        quote: m[3],
        exchangeRate: m[4].trim(),
        error: m[5]?.trim() || undefined,
      });
    }
    return items;
  };

  const stopRcPolling = () => {
    if (rcPollRef.current) { clearInterval(rcPollRef.current); rcPollRef.current = null; }
  };

  const pollRcStatus = (runId: string) => {
    stopRcPolling();
    rcPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/trigger?runId=${runId}&project=peach`);
        if (!res.ok) return;
        const data = await res.json();
        rcAccRef.current = (data.output ?? []).join('');
        const parsed = parseRcResults(rcAccRef.current);
        if (parsed.length > 0) setRcResults(parsed);
        // Parse summary
        const summaryMatch = /##ROUTE_CHANGE_SUMMARY:changed=(true|false),counts=([^,#]+),totalAmounts=(\d+)##/.exec(rcAccRef.current);
        if (summaryMatch) setRcHasChange(summaryMatch[1] === 'true');
        if (data.status === 'running') return;
        stopRcPolling();

        // 测试结束后，对没有解析到结果的 amount 补充 error 占位
        // 优先使用最新解析结果，同时保留轮询过程中已有的正确记录
        const finalParsed = parseRcResults(rcAccRef.current);
        setRcResults(prev => {
          const amountList = rcAmounts.split(',').map(a => a.trim()).filter(Boolean);
          // 以 finalParsed 为准，如果 finalParsed 没有某条记录，尝试从 prev 里找，最后才补 error 占位
          const merged: typeof finalParsed = [];
          for (const amt of amountList) {
            const fromFinal = finalParsed.find(r => r.amount === amt);
            const fromPrev  = prev.find(r => r.amount === amt);
            if (fromFinal) {
              merged.push(fromFinal);
            } else if (fromPrev && !fromPrev.error) {
              // prev 里有有效结果（非 error）则保留
              merged.push(fromPrev);
            } else {
              merged.push({ amount: amt, routeCount: 0, quote: '—', exchangeRate: '—', error: '未获取到结果' });
            }
          }
          return merged;
        });

        setRcRunState({
          status: data.status === 'completed' ? 'completed' : 'failed',
          runId,
          output: data.output ?? [],
          duration: data.duration,
        });
      } catch { /* ignore */ }
    }, 2000);
  };

  const handleRcRun = async () => {
    const amountList = rcAmounts.split(',').map(a => a.trim()).filter(a => a && !isNaN(parseFloat(a)));
    if (amountList.length === 0) { alert('请输入至少一个有效金额，用逗号分隔，如 0.01,0.05,0.1'); return; }
    setRcRunState({ status: 'running' });
    setRcShowOutput(false);
    setRcResults([]);
    setRcHasChange(null);
    rcAccRef.current = '';
    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testId: 'peach-route-change',
          project: 'peach',
          mode: 'local',
          testAllRoutes: false,
          peachRoutes: [],
          swapParams: { routeChangeAmounts: amountList.join(','), payToken: rcPayToken, receiveToken: rcReceiveToken },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) { setRcRunState({ status: 'failed', errorMsg: data.error ?? '启动失败' }); return; }
      setRcRunState(prev => ({ ...prev, runId: data.runId }));
      pollRcStatus(data.runId);
    } catch (err) { setRcRunState({ status: 'failed', errorMsg: String(err) }); }
  };

  // ── Slippage: parse results from log text ─────────────────────────────
  const parseSlippageResults = (text: string) => {
    const items: typeof slippageResults = [];
    const re = /##SLIPPAGE_RESULT:value=([^,]+),label=([^,]+),matched=(true|false),warning=([^#]*)##/g;
    let m: RegExpExecArray | null;
    const KEYWORDS: Record<string, string> = {
      low:  'Your slippage is quite low and may cause failed transactions in highly volatile markets.',
      high: 'Your slippage setting might be high. Consider adjusting it to reduce front-running risks.',
      over: 'Enter a valid slippage percentage. Max is 19.99%',
    };
    while ((m = re.exec(text)) !== null) {
      const label = m[2];
      items.push({
        value: m[1],
        label,
        matched: m[3] === 'true',
        warningText: m[4].replace(/;/g, ','),
        expectedKeyword: KEYWORDS[label] ?? '',
      });
    }
    return items;
  };

  const stopSlippagePolling = () => {
    if (slippagePollRef.current) { clearInterval(slippagePollRef.current); slippagePollRef.current = null; }
  };

  const pollSlippageStatus = (runId: string) => {
    stopSlippagePolling();
    slippagePollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/trigger?runId=${runId}&project=peach`);
        if (!res.ok) return;
        const data = await res.json();
        slippageAccRef.current = (data.output ?? []).join('');
        const parsed = parseSlippageResults(slippageAccRef.current);
        if (parsed.length > 0) setSlippageResults(parsed);
        if (data.status === 'running') return;
        stopSlippagePolling();
        setSlippageRunState({
          status: data.status === 'completed' ? 'completed' : 'failed',
          runId,
          output: data.output ?? [],
          duration: data.duration,
        });
      } catch { /* ignore */ }
    }, 2000);
  };

  const handleSlippageRun = async () => {
    const vals = slippageValues.split(',').map(v => v.trim()).filter(v => v && !isNaN(parseFloat(v)));
    if (vals.length !== 3) { alert('请输入恰好 3 个有效的滑点值，用逗号分隔，如 0.05,2.5,20'); return; }
    setSlippageRunState({ status: 'running' });
    setSlippageShowOutput(false);
    setSlippageResults([]);
    slippageAccRef.current = '';
    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testId: 'peach-slippage',
          project: 'peach',
          mode: 'local',
          testAllRoutes: false,
          peachRoutes: [],
          swapParams: { slippageValues: vals.join(',') },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) { setSlippageRunState({ status: 'failed', errorMsg: data.error ?? '启动失败' }); return; }
      setSlippageRunState(prev => ({ ...prev, runId: data.runId }));
      pollSlippageStatus(data.runId);
    } catch (err) { setSlippageRunState({ status: 'failed', errorMsg: String(err) }); }
  };

  // ── Gas: parse result from log text ──────────────────────────────────
  const parseGasResult = (text: string) => {
    const m = /##GAS_RESULT:amount=([^,]+),matched=(true|false),warning=([^#]*)##/.exec(text);
    if (!m) return null;
    return { amount: m[1], matched: m[2] === 'true', warningText: m[3].replace(/;/g, ',') };
  };

  const parseGasBalance = (text: string): string | null => {
    const m = /##GAS_BALANCE:([\d.]+)##/.exec(text);
    return m ? m[1] : null;
  };

  const stopGasPolling = () => {
    if (gasPollRef.current) { clearInterval(gasPollRef.current); gasPollRef.current = null; }
  };

  const pollGasStatus = (runId: string) => {
    stopGasPolling();
    gasPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/trigger?runId=${runId}&project=peach`);
        if (!res.ok) return;
        const data = await res.json();
        gasAccRef.current = (data.output ?? []).join('');
        const bal = parseGasBalance(gasAccRef.current);
        if (bal) setGasBalance(bal);
        const parsed = parseGasResult(gasAccRef.current);
        if (parsed) setGasResult(parsed);
        if (data.status === 'running') return;
        stopGasPolling();
        setGasRunState({ status: data.status === 'completed' ? 'completed' : 'failed', runId, output: data.output ?? [], duration: data.duration });
      } catch { /* ignore */ }
    }, 2000);
  };

  const handleGasRun = async () => {
    if (!gasTestAmount.trim()) {
      alert('请先在 You Pay 中输入金额');
      return;
    }
    setGasRunState({ status: 'running' });
    setGasShowOutput(false);
    setGasResult(null);
    gasAccRef.current = '';
    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testId: 'peach-gas',
          project: 'peach',
          mode: 'local',
          testAllRoutes: false,
          peachRoutes: [],
          swapParams: gasTestAmount.trim() ? { gasTestAmount: gasTestAmount.trim() } : {},
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) { setGasRunState({ status: 'failed', errorMsg: data.error ?? '启动失败' }); return; }
      setGasRunState(prev => ({ ...prev, runId: data.runId }));
      pollGasStatus(data.runId);
    } catch (err) { setGasRunState({ status: 'failed', errorMsg: String(err) }); }
  };

  // ── Gas: query BNB balance via /api/balance (BSC JSON-RPC, no Playwright) ──
  const handleQueryBalance = async () => {
    setGasBalanceLoading(true);
    try {
      const res = await fetch('/api/balance');
      const data = await res.json() as { balanceBNB?: string; address?: string; error?: string };
      if (!res.ok || data.error) {
        console.error('Balance query failed:', data.error);
        setGasBalance(null);
      } else {
        const bal = data.balanceBNB ?? null;
        setGasBalance(bal);
        // 自动填入 You Pay 输入框
        if (bal) setGasTestAmount(bal);
      }
    } catch (err) {
      console.error('Balance query error:', err);
      setGasBalance(null);
    } finally {
      setGasBalanceLoading(false);
    }
  };

  // ── Limit Order: parse result from log text ───────────────────────────
  const parseLimitResult = (text: string) => {
    const m = /##LIMIT_RESULT:passed=(true|false),payAmount=([^,]+),usdValue=([^,]+),bnbPrice=([^#\n]+)##/.exec(text);
    if (!m) {
      const errM = /##LIMIT_RESULT:passed=false,error=([^#\n]+)##/.exec(text);
      if (errM) return { passed: false, error: errM[1].trim() };
      return null;
    }
    return { passed: m[1] === 'true', payAmount: m[2], usdValue: m[3], bnbPrice: m[4].trim() };
  };

  const stopLimitPolling = () => {
    if (limitPollRef.current) { clearInterval(limitPollRef.current); limitPollRef.current = null; }
  };
  const pollLimitStatus = (runId: string) => {
    stopLimitPolling();
    limitPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/trigger?runId=${runId}&project=peach`);
        if (!res.ok) return;
        const data = await res.json();
        limitAccRef.current = (data.output ?? []).join('');
        const parsed = parseLimitResult(limitAccRef.current);
        if (parsed) setLimitResult(parsed);
        if (data.status === 'running') return;
        stopLimitPolling();
        setLimitRunState({ status: data.status === 'completed' ? 'completed' : 'failed', runId, output: data.output ?? [], duration: data.duration });
      } catch { /* ignore */ }
    }, 2000);
  };

  const handleLimitRun = async () => {
    const minUsd = parseFloat(limitMinUsd);
    if (isNaN(minUsd) || minUsd < 1) {
      alert('请输入 ≥ 1 的 USD 金额');
      return;
    }
    setLimitRunState({ status: 'running' });
    setLimitShowOutput(false);
    setLimitResult(null);
    setLimitBnbPrice(null);
    limitAccRef.current = '';

    // Query BNB price via BSC on-chain (Chainlink BNB/USD feed) using ethers.js
    // Falls back to /api/balance endpoint which also exposes BNB price
    let bnbPrice: number | null = null;
    try {
      setLimitBnbLoading(true);
      const res = await fetch('/api/balance');
      if (res.ok) {
        const d = await res.json() as { bnbPriceUsd?: string };
        if (d.bnbPriceUsd) bnbPrice = parseFloat(d.bnbPriceUsd);
      }
    } catch { /* ignore — test script will re-query on its own */ }
    finally { setLimitBnbLoading(false); }

    // Compute the BNB amount: ceil to 6 decimals, add 10% buffer so USD ≥ minUsd
    let computedBnbAmount: string | undefined;
    if (bnbPrice && bnbPrice > 0) {
      const raw = (minUsd * 1.1) / bnbPrice;
      const ceiled = Math.ceil(raw * 1_000_000) / 1_000_000;
      computedBnbAmount = ceiled.toFixed(6);
      setLimitBnbPrice(bnbPrice.toFixed(2));
    }

    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testId: 'peach-limit',
          project: 'peach',
          mode: 'local',
          testAllRoutes: false,
          peachRoutes: [],
          swapParams: {
            ...(computedBnbAmount ? { limitPayAmount: computedBnbAmount } : {}),
            limitMinUsd: minUsd,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) { setLimitRunState({ status: 'failed', errorMsg: data.error ?? '启动失败' }); return; }
      setLimitRunState(prev => ({ ...prev, runId: data.runId }));
      pollLimitStatus(data.runId);
    } catch (err) { setLimitRunState({ status: 'failed', errorMsg: String(err) }); }
  };

  // ── Limit Price Guard helpers ─────────────────────────────────────────
  const parsePgResult = (text: string) => {
    const m = /##PRICE_GUARD_RESULT:passed=(true|false),textMatches=(true|false),isDisabled=(true|false),triggerPrice=([^,]+),marketPrice=([^#\n]+)##/.exec(text);
    if (!m) return null;
    return {
      passed:       m[1] === 'true',
      textMatches:  m[2] === 'true',
      isDisabled:   m[3] === 'true',
      triggerPrice: m[4],
      marketPrice:  m[5].trim(),
    };
  };

  const stopPgPolling = () => {
    if (pgPollRef.current) { clearInterval(pgPollRef.current); pgPollRef.current = null; }
  };

  const pollPgStatus = (runId: string) => {
    stopPgPolling();
    pgPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/trigger?runId=${runId}&project=peach`);
        if (!res.ok) return;
        const data = await res.json();
        pgAccRef.current = (data.output ?? []).join('');
        const parsed = parsePgResult(pgAccRef.current);
        if (parsed) setPgResult(parsed);
        if (data.status === 'running') return;
        stopPgPolling();
        setPgRunState({ status: data.status === 'completed' ? 'completed' : 'failed', runId, output: data.output ?? [], duration: data.duration });
      } catch { /* ignore */ }
    }, 2000);
  };

  const handlePgRun = async () => {
    const minUsd = parseFloat(pgMinUsd);
    if (isNaN(minUsd) || minUsd < 5) { alert('请输入 ≥ 5 的 USD 金额'); return; }
    const ratio = parseFloat(pgPriceRatio);
    if (isNaN(ratio) || ratio <= 0 || ratio >= 1) {
      alert('价格比例需介于 0 和 1 之间（如 0.949）');
      return;
    }
    setPgRunState({ status: 'running' });
    setPgShowOutput(false);
    setPgResult(null);
    setPgBnbPrice(null);
    pgAccRef.current = '';

    let bnbPrice: number | null = null;
    try {
      setPgBnbLoading(true);
      const res = await fetch('/api/balance');
      if (res.ok) {
        const d = await res.json() as { bnbPriceUsd?: string };
        if (d.bnbPriceUsd) bnbPrice = parseFloat(d.bnbPriceUsd);
      }
    } catch { /* ignore */ } finally { setPgBnbLoading(false); }

    let computedBnbAmount: string | undefined;
    if (bnbPrice && bnbPrice > 0) {
      const raw = (minUsd * 1.1) / bnbPrice;
      computedBnbAmount = (Math.ceil(raw * 1_000_000) / 1_000_000).toFixed(6);
      setPgBnbPrice(bnbPrice.toFixed(2));
    }

    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testId: 'peach-limit-price-guard',
          project: 'peach',
          mode: 'local',
          testAllRoutes: false,
          peachRoutes: [],
          swapParams: {
            ...(computedBnbAmount ? { limitPayAmount: computedBnbAmount } : {}),
            limitMinUsd: minUsd,
            limitPriceRatio: ratio,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setPgRunState({ status: 'failed', errorMsg: data.error ?? '启动失败' });
        return;
      }
      setPgRunState(prev => ({ ...prev, runId: data.runId }));
      pollPgStatus(data.runId);
    } catch (err) { setPgRunState({ status: 'failed', errorMsg: String(err) }); }
  };

  // ── Limit Price Direction helpers ─────────────────────────────────────
  const parsePdResult = (text: string) => {
    const m = /##PRICE_DIR_RESULT:passed=(true|false),belowPassed=(true|false),abovePassed=(true|false),marketPrice=([^#\n]+)##/.exec(text);
    if (!m) return null;
    return {
      passed:      m[1] === 'true',
      belowPassed: m[2] === 'true',
      abovePassed: m[3] === 'true',
      marketPrice: m[4].trim(),
    };
  };

  const stopPdPolling = () => {
    if (pdPollRef.current) { clearInterval(pdPollRef.current); pdPollRef.current = null; }
  };

  const pollPdStatus = (runId: string) => {
    stopPdPolling();
    pdPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/trigger?runId=${runId}&project=peach`);
        if (!res.ok) return;
        const data = await res.json();
        pdAccRef.current = (data.output ?? []).join('');
        const parsed = parsePdResult(pdAccRef.current);
        if (parsed) setPdResult(parsed);
        if (data.status === 'running') return;
        stopPdPolling();
        setPdRunState({ status: data.status === 'completed' ? 'completed' : 'failed', runId, output: data.output ?? [], duration: data.duration });
      } catch { /* ignore */ }
    }, 2000);
  };

  const handlePdRun = async () => {
    const minUsd = parseFloat(pdMinUsd);
    if (isNaN(minUsd) || minUsd < 5) { alert('请输入 ≥ 5 的 USD 金额'); return; }
    setPdRunState({ status: 'running' });
    setPdShowOutput(false);
    setPdResult(null);
    setPdBnbPrice(null);
    pdAccRef.current = '';

    let bnbPrice: number | null = null;
    try {
      setPdBnbLoading(true);
      const res = await fetch('/api/balance');
      if (res.ok) {
        const d = await res.json() as { bnbPriceUsd?: string };
        if (d.bnbPriceUsd) bnbPrice = parseFloat(d.bnbPriceUsd);
      }
    } catch { /* ignore */ } finally { setPdBnbLoading(false); }

    if (bnbPrice && bnbPrice > 0) {
      setPdBnbPrice(bnbPrice.toFixed(2));
    }

    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testId: 'peach-limit-price-direction',
          project: 'peach',
          mode: 'local',
          testAllRoutes: false,
          peachRoutes: [],
          swapParams: { limitMinUsd: minUsd },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setPdRunState({ status: 'failed', errorMsg: data.error ?? '启动失败' });
        return;
      }
      setPdRunState(prev => ({ ...prev, runId: data.runId }));
      pollPdStatus(data.runId);
    } catch (err) { setPdRunState({ status: 'failed', errorMsg: String(err) }); }
  };

  // ── Limit Price Mode helpers ──────────────────────────────────────────
  const parsePmResult = (text: string) => {
    const m = /##PRICE_MODE_RESULT:passed=(true|false),sc1=(true|false),sc2=(true|false),sc3=(true|false),sc4=(true|false),market=([^#\n]+)##/.exec(text);
    if (!m) return null;
    return { passed: m[1]==='true', sc1: m[2]==='true', sc2: m[3]==='true', sc3: m[4]==='true', sc4: m[5]==='true', market: m[6].trim() };
  };

  const stopPmPolling = () => {
    if (pmPollRef.current) { clearInterval(pmPollRef.current); pmPollRef.current = null; }
  };

  const pollPmStatus = (runId: string) => {
    stopPmPolling();
    pmPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/trigger?runId=${runId}&project=peach`);
        if (!res.ok) return;
        const data = await res.json();
        pmAccRef.current = (data.output ?? []).join('');
        const parsed = parsePmResult(pmAccRef.current);
        if (parsed) setPmResult(parsed);
        if (data.status === 'running') return;
        stopPmPolling();
        setPmRunState({ status: data.status === 'completed' ? 'completed' : 'failed', runId, output: data.output ?? [], duration: data.duration });
      } catch { /* ignore */ }
    }, 2000);
  };

  const handlePmRun = async () => {
    const minUsd = parseFloat(pmMinUsd);
    if (isNaN(minUsd) || minUsd < 5) { alert('请输入 ≥ 5 的 USD 金额'); return; }
    setPmRunState({ status: 'running' });
    setPmShowOutput(false);
    setPmResult(null);
    setPmBnbPrice(null);
    pmAccRef.current = '';
    let bnbPrice: number | null = null;
    try {
      setPmBnbLoading(true);
      const res = await fetch('/api/balance');
      if (res.ok) {
        const d = await res.json() as { bnbPriceUsd?: string };
        if (d.bnbPriceUsd) bnbPrice = parseFloat(d.bnbPriceUsd);
      }
    } catch { /* ignore */ } finally { setPmBnbLoading(false); }
    if (bnbPrice && bnbPrice > 0) setPmBnbPrice(bnbPrice.toFixed(2));
    try {
      const res = await fetch('/api/trigger', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testId: 'peach-limit-price-mode', project: 'peach', mode: 'local', testAllRoutes: false, peachRoutes: [], swapParams: { limitMinUsd: minUsd } }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) { setPmRunState({ status: 'failed', errorMsg: data.error ?? '启动失败' }); return; }
      setPmRunState(prev => ({ ...prev, runId: data.runId }));
      pollPmStatus(data.runId);
    } catch (err) { setPmRunState({ status: 'failed', errorMsg: String(err) }); }
  };

  return (
    <div className="mx-auto max-w-7xl">
      {/* Peach project divider */}
      <div className="mb-6 flex items-center gap-3">
        <div className="h-px flex-1 bg-slate-700" />
        <div className="flex items-center gap-2 rounded-full border border-slate-600 bg-slate-800 px-4 py-1.5">
          <span className="text-sm">🍑</span>
          <span className="text-sm font-semibold text-slate-200">Peach</span>
          <span className="text-xs text-slate-500">· {PEACH_GROUPS.length} 模块 · {PEACH_GROUPS.reduce((s, g) => s + g.tests.length, 0)} 用例</span>
        </div>
        <div className="h-px flex-1 bg-slate-700" />
      </div>

      {/* App URL Configuration */}
      <div className="mb-4 rounded-xl border border-slate-700 bg-slate-800/50 p-4">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <label className="mb-2 block text-sm font-semibold text-slate-300">
              应用地址配置
            </label>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={termAppUrl}
                onChange={(e) => setTermAppUrl(e.target.value)}
                placeholder="https://demo.peach.ag"
                className="flex-1 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-orange-500 transition"
              />
              <button
                onClick={handleApplyAppUrl}
                className="shrink-0 rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-500"
              >
                应用
              </button>
            </div>
            <div className="mt-2 flex items-center gap-4 text-xs">
              <p className="text-slate-500">
                当前使用: <span className="text-orange-400 font-mono">{termAppUrlApplied}</span>
              </p>
              {termAppUrl !== termAppUrlApplied && (
                <span className="text-yellow-400">⚠ 配置已修改，点击"应用"生效</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Swap module group header — same style as Cetus group headers */}
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-slate-600 bg-slate-800 px-5 py-3">
        <span className="text-2xl">🔄</span>
        <div>
          <h2 className="text-lg font-bold text-white">Swap 兑换</h2>
          <p className="text-xs text-slate-400">{PEACH_SWAP_TESTS.length} 个测试用例 · {PEACH_ROUTES.length} 条路由 · EVM 链路由流动性来源自动化测试</p>
        </div>
      </div>

      {/* Test card */}
      <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
        <div className="flex items-start gap-3 mb-4">
          <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white shrink-0">P0</span>
          <div>
            <h3 className="font-semibold text-white">多路由兑换</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              选择指定流动性路由，执行真实链上 Swap 交易并验证余额变化
            </p>
          </div>
        </div>

        {/* Swap Parameters */}
        <div className="mb-4 space-y-3 rounded-lg border border-slate-700 bg-slate-800/50 p-3">
          <h4 className="text-xs font-semibold text-slate-300 mb-2">Swap 参数配置</h4>

          {/* Row 1: Pay Token + Receive Token */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">You Pay Token 地址</label>
              <input
                type="text"
                value={payToken}
                onChange={(e) => setPayToken(e.target.value)}
                placeholder="0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-orange-500 transition font-mono"
              />
              <p className="mt-0.5 text-[10px] text-slate-500">默认: BNB (0xeeee...eeee)</p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">You Receive Token 地址</label>
              <input
                type="text"
                value={receiveToken}
                onChange={(e) => setReceiveToken(e.target.value)}
                placeholder="0x55d398326f99059fF775485246999027B3197955"
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-orange-500 transition font-mono"
              />
              <p className="mt-0.5 text-[10px] text-slate-500">默认: USDT (0x55d3...7955)</p>
            </div>
          </div>

          {/* Row 2: Swap 金额 + 滑点 + 快速预设 */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">Swap 金额</label>
              <input
                type="text"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
                placeholder="0.001"
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-orange-500 transition"
              />
              <p className="mt-0.5 text-[10px] text-slate-500">默认: 0.001</p>
            </div>

            {/* Slippage */}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">滑点 (%)</label>
              <input
                type="text"
                value={swapSlippage}
                onChange={(e) => setSwapSlippage(e.target.value)}
                placeholder="0.5"
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-orange-500 transition"
              />
              <p className="mt-0.5 text-[10px] text-slate-500">留空使用页面默认值</p>
            </div>

            {/* Quick Presets */}
            <div>
              <p className="text-xs text-slate-400 mb-1.5">快速预设:</p>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => { setPayToken('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'); setReceiveToken('0x55d398326f99059fF775485246999027B3197955'); }}
                  className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600 transition"
                >BNB → USDT</button>
                <button
                  onClick={() => { setPayToken('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'); setReceiveToken('0x55d398326f99059fF775485246999027B3197955'); }}
                  className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600 transition"
                >USDC → USDT</button>
                <button
                  onClick={() => { setPayToken('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'); setReceiveToken('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'); }}
                  className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600 transition"
                >BNB → USDC</button>
              </div>
            </div>
          </div>
        </div>

        {/* Test All Routes toggle */}
        <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/50 p-3">
          <label className="flex cursor-pointer items-start gap-3">
            <div className="relative mt-0.5 shrink-0">
              <input
                type="checkbox"
                checked={testAllRoutes}
                onChange={(e) => { setTestAllRoutes(e.target.checked); clearResults(); }}
                className="peer sr-only"
              />
              <div className="h-5 w-9 rounded-full bg-slate-600 transition-colors peer-checked:bg-orange-500" />
              <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
            </div>
            <div>
              <span className="text-sm font-medium text-slate-200">测试全部路由（TEST_ALL_ROUTES）</span>
              <p className="mt-0.5 text-[10px] text-slate-500">
                {testAllRoutes
                  ? `✅ 开启：将逐条测试全部 ${PEACH_ROUTES.length} 个路由，每条路由各执行一次 swap 交易`
                  : '关闭：仅测试下方选中的路由，先多路由组合 swap，再逐条单独 swap'}
              </p>
            </div>
          </label>
        </div>

        {/* Route multi-select dropdown — hidden when testAllRoutes is on */}
        <div className={`mb-4 ${testAllRoutes ? 'hidden' : ''}`} ref={dropdownRef}>
          <label className="mb-1.5 block text-xs font-medium text-slate-400">
            选择路由 ({selectedRoutes.length}/{PEACH_ROUTES.length})
          </label>
          <div className="relative">
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              className="w-full flex items-center justify-between rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-left hover:border-slate-500 transition"
            >
              <span className={selectedRoutes.length === 0 ? 'text-slate-500' : 'text-white'}>
                {selectedRoutes.length === 0
                  ? '未选择任何路由（点击添加）'
                  : selectedRoutes.length === PEACH_ROUTES.length
                  ? `全部 ${PEACH_ROUTES.length} 个路由（已默认全选）`
                  : selectedRoutes.slice(0, 3).join(', ') +
                    (selectedRoutes.length > 3 ? ` 等 ${selectedRoutes.length} 个` : '')}
              </span>
              <span className="text-slate-400 ml-2">{dropdownOpen ? '▲' : '▼'}</span>
            </button>

            {dropdownOpen && (
              <div className="absolute z-50 mt-1 w-full rounded-lg border border-slate-600 bg-slate-800 shadow-xl">
                {/* Search & controls */}
                <div className="border-b border-slate-700 p-2 space-y-2">
                  <input
                    type="text"
                    placeholder="搜索路由..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full rounded bg-slate-700 px-2 py-1.5 text-xs text-white placeholder-slate-500 outline-none"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={selectAll}
                      className="flex-1 rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600"
                    >
                      全选
                    </button>
                    <button
                      onClick={clearAll}
                      className="flex-1 rounded bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600"
                    >
                      清空
                    </button>
                  </div>
                </div>

                {/* Route list */}
                <div className="max-h-56 overflow-y-auto py-1">
                  {filteredRoutes.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-slate-500">无匹配结果</div>
                  ) : (
                    filteredRoutes.map((route) => (
                      <label
                        key={route}
                        className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-slate-700 transition"
                      >
                        <input
                          type="checkbox"
                          checked={selectedRoutes.includes(route)}
                          onChange={() => toggleRoute(route)}
                          className="rounded accent-orange-500"
                        />
                        <span className="text-sm text-slate-200">{route}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Selected tags */}
          {selectedRoutes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {selectedRoutes.map((r) => (
                <span
                  key={r}
                  className="flex items-center gap-1 rounded-full bg-orange-900/50 border border-orange-700 px-2 py-0.5 text-xs text-orange-300"
                >
                  {r}
                  <button
                    onClick={() => toggleRoute(r)}
                    className="hover:text-white leading-none"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Status bar */}
        {runState.status !== 'idle' && (
          <div className={`mb-3 text-xs font-medium ${statusColor}`}>
            {statusLabel}
            {runState.duration && runState.status !== 'running' && (
              <span className="ml-2 text-slate-500">
                ({(runState.duration / 1000).toFixed(1)}s)
              </span>
            )}
          </div>
        )}

        {/* Execute Swap toggle */}
        <div className={`mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors ${
          executeSwap ? 'border-red-700/50 bg-red-950/20' : 'border-slate-700 bg-slate-800/40'
        }`}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-base shrink-0">{executeSwap ? '' : ''}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-semibold text-slate-200">发送真实交易</span>
                {executeSwap
                  ? <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">链上交易</span>
                  : <span className="rounded-full bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">模拟</span>}
              </div>
              <p className="text-[10px] text-slate-500 mt-0.5">
                {executeSwap ? '⚠️ 将消耗真实 BNB 和 Gas' : '仅验证报价，不发送链上交易'}
              </p>
            </div>
          </div>
          <label className="relative shrink-0 cursor-pointer">
            <input type="checkbox" checked={executeSwap} onChange={(e) => setExecuteSwap(e.target.checked)} className="peer sr-only" />
            <div className={`h-5 w-10 rounded-full transition-colors ${executeSwap ? 'bg-red-600' : 'bg-slate-600'}`} />
            <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
          </label>
        </div>

        {/* Action buttons */}
        <div className="space-y-2">
          {runState.output && runState.output.length > 0 && (
            <button
              onClick={() => setShowOutput(true)}
              className="w-full rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 transition"
            >
              查看输出
            </button>
          )}
          <button
            onClick={handleRun}
            disabled={runState.status === 'running' || (!testAllRoutes && selectedRoutes.length === 0)}
            className="w-full rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50 transition"
          >
            {runState.status === 'running'
              ? '⏳ 运行中...'
              : testAllRoutes
              ? `▶ ${executeSwap ? '' : ''} 运行全部 ${PEACH_ROUTES.length} 条路由`
              : selectedRoutes.length === 0
              ? '请先选择路由'
              : `▶ ${executeSwap ? '' : ''} 运行测试 (${selectedRoutes.length} 条路由)`}
          </button>
        </div>

        {/* Estimated time */}
        <p className="mt-2 text-xs text-slate-600">
          {testAllRoutes
            ? `预计耗时 ~${PEACH_ROUTES.length * 2}min（每条路由约 2 分钟）`
            : selectedRoutes.length > 1
            ? `预计耗时 ~${Math.max(20, selectedRoutes.length * 5 * 2)}s（组合 swap + 逐条 swap）`
            : `预计耗时 ~${Math.max(20, selectedRoutes.length * 5)}s（逐条 swap）`}
        </p>

        {/* Route results panel */}
        {(combinedPhase !== null || Object.keys(routeResults).length > 0) && (
          <div className="mt-4 space-y-3">

            {/* ── Phase 1: Combined swap card ─────────────────────────────── */}
            {combinedPhase && (
              <div>
                <div className="mb-1.5 text-xs font-semibold text-slate-400">
                  阶段一：组合 Swap（{combinedPhase.routes.length} 条路由同时选中）
                </div>
                <div
                  className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${
                    combinedPhase.status === 'passed'
                      ? 'border-green-700/60 bg-green-900/20 text-green-300'
                      : combinedPhase.status === 'failed'
                      ? 'border-red-700/60 bg-red-900/20 text-red-300'
                      : combinedPhase.status === 'running'
                      ? 'border-yellow-700/60 bg-yellow-900/20 text-yellow-300'
                      : 'border-slate-700/60 bg-slate-800/30 text-slate-500'
                  }`}
                >
                  <span className="shrink-0 text-base leading-snug">
                    {combinedPhase.status === 'passed'  ? '✅'
                     : combinedPhase.status === 'failed'  ? '❌'
                     : combinedPhase.status === 'running' ? '⏳'
                     : '○'}
                  </span>
                  <div className="min-w-0">
                    <div className="font-medium">
                      {combinedPhase.status === 'passed'  ? '组合 Swap 成功'
                       : combinedPhase.status === 'failed'  ? '组合 Swap 失败'
                       : combinedPhase.status === 'running' ? '组合 Swap 进行中...'
                       : '组合 Swap 等待中'}
                    </div>
                    <div className="mt-0.5 text-[11px] opacity-70 truncate">
                      {combinedPhase.routes.join(' · ')}
                    </div>
                    {combinedPhase.status === 'failed' && combinedPhase.error && (
                      <div className="mt-1 text-[10px] opacity-70" title={combinedPhase.error}>
                        {combinedPhase.error}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── Phase 2: Per-route results ────────────────────────────── */}
            {Object.keys(routeResults).length > 0 && (
              <div>
                {/* Header row */}
                {(() => {
                  const entries = Object.values(routeResults);
                  const passed  = entries.filter((r) => r.status === 'passed').length;
                  const failed  = entries.filter((r) => r.status === 'failed').length;
                  const running = entries.filter((r) => r.status === 'running').length;
                  const pending = entries.filter((r) => r.status === 'pending').length;
                  return (
                    <div className="mb-1.5 flex items-center gap-3 text-xs">
                      <span className="font-semibold text-slate-400">
                        {combinedPhase ? '阶段二：逐条 Swap' : '路由结果'}
                      </span>
                      {passed  > 0 && <span className="text-green-400">✅ 通过 {passed}</span>}
                      {failed  > 0 && <span className="text-red-400">❌ 失败 {failed}</span>}
                      {running > 0 && <span className="text-yellow-400">⏳ 运行中 {running}</span>}
                      {pending > 0 && <span className="text-slate-500">○ 待测 {pending}</span>}
                    </div>
                  );
                })()}

                {/* Route cards grid */}
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {Object.entries(routeResults).map(([route, result]) => (
                    <div
                      key={route}
                      title={result.error ?? undefined}
                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors ${
                        result.status === 'passed'
                          ? 'border-green-700/60 bg-green-900/20 text-green-300'
                          : result.status === 'failed' && result.failureKind === 'on-chain'
                          ? 'border-red-800/70 bg-red-950/30 text-red-300'
                          : result.status === 'failed' && result.failureKind === 'timeout'
                          ? 'border-orange-700/60 bg-orange-900/20 text-orange-300'
                          : result.status === 'failed'
                          ? 'border-red-700/60 bg-red-900/20 text-red-300'
                          : result.status === 'running'
                          ? 'border-yellow-700/60 bg-yellow-900/20 text-yellow-300'
                          : 'border-slate-700/60 bg-slate-800/30 text-slate-500'
                      }`}
                    >
                      <span className="shrink-0 text-sm leading-none">
                        {result.status === 'passed'  ? '✅'
                         : result.status === 'failed' && result.failureKind === 'timeout' ? '⏱️'
                         : result.status === 'failed'  ? '❌'
                         : result.status === 'running' ? '⏳'
                         : '○'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{route}</div>
                        {result.duration && (
                          <div className="text-[10px] opacity-70">{result.duration}</div>
                        )}
                        {result.status === 'failed' && (
                          <div className="truncate text-[10px] opacity-80" title={result.error}>
                            {result.failureKind === 'on-chain'
                              ? result.error ?? '链上交易失败'
                              : result.failureKind === 'timeout'
                              ? '等待超时'
                              : result.error ?? '未知失败'}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        )}
      </div>

      {/* Route Change Test Card — 路由数量变化测试（Swap 模块用例 2）*/}
      <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/60 p-5">
        <div className="flex items-start gap-3 mb-4">
          <span className="rounded bg-yellow-600 px-1.5 py-0.5 text-xs font-bold text-white shrink-0">P1</span>
          <div>
            <h3 className="font-semibold text-white">路由数量变化监测</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              依次输入多个金额，观察每个金额下 Auto Router 显示的路由/Stream 数量，分析不同金额下路由数量的变化
            </p>
          </div>
        </div>

        {/* Config panel */}
        <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/50 p-3 space-y-3">
          <div>
            <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
              金额序列（逗号分隔）
            </label>
            <input
              type="text"
              value={rcAmounts}
              onChange={(e) => setRcAmounts(e.target.value)}
              disabled={rcRunState.status === 'running'}
              placeholder="例如: 0.01,0.02,0.03 或 0.001,0.01,0.1,1"
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500 transition disabled:opacity-50 font-mono"
            />
            <p className="mt-0.5 text-[10px] text-slate-500">
              每个金额对应一次测试；金额个数决定测试次数。如 0.01,0.02,0.03 → 3 次测试
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">You Pay Token 地址</label>
              <input type="text" value={rcPayToken} onChange={(e) => setRcPayToken(e.target.value)} disabled={rcRunState.status === 'running'}
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500 transition disabled:opacity-50 font-mono" />
              <p className="mt-0.5 text-[10px] text-slate-500">默认 BNB (0xeeee...eeee)</p>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">You Receive Token 地址</label>
              <input type="text" value={rcReceiveToken} onChange={(e) => setRcReceiveToken(e.target.value)} disabled={rcRunState.status === 'running'}
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500 transition disabled:opacity-50 font-mono" />
              <p className="mt-0.5 text-[10px] text-slate-500">默认 USDT (0x55d3...7955)</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="text-[10px] text-slate-500 self-center">快速预设：</span>
            {[
              { label: '小金额 ×3', value: '0.01,0.02,0.03' },
              { label: '梯度 ×4', value: '0.001,0.01,0.1,1' },
              { label: '大范围 ×5', value: '0.001,0.01,0.1,1,10' },
            ].map(preset => (
              <button key={preset.label} onClick={() => setRcAmounts(preset.value)} disabled={rcRunState.status === 'running'}
                className="rounded border border-slate-600 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700 transition disabled:opacity-50">
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {/* Status + action */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            {rcRunState.status !== 'idle' && (
              <span className={`text-xs font-medium ${rcRunState.status === 'running' ? 'text-yellow-400' : rcRunState.status === 'completed' ? 'text-green-400' : 'text-red-400'}`}>
                {rcRunState.status === 'running' ? '⏳ 测试运行中...' : rcRunState.status === 'completed' ? '✓ 测试完成' : '✗ 测试失败'}
              </span>
            )}
            {rcRunState.duration != null && rcRunState.status !== 'running' && (
              <span className="text-xs text-slate-500">({(rcRunState.duration / 1000).toFixed(1)}s)</span>
            )}
            {rcHasChange === true && (
              <span className="rounded-full bg-green-800 border border-green-600 px-2 py-0.5 text-[10px] font-semibold text-green-300">路由数量有变化 ✓</span>
            )}
            {rcHasChange === false && (
              <span className="rounded-full bg-slate-700 border border-slate-600 px-2 py-0.5 text-[10px] text-slate-400">路由数量无变化</span>
            )}
          </div>
          {(rcRunState.status === 'completed' || rcRunState.status === 'failed') && rcRunState.output && (
            <button onClick={() => setRcShowOutput(true)}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors">
              查看日志
            </button>
          )}
          <button onClick={handleRcRun} disabled={rcRunState.status === 'running'}
            className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${rcRunState.status === 'running' ? 'cursor-not-allowed bg-slate-700 text-slate-500' : 'bg-orange-600 text-white hover:bg-orange-500'}`}>
            {rcRunState.status === 'running' ? '⏳ 运行中...' : `▶ 运行测试 (${rcAmounts.split(',').filter(a => a.trim()).length} 个金额)`}
          </button>
        </div>

        {rcRunState.errorMsg && <p className="mt-2 text-xs text-red-400">{rcRunState.errorMsg}</p>}

        {/* Results table */}
        {(rcResults.length > 0 || rcRunState.status === 'running') && (
          <div className="mt-4">
            <div className="mb-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">各金额路由数量对比</div>
            <div className="overflow-x-auto rounded-lg border border-slate-700">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-700 bg-slate-800/80">
                    <th className="px-3 py-2 text-left font-semibold text-slate-400">#</th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-400">金额</th>
                    <th className="px-3 py-2 text-center font-semibold text-slate-400">路由数量</th>
                    <th className="px-3 py-2 text-right font-semibold text-slate-400">报价</th>
                    <th className="px-3 py-2 text-right font-semibold text-slate-400">汇率 (1:x)</th>
                    <th className="px-3 py-2 text-center font-semibold text-slate-400">变化</th>
                  </tr>
                </thead>
                <tbody>
                  {rcAmounts.split(',').map((a, i) => {
                    const amount = a.trim();
                    const result = rcResults.find(r => r.amount === amount);
                    const isRunning = rcRunState.status === 'running' && !result;
                    const prevResult = i > 0 ? rcResults.find(r => r.amount === rcAmounts.split(',')[i - 1]?.trim()) : null;
                    const changed = result && prevResult && result.routeCount !== prevResult.routeCount;
                    return (
                      <tr key={amount} className={`border-b border-slate-800 ${result?.error ? 'bg-red-950/20' : changed ? 'bg-yellow-950/20' : ''}`}>
                        <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                        <td className="px-3 py-2 font-mono text-white">{amount}</td>
                        <td className="px-3 py-2 text-center">
                          {isRunning ? <span className="animate-pulse text-yellow-400">⏳</span>
                            : result ? <span className={`font-bold text-base ${result.error ? 'text-red-400' : 'text-blue-300'}`}>{result.error ? '✗' : result.routeCount}</span>
                            : <span className="text-slate-600">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-300">
                          {result && !result.error ? result.quote : result?.error ? <span className="text-red-400 text-[10px]" title={result.error}>错误</span> : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-400">{result && !result.error ? result.exchangeRate : '—'}</td>
                        <td className="px-3 py-2 text-center">
                          {changed ? <span className="text-yellow-400 font-bold" title={`${prevResult!.routeCount} → ${result!.routeCount}`}>↕</span>
                            : result && prevResult && !result.error ? <span className="text-slate-600">═</span>
                            : <span className="text-slate-700">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rcResults.length > 0 && rcRunState.status !== 'running' && (
              <div className={`mt-3 rounded-lg border px-4 py-3 text-xs ${rcHasChange === true ? 'border-green-700/60 bg-green-950/20 text-green-300' : 'border-slate-600 bg-slate-800/40 text-slate-400'}`}>
                {rcHasChange === true
                  ? <span>路由数量随金额变化：观察到 <strong>{Array.from(new Set(rcResults.filter(r => !r.error).map(r => r.routeCount))).sort((a,b)=>a-b).join(', ')}</strong> 种不同路由数量</span>
                  : <span>所有金额下路由数量相同（{rcResults[0]?.routeCount ?? 0} 条路由）</span>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Slippage Warning Validation Card（Swap 模块用例 3）───────────── */}
      <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/60 p-5">
        <div className="flex items-start gap-3 mb-4">
          <span className="rounded bg-yellow-600 px-1.5 py-0.5 text-xs font-bold text-white shrink-0">P1</span>
          <div>
            <h3 className="font-semibold text-white">滑点警告验证</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              依次输入三个滑点值，验证 Swap Settings 中对应的警告/错误提示文案是否正确展示
            </p>
          </div>
        </div>

        {/* Config */}
        <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/50 p-3 space-y-2">
          <div>
            <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
              三个滑点值（逗号分隔，依次对应低/高/超限）
            </label>
            <input
              type="text"
              value={slippageValues}
              onChange={(e) => setSlippageValues(e.target.value)}
              disabled={slippageRunState.status === 'running'}
              placeholder="0.05,2.5,20"
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-yellow-500 transition disabled:opacity-50 font-mono"
            />
          </div>
          {/* Expected warnings legend */}
          <div className="space-y-1.5 pt-1">
            {[
              { label: '低滑点', color: 'text-yellow-400', badge: 'bg-yellow-900/40 border-yellow-700/50', keyword: 'Your slippage is quite low and may cause failed transactions in highly volatile markets.', val: slippageValues.split(',')[0]?.trim() ?? '0.05' },
              { label: '高滑点', color: 'text-orange-400', badge: 'bg-orange-900/40 border-orange-700/50', keyword: 'Your slippage setting might be high. Consider adjusting it to reduce front-running risks.', val: slippageValues.split(',')[1]?.trim() ?? '2.5' },
              { label: '超上限', color: 'text-red-400',    badge: 'bg-red-900/40 border-red-700/50',       keyword: 'Enter a valid slippage percentage. Max is 19.99%', val: slippageValues.split(',')[2]?.trim() ?? '20' },
            ].map(({ label, color, badge, keyword, val }) => (
              <div key={label} className={`flex items-start gap-2 rounded border ${badge} px-2.5 py-1.5 text-[11px]`}>
                <span className={`shrink-0 font-semibold ${color}`}>{val}%</span>
                <span className="text-slate-500 shrink-0">[{label}]</span>
                <span className="text-slate-400 italic">&ldquo;{keyword}&rdquo;</span>
              </div>
            ))}
          </div>
        </div>

        {/* Status + action */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            {slippageRunState.status !== 'idle' && (
              <span className={`text-xs font-medium ${
                slippageRunState.status === 'running' ? 'text-yellow-400' :
                slippageRunState.status === 'completed' ? 'text-green-400' : 'text-red-400'
              }`}>
                {slippageRunState.status === 'running' ? '⏳ 测试运行中...' :
                 slippageRunState.status === 'completed' ? '✓ 测试完成' : '✗ 测试失败'}
              </span>
            )}
            {slippageRunState.duration != null && slippageRunState.status !== 'running' && (
              <span className="text-xs text-slate-500">({(slippageRunState.duration / 1000).toFixed(1)}s)</span>
            )}
          </div>
          {(slippageRunState.status === 'completed' || slippageRunState.status === 'failed') && slippageRunState.output && (
            <button onClick={() => setSlippageShowOutput(true)}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors">
              查看日志
            </button>
          )}
          <button onClick={handleSlippageRun} disabled={slippageRunState.status === 'running'}
            className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
              slippageRunState.status === 'running'
                ? 'cursor-not-allowed bg-slate-700 text-slate-500'
                : 'bg-orange-600 text-white hover:bg-orange-500'
            }`}>
            {slippageRunState.status === 'running' ? '⏳ 运行中...' : '▶ 运行测试 (3 个滑点值)'}
          </button>
        </div>

        {slippageRunState.errorMsg && <p className="mt-2 text-xs text-red-400">{slippageRunState.errorMsg}</p>}

        {/* Per-value result cards */}
        {slippageResults.length > 0 && (
          <div className="mt-4 space-y-2">
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">各滑点值验证结果</div>
            {slippageResults.map((r) => (
              <div key={r.value} className={`rounded-lg border px-3 py-2.5 text-xs ${
                r.error    ? 'border-slate-600 bg-slate-800/40' :
                r.matched  ? 'border-green-700/60 bg-green-900/15' :
                             'border-red-700/60 bg-red-900/15'
              }`}>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className={`font-bold text-sm font-mono ${
                      r.label === 'low' ? 'text-yellow-300' :
                      r.label === 'high' ? 'text-orange-300' : 'text-red-300'
                    }`}>{r.value}%</span>
                    <span className="text-slate-500 text-[10px]">
                      {r.label === 'low' ? '[低滑点]' : r.label === 'high' ? '[高滑点]' : '[超上限]'}
                    </span>
                  </div>
                  <span className="text-base">
                    {r.error ? '⚠️' : r.matched ? '✅' : '❌'}
                  </span>
                </div>
                <div className="space-y-1">
                  <div className="flex gap-1.5">
                    <span className="text-slate-500 shrink-0">实际文案:</span>
                    <span className={`${r.matched ? 'text-green-300' : r.error ? 'text-slate-500' : 'text-red-300'} break-all`}>
                      {r.error ? `错误: ${r.error}` : r.warningText || '（未读取到文案）'}
                    </span>
                  </div>
                  {r.label === 'over' && r.confirmDisabled !== undefined && (
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 shrink-0">Confirm 禁用:</span>
                      <span className={r.confirmDisabled ? 'text-green-300' : 'text-red-300'}>
                        {r.confirmDisabled ? '✅ 是（符合预期）' : '❌ 否（按钮未被禁用）'}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {/* Summary */}
            {slippageRunState.status !== 'running' && (
              <div className={`rounded-lg border px-3 py-2 text-xs mt-1 ${
                slippageResults.every(r => r.matched)
                  ? 'border-green-700/60 bg-green-950/20 text-green-300'
                  : 'border-red-700/60 bg-red-950/20 text-red-300'
              }`}>
                {slippageResults.every(r => r.matched)
                  ? `✅ 全部 ${slippageResults.length} 个滑点值的提示文案验证通过`
                  : `❌ ${slippageResults.filter(r => !r.matched).length}/${slippageResults.length} 个文案未能匹配`}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Output modal — Slippage */}
      {slippageShowOutput && slippageRunState.output && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setSlippageShowOutput(false)}>
          <div className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">滑点测试输出</h3>
              <button onClick={() => setSlippageShowOutput(false)} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
            </div>
            <pre className="overflow-y-auto p-4 text-xs text-green-400 font-mono max-h-[65vh] whitespace-pre-wrap">
              {slippageRunState.output.join('')}
            </pre>
          </div>
        </div>
      )}

      {/* ── Gas 不足提示验证卡片（Swap 模块用例 4）────────────────────────── */}
      <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/60 p-5">
        <div className="flex items-start gap-3 mb-4">
          <span className="rounded bg-yellow-600 px-1.5 py-0.5 text-xs font-bold text-white shrink-0">P1</span>
          <div>
            <h3 className="font-semibold text-white">Gas 不足提示验证</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              输入超出余额的 BNB 数量，验证页面显示 &ldquo;Must have 0.00005 BNB or more left in wallet for gas fee.&rdquo;
            </p>
          </div>
        </div>

        {/* Config: balance query + amount input */}
        <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/50 p-3 space-y-3">
          {/* BNB Balance */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">当前 BNB 余额</p>
              <span className={`text-sm font-mono font-bold ${gasBalance ? 'text-orange-300' : 'text-slate-500'}`}>
                {gasBalance ? `${gasBalance} BNB` : '— 未查询'}
              </span>
              {gasBalance && <span className="ml-2 text-[10px] text-slate-500">（已自动填入下方输入框）</span>}
            </div>
            <button onClick={handleQueryBalance} disabled={gasBalanceLoading || gasRunState.status === 'running'}
              className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 transition disabled:opacity-50 shrink-0">
              {gasBalanceLoading ? '查询中...' : '查询余额'}
            </button>
          </div>

          {/* You Pay Amount */}
          <div>
            <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
              You Pay 金额（留空则自动使用全部余额）
            </label>
            <input
              type="text"
              value={gasTestAmount}
              onChange={(e) => setGasTestAmount(e.target.value)}
              disabled={gasRunState.status === 'running'}
              placeholder={gasBalance ? `如 ${gasBalance}（全部余额）` : '例如: 0.021021'}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-orange-500 transition disabled:opacity-50 font-mono"
            />
            <p className="mt-0.5 text-[10px] text-slate-500">
              填入等于或接近全部余额的值，使 BNB 不足以支付 gas（0.00005 BNB），从而触发警告
            </p>
          </div>

          {/* Expected warning preview */}
          <div className="rounded border border-orange-700/40 bg-orange-900/15 px-2.5 py-2 text-[11px]">
            <span className="text-slate-500 shrink-0">期望文案：</span>
            <span className="text-orange-300 italic">&ldquo;Must have 0.00005 BNB or more left in wallet for gas fee.&rdquo;</span>
          </div>
        </div>

        {/* Status + action */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            {gasRunState.status !== 'idle' && (
              <span className={`text-xs font-medium ${gasRunState.status === 'running' ? 'text-yellow-400' : gasRunState.status === 'completed' ? 'text-green-400' : 'text-red-400'}`}>
                {gasRunState.status === 'running' ? '⏳ 测试运行中...' : gasRunState.status === 'completed' ? '✓ 测试完成' : '✗ 测试失败'}
              </span>
            )}
            {gasRunState.duration != null && gasRunState.status !== 'running' && (
              <span className="text-xs text-slate-500">({(gasRunState.duration / 1000).toFixed(1)}s)</span>
            )}
          </div>
          {(gasRunState.status === 'completed' || gasRunState.status === 'failed') && gasRunState.output && (
            <button onClick={() => setGasShowOutput(true)}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors">
              查看日志
            </button>
          )}
          {!gasTestAmount.trim() && gasRunState.status === 'idle' && (
            <p className="text-xs text-amber-400">请在 You Pay 中输入金额后再运行测试</p>
          )}
          <button onClick={handleGasRun} disabled={gasRunState.status === 'running' || !gasTestAmount.trim()}
            className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
              gasRunState.status === 'running' || !gasTestAmount.trim() ? 'cursor-not-allowed bg-slate-700 text-slate-500' : 'bg-orange-600 text-white hover:bg-orange-500'
            }`}>
            {gasRunState.status === 'running' ? '⏳ 运行中...' : !gasTestAmount.trim() ? '请先输入 You Pay 金额' : '▶ 运行测试'}
          </button>
        </div>

        {gasRunState.errorMsg && <p className="mt-2 text-xs text-red-400">{gasRunState.errorMsg}</p>}

        {/* Result card */}
        {gasResult && (
          <div className={`mt-4 rounded-lg border px-3 py-3 text-xs ${
            gasResult.matched ? 'border-green-700/60 bg-green-900/15' : 'border-red-700/60 bg-red-900/15'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-slate-200">测试结果</span>
              <span className="text-base">{gasResult.matched ? '✅' : '❌'}</span>
            </div>
            <div className="space-y-1.5">
              <div className="flex gap-1.5">
                <span className="text-slate-500 shrink-0">输入金额:</span>
                <span className="font-mono text-slate-300">{gasResult.amount} BNB</span>
              </div>
              <div className="flex gap-1.5">
                <span className="text-slate-500 shrink-0">实际文案:</span>
                <span className={`break-all ${gasResult.matched ? 'text-green-300' : gasResult.error ? 'text-slate-500' : 'text-red-300'}`}>
                  {gasResult.error ? `错误: ${gasResult.error}` : gasResult.warningText || '（未读取到文案）'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Output modal — Gas */}
      {gasShowOutput && gasRunState.output && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setGasShowOutput(false)}>
          <div className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">Gas 不足测试输出</h3>
              <button onClick={() => setGasShowOutput(false)} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
            </div>
            <pre className="overflow-y-auto p-4 text-xs text-green-400 font-mono max-h-[65vh] whitespace-pre-wrap">
              {gasRunState.output.join('')}
            </pre>
          </div>
        </div>
      )}

      {/* ── Limit Order ─────────────────────────────────────────── */}
      <div className="mt-8">
        {/* Module header */}
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-slate-600 bg-slate-800 px-5 py-3">
          <span className="text-2xl">📋</span>
          <div>
            <h2 className="text-lg font-bold text-white">Limit 限价单</h2>
            <p className="text-xs text-slate-400">限价单核心功能自动化测试 · 挂单创建、验证与状态检查</p>
          </div>
        </div>

        {/* Test card */}
        <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
          <div className="flex items-start gap-3 mb-4">
            <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white shrink-0">P0</span>
            <div>
              <h3 className="font-semibold text-white">Limit 挂单</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                以 +5% 溢价率挂 BNB→USDT 限价单，完成 MetaMask 签名后验证 Open Orders 出现新挂单
              </p>
            </div>
          </div>

          {/* Parameters */}
          <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/50 p-3">
            <h4 className="text-xs font-semibold text-slate-300 mb-3">测试参数配置</h4>
            <div className="max-w-xs">
              <label className="mb-1 block text-xs font-medium text-slate-400">
                You Pay 金额（USD）
              </label>
              <input
                type="number"
                value={limitMinUsd}
                min="5"
                step="0.5"
                onChange={(e) => setLimitMinUsd(e.target.value)}
                onBlur={(e) => {
                  const v = parseFloat(e.target.value);
                  if (isNaN(v) || v < 5) setLimitMinUsd('5');
                }}
                className={`w-full rounded-lg border bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-orange-500 transition ${parseFloat(limitMinUsd) < 5 ? 'border-red-500' : 'border-slate-600'}`}
              />
              <p className="mt-1 text-[10px] text-slate-500">
                系统通过链上查询 BNB/USD 价格自动换算出 You Pay 数量，输入金额必须 ≥ $5
              </p>
              {limitBnbLoading && (
                <p className="mt-1 text-[10px] text-yellow-400">正在查询 BNB 价格...</p>
              )}
              {limitBnbPrice && !limitBnbLoading && (
                <p className="mt-1 text-[10px] text-green-400">
                  BNB 当前价格：${limitBnbPrice} · You Pay = {(Math.ceil(parseFloat(limitMinUsd) * 1.1 / parseFloat(limitBnbPrice) * 1_000_000) / 1_000_000).toFixed(6)} BNB
                </p>
              )}
            </div>
          </div>

          {/* Status + Run button */}
          <div className="mb-3 flex items-center justify-between">
            <span className={`text-sm font-medium ${{
              idle: 'text-slate-400',
              running: 'text-yellow-400',
              completed: 'text-green-400',
              failed: 'text-red-400',
            }[limitRunState.status]}`}>
              {{
                idle: '',
                running: '⏳ 测试运行中... (最多 6 分钟)',
                completed: '✓ 测试通过',
                failed: '✗ 测试失败',
              }[limitRunState.status]}
            </span>
            {limitRunState.runId && limitRunState.output && (
              <button
                onClick={() => setLimitShowOutput(true)}
                className="text-xs text-slate-400 hover:text-orange-400 underline"
              >查看日志</button>
            )}
          </div>

          {limitRunState.errorMsg && <p className="mb-3 text-xs text-red-400">{limitRunState.errorMsg}</p>}

          <button
            onClick={handleLimitRun}
            disabled={limitRunState.status === 'running'}
            className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
              limitRunState.status === 'running'
                ? 'cursor-not-allowed bg-slate-700 text-slate-500'
                : 'bg-orange-600 text-white hover:bg-orange-500'
            }`}
          >
            {limitRunState.status === 'running' ? '⏳ 运行中...' : '▶ 运行 Limit 挂单测试'}
          </button>

          {/* Result card */}
          {limitResult && (
            <div className={`mt-4 rounded-lg border px-3 py-3 text-xs ${
              limitResult.passed ? 'border-green-700/60 bg-green-900/15' : 'border-red-700/60 bg-red-900/15'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-slate-200">测试结果</span>
                <span className="text-base">{limitResult.passed ? '✅' : '❌'}</span>
              </div>
              <div className="space-y-1.5">
                {limitResult.error ? (
                  <div className="flex gap-1.5">
                    <span className="text-slate-500 shrink-0">错误:</span>
                    <span className="text-red-300 break-all">{limitResult.error}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 shrink-0">BNB 数量:</span>
                      <span className="font-mono text-slate-300">{limitResult.payAmount} BNB</span>
                    </div>
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 shrink-0">USD 价值:</span>
                      <span className="font-mono text-slate-300">${limitResult.usdValue}</span>
                    </div>
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 shrink-0">BNB 价格:</span>
                      <span className="font-mono text-slate-300">{limitResult.bnbPrice} USDT</span>
                    </div>
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 shrink-0">Open Orders:</span>
                      <span className={limitResult.passed ? 'text-green-300' : 'text-red-300'}>
                        {limitResult.passed ? '✓ 挂单已出现在 Open Orders' : '✗ Open Orders 中未找到挂单'}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Output modal — Limit */}
      {limitShowOutput && limitRunState.output && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setLimitShowOutput(false)}>
          <div className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">Limit 挂单测试输出</h3>
              <button onClick={() => setLimitShowOutput(false)} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
            </div>
            <pre className="overflow-y-auto p-4 text-xs text-green-400 font-mono max-h-[65vh] whitespace-pre-wrap">
              {limitRunState.output.join('')}
            </pre>
          </div>
        </div>
      )}

      {/* ── Price Guard 测试卡片 ─────────────────────────────────── */}
      <div className="mt-6">
        <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
          <div className="flex items-start gap-3 mb-4">
            <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white shrink-0">P0</span>
            <div>
              <h3 className="font-semibold text-white">不合理价格限制</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                输入市价 × {(parseFloat(pgPriceRatio || '0.949') * 100).toFixed(1)}% 触发价格保护，验证按钮置灰且显示 &quot;Adjust price to continue&quot;
              </p>
            </div>
          </div>

          {/* Parameters */}
          <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/50 p-3">
            <h4 className="text-xs font-semibold text-slate-300 mb-3">测试参数配置</h4>
            <div className="grid grid-cols-2 gap-3 max-w-sm">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">You Pay 金额（USD）</label>
                <input
                  type="number"
                  value={pgMinUsd}
                  min="5"
                  step="0.5"
                  onChange={(e) => setPgMinUsd(e.target.value)}
                  onBlur={(e) => { const v = parseFloat(e.target.value); if (isNaN(v) || v < 5) setPgMinUsd('5'); }}
                  className={`w-full rounded-lg border bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-orange-500 transition ${parseFloat(pgMinUsd) < 5 ? 'border-red-500' : 'border-slate-600'}`}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">价格比例（触发阈值）</label>
                <input
                  type="number"
                  value={pgPriceRatio}
                  min="0.01"
                  max="0.999"
                  step="0.001"
                  onChange={(e) => setPgPriceRatio(e.target.value)}
                  onBlur={(e) => { const v = parseFloat(e.target.value); if (isNaN(v) || v <= 0 || v >= 1) setPgPriceRatio('0.949'); }}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-orange-500 transition"
                />
              </div>
            </div>
            <p className="mt-2 text-[10px] text-slate-500">
              比例 0.949 = 市场价 × 94.9%，低于市场价 5.1%，足以触发价格保护（阈值 −5%）
            </p>
            {pgBnbLoading && <p className="mt-1 text-[10px] text-yellow-400">正在查询 BNB 价格...</p>}
            {pgBnbPrice && !pgBnbLoading && (
              <p className="mt-1 text-[10px] text-green-400">
                BNB 当前价格：${pgBnbPrice} · 触发价格 ≈ {(parseFloat(pgBnbPrice) * parseFloat(pgPriceRatio || '0.949')).toFixed(2)} USDT
              </p>
            )}
          </div>

          {/* Status + Run button */}
          <div className="mb-3 flex items-center justify-between">
            <span className={`text-sm font-medium ${{
              idle: 'text-slate-400',
              running: 'text-yellow-400',
              completed: 'text-green-400',
              failed: 'text-red-400',
            }[pgRunState.status]}`}>
              {{
                idle: '',
                running: '⏳ 测试运行中... (最多 2 分钟)',
                completed: '✓ 测试通过',
                failed: '✗ 测试失败',
              }[pgRunState.status]}
            </span>
            {pgRunState.runId && pgRunState.output && (
              <button onClick={() => setPgShowOutput(true)} className="text-xs text-slate-400 hover:text-orange-400 underline">查看日志</button>
            )}
          </div>

          {pgRunState.errorMsg && <p className="mb-3 text-xs text-red-400">{pgRunState.errorMsg}</p>}

          <button
            onClick={handlePgRun}
            disabled={pgRunState.status === 'running'}
            className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
              pgRunState.status === 'running'
                ? 'cursor-not-allowed bg-slate-700 text-slate-500'
                : 'bg-orange-600 text-white hover:bg-orange-500'
            }`}
          >
            {pgRunState.status === 'running' ? '⏳ 运行中...' : '▶ 运行 Price Guard 测试'}
          </button>

          {/* Result card */}
          {pgResult && (
            <div className={`mt-4 rounded-lg border px-3 py-3 text-xs ${
              pgResult.passed ? 'border-green-700/60 bg-green-900/15' : 'border-red-700/60 bg-red-900/15'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-slate-200">测试结果</span>
                <span className="text-base">{pgResult.passed ? '✅' : '❌'}</span>
              </div>
              <div className="space-y-1.5">
                {pgResult.error ? (
                  <div className="flex gap-1.5">
                    <span className="text-slate-500 shrink-0">错误:</span>
                    <span className="text-red-300 break-all">{pgResult.error}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 shrink-0">市场价格:</span>
                      <span className="font-mono text-slate-300">{pgResult.marketPrice} USDT</span>
                    </div>
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 shrink-0">触发价格:</span>
                      <span className="font-mono text-slate-300">{pgResult.triggerPrice} USDT</span>
                    </div>
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 shrink-0">按钮置灰:</span>
                      <span className={pgResult.isDisabled ? 'text-green-300' : 'text-red-300'}>
                        {pgResult.isDisabled ? '✓ 已置灰' : '✗ 未置灰'}
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 shrink-0">提示文案:</span>
                      <span className={pgResult.textMatches ? 'text-green-300' : 'text-red-300'}>
                        {pgResult.textMatches ? '✓ "Adjust price to continue"' : '✗ 文案不匹配'}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Output modal — Price Guard */}
      {pgShowOutput && pgRunState.output && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setPgShowOutput(false)}>
          <div className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">Price Guard 测试输出</h3>
              <button onClick={() => setPgShowOutput(false)} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
            </div>
            <pre className="overflow-y-auto p-4 text-xs text-green-400 font-mono max-h-[65vh] whitespace-pre-wrap">
              {pgRunState.output.join('')}
            </pre>
          </div>
        </div>
      )}

      {/* ── Price Direction 测试卡片 ─────────────────────────────── */}
      <div className="mt-6">
        <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
          <div className="flex items-start gap-3 mb-4">
            <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white shrink-0">P0</span>
            <div>
              <h3 className="font-semibold text-white">价格方向自动判定</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                输入 50% 市价验证提示 &quot;below&quot;（红色），输入 150% 市价验证提示 &quot;above&quot;（绿色）
              </p>
            </div>
          </div>

          {/* Parameters */}
          <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/50 p-3">
            <h4 className="text-xs font-semibold text-slate-300 mb-3">测试参数配置</h4>
            <div className="max-w-xs">
              <label className="mb-1 block text-xs font-medium text-slate-400">You Pay 金额（USD，最小 5）</label>
              <input
                type="number"
                value={pdMinUsd}
                min="5"
                step="0.5"
                onChange={(e) => setPdMinUsd(e.target.value)}
                onBlur={(e) => { const v = parseFloat(e.target.value); if (isNaN(v) || v < 5) setPdMinUsd('5'); }}
                className={`w-full rounded-lg border bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-orange-500 transition ${parseFloat(pdMinUsd) < 5 ? 'border-red-500' : 'border-slate-600'}`}
              />
            </div>
            {pdBnbLoading && <p className="mt-2 text-[10px] text-yellow-400">正在查询 BNB 价格...</p>}
            {pdBnbPrice && !pdBnbLoading && (
              <p className="mt-2 text-[10px] text-green-400">
                BNB 当前价格：${pdBnbPrice} · 50% = {(parseFloat(pdBnbPrice) * 0.5).toFixed(2)} USDT · 150% = {(parseFloat(pdBnbPrice) * 1.5).toFixed(2)} USDT
              </p>
            )}
          </div>

          {/* Status + Run button */}
          <div className="mb-3 flex items-center justify-between">
            <span className={`text-sm font-medium ${{
              idle: 'text-slate-400',
              running: 'text-yellow-400',
              completed: 'text-green-400',
              failed: 'text-red-400',
            }[pdRunState.status]}`}>
              {{
                idle: '',
                running: '⏳ 测试运行中... (最多 3 分钟)',
                completed: '✓ 测试通过',
                failed: '✗ 测试失败',
              }[pdRunState.status]}
            </span>
            {pdRunState.runId && pdRunState.output && (
              <button onClick={() => setPdShowOutput(true)} className="text-xs text-slate-400 hover:text-orange-400 underline">查看日志</button>
            )}
          </div>

          {pdRunState.errorMsg && <p className="mb-3 text-xs text-red-400">{pdRunState.errorMsg}</p>}

          <button
            onClick={handlePdRun}
            disabled={pdRunState.status === 'running'}
            className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
              pdRunState.status === 'running'
                ? 'cursor-not-allowed bg-slate-700 text-slate-500'
                : 'bg-orange-600 text-white hover:bg-orange-500'
            }`}
          >
            {pdRunState.status === 'running' ? '⏳ 运行中...' : '▶ 运行 价格方向判定 测试'}
          </button>

          {/* Result card */}
          {pdResult && (
            <div className="mt-4 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-3 text-xs">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-slate-200">测试结果</span>
                <span className="text-base">{pdResult.passed ? '✅' : '❌'}</span>
              </div>
              <div className="space-y-1.5">
                {pdResult.error ? (
                  <div className="flex gap-1.5">
                    <span className="text-slate-500 shrink-0">错误:</span>
                    <span className="text-red-300 break-all">{pdResult.error}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 shrink-0">BNB 市场价:</span>
                      <span className="font-mono text-slate-300">{pdResult.marketPrice} USDT</span>
                    </div>
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 shrink-0">50% 市价场景:</span>
                      <span className={pdResult.belowPassed ? 'text-green-300' : 'text-red-300'}>
                        {pdResult.belowPassed ? '✓ 颜色为红色（低于市价）' : '✗ 未检测到红色'}
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      <span className="text-slate-500 shrink-0">150% 市价场景:</span>
                      <span className={pdResult.abovePassed ? 'text-green-300' : 'text-red-300'}>
                        {pdResult.abovePassed ? '✓ 颜色为绿色（高于市价）' : '✗ 未检测到绿色'}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Output modal — Price Direction */}
      {pdShowOutput && pdRunState.output && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setPdShowOutput(false)}>
          <div className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">价格方向判定测试输出</h3>
              <button onClick={() => setPdShowOutput(false)} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
            </div>
            <pre className="overflow-y-auto p-4 text-xs text-green-400 font-mono max-h-[65vh] whitespace-pre-wrap">
              {pdRunState.output.join('')}
            </pre>
          </div>
        </div>
      )}

      {/* ── Price Mode Linkage 测试卡片 ──────────────────────────── */}
      <div className="mt-6">
        <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
          <div className="flex items-start gap-3 mb-4">
            <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white shrink-0">P0</span>
            <div>
              <h3 className="font-semibold text-white">价格模式联动</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                +5%/+10% 验证 rate 换算；输入 rate=100/200 验证百分比反算
              </p>
            </div>
          </div>

          {/* Parameters */}
          <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/50 p-3">
            <h4 className="text-xs font-semibold text-slate-300 mb-2">测试参数</h4>
            <div className="max-w-xs">
              <label className="mb-1 block text-xs font-medium text-slate-400">You Pay 金额（USD，最小 5）</label>
              <input type="number" value={pmMinUsd} min="5" step="0.5"
                onChange={(e) => setPmMinUsd(e.target.value)}
                onBlur={(e) => { const v = parseFloat(e.target.value); if (isNaN(v) || v < 5) setPmMinUsd('5'); }}
                className={`w-full rounded-lg border bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-orange-500 transition ${parseFloat(pmMinUsd) < 5 ? 'border-red-500' : 'border-slate-600'}`}
              />
            </div>
            {pmBnbLoading && <p className="mt-2 text-[10px] text-yellow-400">正在查询 BNB 价格...</p>}
            {pmBnbPrice && !pmBnbLoading && (
              <p className="mt-2 text-[10px] text-green-400">
                BNB 当前价格：${pmBnbPrice} · +5%≈{(parseFloat(pmBnbPrice)*1.05).toFixed(2)} · +10%≈{(parseFloat(pmBnbPrice)*1.10).toFixed(2)} USDT
              </p>
            )}
          </div>

          {/* Status */}
          <div className="mb-3 flex items-center justify-between">
            <span className={`text-sm font-medium ${{ idle:'text-slate-400', running:'text-yellow-400', completed:'text-green-400', failed:'text-red-400' }[pmRunState.status]}`}>
              {{ idle:'', running:'⏳ 测试运行中... (最多 3 分钟)', completed:'✓ 测试通过', failed:'✗ 测试失败' }[pmRunState.status]}
            </span>
            {pmRunState.runId && pmRunState.output && (
              <button onClick={() => setPmShowOutput(true)} className="text-xs text-slate-400 hover:text-orange-400 underline">查看日志</button>
            )}
          </div>

          {pmRunState.errorMsg && <p className="mb-3 text-xs text-red-400">{pmRunState.errorMsg}</p>}

          <button onClick={handlePmRun} disabled={pmRunState.status === 'running'}
            className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${pmRunState.status === 'running' ? 'cursor-not-allowed bg-slate-700 text-slate-500' : 'bg-orange-600 text-white hover:bg-orange-500'}`}>
            {pmRunState.status === 'running' ? '⏳ 运行中...' : '▶ 运行 价格模式联动 测试'}
          </button>

          {pmResult && (
            <div className="mt-4 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-3 text-xs">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-slate-200">测试结果</span>
                <span className="text-base">{pmResult.passed ? '✅' : '❌'}</span>
              </div>
              <div className="space-y-1.5">
                {pmResult.market && <p className="text-slate-400">BNB 市价：{pmResult.market} USDT</p>}
                <div className="grid grid-cols-2 gap-1 mt-1">
                  {(['sc1','sc2','sc3','sc4'] as const).map((k, i) => (
                    <div key={k} className="flex items-center gap-1.5">
                      <span className={pmResult[k] ? 'text-green-400' : 'text-red-400'}>{pmResult[k] ? '✓' : '✗'}</span>
                      <span className="text-slate-300 text-[11px]">{['场景1: +5%→rate','场景2: +10%→rate','场景3: rate=100→%','场景4: rate=200→%'][i]}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {pmShowOutput && pmRunState.output && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setPmShowOutput(false)}>
          <div className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">价格模式联动测试输出</h3>
              <button onClick={() => setPmShowOutput(false)} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
            </div>
            <pre className="overflow-y-auto p-4 text-xs text-green-400 font-mono max-h-[65vh] whitespace-pre-wrap">{pmRunState.output.join('')}</pre>
          </div>
        </div>
      )}

      <div className="mt-8">
        {/* Module header */}
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-slate-600 bg-slate-800 px-5 py-3">
          <span className="text-2xl">📊</span>
          <div>
            <h2 className="text-lg font-bold text-white">Terminal</h2>
            <p className="text-xs text-slate-400">
              1 个测试用例 · 通过 {termUseTokenlist ? 'tokenlist API 获取代币列表' : `coin_list API 获取 <span className="text-orange-400">${termTag}</span> 标签下代币`}
              {termBatchSize > 0 && termTotalTokens > 0
                ? ` · 总共 ${termTotalTokens} 个代币 · 批次 ${termBatchIndex + 1}/${termTotalBatches} (测试 ${termBatchIndex * termBatchSize + 1}-${Math.min((termBatchIndex + 1) * termBatchSize, termTotalTokens)})`
                : ` · 前 ${termTokenCount} 个`
              } · 逐一执行 {termPayAmount} BNB Swap 并验证路由
            </p>
          </div>
        </div>

        {/* Test card */}
        <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
          <div className="flex items-start gap-3 mb-4">
            <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white shrink-0">P0</span>
            <div>
              <h3 className="font-semibold text-white">Top Token Swap 验证</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {termUseTokenlist 
                  ? `通过 tokenlist API 获取前 ${termTokenCount} 个代币（含合约地址）`
                  : `通过 coin_list API 获取 <span className="text-orange-400">${termTag}</span> 标签下前 ${termTokenCount} 个代币（含合约地址）`
                }，直接导航到各代币 swap 页面，逐一执行 {termPayAmount} BNB Swap。
                USD 价值差距超过 {(termUsdRatio * 100).toFixed(0)}% 则跳过，验证路由真实可用性
              </p>
            </div>
          </div>

          {/* ── Config panel ─────────────────────────────────────────── */}
          <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/50 p-3 space-y-3">
            {/* Row 0: data source */}
            <div>
              <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                数据源 (Data Source)
              </label>
              <select
                value={termUseTokenlist ? 'tokenlist' : 'coin_list'}
                onChange={(e) => setTermUseTokenlist(e.target.value === 'tokenlist')}
                disabled={terminalRun.status === 'running'}
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500 transition disabled:opacity-50"
              >
                <option value="coin_list">coin_list (trending/new/gainer-loser)</option>
                <option value="tokenlist">tokenlist (全代币列表)</option>
              </select>
              <p className="mt-0.5 text-[10px] text-slate-500">
                {termUseTokenlist ? '从 tokenlist API 获取代币列表' : '从 coin_list API 根据标签获取代币'}
              </p>
            </div>

            {/* Row 1: tag + date_type (仅 coin_list 模式且 gainer-loser 有效) */}
            {!termUseTokenlist && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                    代币分类 (Tag)
                  </label>
                  <select
                    value={termTag}
                    onChange={(e) => setTermTag(e.target.value)}
                    disabled={terminalRun.status === 'running'}
                    className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500 transition disabled:opacity-50"
                  >
                    {PEACH_TERMINAL_TAGS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <p className="mt-0.5 text-[10px] text-slate-500">new · trending · gainer-loser</p>
                </div>
                <div>
                  <label className={`mb-1 block text-[10px] font-semibold uppercase tracking-wide ${termTag === 'gainer-loser' ? 'text-slate-400' : 'text-slate-600'}`}>
                    时间窗口 (date_type)
                  </label>
                  <select
                    value={termDateType}
                    onChange={(e) => setTermDateType(e.target.value)}
                    disabled={terminalRun.status === 'running' || termTag !== 'gainer-loser'}
                    className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500 transition disabled:opacity-50"
                  >
                    {PEACH_TERMINAL_DATE_TYPES.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                  <p className="mt-0.5 text-[10px] text-slate-500">
                    {termTag === 'gainer-loser' ? <span className="text-slate-300">{termDateType} 涨跌榜</span> : '仅 gainer-loser 生效'}
                  </p>
                </div>
              </div>
            )}
            {/* Row 2: 代币数量 + 支付金额 + USD阈值 */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                  代币池大小
                </label>
                {termFetchAll || termBatchSize > 0 ? (
                  <div className="flex h-[34px] items-center rounded-lg border border-orange-600/50 bg-orange-950/20 px-2 text-xs text-orange-400 font-semibold">
                    全部
                  </div>
                ) : (
                  <input
                    type="number"
                    min={1} max={500}
                    value={termTokenCount}
                    onChange={(e) => setTermTokenCount(parseInt(e.target.value) || 20)}
                    disabled={terminalRun.status === 'running'}
                    className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500 transition disabled:opacity-50"
                  />
                )}
                <p className="mt-0.5 text-[10px] text-slate-500">
                  {termBatchSize > 0
                    ? <span className="text-orange-400">批次模式：获取全部代币</span>
                    : termFetchAll 
                      ? '获取所有可用代币' 
                      : <>默认 20 · 当前: <span className="text-slate-300">{termTokenCount}</span></>
                  }
                </p>
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                  支付金额 (BNB)
                </label>
                <input
                  type="text"
                  value={termPayAmount}
                  onChange={(e) => setTermPayAmount(e.target.value)}
                  disabled={terminalRun.status === 'running'}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500 transition disabled:opacity-50"
                />
                <p className="mt-0.5 text-[10px] text-slate-500">默认 0.0001 · 当前: <span className="text-slate-300">{termPayAmount}</span></p>
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                  USD 跳过阈值
                </label>
                <input
                  type="number"
                  min={0} max={1} step={0.05}
                  value={termUsdRatio}
                  onChange={(e) => setTermUsdRatio(parseFloat(e.target.value) || 0.5)}
                  disabled={terminalRun.status === 'running'}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500 transition disabled:opacity-50"
                />
                <p className="mt-0.5 text-[10px] text-slate-500">{'<'} <span className="text-slate-300">{(termUsdRatio * 100).toFixed(0)}%</span> 跳过</p>
              </div>
            </div>

            {/* Custom Token List */}
            <div className={`rounded-lg border px-3 py-2.5 transition-colors ${
              termCustomTokens.trim() ? 'border-cyan-600/60 bg-cyan-950/20' : 'border-slate-700 bg-slate-800/40'
            }`}>
              <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                    自定义代币列表
                  </label>
                  {termCustomTokens.trim() && (
                    <span className="rounded-full bg-cyan-700 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {termCustomTokens.trim().split('\n').filter(l => l.includes(':')).length} 个代币
                    </span>
                  )}
                </div>
                {termCustomTokens.trim() && (
                  <button
                    onClick={() => setTermCustomTokens('')}
                    disabled={terminalRun.status === 'running'}
                    className="text-[10px] text-slate-500 hover:text-red-400 transition disabled:opacity-50"
                  >
                    清除
                  </button>
                )}
              </div>
              <textarea
                rows={4}
                value={termCustomTokens}
                onChange={(e) => setTermCustomTokens(e.target.value)}
                disabled={terminalRun.status === 'running'}
                placeholder={'每行一个，格式: 名称:合约地址\n例如:\nPEPE:0x6982508145454ce325ddbe47a25d4ec3d2311933\nGOT:0x4f5eabce5d81a67a8e01b8d2a3ae3e70b4de2a7d'}
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-xs text-white font-mono outline-none focus:border-cyan-500 transition disabled:opacity-50 resize-none"
              />
              <p className="mt-0.5 text-[10px] text-slate-500">
                {termCustomTokens.trim()
                  ? <span className="text-cyan-400">已启用：将忽略 API 数据源，仅测试此列表中的代币</span>
                  : '填写后将跳过 API 拉取，直接按此列表路由验证'}
              </p>
            </div>

            {/* Batch Configuration */}
            <div className="mt-3 rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2.5">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-xs font-semibold text-slate-300">分批配置</h4>
                <div className="flex items-center gap-2">
                  {termFetchingCount && (
                    <span className="text-[10px] text-orange-400">获取中...</span>
                  )}
                  <button
                    onClick={fetchTokenCount}
                    disabled={terminalRun.status === 'running' || termBatchSize === 0 || termFetchingCount}
                    className="rounded-md bg-orange-600 px-2.5 py-1 text-[10px] font-semibold text-white transition hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    确定
                  </button>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                    批次大小
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={termBatchSize}
                    onChange={(e) => setTermBatchSize(parseInt(e.target.value) || 0)}
                    disabled={terminalRun.status === 'running'}
                    className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500 transition disabled:opacity-50"
                  />
                  <p className="mt-0.5 text-[10px] text-slate-500">
                    {termBatchSize > 0 ? `每批 ${termBatchSize} 个代币` : '0 = 不分批（测试全部）'}
                  </p>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                    批次索引
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={termTotalBatches > 0 ? termTotalBatches - 1 : undefined}
                    value={termBatchIndex}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || 0;
                      const maxIndex = termTotalBatches > 0 ? termTotalBatches - 1 : 999;
                      setTermBatchIndex(Math.min(val, maxIndex));
                    }}
                    disabled={terminalRun.status === 'running' || termBatchSize === 0}
                    className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white outline-none focus:border-orange-500 transition disabled:opacity-50"
                  />
                  <p className="mt-0.5 text-[10px] text-slate-500">
                    {termBatchSize > 0 
                      ? `第 ${termBatchIndex + 1} 批 (${termBatchIndex * termBatchSize + 1}-${Math.min((termBatchIndex + 1) * termBatchSize, termTotalTokens || (termBatchIndex + 1) * termBatchSize)})`
                      : '当前批次索引（从 0 开始）'
                    }
                  </p>
                </div>
              </div>
              
              {/* Show total info when batch size is set */}
              {termBatchSize > 0 && termTotalTokens > 0 && (
                <div className="mt-2 rounded-md bg-slate-900/60 border border-slate-600/50 px-2 py-1.5">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-slate-400">总代币数:</span>
                    <span className="font-semibold text-orange-400">{termTotalTokens}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] mt-0.5">
                    <span className="text-slate-400">总批次数:</span>
                    <span className="font-semibold text-orange-400">{termTotalBatches} 批</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] mt-0.5">
                    <span className="text-slate-400">可选范围:</span>
                    <span className="font-semibold text-slate-300">批次 1-{termTotalBatches}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Fetch All Tokens toggle — Terminal */}
          <div className={`mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors ${
            termFetchAll ? 'border-orange-600/50 bg-orange-950/20' : 'border-slate-700 bg-slate-800/40'
          }`}>
            <div className="flex items-center gap-2 min-w-0">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-semibold text-slate-200">测试全部 Token</span>
                  {termFetchAll
                    ? <span className="rounded-full bg-orange-600 px-1.5 py-0.5 text-[10px] font-bold text-white">全量</span>
                    : <span className="rounded-full bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">按数量</span>}
                </div>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {termFetchAll ? '获取 API 所有可用代币，忽略数量限制' : '开启后忽略代币数量输入，拉取全部代币'}
                </p>
              </div>
            </div>
            <label className="relative shrink-0 cursor-pointer">
              <input
                type="checkbox"
                checked={termFetchAll}
                onChange={(e) => setTermFetchAll(e.target.checked)}
                disabled={terminalRun.status === 'running'}
                className="peer sr-only"
              />
              <div className={`h-5 w-10 rounded-full transition-colors ${termFetchAll ? 'bg-orange-600' : 'bg-slate-600'}`} />
              <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
            </label>
          </div>

          {/* Execute Swap toggle — Terminal */}
          <div className={`mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors ${
            termExecuteSwap ? 'border-red-700/50 bg-red-950/20' : 'border-slate-700 bg-slate-800/40'
          }`}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-base shrink-0">{termExecuteSwap ? '' : ''}</span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-semibold text-slate-200">发送真实交易</span>
                  {termExecuteSwap
                    ? <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">链上交易</span>
                    : <span className="rounded-full bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">模拟</span>}
                </div>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {termExecuteSwap ? '⚠️ 将消耗真实 BNB 和 Gas' : '仅验证报价，不发送链上交易'}
                </p>
              </div>
            </div>
            <label className="relative shrink-0 cursor-pointer">
              <input type="checkbox" checked={termExecuteSwap} onChange={(e) => setTermExecuteSwap(e.target.checked)} disabled={terminalRun.status === 'running'} className="peer sr-only" />
              <div className={`h-5 w-10 rounded-full transition-colors ${termExecuteSwap ? 'bg-red-600' : 'bg-slate-600'}`} />
              <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
            </label>
          </div>

          {/* ── Status + action row ──────────────────────────────────── */}
          {/* ── Status + action ──────────────────────────────────── */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {terminalRun.status !== 'idle' && (
                <span className={`text-xs font-medium ${
                  terminalRun.status === 'running'   ? 'text-yellow-400' :
                  terminalRun.status === 'completed' ? 'text-green-400'  : 'text-red-400'
                }`}>
                  {terminalRun.status === 'running'   ? '⏳ 测试运行中...' :
                   terminalRun.status === 'completed' ? '✓ 测试通过'       : '✗ 测试失败'}
                </span>
              )}
              {terminalRun.duration && terminalRun.status !== 'running' && (
                <span className="text-xs text-slate-500">
                  ({(terminalRun.duration / 1000).toFixed(1)}s)
                </span>
              )}
            </div>
            {(terminalRun.status === 'completed' || terminalRun.status === 'failed') && terminalRun.output && (
              <button
                onClick={() => setTerminalShowOutput(true)}
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors"
              >
                查看日志
              </button>
            )}
            <button
              onClick={handleTerminalRun}
              disabled={terminalRun.status === 'running'}
              className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
                terminalRun.status === 'running'
                  ? 'cursor-not-allowed bg-slate-700 text-slate-500'
                  : 'bg-orange-600 text-white hover:bg-orange-500'
              }`}
            >
              {terminalRun.status === 'running'
                ? '⏳ 运行中...'
                : (() => {
                    let text = `▶ ${termExecuteSwap ? '' : ''} 运行测试 (`;
                    if (termCustomTokens.trim()) {
                      const count = termCustomTokens.trim().split('\n').filter(l => l.includes(':')).length;
                      text += `${count} 个代币`;
                    } else if (termFetchAll) {
                      text += '全部代币';
                    } else if (termBatchSize > 0 && termTotalTokens > 0) {
                      const batchStart = termBatchIndex * termBatchSize + 1;
                      const batchEnd = Math.min((termBatchIndex + 1) * termBatchSize, termTotalTokens);
                      const batchCount = batchEnd - batchStart + 1;
                      text += `${batchCount} 个代币 · 批次 ${termBatchIndex + 1}/${termTotalBatches}`;
                    } else {
                      text += `${termTokenCount} 个代币`;
                    }
                    text += ')';
                    return text;
                  })()
              }
            </button>
          </div>

          {terminalRun.errorMsg && (
            <p className="mt-2 text-xs text-red-400">{terminalRun.errorMsg}</p>
          )}

          {/* ── Token result area ────────────────────────────────────── */}
          {(terminalRun.status !== 'idle' || Object.keys(tokenResults).length > 0) && (
            <div className="mt-4">
              {/* Summary counts */}
              {(() => {
                const vals    = Object.values(tokenResults);
                const total   = vals.length;
                const running = vals.filter(v => v.status === 'running').length;
                const pending = vals.filter(v => v.status === 'pending').length;
                const passed  = vals.filter(v => v.status === 'passed').length;
                const failed  = vals.filter(v => v.status === 'failed').length;
                const skipped = vals.filter(v => v.status === 'skipped').length;
                const errors  = vals.filter(v => v.status === 'error').length;
                const done    = passed + failed + skipped + errors;
                const isRunning = terminalRun.status === 'running';
                return (
                  <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <span className="font-semibold text-slate-400">
                      进度: {done}/{total}
                    </span>
                    {isRunning && done === 0 && (
                      <span className="animate-pulse text-yellow-400">⏳ 收集代币中...</span>
                    )}
                    {running > 0 && <span className="animate-pulse text-yellow-400">⏳ 测试中 {running}</span>}
                    {pending > 0 && <span className="text-slate-500">○ 等待 {pending}</span>}
                    {passed  > 0 && <span className="text-green-400">✅ 通过 {passed}</span>}
                    {failed  > 0 && <span className="text-red-400">❌ 失败 {failed}</span>}
                    {skipped > 0 && <span className="text-slate-400">⏭ 跳过 {skipped}</span>}
                    {errors  > 0 && <span className="text-red-400">❌ 错误 {errors}</span>}
                  </div>
                );
              })()}

              {/* Token cards grid — sorted by rank (descending for bottom-to-top progress) */}
              {Object.keys(tokenResults).length > 0 && (
                <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-5">
                  {Object.entries(tokenResults)
                    .sort(([, a], [, b]) => (b.rank ?? 0) - (a.rank ?? 0))
                    .map(([sym, result]) => (
                    <div
                      key={sym}
                      title={result.reason ?? sym}
                      className={`relative flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition-colors overflow-hidden ${
                        result.status === 'running'  ? 'border-yellow-600/70 bg-yellow-900/20 text-yellow-300' :
                        result.status === 'passed'   ? 'border-green-700/60 bg-green-900/20 text-green-300'  :
                        result.status === 'failed'   ? 'border-red-700/60 bg-red-900/20 text-red-300'        :
                        result.status === 'skipped'  ? 'border-slate-600/60 bg-slate-800/30 text-slate-400'  :
                        result.status === 'error'    ? 'border-red-700/60 bg-red-900/20 text-red-300'        :
                        'border-slate-700/60 bg-slate-800/20 text-slate-500'
                      }`}
                    >
                      {/* Animated shimmer for running token */}
                      {result.status === 'running' && (
                        <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-yellow-400/10 to-transparent" />
                      )}
                      {/* Rank badge */}
                      {result.rank && (
                        <span className="shrink-0 text-[9px] opacity-50 font-mono leading-none">
                          #{result.rank}
                        </span>
                      )}
                      {/* Status icon */}
                      <span className="shrink-0 text-sm leading-none">
                        {result.status === 'running'  ? '⏳' :
                         result.status === 'passed'   ? '✅' :
                         result.status === 'failed'   ? '❌' :
                         result.status === 'skipped'  ? '⏭' :
                         result.status === 'error'    ? '❌' : '○'}
                      </span>
                      <span className="truncate font-mono font-medium">{sym}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── 问题代币汇总（测试完成后展示） ──────────────────────── */}
          {(terminalRun.status === 'completed' || terminalRun.status === 'failed') && (() => {
            const problematic = Object.entries(tokenResults)
              .filter(([, r]) => r.status === 'failed' || r.status === 'error' || r.status === 'skipped')
              .sort(([, a], [, b]) => (b.rank ?? 0) - (a.rank ?? 0));
            if (problematic.length === 0) return null;
            return (
              <div className="mt-4 rounded-lg border border-red-700/40 bg-red-950/20 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs font-bold text-red-400 uppercase tracking-wide">问题代币</span>
                  <span className="rounded-full bg-red-700 px-1.5 py-0.5 text-[10px] font-bold text-white">{problematic.length}</span>
                </div>
                <div className="space-y-1">
                  {problematic.map(([sym, r]) => (
                    <div key={sym} className="text-xs font-mono text-slate-300">
                      <span className="text-red-300 font-semibold">{sym}</span>
                      {' : '}
                      <span className="text-slate-400">{r.address ?? '无地址'}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── Liquidity & Last-Trade Checker ──────────────────────────────── */}
      <div className="mt-8">
        {/* Module header */}
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-slate-600 bg-slate-800 px-5 py-3">
          <span className="text-2xl">💧</span>
          <div>
            <h2 className="text-lg font-bold text-white">流动性 &amp; 交易检查</h2>
            <p className="text-xs text-slate-400">
              输入代币列表，检查 pool 流动性（top pool liqUsd）和最近交易时间是否满足要求
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
          {/* Params row */}
          <div className="mb-4 grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                最小流动性 (USD)
              </label>
              <input
                type="number" min={0}
                value={liqMinLiquidity}
                onChange={(e) => setLiqMinLiquidity(parseFloat(e.target.value) || 0)}
                disabled={liqCheckStatus === 'running'}
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white outline-none focus:border-violet-500 transition disabled:opacity-50"
              />
              <p className="mt-0.5 text-[10px] text-slate-500">
                top pool liqUsd ≥ <span className="text-slate-300">${liqMinLiquidity.toLocaleString()}</span>
              </p>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                最近交易时间 (秒)
              </label>
              <input
                type="number" min={0}
                value={liqMaxLastTradeSecs}
                onChange={(e) => setLiqMaxLastTradeSecs(parseFloat(e.target.value) || 0)}
                disabled={liqCheckStatus === 'running'}
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-white outline-none focus:border-violet-500 transition disabled:opacity-50"
              />
              <p className="mt-0.5 text-[10px] text-slate-500">
                最近交易距今 &lt; <span className="text-slate-300">
                  {liqMaxLastTradeSecs >= 3600 ? `${(liqMaxLastTradeSecs/3600).toFixed(1)}h` : `${liqMaxLastTradeSecs}s`}
                </span>
              </p>
            </div>
          </div>

          {/* Token list input */}
          <div className="mb-4">
            <div className="mb-1 flex items-center justify-between">
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                代币列表
              </label>
              {liqCheckTokens.trim() && (
                <span className="text-[10px] text-slate-500">
                  {liqCheckTokens.trim().split('\n').filter(l => l.includes(':')).length} 个代币
                </span>
              )}
            </div>
            <textarea
              rows={6}
              value={liqCheckTokens}
              onChange={(e) => setLiqCheckTokens(e.target.value)}
              disabled={liqCheckStatus === 'running'}
              placeholder={'每行一个，格式: 名称:合约地址\n例如:\nPEPE:0x6982508145454ce325ddbe47a25d4ec3d2311933\nGOT:0x4f5eabce5d81a67a8e01b8d2a3ae3e70b4de2a7d'}
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-white font-mono outline-none focus:border-violet-500 transition disabled:opacity-50 resize-none"
            />
          </div>

          {/* Action button */}
          <button
            onClick={handleLiqCheck}
            disabled={liqCheckStatus === 'running'}
            className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${
              liqCheckStatus === 'running'
                ? 'cursor-not-allowed bg-slate-700 text-slate-500'
                : 'bg-violet-600 text-white hover:bg-violet-500'
            }`}
          >
            {liqCheckStatus === 'running' ? '⏳ 检查中...' : '▶ 开始检查'}
          </button>

          {/* Results */}
          {liqResults.length > 0 && (
            <div className="mt-5">
              {/* Summary */}
              {(() => {
                const qualified   = liqResults.filter(r => r.status === 'qualified').length;
                const disqualified= liqResults.filter(r => r.status === 'disqualified').length;
                const checking    = liqResults.filter(r => r.status === 'checking' || r.status === 'pending').length;
                const errors      = liqResults.filter(r => r.status === 'error').length;
                return (
                  <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <span className="font-semibold text-slate-400">共 {liqResults.length} 个</span>
                    {checking    > 0 && <span className="animate-pulse text-yellow-400">⏳ 检查中 {checking}</span>}
                    {qualified   > 0 && <span className="text-green-400">✅ 通过 {qualified}</span>}
                    {disqualified> 0 && <span className="text-red-400">❌ 不通过 {disqualified}</span>}
                    {errors      > 0 && <span className="text-orange-400">⚠ 错误 {errors}</span>}
                  </div>
                );
              })()}

              {/* Token result rows */}
              <div className="space-y-2">
                {liqResults.map((r) => (
                  <div
                    key={r.address}
                    className={`rounded-lg border px-3 py-2 text-xs transition-colors ${
                      r.status === 'qualified'    ? 'border-green-700/60 bg-green-900/20' :
                      r.status === 'disqualified' ? 'border-red-700/60 bg-red-900/20'    :
                      r.status === 'error'        ? 'border-orange-700/60 bg-orange-900/20' :
                      r.status === 'checking'     ? 'border-yellow-700/60 bg-yellow-900/10' :
                      'border-slate-700/60 bg-slate-800/20'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm leading-none shrink-0">
                        {r.status === 'qualified'    ? '✅' :
                         r.status === 'disqualified' ? '❌' :
                         r.status === 'error'        ? '⚠️' :
                         r.status === 'checking'     ? '⏳' : '○'}
                      </span>
                      <span className="font-semibold font-mono text-slate-200 shrink-0">{r.sym}</span>
                      <span className="truncate text-slate-500 font-mono text-[10px]">{r.address}</span>
                    </div>
                    {(r.status === 'qualified' || r.status === 'disqualified') && (
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] pl-6">
                        <span className={r.liqOk ? 'text-green-400' : 'text-red-400'}>
                          💧 liqUsd: {r.maxLiqUsd != null ? `$${r.maxLiqUsd.toLocaleString(undefined, {maximumFractionDigits: 0})}` : '—'}
                          {r.liqOk ? ' ✓' : ` ✗ (需 ≥ $${liqMinLiquidity.toLocaleString()})`}
                        </span>
                        <span className={r.tradeOk ? 'text-green-400' : 'text-red-400'}>
                          🕐 距今: {r.lastTradeAgo != null
                            ? r.lastTradeAgo >= 3600 ? `${(r.lastTradeAgo/3600).toFixed(1)}h` : `${r.lastTradeAgo}s`
                            : '无记录'}
                          {r.tradeOk ? ' ✓' : ` ✗ (需 < ${liqMaxLastTradeSecs >= 3600 ? `${(liqMaxLastTradeSecs/3600).toFixed(1)}h` : `${liqMaxLastTradeSecs}s`})`}
                        </span>
                      </div>
                    )}
                    {r.status === 'error' && (
                      <p className="mt-1 pl-6 text-[10px] text-orange-400">{r.errorMsg}</p>
                    )}
                  </div>
                ))}
              </div>

              {/* Failure list — show after all checks done */}
              {liqCheckStatus === 'done' && (() => {
                const failed = liqResults.filter(r => r.status === 'disqualified' || r.status === 'error');
                if (failed.length === 0) return null;
                const text = failed.map(r => `${r.sym}:${r.address}`).join('\n');
                return (
                  <div className="mt-4">
                    <div className="mb-1 flex items-center justify-between">
                      <label className="text-[10px] font-semibold text-red-400 uppercase tracking-wide">
                        失败名单 ({failed.length} 个)
                      </label>
                      <button
                        onClick={() => navigator.clipboard.writeText(text)}
                        className="text-[10px] text-slate-500 hover:text-slate-300 transition"
                      >
                        复制
                      </button>
                    </div>
                    <textarea
                      readOnly
                      rows={Math.min(failed.length, 8)}
                      value={text}
                      className="w-full rounded-lg border border-red-700/40 bg-red-950/20 px-3 py-2 text-xs text-red-300 font-mono outline-none resize-none"
                    />
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Output modal — Terminal */}
      {terminalShowOutput && terminalRun.output && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setTerminalShowOutput(false)}
        >
          <div
            className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">Terminal 测试输出</h3>
              <button
                onClick={() => setTerminalShowOutput(false)}
                className="text-slate-400 hover:text-white text-lg leading-none"
              >×</button>
            </div>
            <pre className="overflow-y-auto p-4 text-xs text-green-400 font-mono max-h-[65vh] whitespace-pre-wrap">
              {terminalRun.output.join('')}
            </pre>
          </div>
        </div>
      )}

      {/* Output modal */}
      {showOutput && runState.output && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setShowOutput(false)}
        >
          <div
            className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">测试输出</h3>
              <button
                onClick={() => setShowOutput(false)}
                className="text-slate-400 hover:text-white text-lg leading-none"
              >
                ×
              </button>
            </div>
            <pre className="overflow-y-auto p-4 text-xs text-green-400 font-mono max-h-[65vh] whitespace-pre-wrap">
              {runState.output.join('')}
            </pre>
          </div>
        </div>
      )}

      {/* Output modal — Route Change */}
      {rcShowOutput && rcRunState.output && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setRcShowOutput(false)}
        >
          <div
            className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">路由变化测试输出</h3>
              <button onClick={() => setRcShowOutput(false)} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
            </div>
            <pre className="overflow-y-auto p-4 text-xs text-green-400 font-mono max-h-[65vh] whitespace-pre-wrap">
              {rcRunState.output.join('')}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}