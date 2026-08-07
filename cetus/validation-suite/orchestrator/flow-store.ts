/**
 * 流程模板持久化：读取 / 校验 / 保存 flows 目录下的 JSON 模板。
 */

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { findCatalogItem } from './catalog.js';
import type { FlowDefinition } from './types.js';

export const FLOW_DIR = path.resolve(process.cwd(), 'validation-suite/orchestrator/flows');

const flowStepSchema = z.object({
  id: z.string().min(1),
  env: z.record(z.string()).optional(),
  stopOnFailure: z.boolean().optional(),
  disabled: z.boolean().optional(),
  delayMs: z.number().int().nonnegative().optional()
});

const flowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  continueOnFailure: z.boolean().optional(),
  env: z.record(z.string()).optional(),
  delayMs: z.number().int().nonnegative().optional(),
  steps: z.array(flowStepSchema).min(1, '流程至少需要一个步骤'),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
});

/** 文件名安全化，避免路径穿越 */
function toFileSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`流程名无法转换为合法文件名: ${name}`);
  return slug;
}

export function flowFilePath(name: string): string {
  return path.join(FLOW_DIR, `${toFileSlug(name)}.json`);
}

export function listFlowNames(): string[] {
  if (!fs.existsSync(FLOW_DIR)) return [];
  return fs
    .readdirSync(FLOW_DIR)
    // 下划线开头的是临时文件（如 dashboard 生成的 _dashboard-run-*），不展示
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

/** 校验步骤 id 是否都能在功能清单里找到 */
function assertStepsResolvable(flow: FlowDefinition): void {
  const unknown = flow.steps.map((s) => s.id).filter((id) => !findCatalogItem(id));
  if (unknown.length > 0) {
    throw new Error(`流程「${flow.name}」包含未知功能 id: ${unknown.join(', ')}`);
  }
}

export function parseFlow(raw: unknown): FlowDefinition {
  const parsed = flowSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new Error(`流程定义校验失败 → ${detail}`);
  }
  const flow = parsed.data as FlowDefinition;
  assertStepsResolvable(flow);
  return flow;
}

/** 按名称或文件路径加载流程模板 */
export function loadFlow(nameOrPath: string): FlowDefinition {
  const candidate = nameOrPath.endsWith('.json')
    ? path.resolve(process.cwd(), nameOrPath)
    : flowFilePath(nameOrPath);

  if (!fs.existsSync(candidate)) {
    const available = listFlowNames();
    const hint = available.length > 0 ? `可用模板: ${available.join(', ')}` : '当前没有任何模板';
    throw new Error(`找不到流程模板: ${nameOrPath}（${hint}）`);
  }

  return parseFlow(JSON.parse(fs.readFileSync(candidate, 'utf8')));
}

export function saveFlow(flow: FlowDefinition): string {
  const validated = parseFlow(flow);
  const target = flowFilePath(validated.name);
  const now = new Date().toISOString();
  const existing = fs.existsSync(target)
    ? (JSON.parse(fs.readFileSync(target, 'utf8')) as FlowDefinition)
    : undefined;

  const payload: FlowDefinition = {
    ...validated,
    createdAt: existing?.createdAt ?? validated.createdAt ?? now,
    updatedAt: now
  };

  fs.mkdirSync(FLOW_DIR, { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

/** 由一串功能 id 快速构造流程模板（用于命令行临时编排后保存） */
export function buildFlowFromIds(
  name: string,
  ids: string[],
  options: { description?: string; continueOnFailure?: boolean; delayMs?: number } = {}
): FlowDefinition {
  return parseFlow({
    name,
    description: options.description,
    continueOnFailure: options.continueOnFailure ?? true,
    delayMs: options.delayMs,
    steps: ids.map((id) => ({ id }))
  });
}
