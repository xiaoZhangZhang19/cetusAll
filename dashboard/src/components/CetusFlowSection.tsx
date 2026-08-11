'use client';

/**
 * 串联执行（Flow）区块。
 *
 * 左侧勾选功能，右侧编排执行顺序，支持上下移动、失败中断标记、保存为模板。
 * 执行走 /api/flow/run，前端轮询解析每步实时状态。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FLOW_QUICK_PAIRS,
  STEP_PARAM_SCHEMA,
  STEP_STATUS_META,
  type FlowCatalogGroup,
  type FlowRunStatus,
  type FlowStepConfig,
  type FlowTemplate,
} from '@/lib/flow';
import { fetchRouteNames } from '@/lib/cetus-routes';
import { useUi } from '@/components/ui/DialogProvider';

interface DraftStep extends FlowStepConfig {
  name: string;
  groupLabel: string;
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '-';
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m${sec}s` : `${sec}s`;
}

function downloadLog(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function LoadingSpinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(id);
  }, [startedAt]);
  return <span className="tabular-nums">{formatDuration(elapsed * 1000)}</span>;
}

/** 步骤级参数表单：留空的字段回退到 .env 默认值 */
function StepParamForm({
  stepId,
  env,
  availableRoutes,
  onChange,
  onClear,
  onClose,
}: {
  stepId: string;
  env?: Record<string, string>;
  availableRoutes: string[];
  onChange: (key: string, value: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const schema = STEP_PARAM_SCHEMA[stepId];
  if (!schema) return null;

  const routesKey = 'SELECTED_CETUS_ROUTES';
  const selected = (env?.[routesKey] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const testAll = env?.TEST_ALL_ROUTES === 'true';

  function toggleRoute(name: string) {
    const next = selected.includes(name)
      ? selected.filter((r) => r !== name)
      : [...selected, name];
    onChange(routesKey, next.join(','));
  }

  return (
    <div className="mt-2 space-y-2.5 rounded-lg border border-sky-800/60 bg-slate-950/60 p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-sky-300">{schema.label} · 参数配置</span>
        <div className="flex items-center gap-2">
          <button onClick={onClear} className="text-[10px] text-slate-500 transition hover:text-red-400">
            重置为默认
          </button>
          <button onClick={onClose} className="text-[10px] text-slate-500 transition hover:text-white">
            收起
          </button>
        </div>
      </div>

      {/* 快捷代币对 */}
      <div className="flex flex-wrap gap-1">
        {FLOW_QUICK_PAIRS.map((p) => {
          const active =
            env?.ROUTE_SWAP_INPUT_TYPE === p.input && env?.ROUTE_SWAP_OUTPUT_TYPE === p.output;
          return (
            <button
              key={p.label}
              onClick={() => {
                onChange('ROUTE_SWAP_INPUT_TYPE', p.input);
                onChange('ROUTE_SWAP_OUTPUT_TYPE', p.output);
              }}
              className={`rounded border px-1.5 py-0.5 text-[10px] transition ${
                active
                  ? 'border-sky-500 bg-sky-950/60 text-sky-300'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* 文本与开关字段 */}
      <div className="grid gap-2 sm:grid-cols-2">
        {schema.fields
          .filter((f) => f.type === 'text')
          .map((f) => (
            <label key={f.key} className="block">
              <span className="mb-0.5 block text-[10px] text-slate-500">{f.label}</span>
              <input
                value={env?.[f.key] ?? ''}
                onChange={(e) => onChange(f.key, e.target.value)}
                placeholder={f.placeholder}
                className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 outline-none transition focus:border-sky-500"
              />
            </label>
          ))}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {schema.fields
          .filter((f) => f.type === 'bool')
          .map((f) => (
            <label key={f.key} className="flex items-center gap-1.5 text-[10px] text-slate-400">
              <input
                type="checkbox"
                checked={env?.[f.key] === 'true'}
                onChange={(e) => onChange(f.key, e.target.checked ? 'true' : '')}
                className="h-3 w-3 accent-sky-500"
              />
              {f.label}
              {f.key === 'EXECUTE_SWAP' && env?.EXECUTE_SWAP === 'true' && (
                <span className="rounded bg-orange-600/30 px-1 text-orange-400">⚠ 真实交易</span>
              )}
            </label>
          ))}
      </div>

      {/* 路由多选 */}
      {!testAll && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] text-slate-500">
              选择路由 {selected.length}/{availableRoutes.length}
              {selected.length === 0 && (
                <span className="ml-1 text-amber-500/80">留空 → 只测 DeepBook V3 单路由</span>
              )}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => onChange(routesKey, availableRoutes.join(','))}
                className="text-[10px] text-slate-500 transition hover:text-sky-400"
              >
                全选
              </button>
              <button
                onClick={() => onChange(routesKey, '')}
                className="text-[10px] text-slate-500 transition hover:text-sky-400"
              >
                清空
              </button>
            </div>
          </div>
          <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
            {availableRoutes.map((name) => (
              <button
                key={name}
                onClick={() => toggleRoute(name)}
                className={`rounded border px-1.5 py-0.5 text-[10px] transition ${
                  selected.includes(name)
                    ? 'border-sky-600 bg-sky-950/60 text-sky-300'
                    : 'border-slate-700 text-slate-500 hover:border-slate-500'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function CetusFlowSection({ appUrl }: { appUrl?: string }) {
  const ui = useUi();
  const [groups, setGroups] = useState<FlowCatalogGroup[]>([]);
  const [templates, setTemplates] = useState<FlowTemplate[]>([]);
  const [draft, setDraft] = useState<DraftStep[]>([]);
  const [flowName, setFlowName] = useState('');
  const [description, setDescription] = useState('');
  const [continueOnFailure, setContinueOnFailure] = useState(true);
  const [delaySec, setDelaySec] = useState(5);
  const [keyword, setKeyword] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** 展开参数表单的步骤位置（同一功能可重复加入，故按位置而非 id 记录） */
  const [paramOpen, setParamOpen] = useState<number | null>(null);
  const [availableRoutes, setAvailableRoutes] = useState<string[]>([]);

  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<FlowRunStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 同步守卫：确认弹窗等待期间按钮仍可点击，state 更新是异步的挡不住重复提交 */
  const submitLockRef = useRef(false);

  const itemIndex = useMemo(() => {
    const map = new Map<string, { name: string; groupLabel: string }>();
    groups.forEach((g) => g.items.forEach((i) => map.set(i.id, { name: i.name, groupLabel: g.groupLabel })));
    return map;
  }, [groups]);

  const loadTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/flow/templates');
      const data = await res.json();
      if (res.ok) setTemplates(data.templates ?? []);
    } catch {
      // 模板加载失败不阻塞主流程
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/flow/catalog');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? '加载功能清单失败');
        setGroups(data.groups ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    loadTemplates();
    // 路由列表随线上开关变化，从 router_v3/status 动态获取
    fetchRouteNames().then(setAvailableRoutes);
  }, [loadTemplates]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const isRunning = starting || run?.status === 'running';

  /** 同一功能允许重复加入（比如加流动性→移除→再加），故用数组而非集合 */
  function addStep(id: string) {
    const meta = itemIndex.get(id);
    if (!meta) return;
    setDraft((prev) => [...prev, { id, name: meta.name, groupLabel: meta.groupLabel }]);
  }

  function removeStep(pos: number) {
    setDraft((prev) => prev.filter((_, i) => i !== pos));
  }

  function moveStep(pos: number, dir: -1 | 1) {
    setDraft((prev) => {
      const next = [...prev];
      const target = pos + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[pos], next[target]] = [next[target], next[pos]];
      return next;
    });
  }

  function toggleStepFlag(pos: number, flag: 'stopOnFailure' | 'disabled') {
    setDraft((prev) => prev.map((s, i) => (i === pos ? { ...s, [flag]: !s[flag] } : s)));
  }

  /** 写入步骤级环境变量；空值表示回退到 .env 默认，直接删除该键 */
  function setStepEnv(pos: number, key: string, value: string) {
    setDraft((prev) =>
      prev.map((s, i) => {
        if (i !== pos) return s;
        const env = { ...(s.env ?? {}) };
        if (value === '') delete env[key];
        else env[key] = value;
        return { ...s, env: Object.keys(env).length > 0 ? env : undefined };
      })
    );
  }

  function clearStepEnv(pos: number) {
    setDraft((prev) => prev.map((s, i) => (i === pos ? { ...s, env: undefined } : s)));
  }

  function loadTemplate(tpl: FlowTemplate) {
    const steps: DraftStep[] = tpl.steps.map((s) => {
      const meta = itemIndex.get(s.id);
      return {
        ...s,
        name: meta?.name ?? s.id,
        groupLabel: meta?.groupLabel ?? '未知分组',
      };
    });
    setParamOpen(null);
    setDraft(steps);
    setFlowName(tpl.name);
    setDescription(tpl.description ?? '');
    setContinueOnFailure(tpl.continueOnFailure ?? true);
    setDelaySec(Math.round((tpl.delayMs ?? 0) / 1000));
    setRun(null);
    setRunId(null);
  }

  async function handleSaveTemplate() {
    if (!flowName.trim()) { setError('请填写流程名称后再保存'); return; }
    if (draft.length === 0) { setError('请至少选择一个功能'); return; }
    setError('');
    try {
      const res = await fetch('/api/flow/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '保存失败');
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeleteTemplate(name: string) {
    const ok = await ui.confirm({
      title: '删除流程模板',
      tone: 'danger',
      message: `确定删除流程模板「${name}」？此操作不可撤销。`,
      confirmText: '删除',
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/flow/templates?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? '删除失败');
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function buildPayload(): FlowTemplate {
    return {
      name: flowName.trim() || '临时流程',
      description: description.trim() || undefined,
      continueOnFailure,
      delayMs: delaySec > 0 ? delaySec * 1000 : undefined,
      steps: draft.map((s) => ({
        id: s.id,
        ...(s.stopOnFailure ? { stopOnFailure: true } : {}),
        ...(s.disabled ? { disabled: true } : {}),
        ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
      })),
    };
  }

  function startPolling(id: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/flow/run?runId=${id}`);
        if (!res.ok) return;
        const data: FlowRunStatus = await res.json();
        setRun(data);
        if (data.status !== 'running' && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        // 忽略瞬时网络错误，下个周期重试
      }
    }, 3_000);
  }

  async function handleRun() {
    if (submitLockRef.current) return;
    const enabled = draft.filter((s) => !s.disabled);
    if (enabled.length === 0) { setError('请至少选择一个启用的功能'); return; }

    submitLockRef.current = true;
    const confirmed = await ui.confirm({
      title: `串联执行 ${enabled.length} 个功能`,
      tone: 'warn',
      message:
        `将按以下顺序依次执行：\n\n` +
        enabled.map((s, i) => `${i + 1}. ${s.name}`).join('\n') +
        `\n\n失败策略：${continueOnFailure ? '继续执行后续步骤' : '立即中断'}\n` +
        `会依次打开浏览器并发起真实链上交易。`,
      confirmText: '开始执行',
    });
    if (!confirmed) { submitLockRef.current = false; return; }

    setError('');
    setStarting(true);
    setRun(null);
    try {
      const res = await fetch('/api/flow/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: buildPayload(), ...(appUrl ? { appUrl } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '启动失败');
      setRunId(data.runId);
      setStartedAt(Date.now());
      startPolling(data.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
      submitLockRef.current = false;
    }
  }

  async function handleAbort() {
    if (!runId) return;
    const ok = await ui.confirm({
      title: '中止当前流程',
      tone: 'danger',
      message: '正在执行的步骤会被强制终止，已完成的步骤结果保留。',
      confirmText: '中止',
    });
    if (!ok) return;
    try {
      await fetch(`/api/flow/run?runId=${runId}`, { method: 'DELETE' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const filteredGroups = keyword.trim()
    ? groups
        .map((g) => ({
          ...g,
          items: g.items.filter(
            (i) => i.name.includes(keyword.trim()) || i.id.includes(keyword.trim().toLowerCase())
          ),
        }))
        .filter((g) => g.items.length > 0)
    : groups;

  const totalCount = groups.reduce((s, g) => s + g.items.length, 0);
  const displaySteps = run?.steps?.length ? run.steps : null;

  return (
    <section className="rounded-xl bg-slate-900 p-5">
      {/* 标题 */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🔗</span>
          <div>
            <h3 className="text-lg font-bold text-white">串联执行</h3>
            <p className="text-xs text-slate-400">
              勾选已有功能并排定顺序，逐个串联执行 · 共 {totalCount} 项可选
            </p>
          </div>
        </div>
        {run?.summary && (
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full border border-emerald-700 px-2.5 py-1 text-emerald-400">
              通过 {run.summary.passed}
            </span>
            <span className="rounded-full border border-red-800 px-2.5 py-1 text-red-400">
              失败 {run.summary.failed}
            </span>
            <span className="rounded-full border border-slate-700 px-2.5 py-1 text-slate-400">
              跳过 {run.summary.skipped}
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          ⚠ {error}
        </div>
      )}

      {/* 已保存的流程模板 */}
      {templates.length > 0 && (
        <div className="mb-5 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
          <div className="mb-2 text-xs font-semibold text-slate-300">已保存的流程模板</div>
          <div className="flex flex-wrap gap-2">
            {templates.map((tpl) => (
              <div
                key={tpl.name}
                className="group flex items-center gap-1 rounded-lg border border-slate-600 bg-slate-900 pl-3 text-xs"
                title={tpl.description}
              >
                <button
                  onClick={() => loadTemplate(tpl)}
                  disabled={isRunning}
                  className="py-1.5 font-medium text-slate-300 transition hover:text-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {tpl.name}
                  <span className="ml-1.5 text-slate-500">{tpl.steps.length} 步</span>
                </button>
                <button
                  onClick={() => handleDeleteTemplate(tpl.name)}
                  disabled={isRunning}
                  className="px-2 py-1.5 text-slate-600 transition hover:text-red-400 disabled:cursor-not-allowed"
                  title="删除模板"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* 左：功能选择 */}
        <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-3">
          <div className="mb-3 flex items-center gap-2">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索功能名称…"
              className="flex-1 rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs text-white outline-none transition focus:border-sky-500"
            />
            <span className="text-xs text-slate-500">点击加入 →</span>
          </div>

          <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {filteredGroups.map((g) => {
              const open = expanded[g.group] ?? Boolean(keyword.trim());
              return (
                <div key={g.group} className="rounded-lg border border-slate-700/70">
                  <button
                    onClick={() => setExpanded((p) => ({ ...p, [g.group]: !open }))}
                    className="flex w-full items-center justify-between px-3 py-2 text-left transition hover:bg-slate-800/60"
                  >
                    <span className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                      <span>{g.icon ?? '•'}</span>
                      {g.groupLabel}
                      <span className="font-normal text-slate-500">{g.items.length}</span>
                    </span>
                    <span className="text-xs text-slate-500">{open ? '▾' : '▸'}</span>
                  </button>
                  {open && (
                    <div className="border-t border-slate-700/70 p-2">
                      <div className="grid gap-1 sm:grid-cols-2">
                        {g.items.map((item) => {
                          const count = draft.filter((s) => s.id === item.id).length;
                          return (
                            <button
                              key={item.id}
                              onClick={() => addStep(item.id)}
                              disabled={isRunning}
                              title={item.spec}
                              className="flex items-center justify-between gap-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-left text-xs text-slate-300 transition hover:border-sky-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <span className="truncate">{item.name}</span>
                              {count > 0 && (
                                <span className="shrink-0 rounded bg-sky-600 px-1 text-[10px] font-bold text-white">
                                  {count}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {filteredGroups.length === 0 && (
              <p className="py-8 text-center text-xs text-slate-500">没有匹配的功能</p>
            )}
          </div>
        </div>

        {/* 右：执行顺序与运行 */}
        <div className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-800/30 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300">
              执行顺序 <span className="font-normal text-slate-500">{draft.length} 步</span>
            </span>
            {draft.length > 0 && !isRunning && (
              <button
                onClick={() => { setDraft([]); setRun(null); }}
                className="text-xs text-slate-500 transition hover:text-red-400"
              >
                清空
              </button>
            )}
          </div>

          <div className="max-h-[300px] min-h-[120px] space-y-1.5 overflow-y-auto pr-1">
            {draft.length === 0 && (
              <p className="py-10 text-center text-xs text-slate-500">
                从左侧点击功能加入执行序列
                <br />
                <span className="text-slate-600">同一功能可重复加入</span>
              </p>
            )}
            {draft.map((step, pos) => {
              const live = displaySteps?.find((s) => s.index === pos + 1);
              const meta = STEP_STATUS_META[live?.status ?? 'pending'];
              return (
                <div
                  key={`${step.id}-${pos}`}
                  className={`rounded-lg border px-2.5 py-2 transition ${
                    live?.status === 'running'
                      ? 'border-blue-600 bg-blue-950/30'
                      : live?.status === 'failed'
                        ? 'border-red-800 bg-red-950/20'
                        : 'border-slate-700 bg-slate-900'
                  } ${step.disabled ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-4 shrink-0 text-center text-xs ${meta.cls}`}>
                      {live?.status === 'running' ? <LoadingSpinner /> : meta.icon}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-500">{pos + 1}.</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-slate-200">{step.name}</div>
                      <div className="truncate text-[10px] text-slate-500">
                        {step.groupLabel}
                        {STEP_PARAM_SCHEMA[step.id] && (
                          <span className={`ml-1.5 ${step.env ? 'text-sky-400' : 'text-amber-500/80'}`}>
                            · {step.env ? '自定义参数' : '默认参数'}
                          </span>
                        )}
                        {live?.durationMs !== undefined && live.status !== 'pending' && (
                          <span className="ml-1.5 text-slate-400">· {formatDuration(live.durationMs)}</span>
                        )}
                      </div>
                    </div>
                    {!isRunning && (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          onClick={() => moveStep(pos, -1)}
                          disabled={pos === 0}
                          className="rounded px-1 text-xs text-slate-500 transition hover:text-white disabled:opacity-30"
                          title="上移"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => moveStep(pos, 1)}
                          disabled={pos === draft.length - 1}
                          className="rounded px-1 text-xs text-slate-500 transition hover:text-white disabled:opacity-30"
                          title="下移"
                        >
                          ↓
                        </button>
                        {STEP_PARAM_SCHEMA[step.id] && (
                          <button
                            onClick={() => setParamOpen(paramOpen === pos ? null : pos)}
                            className={`rounded px-1 text-[10px] transition ${
                              step.env ? 'text-sky-400' : 'text-slate-600 hover:text-slate-400'
                            }`}
                            title={step.env ? '已自定义参数，点击编辑' : '配置该步骤参数'}
                          >
                            ⚙
                          </button>
                        )}
                        <button
                          onClick={() => toggleStepFlag(pos, 'stopOnFailure')}
                          className={`rounded px-1 text-[10px] transition ${
                            step.stopOnFailure ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'
                          }`}
                          title="失败即中断整条流程"
                        >
                          ⛔
                        </button>
                        <button
                          onClick={() => toggleStepFlag(pos, 'disabled')}
                          className={`rounded px-1 text-[10px] transition ${
                            step.disabled ? 'text-slate-300' : 'text-slate-600 hover:text-slate-400'
                          }`}
                          title="保留但本次不执行"
                        >
                          ⏸
                        </button>
                        <button
                          onClick={() => removeStep(pos)}
                          className="rounded px-1 text-xs text-slate-600 transition hover:text-red-400"
                          title="移除"
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>
                  {paramOpen === pos && !isRunning && (
                    <StepParamForm
                      stepId={step.id}
                      env={step.env}
                      availableRoutes={availableRoutes}
                      onChange={(k, v) => setStepEnv(pos, k, v)}
                      onClear={() => clearStepEnv(pos)}
                      onClose={() => setParamOpen(null)}
                    />
                  )}
                  {live?.errorLines && live.errorLines.length > 0 && (
                    <div className="mt-1.5 border-t border-red-900/50 pt-1.5">
                      {live.errorLines.slice(0, 2).map((line, i) => (
                        <p key={i} className="truncate text-[10px] text-red-400" title={line}>
                          ↳ {line}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 流程配置 */}
          <div className="space-y-2 border-t border-slate-700 pt-3">
            <div className="flex gap-2">
              <input
                value={flowName}
                onChange={(e) => setFlowName(e.target.value)}
                disabled={isRunning}
                placeholder="流程名称（保存模板时必填）"
                className="flex-1 rounded-lg border border-slate-600 bg-slate-900 px-2.5 py-1.5 text-xs text-white outline-none transition focus:border-sky-500 disabled:opacity-50"
              />
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={isRunning}
                placeholder="说明（可选）"
                className="flex-1 rounded-lg border border-slate-600 bg-slate-900 px-2.5 py-1.5 text-xs text-white outline-none transition focus:border-sky-500 disabled:opacity-50"
              />
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-1.5 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={continueOnFailure}
                  onChange={(e) => setContinueOnFailure(e.target.checked)}
                  disabled={isRunning}
                  className="h-3.5 w-3.5 accent-sky-500"
                />
                失败后继续执行
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-400">
                步骤间隔
                <input
                  type="number"
                  min={0}
                  max={120}
                  value={delaySec}
                  onChange={(e) => setDelaySec(Math.max(0, Number(e.target.value) || 0))}
                  disabled={isRunning}
                  className="w-14 rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-center text-xs text-white outline-none focus:border-sky-500 disabled:opacity-50"
                />
                秒
              </label>
              <span className="text-xs text-slate-600">⛔ 失败中断 · ⏸ 跳过本步</span>
            </div>
          </div>

          {/* 运行状态 */}
          {isRunning && (
            <div className="flex items-center gap-2 rounded-lg border border-blue-800 bg-blue-950/30 px-3 py-2 text-xs text-blue-300">
              <LoadingSpinner />
              {starting ? '正在启动流程…' : <>流程执行中 · 已用 <ElapsedTimer startedAt={startedAt} /></>}
            </div>
          )}
          {run && run.status !== 'running' && run.summary && (
            <div
              className={`rounded-lg border px-3 py-2 text-xs ${
                run.summary.failed > 0
                  ? 'border-red-800 bg-red-950/30 text-red-300'
                  : 'border-emerald-800 bg-emerald-950/30 text-emerald-300'
              }`}
            >
              {run.summary.failed > 0 ? '❌ 流程完成，存在失败步骤' : '✅ 流程全部通过'}
              <span className="ml-1.5 text-slate-400">
                · 总计 {run.summary.total} · 耗时 {formatDuration(run.duration)}
                {run.summary.aborted && ' · 已提前中断'}
              </span>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleRun}
              disabled={isRunning || draft.length === 0}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                isRunning || draft.length === 0
                  ? 'cursor-not-allowed bg-slate-700 text-slate-400'
                  : 'bg-sky-600 text-white hover:bg-sky-500 active:bg-sky-700'
              }`}
            >
              {isRunning ? <><LoadingSpinner />执行中</> : <>▶ 串联执行</>}
            </button>
            {isRunning && !starting && (
              <button
                onClick={handleAbort}
                className="rounded-lg border border-red-800 px-3 py-2 text-xs text-red-400 transition hover:bg-red-950/40"
              >
                中止
              </button>
            )}
            <button
              onClick={handleSaveTemplate}
              disabled={isRunning || draft.length === 0}
              className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300 transition hover:border-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              💾 保存模板
            </button>
            {run && run.output.length > 0 && (
              <button
                onClick={() => setShowLog(true)}
                className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300 transition hover:border-slate-400 hover:text-white"
              >
                📄 日志
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 日志弹窗 */}
      {showLog && run && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setShowLog(false)}
        >
          <div
            className="relative max-h-[80vh] w-full max-w-4xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-700 px-6 py-4">
              <div>
                <h3 className="text-lg font-semibold text-white">{run.flowName} · 执行日志</h3>
                <p className="mt-1 text-xs text-slate-400">
                  {run.status === 'running' ? '执行中…' : '已结束'} · 耗时 {formatDuration(run.duration)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => downloadLog(`flow-${run.runId}.txt`, run.output.join(''))}
                  className="rounded-lg border border-slate-600 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-slate-400 hover:text-white"
                >
                  ⬇ 下载日志
                </button>
                <button onClick={() => setShowLog(false)} className="text-slate-400 transition hover:text-white">
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="overflow-y-auto p-6" style={{ maxHeight: 'calc(80vh - 120px)' }}>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-slate-300">
                {run.output.join('').replace(/##FLOW_\w+:[\s\S]*?##\r?\n?/g, '')}
              </pre>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
