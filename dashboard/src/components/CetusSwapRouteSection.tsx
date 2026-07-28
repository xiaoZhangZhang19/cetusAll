'use client';

import { useState, useRef, useEffect } from 'react';
import { CETUS_ROUTES } from '@/lib/tests';

// ── Types ──────────────────────────────────────────────────────────────────────

type Status = 'idle' | 'running' | 'completed' | 'failed';
type RouteStatus = 'pending' | 'running' | 'passed' | 'failed';

interface RouteResult {
  status: RouteStatus;
  quote?: string;
  duration?: string;
  error?: string;
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

// ── SUI coin types ─────────────────────────────────────────────────────────────

const SUI_COIN_TYPE   = '0x2::sui::SUI';
const USDC_COIN_TYPE  = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const CETUS_COIN_TYPE = '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS';

const QUICK_PAIRS = [
  { label: 'SUI → USDC',  input: SUI_COIN_TYPE,   output: USDC_COIN_TYPE },
  { label: 'USDC → SUI',  input: USDC_COIN_TYPE,  output: SUI_COIN_TYPE },
  { label: 'SUI → CETUS', input: SUI_COIN_TYPE,   output: CETUS_COIN_TYPE },
] as const;

interface CoinEntry {
  id: string;           // uuid for stable key
  label: string;        // friendly name shown in UI
  coinType: string;     // on-chain coin type string
}

/** Default coin list used when multi-coin mode is first enabled. */
const DEFAULT_COIN_LIST: CoinEntry[] = [
  { id: '1', label: 'SUI',   coinType: SUI_COIN_TYPE },
  { id: '2', label: 'USDC',  coinType: USDC_COIN_TYPE },
  { id: '3', label: 'CETUS', coinType: CETUS_COIN_TYPE },
];

/** Pick two distinct items from an array at random. Returns null if fewer than 2 items. */
function pickTwoRandom<T>(arr: T[]): [T, T] | null {
  if (arr.length < 2) return null;
  const i = Math.floor(Math.random() * arr.length);
  let j = Math.floor(Math.random() * (arr.length - 1));
  if (j >= i) j++;
  return [arr[i], arr[j]];
}

// ── Log parsers (same structure markers as test file) ─────────────────────────

function downloadLog(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parseCombinedPhase(text: string): CombinedPhase | null {
  const routesMatch = /##COMBINED_ROUTES:([^#]+)##/.exec(text);
  if (!routesMatch) return null;
  const routes = routesMatch[1].split(',').map((r) => r.trim());
  if (/##COMBINED_PASSED##/.test(text)) return { status: 'passed', routes };
  const failedMatch = /##COMBINED_FAILED:([^#]*)##/.exec(text);
  if (failedMatch) return { status: 'failed', routes, error: failedMatch[1].trim() };
  if (/##COMBINED_RUNNING##/.test(text)) return { status: 'running', routes };
  return { status: 'pending', routes };
}

function parseRouteResults(text: string): Record<string, RouteResult> {
  const results: Record<string, RouteResult> = {};
  let m: RegExpExecArray | null;

  // Route started
  const reStarted = /Testing route:\s*(.+)/g;
  while ((m = reStarted.exec(text)) !== null) {
    const name = m[1].trim();
    if (!results[name]) results[name] = { status: 'running' };
  }

  // Route passed: ✅ Route "Kriya V2" PASSED  (2.3s)
  const rePassed = /Route "([^"]+)" PASSED[^\n]*\(([^)]+)\)/g;
  while ((m = rePassed.exec(text)) !== null) {
    results[m[1]] = { status: 'passed', duration: m[2] };
  }

  // Route failed: ❌ Route "Kriya V2" FAILED: msg  (1.5s)
  const reFailed = /Route "([^"]+)" FAILED(?:: ([^\n(]+))?\s*\(([^)]+)\)/g;
  while ((m = reFailed.exec(text)) !== null) {
    const errorMsg = m[2]?.trim();
    let failureKind: RouteResult['failureKind'];
    if (errorMsg) {
      if (/on-chain tx failed|on-chain transaction failed|Transaction failed|Something went wrong/i.test(errorMsg)) failureKind = 'on-chain';
      else if (/timed out|timeout/i.test(errorMsg)) failureKind = 'timeout';
    }
    results[m[1]] = { status: 'failed', error: errorMsg, duration: m[3], failureKind };
  }

  return results;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CetusSwapRouteSection() {
  // Global
  const [executeSwap,     setExecuteSwap]     = useState(false);
  const [testAllRoutes,   setTestAllRoutes]   = useState(false);
  const [selectedRoutes,  setSelectedRoutes]  = useState<string[]>([...CETUS_ROUTES]);
  const [dropdownOpen,    setDropdownOpen]    = useState(false);
  const [search,          setSearch]          = useState('');
  const [runState,        setRunState]        = useState<RunState>({ status: 'idle' });
  const [showOutput,      setShowOutput]      = useState(false);
  const [routeResults,    setRouteResults]    = useState<Record<string, RouteResult>>({});
  const [combinedPhase,   setCombinedPhase]   = useState<CombinedPhase | null>(null);

  const dropdownRef   = useRef<HTMLDivElement>(null);
  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const accOutputRef  = useRef('');

  // Swap params — single pair mode
  const [inputType,  setInputType]  = useState(SUI_COIN_TYPE);
  const [outputType, setOutputType] = useState(USDC_COIN_TYPE);
  const [amount,     setAmount]     = useState('0.1');
  const [slippage,   setSlippage]   = useState('');

  // Multi-coin mode: maintain a list of coins; each run randomly picks 2
  const [multiCoinMode,  setMultiCoinMode]  = useState(false);
  const [coinList,       setCoinList]       = useState<CoinEntry[]>(DEFAULT_COIN_LIST);
  // Which pair was randomly chosen for the last run (shown in UI)
  const [chosenPair, setChosenPair] = useState<[CoinEntry, CoinEntry] | null>(null);
  // Inline add-coin form
  const [newCoinLabel,    setNewCoinLabel]    = useState('');
  const [newCoinType,     setNewCoinType]     = useState('');

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filteredRoutes = CETUS_ROUTES.filter((r) =>
    r.toLowerCase().includes(search.toLowerCase())
  );

  const clearResults = () => {
    setRouteResults({});
    setCombinedPhase(null);
    setRunState({ status: 'idle' });
    accOutputRef.current = '';
  };

  const toggleRoute = (route: string) => {
    setSelectedRoutes((prev) =>
      prev.includes(route) ? prev.filter((r) => r !== route) : [...prev, route]
    );
    clearResults();
  };

  const selectAll = () => { setSelectedRoutes([...CETUS_ROUTES]); clearResults(); };
  const clearAll  = () => { setSelectedRoutes([]); clearResults(); };

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const startPolling = (runId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res  = await fetch(`/api/trigger?runId=${runId}`);
        const data = await res.json();
        if (!res.ok) return;

        if (data.output) {
          accOutputRef.current = data.output.join('');
          setRunState((prev) => ({
            ...prev,
            status:   data.status,
            output:   data.output,
            duration: data.duration,
          }));

          // Parse combined phase
          const cp = parseCombinedPhase(accOutputRef.current);
          if (cp) setCombinedPhase(cp);

          // Parse per-route results
          const rr = parseRouteResults(accOutputRef.current);
          if (Object.keys(rr).length > 0) setRouteResults(rr);
        }

        if (data.status === 'completed' || data.status === 'failed') {
          stopPolling();
        }
      } catch (_) { /* ignore network errors during polling */ }
    }, 1500);
  };

  const handleRun = async () => {
    if (runState.status === 'running') return;
    clearResults();

    // Resolve coin pair: in multi-coin mode pick two at random, otherwise use manual fields
    let resolvedInput  = inputType;
    let resolvedOutput = outputType;
    if (multiCoinMode && coinList.length >= 2) {
      const pair = pickTwoRandom(coinList);
      if (pair) {
        setChosenPair(pair);
        resolvedInput  = pair[0].coinType;
        resolvedOutput = pair[1].coinType;
      }
    } else {
      setChosenPair(null);
    }

    // Pass full coin pool so each route can pick its own random pair
    const tokenPoolJson = multiCoinMode && coinList.length >= 2
      ? JSON.stringify(coinList.map((c) => ({ label: c.label, coinType: c.coinType })))
      : undefined;

    const routes = testAllRoutes ? [] : selectedRoutes;
    const payload = {
      testId:        'cetus-swap-route-execution',
      project:       'cetus',
      mode:          'local',
      testAllRoutes,
      swapParams: {
        cetusRoutes: routes,
        executeSwap,
        inputType:  resolvedInput,
        outputType: resolvedOutput,
        amount,
        slippage,
        tokenPool: tokenPoolJson,
      },
    };

    setRunState({ status: 'running' });
    try {
      const res  = await fetch('/api/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) {
        setRunState({ status: 'failed', errorMsg: data.error ?? 'Trigger failed' });
        return;
      }
      // alreadyRunning: a process for this testId is already live on the server —
      // resume polling the existing run instead of starting a second Chrome window.
      setRunState((prev) => ({
        ...prev,
        status: 'running',
        runId: data.runId,
        errorMsg: data.alreadyRunning ? '已有进程在运行，正在接入监控…' : undefined,
      }));
      startPolling(data.runId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunState({ status: 'failed', errorMsg: msg });
    }
  };

  const handleStop = () => {
    stopPolling();
    setRunState((prev) => ({ ...prev, status: 'failed', errorMsg: 'Stopped by user' }));
  };

  // ── Derived values ──────────────────────────────────────────────────────────

  const isRunning      = runState.status === 'running';
  const routeCount     = testAllRoutes ? CETUS_ROUTES.length : selectedRoutes.length;
  const passCount      = Object.values(routeResults).filter((r) => r.status === 'passed').length;
  const failCount      = Object.values(routeResults).filter((r) => r.status === 'failed').length;
  const runningCount   = Object.values(routeResults).filter((r) => r.status === 'running').length;

  // Estimate: combined (3 min) + per-route (2 min each)
  const estSeconds = testAllRoutes
    ? CETUS_ROUTES.length * 120
    : selectedRoutes.length > 1
    ? 180 + selectedRoutes.length * 120
    : 120;
  const estLabel = estSeconds >= 3600
    ? `~${Math.round(estSeconds / 3600)}h`
    : `~${Math.round(estSeconds / 60)}min`;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="relative flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-md transition-all hover:border-slate-500 col-span-full">
      {/* Header — matches TestCard layout */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">P0</span>
            <span className="text-sm font-semibold text-white">多路由兑换</span>
          </div>
          <p className="text-xs text-slate-400">选择指定 Aggregator 路由，执行真实链上 Swap 并验证余额变化</p>
        </div>
        {runState.status !== 'idle' && (
          <div className="flex items-center gap-2 text-xs">
            {isRunning && <span className="animate-pulse text-yellow-400">● 运行中</span>}
            {runState.status === 'completed' && <span className="text-emerald-400">✅ 完成</span>}
            {runState.status === 'failed' && !isRunning && <span className="text-red-400">❌ 失败</span>}
            {runState.duration !== undefined && (
              <span className="text-slate-500">{(runState.duration / 1000).toFixed(1)}s</span>
            )}
          </div>
        )}
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1">
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">swap</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">aggregator</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">multi-route</span>
      </div>

      {/* ── Expandable config panel ──────────────────────────────────────── */}
      <details className="group rounded-lg border border-slate-700 bg-slate-800/60">
        <summary className="flex cursor-pointer select-none items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200">
          <span>配置参数</span>
          <span className="text-slate-500 transition group-open:rotate-180">▼</span>
        </summary>
        <div className="border-t border-slate-700 p-3">

      {/* Swap params */}
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-slate-400">Input Token CoinType</label>
            <input
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
              value={inputType}
              onChange={(e) => setInputType(e.target.value)}
              placeholder={SUI_COIN_TYPE}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">Output Token CoinType</label>
            <input
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
              value={outputType}
              onChange={(e) => setOutputType(e.target.value)}
              placeholder={USDC_COIN_TYPE}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">Swap 金额</label>
            <input
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.1"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">滑点 (%)</label>
            <input
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
              placeholder="留空使用页面默认值"
            />
          </div>
        </div>
        {/* Quick pair presets */}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {QUICK_PAIRS.map((p) => (
            <button
              key={p.label}
              onClick={() => { setInputType(p.input); setOutputType(p.output); clearResults(); }}
              className={`rounded border px-2 py-0.5 text-xs transition
                ${inputType === p.input && outputType === p.output
                  ? 'border-sky-500 bg-sky-900/40 text-sky-300'
                  : 'border-slate-600 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200'}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Multi-coin mode toggle */}
        <div className="mb-3 flex items-center gap-2">
          <button
            role="switch"
            aria-checked={multiCoinMode}
            onClick={() => { setMultiCoinMode((v) => !v); clearResults(); }}
            className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors focus:outline-none
              ${multiCoinMode ? 'bg-violet-600' : 'bg-slate-600'}`}
          >
            <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform
              ${multiCoinMode ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
          <span className="text-xs text-slate-300">
            多币种模式（每次随机选两个币种兑换）
            {multiCoinMode && <span className="ml-1 rounded bg-violet-600/30 px-1 text-violet-300">🎲 随机</span>}
          </span>
        </div>

        {/* Multi-coin list */}
        {multiCoinMode && (
          <div className="mb-3 rounded-lg border border-violet-800/50 bg-violet-900/10 p-3">
            <p className="mb-2 text-xs font-medium text-violet-300">币种池（至少 2 个）</p>
            <div className="mb-2 flex flex-col gap-1.5">
              {coinList.map((coin) => (
                <div key={coin.id} className="flex items-center gap-2">
                  <span className="w-16 shrink-0 rounded bg-slate-700 px-1.5 py-0.5 text-center text-xs font-semibold text-slate-200">
                    {coin.label || '—'}
                  </span>
                  <span className="flex-1 truncate rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-400">
                    {coin.coinType}
                  </span>
                  <button
                    onClick={() => setCoinList((prev) => prev.filter((c) => c.id !== coin.id))}
                    disabled={coinList.length <= 2}
                    className="text-xs text-slate-500 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30"
                    title="删除"
                  >✕</button>
                </div>
              ))}
            </div>
            {/* Add coin */}
            <div className="flex gap-1.5">
              <input
                className="w-20 rounded-lg border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200 placeholder-slate-500 focus:border-violet-500 focus:outline-none"
                placeholder="名称"
                value={newCoinLabel}
                onChange={(e) => setNewCoinLabel(e.target.value)}
              />
              <input
                className="flex-1 rounded-lg border border-slate-600 bg-slate-800 px-2 py-1 font-mono text-xs text-slate-200 placeholder-slate-500 focus:border-violet-500 focus:outline-none"
                placeholder="0x...::module::TYPE"
                value={newCoinType}
                onChange={(e) => setNewCoinType(e.target.value)}
              />
              <button
                onClick={() => {
                  const t = newCoinType.trim();
                  const l = newCoinLabel.trim() || t.split('::').pop() || t;
                  if (!t) return;
                  setCoinList((prev) => [...prev, { id: String(Date.now()), label: l, coinType: t }]);
                  setNewCoinLabel('');
                  setNewCoinType('');
                }}
                disabled={!newCoinType.trim()}
                className="rounded-lg border border-violet-700 bg-violet-800/40 px-2 py-1 text-xs text-violet-300 hover:bg-violet-700/50 disabled:cursor-not-allowed disabled:opacity-40"
              >添加</button>
            </div>
            {chosenPair && (
              <p className="mt-2 text-xs text-violet-400">
                上次随机选择：<span className="font-semibold">{chosenPair[0].label}</span>
                {' → '}
                <span className="font-semibold">{chosenPair[1].label}</span>
              </p>
            )}
          </div>
        )}

        {/* TEST_ALL_ROUTES toggle */}
        <div className="mb-3 flex items-center gap-2">
          <button
            role="switch"
            aria-checked={testAllRoutes}
            onClick={() => { setTestAllRoutes((v) => !v); clearResults(); }}
            className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors focus:outline-none
              ${testAllRoutes ? 'bg-sky-600' : 'bg-slate-600'}`}
          >
            <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform
              ${testAllRoutes ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
          <span className="text-xs text-slate-300">测试全部路由（TEST_ALL_ROUTES）</span>
        </div>

        {/* Execute swap toggle */}
        <div className="flex items-center gap-2">
          <button
            role="switch"
            aria-checked={executeSwap}
            onClick={() => setExecuteSwap((v) => !v)}
            disabled={isRunning}
            className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors focus:outline-none disabled:opacity-50
              ${executeSwap ? 'bg-orange-500' : 'bg-slate-600'}`}
          >
            <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform
              ${executeSwap ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
          <span className="text-xs text-slate-300">
            发送真实交易
            {executeSwap && <span className="ml-1 rounded bg-orange-600/30 px-1 text-orange-400">⚠ 消耗 gas</span>}
          </span>
        </div>

        </div>
      </details>

      {/* Route selector */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-xs font-medium text-slate-300">
            选择路由 ({testAllRoutes ? CETUS_ROUTES.length : selectedRoutes.length}/{CETUS_ROUTES.length})
          </label>
          <div className="flex gap-1">
            <button onClick={selectAll} className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:text-slate-200">全选</button>
            <button onClick={clearAll}  className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:text-red-400">清空</button>
          </div>
        </div>

        {/* Dropdown trigger */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:border-slate-500"
          >
            <span>
              {testAllRoutes
                ? `全部 ${CETUS_ROUTES.length} 条（已默认全选）`
                : selectedRoutes.length === 0
                ? '未选择任何路由'
                : selectedRoutes.length === CETUS_ROUTES.length
                ? `全部 ${CETUS_ROUTES.length} 条（已默认全选）`
                : `已选 ${selectedRoutes.length} 条`}
            </span>
            <span className="text-slate-500">▼</span>
          </button>

          {dropdownOpen && !testAllRoutes && (
            <div className="absolute z-30 mt-1 w-full rounded-xl border border-slate-600 bg-slate-800 shadow-xl">
              <div className="border-b border-slate-700 p-2">
                <input
                  className="w-full rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none"
                  placeholder="搜索路由..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="max-h-48 overflow-y-auto p-2">
                {filteredRoutes.map((route) => (
                  <label key={route} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-700">
                    <input
                      type="checkbox"
                      checked={selectedRoutes.includes(route)}
                      onChange={() => toggleRoute(route)}
                      className="h-3 w-3 rounded border-slate-500 accent-sky-500"
                    />
                    <span className="text-xs text-slate-300">{route}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Selected route pills */}
        {!testAllRoutes && selectedRoutes.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {selectedRoutes.map((route) => {
              const rr = routeResults[route];
              const pillColor = !rr
                ? 'border-slate-600 bg-slate-800 text-slate-300'
                : rr.status === 'passed'
                ? 'border-emerald-700 bg-emerald-900/40 text-emerald-300'
                : rr.status === 'failed'
                ? 'border-red-700 bg-red-900/40 text-red-300'
                : rr.status === 'running'
                ? 'border-yellow-600 bg-yellow-900/30 text-yellow-300 animate-pulse'
                : 'border-slate-600 bg-slate-800 text-slate-400';
              return (
                <span key={route} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${pillColor}`}>
                  {rr?.status === 'passed' ? '✓' : rr?.status === 'failed' ? '✗' : rr?.status === 'running' ? '●' : ''}
                  {route}
                  {!isRunning && (
                    <button onClick={() => toggleRoute(route)} className="ml-0.5 hover:opacity-70">×</button>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Combined phase status */}
      {combinedPhase && (
        <div className={`rounded-lg border px-3 py-2 text-xs
          ${combinedPhase.status === 'passed' ? 'border-emerald-700 bg-emerald-900/20 text-emerald-300'
          : combinedPhase.status === 'failed' ? 'border-red-700 bg-red-900/20 text-red-300'
          : combinedPhase.status === 'running' ? 'border-yellow-600 bg-yellow-900/20 text-yellow-300'
          : 'border-slate-700 bg-slate-800/40 text-slate-400'}`}
        >
          <span className="font-medium">
            {combinedPhase.status === 'running' ? '⏳ Combined swap 进行中…'
            : combinedPhase.status === 'passed' ? '✓ Combined swap 通过'
            : combinedPhase.status === 'failed' ? '✗ Combined swap 失败'
            : 'Combined swap 等待中'}
          </span>
          {combinedPhase.error && <span className="ml-2 opacity-75">{combinedPhase.error}</span>}
          <span className="ml-2 opacity-60">({combinedPhase.routes.join(', ')})</span>
        </div>
      )}

      {/* Status bar — mirrors TestCard StatusBar */}
      <div>
        {runState.status === 'idle' && (
          <div className="text-xs text-slate-500">预计耗时 {estLabel}（{executeSwap ? '含 swap' : '仅报价'} × 逐条{selectedRoutes.length > 1 ? ' + 组合' : ''}）</div>
        )}
        {isRunning && Object.keys(routeResults).length === 0 && (
          <div className="text-xs text-blue-400 animate-pulse">正在启动测试…</div>
        )}
        {isRunning && Object.keys(routeResults).length > 0 && (
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-700">
              <div className="h-full animate-pulse rounded-full bg-blue-500" style={{ width: `${Math.round(((passCount + failCount) / routeCount) * 100)}%` }} />
            </div>
            <span className="shrink-0 text-xs text-blue-400">
              {passCount + failCount}/{routeCount}
              {passCount > 0 && <span className="ml-1 text-emerald-400">✓{passCount}</span>}
              {failCount > 0 && <span className="ml-1 text-red-400">✗{failCount}</span>}
            </span>
          </div>
        )}
        {runState.status === 'completed' && (
          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
            ✅ 全部通过
            <span className="font-normal text-slate-400">· {passCount}/{routeCount} 条路由</span>
          </div>
        )}
        {runState.status === 'failed' && !isRunning && (
          <div className="flex items-center gap-1.5 text-xs font-semibold text-red-400">
            ❌ 存在失败
            <span className="font-normal text-slate-400">· {failCount}/{routeCount} 条失败</span>
          </div>
        )}
      </div>

      {/* Actions — matches TestCard button style */}
      <div className="flex items-center gap-2">
        <button
          onClick={isRunning ? handleStop : handleRun}
          disabled={!testAllRoutes && selectedRoutes.length === 0}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition-all
            ${isRunning
              ? 'bg-red-700 text-white hover:bg-red-600'
              : 'bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500'}`}
        >
          {isRunning ? (
            <>
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              执行中
            </>
          ) : (
            <>▶ 运行测试 ({routeCount} 条路由)</>
          )}
        </button>

        {(runState.status === 'completed' || runState.status === 'failed') && runState.output && runState.output.length > 0 && (
          <button
            onClick={() => setShowOutput((v) => !v)}
            className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300 hover:border-slate-400 hover:text-white"
          >
            {showOutput ? '隐藏日志 ▲' : '查看日志 📄'}
          </button>
        )}
        {(runState.status === 'completed' || runState.status === 'failed') && runState.output && runState.output.length > 0 && (
          <button
            onClick={() => downloadLog(`cetus-swap-routes-${Date.now()}.txt`, runState.output!.join(''))}
            className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300 hover:border-slate-400 hover:text-white"
            title="下载日志"
          >
            ⬇ 下载
          </button>
        )}
      </div>

      {/* Error message */}
      {runState.errorMsg && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
          {runState.errorMsg}
        </div>
      )}

      {/* Output log */}
      {showOutput && runState.output && runState.output.length > 0 && (
        <pre className="max-h-64 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs leading-relaxed text-slate-300 font-mono whitespace-pre-wrap">
          {runState.output.join('')}
        </pre>
      )}
    </div>
  );
}

