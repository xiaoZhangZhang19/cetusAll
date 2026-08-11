'use client';

import { useEffect } from 'react';

export type ToastTone = 'info' | 'warn' | 'danger' | 'success';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  duration: number;
}

const TONE: Record<ToastTone, { border: string; glyph: string; icon: string; bar: string }> = {
  info:    { border: 'border-sky-800/70',     glyph: 'ℹ', icon: 'text-sky-400',     bar: 'bg-sky-500' },
  warn:    { border: 'border-amber-800/70',   glyph: '⚠', icon: 'text-amber-400',   bar: 'bg-amber-500' },
  danger:  { border: 'border-red-800/70',     glyph: '✕', icon: 'text-red-400',     bar: 'bg-red-500' },
  success: { border: 'border-emerald-800/70', glyph: '✓', icon: 'text-emerald-400', bar: 'bg-emerald-500' },
};

function Toast({ item, onClose }: { item: ToastItem; onClose: (id: number) => void }) {
  const t = TONE[item.tone];

  useEffect(() => {
    const timer = setTimeout(() => onClose(item.id), item.duration);
    return () => clearTimeout(timer);
  }, [item.id, item.duration, onClose]);

  return (
    <div
      className={`toast-in pointer-events-auto relative w-[340px] overflow-hidden rounded-xl border ${t.border} bg-slate-900/95 shadow-xl shadow-black/50 backdrop-blur`}
      role="status"
    >
      <div className="flex items-start gap-2.5 px-4 py-3">
        <span className={`mt-[1px] text-sm leading-5 ${t.icon}`} aria-hidden="true">{t.glyph}</span>
        <div className="flex-1 space-y-0.5 text-[13px] leading-5 text-slate-300">
          {item.message.split('\n').map((line, i) =>
            line.trim() ? <p key={i} className="break-words">{line}</p> : <div key={i} className="h-1" />
          )}
        </div>
        <button
          onClick={() => onClose(item.id)}
          className="shrink-0 text-slate-600 transition hover:text-slate-300"
          aria-label="关闭提示"
        >
          ✕
        </button>
      </div>
      <div
        className={`toast-bar absolute bottom-0 left-0 h-0.5 ${t.bar}`}
        style={{ animationDuration: `${item.duration}ms` }}
      />
    </div>
  );
}

export function ToastStack({ items, onClose }: { items: ToastItem[]; onClose: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[110] flex flex-col gap-2">
      {items.map((it) => (
        <Toast key={it.id} item={it} onClose={onClose} />
      ))}
    </div>
  );
}
