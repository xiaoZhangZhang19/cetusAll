'use client';

import { useState, useEffect, useCallback } from 'react';
import LogViewer from '@/components/LogViewer';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LogSummary {
  runId: string;
  testId: string;
  project: string;
  status: 'completed' | 'failed';
  startTime: number;
  endTime: number;
  duration: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatDuration(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const PROJECT_LABELS: Record<string, string> = {
  cetus: 'Cetus',
  peach: 'Peach',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function LogsPage() {
  const [logs, setLogs] = useState<LogSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterProject, setFilterProject] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterTestId, setFilterTestId] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (filterProject) params.set('project', filterProject);
      if (filterStatus) params.set('status', filterStatus);
      const res = await fetch(`/api/logs?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setLogs(data.logs ?? []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [filterProject, filterStatus]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleDownloadAll = () => {
    filtered.forEach((log) => {
      window.open(`/api/logs?runId=${encodeURIComponent(log.runId)}&download=1`, '_blank');
    });
  };

  const handleDelete = async (runId: string) => {
    if (!confirm('确认删除该条日志？')) return;
    await fetch(`/api/logs?runId=${encodeURIComponent(runId)}`, { method: 'DELETE' });
    setLogs((prev) => prev.filter((l) => l.runId !== runId));
  };

  const filtered = logs.filter((l) => {
    if (filterTestId && !l.testId.toLowerCase().includes(filterTestId.toLowerCase())) return false;
    return true;
  });

  const passed = filtered.filter((l) => l.status === 'completed').length;
  const failed = filtered.filter((l) => l.status === 'failed').length;

  return (
    <div className="min-h-screen px-4 py-8 sm:px-8">
      {/* Header */}
      <div className="mx-auto mb-8 max-w-7xl">
        <div className="flex items-center gap-3">
          <a href="/" className="text-slate-500 hover:text-slate-300 transition text-sm">
            ← 返回主页
          </a>
        </div>
        <div className="mt-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">日志中心</h1>
            <p className="mt-1 text-sm text-slate-400">所有功能模块的历史运行记录，支持查看与下载</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-400">
              共 {filtered.length} 条
            </span>
            <span className="rounded-full border border-emerald-800 bg-emerald-950/30 px-3 py-1 text-emerald-400">
              通过 {passed}
            </span>
            <span className="rounded-full border border-red-800 bg-red-950/30 px-3 py-1 text-red-400">
              失败 {failed}
            </span>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="mx-auto mb-6 max-w-7xl">
        <div className="flex flex-wrap items-center gap-3">
          {/* Project filter */}
          <select
            value={filterProject}
            onChange={(e) => setFilterProject(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 outline-none focus:border-sky-500"
          >
            <option value="">全部项目</option>
            <option value="cetus">Cetus</option>
            <option value="peach">Peach</option>
          </select>

          {/* Status filter */}
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 outline-none focus:border-sky-500"
          >
            <option value="">全部状态</option>
            <option value="completed">通过</option>
            <option value="failed">失败</option>
          </select>

          {/* Test ID search */}
          <input
            type="text"
            value={filterTestId}
            onChange={(e) => setFilterTestId(e.target.value)}
            placeholder="搜索测试 ID…"
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 placeholder-slate-600 outline-none focus:border-sky-500 min-w-[160px]"
          />

          <button
            onClick={fetchLogs}
            className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300 transition hover:border-slate-400 hover:text-white"
          >
            ↻ 刷新
          </button>

          {filtered.length > 0 && (
            <button
              onClick={handleDownloadAll}
              className="rounded-lg border border-sky-700 bg-sky-950/30 px-3 py-2 text-xs text-sky-400 transition hover:bg-sky-900/30"
            >
              ⬇ 批量下载 ({filtered.length})
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="mx-auto max-w-7xl">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-sm text-slate-500 animate-pulse">
            加载中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-sm text-slate-600">
            <span className="text-4xl">🗂</span>
            <p>暂无运行记录</p>
            <p className="text-xs text-slate-700">运行测试后日志将自动保存在此</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-700">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-700 bg-slate-900/80">
                  <th className="px-4 py-3 text-left font-medium text-slate-400">状态</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-400">测试 ID</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-400">项目</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-400">运行时间</th>
                  <th className="px-4 py-3 text-left font-medium text-slate-400">耗时</th>
                  <th className="px-4 py-3 text-right font-medium text-slate-400">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((log, idx) => (
                  <tr
                    key={log.runId}
                    className={`border-b border-slate-800 transition hover:bg-slate-800/40 ${
                      idx % 2 === 0 ? 'bg-slate-900/20' : 'bg-transparent'
                    }`}
                  >
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          log.status === 'completed'
                            ? 'bg-emerald-950/60 text-emerald-400'
                            : 'bg-red-950/60 text-red-400'
                        }`}
                      >
                        {log.status === 'completed' ? '✓ 通过' : '✗ 失败'}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-300">{log.testId}</td>
                    <td className="px-4 py-3">
                      <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-400">
                        {PROJECT_LABELS[log.project] ?? log.project}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{formatTime(log.startTime)}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-400">
                      {formatDuration(log.duration)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => {
                            setSelectedRunId(log.runId);
                            setSelectedTestId(log.testId);
                          }}
                          className="rounded border border-slate-600 px-2 py-1 text-slate-400 transition hover:border-sky-500 hover:text-sky-400"
                        >
                          查看
                        </button>
                        <a
                          href={`/api/logs?runId=${encodeURIComponent(log.runId)}&download=1`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded border border-slate-600 px-2 py-1 text-slate-400 transition hover:border-sky-500 hover:text-sky-400"
                        >
                          ⬇
                        </a>
                        <button
                          onClick={() => handleDelete(log.runId)}
                          className="rounded border border-slate-700 px-2 py-1 text-slate-600 transition hover:border-red-700 hover:text-red-400"
                        >
                          删
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Log Viewer Modal */}
      {selectedRunId && (
        <LogViewer
          runId={selectedRunId}
          testId={selectedTestId ?? undefined}
          testName={selectedTestId ?? undefined}
          onClose={() => { setSelectedRunId(null); setSelectedTestId(null); }}
        />
      )}
    </div>
  );
}
