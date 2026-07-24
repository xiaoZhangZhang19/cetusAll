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

const SUI_COIN_TYPE  = '0x2::sui::SUI';
const USDC_COIN_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const CETUS_COIN_TYPE = '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS';

const QUICK_PAIRS = [
  { label: 'SUI → USDC', input: SUI_COIN_TYPE,   output: USDC_COIN_TYPE },
  { label: 'USDC → SUI', input: USDC_COIN_TYPE,  output: SUI_COIN_TYPE },
  { label: 'SUI → CETUS', input: SUI_COIN_TYPE,  output: CETUS_COIN_TYPE },
] as const;

// ── Log parsers (same structure markers as test file) ─────────────────────────

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

  // Swap params
  const [inputType,  setInputType]  = useState(SUI_COIN_TYPE);
  const [outputType, setOutputType] = useState(USDC_COIN_TYPE);
  const [amount,     setAmount]     = useState('0.1');
  const [slippage,   setSlippage]   = useState('');

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

    const routes = testAllRoutes ? [] : selectedRoutes;
    const payload = {
      testId:        'cetus-swap-route-execution',
      project:       'cetus',
      mode:          'local',
      testAllRoutes,
      swapParams: {
        cetusRoutes: routes,
        executeSwap,
        inputType,
        outputType,
        amount,
        slippage,
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
      setRunState({ status: 'running', runId: data.runId });
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
    <div className="rounded-2xl border border-slate-700 bg-slate-800/40 p-6">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">P0</span>
            <h2 className="text-lg font-bold text-white">多路由兑换</h2>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            选择指定 Aggregator 路由，执行真实链上 Swap 并验证余额变化
          </p>
        </div>
        {runState.status !== 'idle' && (
          <div className="flex items-center gap-2 text-sm">
            {isRunning && <span className="animate-pulse text-yellow-400">● 运行中</span>}
            {runState.status === 'completed' && <span className="text-green-400">✓ 完成</span>}
            {runState.status === 'failed' && !isRunning && <span className="text-red-400">✗ 失败</span>}
            {runState.duration && (
              <span className="text-slate-500 text-xs">{(runState.duration / 1000).toFixed(1)}s</span>
            )}
          </div>
        )}
      </div>

      {/* Swap params */}
      <div className="mb-5 rounded-xl border border-slate-700 bg-slate-900/60 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Swap 参数配置</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-slate-400">Input Token CoinType</label>
            <input
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
              value={inputType}
              onChange={(e) => setInputType(e.target.value)}
              placeholder={SUI_COIN_TYPE}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">Output Token CoinType</label>
            <input
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
              value={outputType}
              onChange={(e) => setOutputType(e.target.value)}
              placeholder={USDC_COIN_TYPE}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">Swap 金额</label>
            <input
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-sky-500 focus:outline-none"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.1"
            />
            <p className="mt-0.5 text-xs text-slate-600">默认：0.1</p>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">滑点 (%)</label>
            <input
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-sky-500 focus:outline-none"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
              placeholder="留空使用页面默认值"
            />
            <p className="mt-0.5 text-xs text-slate-600">留空使用页面默认值</p>
          </div>
        </div>
        {/* Quick pair presets */}
        <div className="mt-3 flex flex-wrap gap-2">
          {QUICK_PAIRS.map((p) => (
            <button
              key={p.label}
              onClick={() => { setInputType(p.input); setOutputType(p.output); clearResults(); }}
              className={`rounded-lg border px-3 py-1 text-xs transition
                ${inputType === p.input && outputType === p.output
                  ? 'border-sky-500 bg-sky-900/40 text-sky-300'
                  : 'border-slate-600 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* TEST_ALL_ROUTES toggle */}
      <div className="mb-5 flex items-start gap-3 rounded-xl border border-slate-700 bg-slate-900/40 p-4">
        <button
          role="switch"
          aria-checked={testAllRoutes}
          onClick={() => { setTestAllRoutes((v) => !v); clearResults(); }}
          className={`relative mt-0.5 h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none
            ${testAllRoutes ? 'bg-sky-600' : 'bg-slate-600'}`}
        >
          <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform
            ${testAllRoutes ? 'translate-x-5' : 'translate-x-0'}`} />
        </button>
        <div>
          <p className="text-sm font-medium text-slate-200">测试全部路由（TEST_ALL_ROUTES）</p>
          <p className="mt-0.5 text-xs text-slate-500">
            开启：逐条测试下方选中路由，每条各做 swap；关闭：先全部路由组合 swap，再逐条 swap
          </p>
        </div>
      </div>

      {/* Route selector */}
      <div className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <label className="text-sm font-medium text-slate-300">
            选择路由 ({testAllRoutes ? CETUS_ROUTES.length : selectedRoutes.length}/{CETUS_ROUTES.length})
          </label>
          <div className="flex gap-2">
            <button onClick={selectAll} className="rounded px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200">全选</button>
            <button onClick={clearAll}  className="rounded px-2 py-0.5 text-xs text-slate-400 hover:text-red-400">清空</button>
          </div>
        </div>

        {/* Dropdown trigger */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded-lg border border-slate-600 bg-slate-800 px-3 py-2.5 text-sm text-slate-300 hover:border-slate-500"
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
                  className="w-full rounded-lg bg-slate-700 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none"
                  placeholder="搜索路由..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="max-h-56 overflow-y-auto p-2">
                {filteredRoutes.map((route) => (
                  <label key={route} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-slate-700">
                    <input
                      type="checkbox"
                      checked={selectedRoutes.includes(route)}
                      onChange={() => toggleRoute(route)}
                      className="h-3.5 w-3.5 rounded border-slate-500 accent-sky-500"
                    />
                    <span className="text-sm text-slate-300">{route}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Selected route pills */}
        {!testAllRoutes && selectedRoutes.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selectedRoutes.map((route) => {
              const rr = routeResults[route];
              const pillColor = !rr
                ? 'border-slate-600 bg-slate-800 text-slate-300'
                : rr.status === 'passed'
                ? 'border-green-700 bg-green-900/40 text-green-300'
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

      {/* Execute swap toggle */}
      <div className="mb-6 flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/40 p-4">
        <button
          role="switch"
          aria-checked={executeSwap}
          onClick={() => setExecuteSwap((v) => !v)}
          disabled={isRunning}
          className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none disabled:opacity-50
            ${executeSwap ? 'bg-orange-500' : 'bg-slate-600'}`}
        >
          <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform
            ${executeSwap ? 'translate-x-5' : 'translate-x-0'}`} />
        </button>
        <div>
          <p className="text-sm font-medium text-slate-200">
            发送真实交易
            {executeSwap && <span className="ml-2 rounded bg-orange-600/30 px-1.5 py-0.5 text-xs text-orange-400">模拟</span>}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {executeSwap ? '⚠️ 将发送真实链上交易，消耗 SUI gas' : '仅验证报价，不发送链上交易'}
          </p>
        </div>
      </div>

      {/* Combined phase status */}
      {combinedPhase && (
        <div className={`mb-4 rounded-xl border p-3 text-sm
          ${combinedPhase.status === 'passed' ? 'border-green-700 bg-green-900/20 text-green-300'
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
          {combinedPhase.error && <span className="ml-2 text-xs opacity-75">{combinedPhase.error}</span>}
          <span className="ml-2 text-xs opacity-60">({combinedPhase.routes.join(', ')})</span>
        </div>
      )}

      {/* Progress summary */}
      {isRunning && Object.keys(routeResults).length > 0 && (
        <div className="mb-4 flex gap-4 text-sm">
          {runningCount > 0 && <span className="text-yellow-400">● 运行中 {runningCount}</span>}
          {passCount > 0 && <span className="text-green-400">✓ 通过 {passCount}</span>}
          {failCount > 0 && <span className="text-red-400">✗ 失败 {failCount}</span>}
          <span className="text-slate-500">共 {routeCount} 条</span>
        </div>
      )}

      {/* Run button */}
      <button
        onClick={isRunning ? handleStop : handleRun}
        disabled={!testAllRoutes && selectedRoutes.length === 0}
        className={`w-full rounded-xl py-3 text-sm font-semibold transition
          ${isRunning
            ? 'bg-red-700 text-white hover:bg-red-600'
            : 'bg-sky-600 text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500'}`}
      >
        {isRunning
          ? '■ 停止测试'
          : `▶ 运行测试 (${routeCount} 条路由)`}
      </button>
      <p className="mt-1 text-center text-xs text-slate-600">
        预计时长 {estLabel}（{executeSwap ? '含 swap' : '仅报价'} × 逐条 + 组合 swap）
      </p>

      {/* Error message */}
      {runState.errorMsg && (
        <div className="mt-3 rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
          {runState.errorMsg}
        </div>
      )}

      {/* Output log */}
      {runState.output && runState.output.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setShowOutput((v) => !v)}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            {showOutput ? '▲ 隐藏日志' : '▼ 查看日志'}
            {runState.output.length > 0 && ` (${runState.output.length} 行)`}
          </button>
          {showOutput && (
            <pre className="mt-2 max-h-80 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs leading-relaxed text-slate-300">
              {runState.output.join('')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
