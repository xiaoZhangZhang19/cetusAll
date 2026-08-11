'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Dialog } from './Dialog';
import type { DialogTone } from './Dialog';
import { ToastStack } from './Toast';
import type { ToastItem, ToastTone } from './Toast';

export interface ConfirmOptions {
  title: string;
  message?: string;
  tone?: DialogTone;
  confirmText?: string;
  cancelText?: string;
}

interface UiApi {
  /** 替代 window.confirm，返回用户选择 */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** 单按钮模态提示，需要用户确认后才继续 */
  notify: (opts: Omit<ConfirmOptions, 'cancelText'>) => Promise<void>;
  /** 轻量右上角浮层提示，替代 alert */
  toast: (message: string, tone?: ToastTone, duration?: number) => void;
}

const UiContext = createContext<UiApi | null>(null);

interface PendingDialog extends ConfirmOptions {
  /** 无 cancel 时按 notify 语义渲染单按钮 */
  cancelable: boolean;
  resolve: (ok: boolean) => void;
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seqRef = useRef(0);

  const closeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const api = useMemo<UiApi>(() => ({
    confirm: (opts) =>
      new Promise<boolean>((resolve) => {
        setDialog({ tone: 'warn', ...opts, cancelable: true, resolve });
      }),
    notify: (opts) =>
      new Promise<void>((resolve) => {
        setDialog({ tone: 'info', ...opts, cancelable: false, resolve: () => resolve() });
      }),
    toast: (message, tone = 'info', duration = 4000) => {
      const id = ++seqRef.current;
      setToasts((prev) => [...prev.slice(-3), { id, tone, message, duration }]);
    },
  }), []);

  const settle = (ok: boolean) => {
    dialog?.resolve(ok);
    setDialog(null);
  };

  return (
    <UiContext.Provider value={api}>
      {children}
      <Dialog
        open={dialog !== null}
        tone={dialog?.tone}
        title={dialog?.title ?? ''}
        message={dialog?.message}
        confirmText={dialog?.confirmText}
        cancelText={dialog?.cancelText}
        onCancel={dialog?.cancelable ? () => settle(false) : undefined}
        onConfirm={() => settle(true)}
      />
      <ToastStack items={toasts} onClose={closeToast} />
    </UiContext.Provider>
  );
}

export function useUi(): UiApi {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi 必须在 UiProvider 内使用');
  return ctx;
}
