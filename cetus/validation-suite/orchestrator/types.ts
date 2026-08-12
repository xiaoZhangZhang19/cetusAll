/**
 * 串联执行（Flow Orchestrator）类型定义。
 *
 * 该模块独立于现有 e2e spec，不修改任何既有测试代码：
 * 它只负责「按指定顺序，逐个启动已存在的 spec」并汇总结果。
 */

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'blocked';

/**
 * 用例间的资源契约。
 *
 * 用抽象资源名（如 limit.openOrder）而非用例 id 表达依赖，
 * 这样多个用例可以互为替代地生产同一资源，编排时不与具体 spec 耦合。
 */
export interface ResourceContract {
  /** 执行成功后在链上产出的资源 */
  provides?: string[];
  /** 执行前必须已存在的资源，缺失则本步骤记为 blocked */
  requires?: string[];
  /** 执行后该资源失效，后续依赖它的步骤会被封锁 */
  consumes?: string[];
  /**
   * 破坏性用例：会把该类资源全量销毁（如 zap-out 关闭整个仓位）。
   * 排序校验时必须排在同资源的其它消费者之后。
   */
  destructive?: boolean;
}

/** 可被编排的功能项（对应一个已存在的 e2e spec） */
export interface CatalogItem extends ResourceContract {
  /** 唯一标识，等于 spec 文件名去掉 .spec.ts */
  id: string;
  /** 中文展示名 */
  name: string;
  /** 所属功能域 */
  group: string;
  /** 功能域展示名 */
  groupLabel: string;
  /** 相对 cetus 根目录的 spec 路径 */
  spec: string;
}

/** 流程中的一个步骤 */
export interface FlowStep {
  /** 对应 CatalogItem.id */
  id: string;
  /**
   * 步骤实例唯一键。同一个 id 可在流程里出现多次（如 margin-close 平多仓后再平空仓），
   * 依赖图必须按实例而非 id 建边，否则重复步骤会互相干扰。
   * 缺省时由 planner 按 `${id}#${序号}` 自动补齐。
   */
  key?: string;
  /** 仅对本步骤生效的环境变量覆盖，优先级高于 flow.env */
  env?: Record<string, string>;
  /** 本步骤失败时强制中断整条流程（覆盖 flow.continueOnFailure） */
  stopOnFailure?: boolean;
  /** 保留在流程里但本次不执行，结果记为 skipped */
  disabled?: boolean;
  /** 本步骤结束后的等待毫秒数，用于等待链上索引 */
  delayMs?: number;
  /**
   * 忽略依赖检查强制执行本步骤。
   * 用于「我确认链上已有前置状态，只是编排器不知道」的场景。
   */
  ignoreDeps?: boolean;
}

/** 可保存复用的流程模板 */
export interface FlowDefinition {
  name: string;
  description?: string;
  /** 失败后是否继续执行后续步骤，默认 true */
  continueOnFailure?: boolean;
  /** 整条流程共享的环境变量覆盖 */
  env?: Record<string, string>;
  /** 每个步骤之间的默认等待毫秒数 */
  delayMs?: number;
  /**
   * 关闭依赖封锁：上游失败也照常执行下游（回退到改造前的行为）。
   * 默认 false，即启用精确封锁。
   */
  ignoreDependencies?: boolean;
  steps: FlowStep[];
  createdAt?: string;
  updatedAt?: string;
}

/** 单个步骤的执行结果 */
export interface StepResult {
  /** 从 1 开始的执行序号 */
  index: number;
  id: string;
  /** 步骤实例唯一键，与 FlowStep.key 对应 */
  key?: string;
  name: string;
  group: string;
  status: StepStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** 日志落盘路径，skipped 时为空 */
  logFile?: string;
  /** 从输出中提取的关键错误行，用于汇总时快速定位 */
  errorLines: string[];
  /** 跳过 / 封锁原因 */
  skipReason?: string;
  /** 被封锁时缺失的资源名，便于定位依赖链断点 */
  missingResources?: string[];
}

/** 整条流程的执行结果 */
export interface FlowRunResult {
  runId: string;
  flowName: string;
  description?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** 因依赖未满足被封锁的步骤数 */
  blocked: number;
  /** 是否因某步骤 stopOnFailure 提前中断 */
  aborted: boolean;
  steps: StepResult[];
}

/** 依赖静态校验发现的问题 */
export interface DependencyIssue {
  /** error 会阻止执行，warning 仅提示 */
  level: 'error' | 'warning';
  /** 相关步骤实例键 */
  key: string;
  /** 该步骤在流程中的序号，从 1 开始 */
  index: number;
  /** 用例展示名，UI 直接使用，不必反查 */
  name: string;
  message: string;
}
