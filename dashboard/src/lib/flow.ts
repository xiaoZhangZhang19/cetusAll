/**
 * 串联执行（Flow）共享类型与常量。
 *
 * 功能清单与流程模板的唯一数据源都在 cetus 侧：
 *   cetus/validation-suite/orchestrator/catalog.json
 *   cetus/validation-suite/orchestrator/flows/*.json
 * dashboard 只做读取与展示，不复制清单数据。
 */

export type FlowStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface FlowCatalogItem {
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
  stopOnFailure?: boolean;
  disabled?: boolean;
  delayMs?: number;
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
  steps: FlowStepConfig[];
  createdAt?: string;
  updatedAt?: string;
}

/** 前端展示用的步骤运行态 */
export interface FlowStepState {
  index: number;
  id: string;
  name: string;
  groupLabel: string;
  status: FlowStepStatus;
  durationMs?: number;
  errorLines?: string[];
  skipReason?: string;
  stopOnFailure?: boolean;
  disabled?: boolean;
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
    aborted: boolean;
  };
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
};
