/**
 * 串联执行（Flow）共享类型与常量。
 *
 * 功能清单与流程模板的唯一数据源都在 cetus 侧：
 *   cetus/validation-suite/orchestrator/catalog.json
 *   cetus/validation-suite/orchestrator/flows/*.json
 * dashboard 只做读取与展示，不复制清单数据。
 */

export type FlowStepStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'blocked';

/**
 * 用例间的资源契约，与 cetus 侧 catalog.json 的第三个元素一致。
 * 用抽象资源名表达依赖，避免与具体 spec 耦合。
 */
export interface FlowResourceContract {
  provides?: string[];
  requires?: string[];
  consumes?: string[];
  destructive?: boolean;
}

export interface FlowCatalogItem extends FlowResourceContract {
  id: string;
  name: string;
  group: string;
  groupLabel: string;
  spec: string;
}

export interface FlowCatalogGroup {
  group: string;
  groupLabel: string;
  icon?: string;
  items: FlowCatalogItem[];
}

export interface FlowStepConfig {
  id: string;
  /** 步骤实例唯一键，同一功能在流程中出现多次时用于区分 */
  key?: string;
  stopOnFailure?: boolean;
  disabled?: boolean;
  delayMs?: number;
  /** 忽略依赖检查强制执行（确认链上已有前置状态时使用） */
  ignoreDeps?: boolean;
  /**
   * 该步骤专属的环境变量覆盖，优先级高于流程级 env 与 .env。
   * 用于给带参数配置的功能（如多路由兑换执行）单独指定参数。
   */
  env?: Record<string, string>;
}

export interface FlowTemplate {
  name: string;
  description?: string;
  continueOnFailure?: boolean;
  delayMs?: number;
  /** 关闭依赖封锁，回退为上游失败下游照常执行 */
  ignoreDependencies?: boolean;
  steps: FlowStepConfig[];
  createdAt?: string;
  updatedAt?: string;
}

/** 依赖静态校验问题 */
export interface FlowDependencyIssue {
  level: 'error' | 'warning';
  key: string;
  /** 步骤序号，从 1 开始 */
  index: number;
  /** 用例展示名 */
  name: string;
  message: string;
}

/** 依赖检查结果 */
export interface FlowCheckResult {
  total: number;
  issues: FlowDependencyIssue[];
  /** 存在更优顺序时给出的建议序列 */
  suggestion?: { id: string; name: string }[];
}

/** 前端展示用的步骤运行态 */
export interface FlowStepState extends FlowResourceContract {
  index: number;
  id: string;
  key?: string;
  name: string;
  groupLabel: string;
  status: FlowStepStatus;
  durationMs?: number;
  errorLines?: string[];
  skipReason?: string;
  stopOnFailure?: boolean;
  disabled?: boolean;
  /** 被封锁时缺失的资源名 */
  missingResources?: string[];
}

export interface FlowRunStatus {
  runId: string;
  status: 'running' | 'completed' | 'failed';
  flowName: string;
  duration: number;
  steps: FlowStepState[];
  summary?: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    blocked?: number;
    aborted: boolean;
  };
  /** 计划阶段的依赖校验结果 */
  issues?: FlowDependencyIssue[];
  output: string[];
}

export const SUI_COIN_TYPE = '0x2::sui::SUI';
export const USDC_COIN_TYPE =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
export const CETUS_COIN_TYPE =
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS';

export const FLOW_QUICK_PAIRS = [
  { label: 'SUI → USDC', input: SUI_COIN_TYPE, output: USDC_COIN_TYPE },
  { label: 'USDC → SUI', input: USDC_COIN_TYPE, output: SUI_COIN_TYPE },
  { label: 'SUI → CETUS', input: SUI_COIN_TYPE, output: CETUS_COIN_TYPE },
] as const;

/** 支持步骤级参数配置的功能，及其环境变量映射 */
export const STEP_PARAM_SCHEMA: Record<
  string,
  { label: string; fields: { key: string; label: string; type: 'text' | 'bool' | 'routes'; placeholder?: string; hint?: string }[] }
> = {
  'swap-route-execution': {
    label: '多路由兑换执行',
    fields: [
      { key: 'ROUTE_SWAP_INPUT_TYPE', label: 'Input CoinType', type: 'text', placeholder: SUI_COIN_TYPE },
      { key: 'ROUTE_SWAP_OUTPUT_TYPE', label: 'Output CoinType', type: 'text', placeholder: USDC_COIN_TYPE },
      { key: 'ROUTE_SWAP_INPUT_AMOUNT_UI', label: 'Swap 金额', type: 'text', placeholder: '0.1' },
      { key: 'ROUTE_SWAP_SLIPPAGE', label: '滑点 (%)', type: 'text', placeholder: '留空使用页面默认' },
      { key: 'SELECTED_CETUS_ROUTES', label: '选择路由', type: 'routes', hint: '留空则只测 DeepBook V3 单路由' },
      { key: 'TEST_ALL_ROUTES', label: '测试全部路由', type: 'bool' },
      { key: 'EXECUTE_SWAP', label: '发送真实交易（消耗 gas）', type: 'bool' },
    ],
  },
};

export const STEP_STATUS_META: Record<FlowStepStatus, { label: string; icon: string; cls: string }> = {
  pending: { label: '待执行', icon: '○', cls: 'text-slate-500' },
  running: { label: '执行中', icon: '◐', cls: 'text-blue-400' },
  passed: { label: '通过', icon: '✓', cls: 'text-emerald-400' },
  failed: { label: '失败', icon: '✕', cls: 'text-red-400' },
  skipped: { label: '跳过', icon: '⤼', cls: 'text-slate-500' },
  blocked: { label: '依赖未满足', icon: '⛒', cls: 'text-amber-400' },
};

/**
 * 步骤的依赖角色标记。
 *
 * 只用一个字符表达角色，避免在紧凑的步骤列表里堆叠长句：
 *   ↑ 依赖前置   ↓ 产出状态   ✕ 会清空状态
 */
export function contractBadges(
  c: FlowResourceContract,
  labelOf: (r: string) => string,
): { icon: string; text: string; cls: string }[] {
  const badges: { icon: string; text: string; cls: string }[] = [];
  if (c.requires?.length) {
    badges.push({
      icon: '↑',
      text: `需要${c.requires.map(labelOf).join('、')}`,
      cls: 'text-amber-500/90',
    });
  }
  if (c.provides?.length) {
    badges.push({
      icon: '↓',
      text: `产出${c.provides.map(labelOf).join('、')}`,
      cls: 'text-emerald-500/90',
    });
  }
  if (c.destructive && c.consumes?.length) {
    badges.push({
      icon: '✕',
      text: `清空${c.consumes.map(labelOf).join('、')}`,
      cls: 'text-red-400/90',
    });
  }
  return badges;
}
