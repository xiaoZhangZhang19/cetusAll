'use client';

import { useRef, useEffect, useState } from 'react';

interface PeachLogModalProps {
  title: string;
  subtitle?: string;
  output: string[];
  filename?: string;
  onClose: () => void;
}

function LogLine({ line, idx }: { line: string; idx: number }) {
  const l = line.toLowerCase();
  let cls = 'text-slate-300';
  if (/error|fail|failed|✗|✘|\bfailed\b/.test(l))       cls = 'text-red-400';
  else if (/\bpass(ed)?\b|✓|✔|\bok\b|success/.test(l))  cls = 'text-emerald-400';
  else if (/warn(ing)?/.test(l))                          cls = 'text-yellow-400';
  else if (/^\s*\[|^\s*>|^\s*#/.test(line))              cls = 'text-orange-400/80';
  else if (/^\s*at |^\s*Error:/.test(line))               cls = 'text-red-300/80';

  return (
    <div className={`flex gap-2 font-mono text-xs leading-5 ${cls}`}>
      <span className="w-7 shrink-0 select-none text-right text-slate-700">{idx + 1}</span>
      <span className="whitespace-pre-wrap break-all">{line}</span>
    </div>
  );
}

export function PeachLogModal({ title, subtitle, output, filename, onClose }: PeachLogModalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');

  // Scroll to bottom on open
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, []);

  const allLines = output.join('').split('\n');
  const filtered = search.trim()
    ? allLines.filter((l) => l.toLowerCase().includes(search.toLowerCase()))
    : allLines;

  const handleDownload = () => {
    const blob = new Blob([output.join('')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename ?? `peach-log-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-orange-900/50 bg-slate-950 shadow-2xl shadow-orange-950/30"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex shrink-0 items-center justify-between border-b border-orange-900/40 bg-slate-900/80 px-5 py-3.5">
          <div className="flex items-center gap-3">
            {/* Peach accent bar */}
            <div className="h-8 w-1 rounded-full bg-gradient-to-b from-orange-400 to-pink-500" />
            <span className="text-base leading-none">🍑</span>
            <div>
              <h3 className="text-sm font-semibold text-white">{title}</h3>
              {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 rounded-lg border border-orange-800/60 bg-orange-950/40 px-3 py-1.5 text-xs text-orange-400 transition hover:bg-orange-900/40 hover:text-orange-300"
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
        <div className="shrink-0 border-b border-slate-800/80 bg-slate-950 px-5 py-2">
          <div className="flex items-center gap-2">
            <svg className="h-3.5 w-3.5 shrink-0 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="过滤日志行…"
              className="flex-1 bg-transparent text-xs text-slate-300 placeholder-slate-600 outline-none"
            />
            {search && (
              <>
                <span className="text-xs text-slate-600">{filtered.length} 行匹配</span>
                <button onClick={() => setSearch('')} className="text-xs text-slate-600 hover:text-slate-300">✕</button>
              </>
            )}
          </div>
        </div>

        {/* ── Log body ── */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto bg-slate-950 p-4">
          {filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-slate-600">暂无匹配内容</div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((line, idx) => (
                <LogLine key={idx} line={line} idx={idx} />
              ))}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex shrink-0 items-center justify-between border-t border-slate-800/80 bg-slate-900/60 px-5 py-2 text-[11px] text-slate-600">
          <span>{filtered.length} 行</span>
          <button
            onClick={() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}
            className="hover:text-slate-400"
          >
            跳到底部 ↓
          </button>
        </div>
      </div>
    </div>
  );
}
