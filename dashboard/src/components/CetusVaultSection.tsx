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

interface VaultCardProps {
  testId: string;
  name: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  tags: string[];
}

function VaultCard({ testId, name, description, priority, tags }: VaultCardProps) {
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
        body: JSON.stringify({ testId, project: 'cetus', mode: 'local' }),
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
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className={`shrink-0 rounded ${priorityColor} px-1.5 py-0.5 text-xs font-bold text-white`}>{priority}</span>
            <span className="text-sm font-semibold text-white">{name}</span>
          </div>
          <p className="text-xs text-slate-400">{description}</p>
        </div>
        {runState.status !== 'idle' && (
          <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
            {isRunning && <span className="animate-pulse text-yellow-400">● 运行中</span>}
            {runState.status === 'completed' && <span className="text-emerald-400">✅ 通过</span>}
            {runState.status === 'failed' && !isRunning && <span className="text-red-400">❌ 失败</span>}
            {runState.duration !== undefined && <span className="text-slate-500">{(runState.duration / 1000).toFixed(1)}s</span>}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1">
        {tags.map((t) => (
          <span key={t} className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">{t}</span>
        ))}
      </div>

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

export default function CetusVaultSection() {
  return (
    <>
      <VaultCard
        testId="vault-stable-add"
        name="vault稳定-add"
        description="进入 haSUI-SUI Vault，存入 0.01 haSUI，验证 Transaction Completed"
        priority="P0"
        tags={['vault', 'deposit', 'lst']}
      />
      <VaultCard
        testId="vault-stable-zap"
        name="vault稳定-zap in"
        description="开启Zap In，haSUI only / SUI only 各存 0.01，两轮均验证Transaction Completed"
        priority="P0"
        tags={['vault', 'zap', 'lst']}
      />
      <VaultCard
        testId="vault-stable-remove"
        name="vault稳定-remove"
        description="输入 0.01 haSUI，点击 Withdraw 直接提交，验证 Transaction Completed"
        priority="P0"
        tags={['vault', 'withdraw', 'lst']}
      />
      <VaultCard
        testId="vault-stable-zap-out"
        name="vault稳定-zap out"
        description="开启 Zap Out，haSUI only 点 HALF / SUI only 点 MAX，两轮均验证 Transaction Completed"
        priority="P0"
        tags={['vault', 'zap-out', 'lst']}
      />
    </>
  );
}
