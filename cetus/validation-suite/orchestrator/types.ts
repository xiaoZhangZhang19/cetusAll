/**
 * 串联执行（Flow Orchestrator）类型定义。
 *
 * 该模块独立于现有 e2e spec，不修改任何既有测试代码：
 * 它只负责「按指定顺序，逐个启动已存在的 spec」并汇总结果。
 */

export type StepStatus = 'passed' | 'failed' | 'skipped';

/** 可被编排的功能项（对应一个已存在的 e2e spec） */
export interface CatalogItem {
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
  /** 仅对本步骤生效的环境变量覆盖，优先级高于 flow.env */
  env?: Record<string, string>;
  /** 本步骤失败时强制中断整条流程（覆盖 flow.continueOnFailure） */
  stopOnFailure?: boolean;
  /** 保留在流程里但本次不执行，结果记为 skipped */
  disabled?: boolean;
  /** 本步骤结束后的等待毫秒数，用于等待链上索引 */
  delayMs?: number;
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
  steps: FlowStep[];
  createdAt?: string;
  updatedAt?: string;
}

/** 单个步骤的执行结果 */
export interface StepResult {
  /** 从 1 开始的执行序号 */
  index: number;
  id: string;
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
  /** 跳过原因 */
  skipReason?: string;
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
  /** 是否因某步骤 stopOnFailure 提前中断 */
  aborted: boolean;
  steps: StepResult[];
}
