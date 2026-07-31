'use client';

import { useState, useRef } from 'react';

type Status = 'idle' | 'running' | 'completed' | 'failed';

interface RunState {
  status: Status;
  runId?: string;
  output?: string[];
  errorMsg?: string;
  duration?: number;
}

interface FarmStakeParams {
  pairLabel: string;
}

// ── 快捷 Farm 对 ──────────────────────────────────────────────────────────────
const QUICK_FARMS = [
  { label: 'haSUI - SUI' },
  { label: 'USDsui - USDC' },
  { label: 'haWAL - WAL' },
] as const;

// ── 测试卡片 ─────────────────────────────────────────────────────────────────

interface FarmTestCardProps {
  testId: string;
  name: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  tags: string[];
  params: React.ReactNode;
  getParams: () => Record<string, string>;
}

function FarmTestCard({ testId, name, description, priority, tags, params, getParams }: FarmTestCardProps) {
  const [runState, setRunState]     = useState<RunState>({ status: 'idle' });
  const [showOutput, setShowOutput] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const priorityColor = priority === 'P0' ? 'bg-red-600' : priority === 'P1' ? 'bg-yellow-600' : 'bg-slate-600';

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const startPolling = (runId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/trigger?runId=${runId}`);
        if (!res.ok) return;
        const data = await res.json();
        setRunState((prev) => ({ ...prev, status: data.status, output: data.output, duration: data.duration }));
        if (data.status === 'completed' || data.status === 'failed') stopPolling();
      } catch (_) { /* ignore */ }
    }, 1500);
  };

  const handleRun = async () => {
    if (runState.status === 'running') return;
    setRunState({ status: 'running' });
    setShowOutput(false);
    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testId, project: 'cetus', mode: 'local', farmParams: getParams() }),
      });
      const data = await res.json();
      if (!res.ok) { setRunState({ status: 'failed', errorMsg: data.error ?? 'Trigger failed' }); return; }
      setRunState((prev) => ({
        ...prev, status: 'running', runId: data.runId,
        errorMsg: data.alreadyRunning ? '已有进程在运行，正在接入监控…' : undefined,
      }));
      startPolling(data.runId);
    } catch (err: unknown) {
      setRunState({ status: 'failed', errorMsg: err instanceof Error ? err.message : String(err) });
    }
  };

  const isRunning = runState.status === 'running';

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-md transition-all hover:border-slate-500">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className={`rounded ${priorityColor} px-1.5 py-0.5 text-xs font-bold text-white`}>{priority}</span>
            <span className="text-sm font-semibold text-white">{name}</span>
          </div>
          <p className="text-xs text-slate-400">{description}</p>
        </div>
        {runState.status !== 'idle' && (
          <div className="flex shrink-0 items-center gap-2 text-xs">
            {isRunning && <span className="animate-pulse text-yellow-400">● 运行中</span>}
            {runState.status === 'completed' && <span className="text-emerald-400">✅ 通过</span>}
            {runState.status === 'failed' && !isRunning && <span className="text-red-400">❌ 失败</span>}
            {runState.duration !== undefined && <span className="text-slate-500">{(runState.duration / 1000).toFixed(1)}s</span>}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1">
        {tags.map((t) => <span key={t} className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">{t}</span>)}
      </div>

      <details className="group rounded-lg border border-slate-700 bg-slate-800/60">
        <summary className="flex cursor-pointer select-none items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200">
          <span>配置参数</span>
          <span className="text-slate-500 transition group-open:rotate-180">▼</span>
        </summary>
        <div className="border-t border-slate-700 p-3">{params}</div>
      </details>

      <div className="flex items-center gap-2">
        <button
          onClick={handleRun}
          disabled={isRunning}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition-all
            ${isRunning ? 'cursor-not-allowed bg-slate-700 text-slate-400' : 'bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700'}`}
        >
          {isRunning ? (
            <><svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>执行中</>
          ) : '▶ 运行测试'}
        </button>
        {(runState.status === 'completed' || runState.status === 'failed') && !!runState.output?.length && (
          <button onClick={() => setShowOutput((v) => !v)} className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300 hover:border-slate-400 hover:text-white">
            {showOutput ? '隐藏输出 ▲' : '查看输出 📄'}
          </button>
        )}
      </div>

      {runState.errorMsg && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">{runState.errorMsg}</div>
      )}
      {showOutput && !!runState.output?.length && (
        <pre className="max-h-48 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-300 whitespace-pre-wrap">
          {runState.output.join('')}
        </pre>
      )}
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

export default function CetusFarmSection() {
  const [stakeP, setStakeP] = useState<FarmStakeParams>({ pairLabel: 'haSUI - SUI' });

  const tests: {
    testId: string; name: string; description: string;
    priority: 'P0' | 'P1' | 'P2'; tags: string[];
    getParams: () => Record<string, string>; paramsNode: React.ReactNode;
  }[] = [
    {
      testId: 'farm-stake',
      name: 'Stake 质押',
      description: '展开目标 Farm 行，将 CLMM 仓位质押到 Farm 赚取额外奖励',
      priority: 'P0',
      tags: ['farm', 'stake'],
      getParams: () => ({ FARM_PAIR_LABEL: stakeP.pairLabel }),
      paramsNode: (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {QUICK_FARMS.map((f) => (
              <button
                key={f.label}
                onClick={() => setStakeP({ pairLabel: f.label })}
                className={`rounded border px-2 py-0.5 text-xs transition
                  ${stakeP.pairLabel === f.label
                    ? 'border-sky-500 bg-sky-900/40 text-sky-300'
                    : 'border-slate-600 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400">Farm 交易对标签</label>
            <input
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
              value={stakeP.pairLabel}
              onChange={(e) => setStakeP({ pairLabel: e.target.value })}
              placeholder="haSUI - SUI"
            />
            <p className="mt-1 text-xs text-slate-600">Farm 列表中显示的池子名称，用于定位要展开的行</p>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="sm:col-span-2 lg:col-span-3 xl:col-span-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {tests.map((t) => (
          <FarmTestCard
            key={t.testId}
            testId={t.testId}
            name={t.name}
            description={t.description}
            priority={t.priority}
            tags={t.tags}
            params={t.paramsNode}
            getParams={t.getParams}
          />
        ))}
      </div>
    </div>
  );
}
