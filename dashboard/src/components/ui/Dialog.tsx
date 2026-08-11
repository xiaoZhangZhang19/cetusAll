'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export type DialogTone = 'info' | 'warn' | 'danger' | 'success';

const TONE: Record<DialogTone, { ring: string; bar: string; icon: string; glyph: string; confirm: string }> = {
  info:    { ring: 'border-sky-900/60',     bar: 'from-sky-400 to-cyan-500',       icon: 'text-sky-400',     glyph: 'ℹ', confirm: 'bg-sky-600 hover:bg-sky-500' },
  warn:    { ring: 'border-amber-900/60',   bar: 'from-amber-400 to-orange-500',   icon: 'text-amber-400',   glyph: '⚠', confirm: 'bg-amber-600 hover:bg-amber-500' },
  danger:  { ring: 'border-red-900/60',     bar: 'from-red-400 to-rose-500',       icon: 'text-red-400',     glyph: '⚠', confirm: 'bg-red-600 hover:bg-red-500' },
  success: { ring: 'border-emerald-900/60', bar: 'from-emerald-400 to-teal-500',   icon: 'text-emerald-400', glyph: '✓', confirm: 'bg-emerald-600 hover:bg-emerald-500' },
};

export interface DialogProps {
  open: boolean;
  tone?: DialogTone;
  title: string;
  /** 纯文本内容；带 \n 的多行会逐行渲染 */
  message?: string;
  /** 富文本内容，优先级高于 message */
  children?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 省略即为单按钮提示框（alert 语义） */
  onCancel?: () => void;
  onConfirm: () => void;
}

/** 把多行文本渲染成层次分明的段落：`1. xx` 走序号样式，`空行` 转为间距 */
function MessageBody({ message }: { message: string }) {
  const lines = message.split('\n');
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1.5" />;
        const listMatch = /^(\d+)\.\s+(.*)$/.exec(line.trim());
        if (listMatch) {
          return (
            <div key={i} className="flex gap-2.5">
              <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded bg-slate-800 text-[10px] font-semibold text-slate-400">
                {listMatch[1]}
              </span>
              <span className="flex-1 break-words">{listMatch[2]}</span>
            </div>
          );
        }
        return <p key={i} className="break-words">{line}</p>;
      })}
    </div>
  );
}

export function Dialog({
  open, tone = 'info', title, message, children,
  confirmText = '确定', cancelText = '取消', onCancel, onConfirm,
}: DialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const t = TONE[tone];

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (onCancel ?? onConfirm)();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div
      className="dlg-backdrop fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      onClick={() => (onCancel ?? onConfirm)()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`dlg-panel flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border ${t.ring} bg-slate-900/95 shadow-2xl shadow-black/60`}
      >
        <div className="flex items-start gap-3 border-b border-slate-800/80 px-5 py-4">
          <div className={`h-9 w-1 shrink-0 rounded-full bg-gradient-to-b ${t.bar}`} />
          <span className={`mt-0.5 text-base leading-none ${t.icon}`} aria-hidden="true">{t.glyph}</span>
          <h3 className="flex-1 text-sm font-semibold text-white">{title}</h3>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-[13px] leading-6 text-slate-300">
          {children ?? <MessageBody message={message ?? ''} />}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-800/80 bg-slate-950/40 px-5 py-3">
          {onCancel && (
            <button
              onClick={onCancel}
              className="rounded-lg border border-slate-700 px-4 py-1.5 text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
            >
              {cancelText}
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={`rounded-lg px-4 py-1.5 text-xs font-semibold text-white outline-none transition ${t.confirm} focus:ring-2 focus:ring-white/20`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
