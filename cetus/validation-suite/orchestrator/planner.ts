/**
 * 依赖规划器：把「数组顺序隐含的依赖」提升为可校验、可推理的资源图。
 *
 * 职责边界：
 * - 静态阶段（plan 前）：补齐步骤实例键、校验顺序合法性与循环依赖、可选自动排序。
 * - 运行阶段（每步前后）：维护资源可用性台账，判定某步是否应被封锁。
 *
 * 不做的事：不查链上真实状态（那是第二层门禁的职责），
 * 只依据「本次流程内谁产出、谁消费」做推理，因此对单步流程零影响。
 */

import { findCatalogItem, resourceLabel } from './catalog.js';
import type { CatalogItem, DependencyIssue, FlowDefinition, FlowStep } from './types.js';

/** 步骤实例：FlowStep 与其 CatalogItem 的绑定，key 保证唯一 */
export interface PlannedStep {
  key: string;
  step: FlowStep;
  item: CatalogItem;
}

/** 为流程步骤补齐唯一实例键；已显式指定 key 的沿用，冲突时后缀去重 */
export function planSteps(flow: FlowDefinition): PlannedStep[] {
  const used = new Set<string>();

  return flow.steps.map((step, i) => {
    const item = findCatalogItem(step.id);
    if (!item) throw new Error(`流程「${flow.name}」包含未知功能 id: ${step.id}`);

    let key = step.key ?? `${step.id}#${i + 1}`;
    while (used.has(key)) key = `${key}'`;
    used.add(key);

    return { key, step, item };
  });
}

/** 该资源在流程内是否有任何步骤能产出（用于区分"顺序错"和"依赖账户既有状态"） */
function providersOf(planned: PlannedStep[], resource: string): PlannedStep[] {
  return planned.filter((p) => p.item.provides?.includes(resource));
}

/**
 * 静态校验流程顺序。
 *
 * error：流程内明确存在产出者，但排在消费者之后 —— 这必然是编排错误。
 * warning：流程内无人产出，依赖账户既有状态 —— 合法但需提醒（可能余额/仓位不足）。
 */
export function validateOrder(planned: PlannedStep[]): DependencyIssue[] {
  const issues: DependencyIssue[] = [];

  planned.forEach((current, index) => {
    if (current.step.disabled || current.step.ignoreDeps) return;

    for (const resource of current.item.requires ?? []) {
      const providers = providersOf(planned, resource);
      const upstream = providers.filter(
        (p) => planned.indexOf(p) < index && !p.step.disabled
      );
      if (upstream.length > 0) continue;

      const downstream = providers.filter((p) => planned.indexOf(p) > index);
      if (downstream.length > 0) {
        issues.push({
          level: 'error',
          key: current.key,
          index: index + 1,
          name: current.item.name,
          message: `需要「${resourceLabel(resource)}」，但产出它的 ${downstream
            .map((p) => `第 ${planned.indexOf(p) + 1} 步 ${p.item.name}`)
            .join('、')} 排在后面，需要调整顺序`
        });
      } else {
        issues.push({
          level: 'warning',
          key: current.key,
          index: index + 1,
          name: current.item.name,
          message: `需要账户已有「${resourceLabel(resource)}」，本流程中没有步骤会创建它`
        });
      }
    }
  });

  const cycles = sortByDependency(planned).cycles;
  if (cycles.length > 0) {
    const names = cycles
      .map((k) => planned.find((p) => p.key === k))
      .filter((p): p is PlannedStep => p !== undefined)
      .map((p) => p.item.name);
    const first = planned.find((p) => p.key === cycles[0]);
    issues.push({
      level: 'error',
      key: cycles[0],
      index: first ? planned.indexOf(first) + 1 : 1,
      name: first?.item.name ?? cycles[0],
      message: `存在循环依赖，涉及：${names.join('、')}`
    });
  }

  return issues.concat(validateDestructive(planned));
}

/**
 * 破坏性步骤必须是同资源的最后一个消费者。
 *
 * 这是最容易静默失效的一类问题：zap-out 关闭整个仓位后，
 * 后面的 remove-liquidity / claim 会因"找不到仓位"失败，
 * 但表象是功能 bug 而非编排错误。
 */
function validateDestructive(planned: PlannedStep[]): DependencyIssue[] {
  const issues: DependencyIssue[] = [];
  const active = planned.filter((p) => !p.step.disabled);

  active.forEach((destroyer, i) => {
    if (!destroyer.item.destructive) return;
    const killed = destroyer.item.consumes ?? [];

    for (const resource of killed) {
      const rest = active.slice(i + 1);
      // 逐个判断：某使用者之前若已有重建步骤，它就是安全的。
      // 只看"后面某处有重建"会漏报重建晚于使用者的情况。
      const laterUsers = rest.filter((p, j) => {
        if (!p.item.requires?.includes(resource) || p.step.ignoreDeps) return false;
        return !rest.slice(0, j).some((q) => q.item.provides?.includes(resource));
      });
      if (laterUsers.length === 0) continue;

      issues.push({
        level: 'error',
        key: destroyer.key,
        index: planned.indexOf(destroyer) + 1,
        name: destroyer.item.name,
        message: `会清空「${resourceLabel(resource)}」，但后面的 ${laterUsers
          .map((p) => p.item.name)
          .join('、')} 还需要它，应移到这些步骤之后`
      });
    }
  });

  return issues;
}

/** 排序结果：有环时 steps 退回原顺序，cycles 列出环内步骤 */
export interface SortOutcome {
  steps: PlannedStep[];
  cycles: string[];
  /** 排序后顺序是否真的发生了变化 */
  changed: boolean;
}

/**
 * 依赖感知的稳定排序：仅在必要时移动步骤，尽量保留用户编排的原始顺序。
 *
 * 规则优先级：
 *   1. provides 先于 requires（生产者前置）
 *   2. destructive 后于同资源的所有 requires（破坏者垫底）
 * 输入顺序作为同优先级下的稳定 tie-breaker。
 */
export function sortByDependency(planned: PlannedStep[]): SortOutcome {
  const indegree = new Map<string, number>();
  const edges = new Map<string, Set<string>>();
  const byKey = new Map(planned.map((p) => [p.key, p]));

  for (const p of planned) {
    indegree.set(p.key, 0);
    edges.set(p.key, new Set());
  }

  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    const set = edges.get(from)!;
    if (set.has(to)) return;
    set.add(to);
    indegree.set(to, indegree.get(to)! + 1);
  };

  const originalIndex = new Map(planned.map((p, i) => [p.key, i]));

  for (const consumer of planned) {
    for (const resource of consumer.item.requires ?? []) {
      const providers = providersOf(planned, resource);
      // requires 是 OR 语义：只要原顺序里已有任一 provider 在前，就不动它。
      // 否则会把所有可替代的 provider 都提前，篡改用户有意的编排
      // （如「下单 → 取消该单 → 再下单」被改成「连下两单 → 只取消一个」）。
      const satisfied = providers.some(
        (p) => originalIndex.get(p.key)! < originalIndex.get(consumer.key)!
      );
      if (!satisfied && providers.length > 0) {
        addEdge(providers[0].key, consumer.key);
      }
      for (const destroyer of planned) {
        if (!destroyer.item.destructive) continue;
        if (!destroyer.item.consumes?.includes(resource)) continue;
        addEdge(consumer.key, destroyer.key);
      }
    }
  }

  const { result, ok } = topoStable(planned, byKey, indegree, edges);
  if (ok) return { steps: result, cycles: [], changed: hasMoved(planned, result) };

  // 有环时排不出全序，保留原顺序并把环内步骤报给调用方
  const settled = new Set(result.map((p) => p.key));
  return {
    steps: planned,
    cycles: planned.filter((p) => !settled.has(p.key)).map((p) => p.key),
    changed: false
  };
}

function hasMoved(before: PlannedStep[], after: PlannedStep[]): boolean {
  return before.some((p, i) => after[i]?.key !== p.key);
}

/** Kahn 算法 + 原始下标优先队列，保证结果稳定且可复现 */
function topoStable(
  planned: PlannedStep[],
  byKey: Map<string, PlannedStep>,
  indegree: Map<string, number>,
  edges: Map<string, Set<string>>
): { result: PlannedStep[]; ok: boolean } {
  const order = new Map(planned.map((p, i) => [p.key, i]));
  const ready = planned.filter((p) => indegree.get(p.key) === 0).map((p) => p.key);
  const result: PlannedStep[] = [];

  while (ready.length > 0) {
    ready.sort((a, b) => order.get(a)! - order.get(b)!);
    const key = ready.shift()!;
    result.push(byKey.get(key)!);
    for (const next of edges.get(key)!) {
      const left = indegree.get(next)! - 1;
      indegree.set(next, left);
      if (left === 0) ready.push(next);
    }
  }

  return { result, ok: result.length === planned.length };
}

/** 某步被封锁的判定结果 */
export interface BlockDecision {
  blocked: boolean;
  missing: string[];
  reason?: string;
}

/**
 * 运行期资源台账。
 *
 * 核心取舍：只要流程内「有人负责产出」某资源，该资源就进入受管状态，
 * 必须真的产出成功才算可用；反之（无人产出）视为账户既有状态，默认放行，
 * 交由 spec 自身的前置检查处理。这样既能精确封锁，又不会误伤单步执行。
 */
export class ResourceLedger {
  private available = new Set<string>();
  private managed = new Set<string>();
  private failedProviders = new Map<string, string[]>();

  constructor(planned: PlannedStep[]) {
    for (const p of planned) {
      if (p.step.disabled) continue;
      for (const r of p.item.provides ?? []) this.managed.add(r);
    }
  }

  /** 判定某步是否应被封锁：受管资源缺失即封锁，非受管资源放行 */
  evaluate(planned: PlannedStep): BlockDecision {
    if (planned.step.ignoreDeps) return { blocked: false, missing: [] };

    const missing = (planned.item.requires ?? []).filter(
      (r) => this.managed.has(r) && !this.available.has(r)
    );
    if (missing.length === 0) return { blocked: false, missing: [] };

    const detail = missing
      .map((r) => {
        const who = this.failedProviders.get(r);
        const label = resourceLabel(r);
        return who ? `${label}（${who.join('、')} 未成功）` : label;
      })
      .join('、');

    return { blocked: true, missing, reason: `缺少前置：${detail}` };
  }

  /** 步骤成功后登记产出，并按 consumes 注销资源 */
  commitSuccess(planned: PlannedStep): void {
    for (const r of planned.item.provides ?? []) {
      this.available.add(r);
      this.failedProviders.delete(r);
    }
    for (const r of planned.item.consumes ?? []) this.available.delete(r);
  }

  /** 步骤失败/封锁后记录责任人，供下游给出可读的封锁原因 */
  commitFailure(planned: PlannedStep): void {
    for (const r of planned.item.provides ?? []) {
      if (this.available.has(r)) continue;
      const who = this.failedProviders.get(r) ?? [];
      who.push(planned.item.name);
      this.failedProviders.set(r, who);
    }
  }
}
