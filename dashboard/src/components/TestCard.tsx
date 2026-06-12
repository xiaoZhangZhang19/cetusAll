'use client';

import { useState, useEffect, useRef } from 'react';
import type { TestCase } from '@/lib/tests';

type RunState =
  | { phase: 'idle' }
  | { phase: 'triggering' }
  | { phase: 'queued'; runId: number }
  | { phase: 'running'; runId: number; startedAt: number }
  | { phase: 'done'; runId: number; passed: boolean; url: string; durationSec: number; output?: string[] }
  | { phase: 'error'; message: string };

const PRIORITY_BADGE: Record<string, string> = {
  P0: 'bg-red-600 text-white',
  P1: 'bg-yellow-600 text-white',
  P2: 'bg-slate-600 text-slate-200',
};

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(id);
  }, [startedAt]);
  return <span className="tabular-nums">{elapsed}s</span>;
}

export default function TestCard({ test }: { test: TestCase }) {
  const [state, setState] = useState<RunState>({ phase: 'idle' });
  const [showOutput, setShowOutput] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  async function pollStatus(runId: number | string, startedAt: number) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/trigger?runId=${runId}`);
        if (!res.ok) return;
        const data = await res.json();
        const conclusion = data.status === 'completed' ? 'success' : data.status === 'failed' ? 'failure' : null;

        if (data.status !== 'running') {
          stopPolling();
          setState({
            phase: 'done',
            runId: typeof runId === 'number' ? runId : 0,
            passed: conclusion === 'success',
            url: '#',
            durationSec: Math.floor(data.duration / 1000),
            output: data.output || [],
          });
        } else {
          setState((prev) =>
            prev.phase === 'queued'
              ? { phase: 'running', runId: typeof runId === 'number' ? runId : 0, startedAt }
              : prev
          );
        }
      } catch {
        // ignore transient errors
      }
    }, 5_000);
  }

  async function handleRun() {
    setState({ phase: 'triggering' });
    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testId: test.id, mode: 'local' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Unknown error');
      const startedAt = Date.now();
      const runId = data.runId;
      setState({ phase: 'queued', runId: typeof runId === 'number' ? runId : 0 });
      await pollStatus(runId, startedAt);
    } catch (err: unknown) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const isRunning = state.phase === 'triggering' || state.phase === 'queued' || state.phase === 'running';

  return (
    <div className="relative flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-md transition-all hover:border-slate-500">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${PRIORITY_BADGE[test.priority]}`}>
              {test.priority}
            </span>
            <span className="text-sm font-semibold text-white">{test.name}</span>
          </div>
          <p className="text-xs text-slate-400">{test.description}</p>
        </div>
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1">
        {test.tags.map((tag) => (
          <span key={tag} className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">
            {tag}
          </span>
        ))}
      </div>

      {/* Status bar */}
      <StatusBar state={state} estimatedSeconds={test.estimatedSeconds} />

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleRun}
          disabled={isRunning}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition-all
            ${isRunning
              ? 'cursor-not-allowed bg-slate-700 text-slate-400'
              : 'bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700'
            }`}
        >
          {isRunning ? (
            <>
              <LoadingSpinner />
              {state.phase === 'triggering'
                ? '启动中…'
                : state.phase === 'queued'
                ? '等待排队…'
                : '执行中（查看浏览器）'}
            </>
          ) : (
            <>▶ 运行测试</>
          )}
        </button>

        {state.phase === 'done' && (
          <button
            onClick={() => setShowOutput(true)}
            className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300 hover:border-slate-400 hover:text-white"
          >
            查看输出 📄
          </button>
        )}
      </div>

      {/* Output Modal for Local Mode */}
      {showOutput && state.phase === 'done' && state.output && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setShowOutput(false)}>
          <div 
            className="relative max-h-[80vh] w-full max-w-4xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-700 px-6 py-4">
              <div>
                <h3 className="text-lg font-semibold text-white">{test.name} - 测试输出</h3>
                <p className="text-xs text-slate-400 mt-1">
                  {state.passed ? '✅ 测试通过' : '❌ 测试失败'} · 耗时 {state.durationSec}s
                </p>
              </div>
              <button
                onClick={() => setShowOutput(false)}
                className="text-slate-400 hover:text-white transition"
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Output Content */}
            <div className="overflow-y-auto p-6" style={{ maxHeight: 'calc(80vh - 120px)' }}>
              <pre className="text-xs text-slate-300 font-mono whitespace-pre-wrap break-words">
                {state.output.join('')}
              </pre>
            </div>

            {/* Footer */}
            <div className="border-t border-slate-700 px-6 py-3 text-xs text-slate-500">
              提示: 点击背景或 × 关闭窗口
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBar({ state, estimatedSeconds }: { state: RunState; estimatedSeconds: number }) {
  if (state.phase === 'idle') {
    return <div className="text-xs text-slate-500">预计耗时 ~{estimatedSeconds}s</div>;
  }
  if (state.phase === 'triggering') {
    return <div className="text-xs text-blue-400 animate-pulse">正在启动本地测试…</div>;
  }
  if (state.phase === 'queued') {
    return <div className="text-xs text-yellow-400 animate-pulse">⏳ 排队等待运行…</div>;
  }
  if (state.phase === 'running') {
    return (
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-700">
          <div className="h-full animate-pulse rounded-full bg-blue-500" style={{ width: '60%' }} />
        </div>
        <span className="text-xs text-blue-400">
          运行中 <ElapsedTimer startedAt={state.startedAt} />
        </span>
      </div>
    );
  }
  if (state.phase === 'done') {
    return (
      <div className={`flex items-center gap-1.5 text-xs font-semibold ${state.passed ? 'text-emerald-400' : 'text-red-400'}`}>
        {state.passed ? '✅ 通过' : '❌ 失败'}
        <span className="font-normal text-slate-400">· 耗时 {state.durationSec}s · 可查看输出</span>
      </div>
    );
  }
  if (state.phase === 'error') {
    return <div className="text-xs text-red-400">⚠ {state.message}</div>;
  }
  return null;
}

function LoadingSpinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}
