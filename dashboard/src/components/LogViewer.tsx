'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LogEntry {
  runId: string;
  testId: string;
  project: string;
  status: 'completed' | 'failed';
  startTime: number;
  endTime: number;
  duration: number;
  output?: string[];
}

interface LogViewerProps {
  runId?: string;
  testId?: string;
  testName?: string;
  onClose: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function colorLine(line: string): string {
  // PLACEHOLDER_COLOR
  return line;
}

// ── Log line renderer ─────────────────────────────────────────────────────────

function LogLine({ line, idx }: { line: string; idx: number }) {
  // PLACEHOLDER_LOGLINE
  let cls = 'text-slate-300';
  const l = line.toLowerCase();
  if (/\b(error|fail|failed|✗|✘)\b/.test(l)) cls = 'text-red-400';
  else if (/\b(pass|passed|✓|✔|ok)\b/.test(l)) cls = 'text-emerald-400';
  else if (/\b(warn|warning)\b/.test(l)) cls = 'text-yellow-400';
  else if (/^\s*\[/.test(line) || /^\s*>/.test(line)) cls = 'text-slate-500';

  return (
    <div key={idx} className={`flex gap-2 font-mono text-xs leading-5 ${cls}`}>
      <span className="w-8 shrink-0 select-none text-right text-slate-600">{idx + 1}</span>
      <span className="whitespace-pre-wrap break-all">{line}</span>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function LogViewer({ runId, testId, testName, onClose }: LogViewerProps) {
  // PLACEHOLDER_STATE
  const [log, setLog] = useState<LogEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // PLACEHOLDER_FETCH
  const fetchLog = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/logs?runId=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error('日志未找到');
      const data: LogEntry = await res.json();
      setLog(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (runId) fetchLog(runId);
  }, [runId, fetchLog]);

  // Auto-scroll to bottom when new output arrives
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [log?.output, autoScroll]);

  // PLACEHOLDER_DOWNLOAD
  const handleDownload = () => {
    if (!runId) return;
    window.open(`/api/logs?runId=${encodeURIComponent(runId)}&download=1`, '_blank');
  };

  // PLACEHOLDER_FILTER
  const filteredLines: string[] = (() => {
    const raw = log?.output ?? [];
    const allLines = raw.join('').split('\n');
    if (!search.trim()) return allLines;
    const q = search.toLowerCase();
    return allLines.filter((l) => l.toLowerCase().includes(q));
  })();

  void colorLine;

  // PLACEHOLDER_RENDER
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-700 px-6 py-4">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-base font-semibold text-white">
              {testName ?? testId ?? '日志查看器'}
            </h3>
            {log && (
              <p className="text-xs text-slate-400">
                <span className={log.status === 'completed' ? 'text-emerald-400' : 'text-red-400'}>
                  {log.status === 'completed' ? '✅ 通过' : '❌ 失败'}
                </span>
                {' · '}运行于 {formatTime(log.startTime)}
                {' · '}耗时 {(log.duration / 1000).toFixed(1)}s
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownload}
              disabled={!log}
              className="flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 transition hover:border-sky-500 hover:text-sky-400 disabled:opacity-40"
            >
              ⬇ 下载日志
            </button>
            <button
              onClick={onClose}
              className="rounded-lg border border-slate-700 p-1.5 text-slate-400 transition hover:border-slate-500 hover:text-white"
              aria-label="关闭"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* ── Search bar ── */}
        <div className="shrink-0 border-b border-slate-800 px-6 py-2">
          <div className="flex items-center gap-2">
            <svg className="h-3.5 w-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="过滤日志内容…"
              className="flex-1 bg-transparent text-xs text-slate-300 placeholder-slate-600 outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-xs text-slate-500 hover:text-slate-300">
                ✕ 清除
              </button>
            )}
            {search && (
              <span className="text-xs text-slate-500">
                {filteredLines.length} 行匹配
              </span>
            )}
          </div>
        </div>

        {/* ── Body ── */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4"
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            setAutoScroll(atBottom);
          }}
        >
          {loading && (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              <span className="animate-pulse">加载中…</span>
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-red-800 bg-red-950/40 p-4 text-sm text-red-400">
              ⚠ {error}
            </div>
          )}
          {!loading && !error && filteredLines.length === 0 && (
            <div className="flex h-full items-center justify-center text-sm text-slate-600">
              暂无日志输出
            </div>
          )}
          {!loading && !error && filteredLines.length > 0 && (
            <div className="space-y-0.5">
              {filteredLines.map((line, idx) => (
                <LogLine key={idx} line={line} idx={idx} />
              ))}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex shrink-0 items-center justify-between border-t border-slate-800 px-6 py-2 text-xs text-slate-600">
          <span>{filteredLines.length} 行输出</span>
          <button
            onClick={() => {
              setAutoScroll(true);
              if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }}
            className="text-slate-500 hover:text-slate-300"
          >
            跳到底部 ↓
          </button>
        </div>
      </div>
    </div>
  );
}
