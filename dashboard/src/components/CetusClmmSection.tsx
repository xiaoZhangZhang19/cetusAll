'use client';

import { useState, useRef } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

type Status = 'idle' | 'running' | 'completed' | 'failed';

interface RunState {
  status: Status;
  runId?: string;
  output?: string[];
  errorMsg?: string;
  duration?: number;
}

// 常用 SUI 生态 coin type 快捷选项
const SUI_TYPE  = '0x2::sui::SUI';
const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const CETUS_TYPE = '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS';

// 快捷交易对
const QUICK_PAIRS = [
  { label: 'SUI / USDC',  base: SUI_TYPE,  quote: USDC_TYPE  },
  { label: 'SUI / CETUS', base: SUI_TYPE,  quote: CETUS_TYPE },
] as const;

// 各测试参数接口（统一用 coinType 地址）
interface ClmmOpenParams      { baseType: string; quoteType: string; inputTokenType: string; inputAmountUi: string; }
interface ClmmAddParams       { baseType: string; quoteType: string; inputTokenType: string; addMoreAmountUi: string; }
interface ClmmCreateParams    { baseType: string; quoteType: string; }
interface ClmmClaimParams     { baseType: string; quoteType: string; }
interface ClmmZapInParams     { baseType: string; quoteType: string; zapTokenType: string; zapAmountUi: string; }
interface ClmmZapIncreaseParams { baseType: string; quoteType: string; zapTokenType: string; zapAmountUi: string; }
interface ClmmZapOutParams    { baseType: string; quoteType: string; removeTokenType: string; }
interface ClmmRemoveParams    { baseType: string; quoteType: string; removeTokenType: string; }
interface ClmmSwapParams      { inputTokenType: string; outputTokenType: string; inputAmountUi: string; }

// ── 单个测试卡片 Props ─────────────────────────────────────────────────────────

interface ClmmTestCardProps {
  testId: string;
  name: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  tags: string[];
  params: React.ReactNode;
  getParams: () => Record<string, string>;
}

// ── 通用测试卡片组件 ──────────────────────────────────────────────────────────

function ClmmTestCard({ testId, name, description, priority, tags, params, getParams }: ClmmTestCardProps) {
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
        body: JSON.stringify({ testId, project: 'cetus', mode: 'local', clmmParams: getParams() }),
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

// ── 参数输入组件 ──────────────────────────────────────────────────────────────

function TypeInput({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="col-span-2">
      <label className="mb-1 flex items-baseline gap-1.5 text-xs text-slate-400">
        {label}
        {hint && <span className="text-slate-600 normal-case font-normal">{hint}</span>}
      </label>
      <input
        className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 font-mono text-xs text-slate-200 placeholder-slate-600 focus:border-sky-500 focus:outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0x..."
        spellCheck={false}
      />
    </div>
  );
}

function AmountInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-slate-400">{label}</label>
      <input
        className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

// 快捷对 按钮
function QuickPairs({ onSelect, baseType, quoteType }: { onSelect: (base: string, quote: string) => void; baseType: string; quoteType: string }) {
  return (
    <div className="col-span-2 flex flex-wrap gap-1.5">
      {QUICK_PAIRS.map((p) => (
        <button
          key={p.label}
          onClick={() => onSelect(p.base, p.quote)}
          className={`rounded border px-2 py-0.5 text-xs transition
            ${baseType === p.base && quoteType === p.quote
              ? 'border-sky-500 bg-sky-900/40 text-sky-300'
              : 'border-slate-600 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200'}`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

export default function CetusClmmSection() {
  const [openP, setOpenP]         = useState<ClmmOpenParams>({ baseType: SUI_TYPE, quoteType: USDC_TYPE, inputTokenType: SUI_TYPE, inputAmountUi: '0.1' });
  const [addP, setAddP]           = useState<ClmmAddParams>({ baseType: SUI_TYPE, quoteType: USDC_TYPE, inputTokenType: SUI_TYPE, addMoreAmountUi: '0.01' });
  const [createP, setCreateP]     = useState<ClmmCreateParams>({ baseType: SUI_TYPE, quoteType: USDC_TYPE });
  const [claimP, setClaimP]       = useState<ClmmClaimParams>({ baseType: SUI_TYPE, quoteType: USDC_TYPE });
  const [zapInP, setZapInP]       = useState<ClmmZapInParams>({ baseType: SUI_TYPE, quoteType: USDC_TYPE, zapTokenType: SUI_TYPE, zapAmountUi: '0.01' });
  const [zapIncP, setZapIncP]     = useState<ClmmZapIncreaseParams>({ baseType: SUI_TYPE, quoteType: USDC_TYPE, zapTokenType: SUI_TYPE, zapAmountUi: '0.01' });
  const [zapOutP, setZapOutP]     = useState<ClmmZapOutParams>({ baseType: SUI_TYPE, quoteType: USDC_TYPE, removeTokenType: SUI_TYPE });
  const [removeP, setRemoveP]     = useState<ClmmRemoveParams>({ baseType: SUI_TYPE, quoteType: USDC_TYPE, removeTokenType: SUI_TYPE });
  const [swapP, setSwapP]         = useState<ClmmSwapParams>({ inputTokenType: SUI_TYPE, outputTokenType: USDC_TYPE, inputAmountUi: '0.01' });

  const tests: { testId: string; name: string; description: string; priority: 'P0'|'P1'|'P2'; tags: string[]; getParams: () => Record<string,string>; paramsNode: React.ReactNode }[] = [
    {
      testId: 'clmm-open', name: '开仓', description: '在 CLMM 池开设流动性仓位', priority: 'P0', tags: ['clmm'],
      getParams: () => ({ CLMM_POOL_BASE_TYPE: openP.baseType, CLMM_POOL_QUOTE_TYPE: openP.quoteType, CLMM_INPUT_TOKEN_TYPE: openP.inputTokenType, CLMM_INPUT_AMOUNT_UI: openP.inputAmountUi }),
      paramsNode: (
        <div className="grid grid-cols-2 gap-2">
          <QuickPairs baseType={openP.baseType} quoteType={openP.quoteType} onSelect={(b, q) => setOpenP((p) => ({ ...p, baseType: b, quoteType: q }))} />
          <TypeInput label="Base Token" hint="(用于池子筛选)" value={openP.baseType} onChange={(v) => setOpenP((p) => ({ ...p, baseType: v }))} />
          <TypeInput label="Quote Token" hint="(用于池子筛选)" value={openP.quoteType} onChange={(v) => setOpenP((p) => ({ ...p, quoteType: v }))} />
          <TypeInput label="填入金额的 Token" hint="(通常与 Base 相同)" value={openP.inputTokenType} onChange={(v) => setOpenP((p) => ({ ...p, inputTokenType: v }))} />
          <AmountInput label="输入金额" value={openP.inputAmountUi} onChange={(v) => setOpenP((p) => ({ ...p, inputAmountUi: v }))} placeholder="0.1" />
        </div>
      ),
    },
    {
      testId: 'clmm-add', name: '增加流动性', description: '向现有仓位添加流动性', priority: 'P1', tags: ['clmm'],
      getParams: () => ({ CLMM_POOL_BASE_TYPE: addP.baseType, CLMM_POOL_QUOTE_TYPE: addP.quoteType, CLMM_INPUT_TOKEN_TYPE: addP.inputTokenType, CLMM_ADD_MORE_AMOUNT_UI: addP.addMoreAmountUi }),
      paramsNode: (
        <div className="grid grid-cols-2 gap-2">
          <QuickPairs baseType={addP.baseType} quoteType={addP.quoteType} onSelect={(b, q) => setAddP((p) => ({ ...p, baseType: b, quoteType: q }))} />
          <TypeInput label="Base Token" hint="(用于仓位筛选)" value={addP.baseType} onChange={(v) => setAddP((p) => ({ ...p, baseType: v }))} />
          <TypeInput label="Quote Token" hint="(用于仓位筛选)" value={addP.quoteType} onChange={(v) => setAddP((p) => ({ ...p, quoteType: v }))} />
          <TypeInput label="填入金额的 Token" value={addP.inputTokenType} onChange={(v) => setAddP((p) => ({ ...p, inputTokenType: v }))} />
          <AmountInput label="添加金额" value={addP.addMoreAmountUi} onChange={(v) => setAddP((p) => ({ ...p, addMoreAmountUi: v }))} placeholder="0.01" />
        </div>
      ),
    },
    {
      testId: 'clmm-create', name: '创建池子', description: '创建新的 CLMM 流动性池', priority: 'P2', tags: ['clmm', 'create'],
      getParams: () => ({ CLMM_POOL_BASE_TYPE: createP.baseType, CLMM_POOL_QUOTE_TYPE: createP.quoteType }),
      paramsNode: (
        <div className="grid grid-cols-2 gap-2">
          <QuickPairs baseType={createP.baseType} quoteType={createP.quoteType} onSelect={(b, q) => setCreateP({ baseType: b, quoteType: q })} />
          <TypeInput label="Base Token" value={createP.baseType} onChange={(v) => setCreateP((p) => ({ ...p, baseType: v }))} />
          <TypeInput label="Quote Token" value={createP.quoteType} onChange={(v) => setCreateP((p) => ({ ...p, quoteType: v }))} />
        </div>
      ),
    },
    {
      testId: 'clmm-claim', name: '领取奖励', description: '领取 CLMM 仓位奖励', priority: 'P1', tags: ['clmm', 'reward'],
      getParams: () => ({ CLMM_POOL_BASE_TYPE: claimP.baseType, CLMM_POOL_QUOTE_TYPE: claimP.quoteType }),
      paramsNode: (
        <div className="grid grid-cols-2 gap-2">
          <QuickPairs baseType={claimP.baseType} quoteType={claimP.quoteType} onSelect={(b, q) => setClaimP({ baseType: b, quoteType: q })} />
          <TypeInput label="Base Token" hint="(仓位筛选用)" value={claimP.baseType} onChange={(v) => setClaimP((p) => ({ ...p, baseType: v }))} />
          <TypeInput label="Quote Token" hint="(仓位筛选用)" value={claimP.quoteType} onChange={(v) => setClaimP((p) => ({ ...p, quoteType: v }))} />
        </div>
      ),
    },
    {
      testId: 'clmm-zap', name: 'Zap In', description: '单币 Zap 进入流动性仓位', priority: 'P1', tags: ['clmm', 'zap'],
      getParams: () => ({ CLMM_POOL_BASE_TYPE: zapInP.baseType, CLMM_POOL_QUOTE_TYPE: zapInP.quoteType, CLMM_ZAP_TOKEN_TYPE: zapInP.zapTokenType, CLMM_ZAP_AMOUNT_UI: zapInP.zapAmountUi }),
      paramsNode: (
        <div className="grid grid-cols-2 gap-2">
          <QuickPairs baseType={zapInP.baseType} quoteType={zapInP.quoteType} onSelect={(b, q) => setZapInP((p) => ({ ...p, baseType: b, quoteType: q }))} />
          <TypeInput label="Base Token" hint="(池子筛选)" value={zapInP.baseType} onChange={(v) => setZapInP((p) => ({ ...p, baseType: v }))} />
          <TypeInput label="Quote Token" hint="(池子筛选)" value={zapInP.quoteType} onChange={(v) => setZapInP((p) => ({ ...p, quoteType: v }))} />
          <TypeInput label="Zap 输入 Token" hint="(单币输入)" value={zapInP.zapTokenType} onChange={(v) => setZapInP((p) => ({ ...p, zapTokenType: v }))} />
          <AmountInput label="Zap 金额" value={zapInP.zapAmountUi} onChange={(v) => setZapInP((p) => ({ ...p, zapAmountUi: v }))} placeholder="0.01" />
        </div>
      ),
    },
    {
      testId: 'clmm-zap-increase', name: 'Zap 加仓', description: '单币 Zap 增加现有仓位', priority: 'P2', tags: ['clmm', 'zap'],
      getParams: () => ({ CLMM_POOL_BASE_TYPE: zapIncP.baseType, CLMM_POOL_QUOTE_TYPE: zapIncP.quoteType, CLMM_ZAP_TOKEN_TYPE: zapIncP.zapTokenType, CLMM_ZAP_AMOUNT_UI: zapIncP.zapAmountUi }),
      paramsNode: (
        <div className="grid grid-cols-2 gap-2">
          <QuickPairs baseType={zapIncP.baseType} quoteType={zapIncP.quoteType} onSelect={(b, q) => setZapIncP((p) => ({ ...p, baseType: b, quoteType: q }))} />
          <TypeInput label="Base Token" hint="(仓位筛选)" value={zapIncP.baseType} onChange={(v) => setZapIncP((p) => ({ ...p, baseType: v }))} />
          <TypeInput label="Quote Token" hint="(仓位筛选)" value={zapIncP.quoteType} onChange={(v) => setZapIncP((p) => ({ ...p, quoteType: v }))} />
          <TypeInput label="Zap 输入 Token" value={zapIncP.zapTokenType} onChange={(v) => setZapIncP((p) => ({ ...p, zapTokenType: v }))} />
          <AmountInput label="Zap 金额" value={zapIncP.zapAmountUi} onChange={(v) => setZapIncP((p) => ({ ...p, zapAmountUi: v }))} placeholder="0.01" />
        </div>
      ),
    },
    {
      testId: 'clmm-zap-out', name: 'Zap Out', description: '移除流动性并转换为单币', priority: 'P2', tags: ['clmm', 'zap'],
      getParams: () => ({ CLMM_POOL_BASE_TYPE: zapOutP.baseType, CLMM_POOL_QUOTE_TYPE: zapOutP.quoteType, CLMM_REMOVE_TOKEN_TYPE: zapOutP.removeTokenType }),
      paramsNode: (
        <div className="grid grid-cols-2 gap-2">
          <QuickPairs baseType={zapOutP.baseType} quoteType={zapOutP.quoteType} onSelect={(b, q) => setZapOutP((p) => ({ ...p, baseType: b, quoteType: q }))} />
          <TypeInput label="Base Token" hint="(仓位筛选)" value={zapOutP.baseType} onChange={(v) => setZapOutP((p) => ({ ...p, baseType: v }))} />
          <TypeInput label="Quote Token" hint="(仓位筛选)" value={zapOutP.quoteType} onChange={(v) => setZapOutP((p) => ({ ...p, quoteType: v }))} />
          <TypeInput label="取出 Token" hint="(转换目标)" value={zapOutP.removeTokenType} onChange={(v) => setZapOutP((p) => ({ ...p, removeTokenType: v }))} />
        </div>
      ),
    },
    {
      testId: 'clmm-remove', name: '移除流动性', description: '从仓位移除流动性', priority: 'P1', tags: ['clmm'],
      getParams: () => ({ CLMM_POOL_BASE_TYPE: removeP.baseType, CLMM_POOL_QUOTE_TYPE: removeP.quoteType, CLMM_REMOVE_TOKEN_TYPE: removeP.removeTokenType }),
      paramsNode: (
        <div className="grid grid-cols-2 gap-2">
          <QuickPairs baseType={removeP.baseType} quoteType={removeP.quoteType} onSelect={(b, q) => setRemoveP((p) => ({ ...p, baseType: b, quoteType: q }))} />
          <TypeInput label="Base Token" hint="(仓位筛选)" value={removeP.baseType} onChange={(v) => setRemoveP((p) => ({ ...p, baseType: v }))} />
          <TypeInput label="Quote Token" hint="(仓位筛选)" value={removeP.quoteType} onChange={(v) => setRemoveP((p) => ({ ...p, quoteType: v }))} />
          <TypeInput label="取出 Token" value={removeP.removeTokenType} onChange={(v) => setRemoveP((p) => ({ ...p, removeTokenType: v }))} />
        </div>
      ),
    },
    {
      testId: 'clmm-swap', name: 'Swap', description: '通过 CLMM 页面悬浮 Swap 组件执行交换', priority: 'P0', tags: ['clmm', 'swap'],
      getParams: () => ({ SWAP_INPUT_TYPE: swapP.inputTokenType, SWAP_OUTPUT_TYPE: swapP.outputTokenType, SWAP_INPUT_AMOUNT_UI: swapP.inputAmountUi }),
      paramsNode: (
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2 flex flex-wrap gap-1.5">
            <button
              onClick={() => setSwapP((p) => ({ ...p, inputTokenType: SUI_TYPE, outputTokenType: USDC_TYPE }))}
              className={`rounded border px-2 py-0.5 text-xs transition ${swapP.inputTokenType === SUI_TYPE && swapP.outputTokenType === USDC_TYPE ? 'border-sky-500 bg-sky-900/40 text-sky-300' : 'border-slate-600 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200'}`}
            >SUI → USDC</button>
            <button
              onClick={() => setSwapP((p) => ({ ...p, inputTokenType: USDC_TYPE, outputTokenType: SUI_TYPE }))}
              className={`rounded border px-2 py-0.5 text-xs transition ${swapP.inputTokenType === USDC_TYPE && swapP.outputTokenType === SUI_TYPE ? 'border-sky-500 bg-sky-900/40 text-sky-300' : 'border-slate-600 bg-slate-800 text-slate-400 hover:border-slate-500 hover:text-slate-200'}`}
            >USDC → SUI</button>
          </div>
          <TypeInput label="输入 Token" hint="(卖出)" value={swapP.inputTokenType} onChange={(v) => setSwapP((p) => ({ ...p, inputTokenType: v }))} />
          <TypeInput label="输出 Token" hint="(买入)" value={swapP.outputTokenType} onChange={(v) => setSwapP((p) => ({ ...p, outputTokenType: v }))} />
          <AmountInput label="输入金额" value={swapP.inputAmountUi} onChange={(v) => setSwapP((p) => ({ ...p, inputAmountUi: v }))} placeholder="0.01" />
        </div>
      ),
    },
  ];

  return (
    <div className="sm:col-span-2 lg:col-span-3 xl:col-span-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {tests.map((t) => (
          <ClmmTestCard key={t.testId} testId={t.testId} name={t.name} description={t.description} priority={t.priority} tags={t.tags} params={t.paramsNode} getParams={t.getParams} />
        ))}
      </div>
    </div>
  );
}
