import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

import type { FlowTemplate } from '@/lib/flow';

const FLOW_DIR = path.resolve(
  process.cwd(),
  '..',
  'cetus',
  'validation-suite',
  'orchestrator',
  'flows',
);

/**
 * 文件名安全化：只保留字母数字、中文、连字符，避免路径穿越。
 * 与 cetus 侧 flow-store.ts 的 toFileSlug 保持一致。
 */
function toFileSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('流程名无法转换为合法文件名');
  return slug;
}

/** 二次校验：解析后的绝对路径必须仍在 FLOW_DIR 之内 */
function resolveFlowFile(name: string): string {
  const target = path.join(FLOW_DIR, `${toFileSlug(name)}.json`);
  const rel = path.relative(FLOW_DIR, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('非法的流程名');
  }
  return target;
}

export async function GET() {
  try {
    await fs.mkdir(FLOW_DIR, { recursive: true });
    // 下划线开头的是临时/内部文件（如 _dashboard-run-*），不作为用户模板展示
    const files = (await fs.readdir(FLOW_DIR)).filter(
      (f) => f.endsWith('.json') && !f.startsWith('_'),
    );

    const templates: FlowTemplate[] = [];
    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(FLOW_DIR, file), 'utf8');
        templates.push(JSON.parse(raw) as FlowTemplate);
      } catch {
        console.warn(`[flow/templates] 跳过无法解析的模板: ${file}`);
      }
    }

    templates.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return NextResponse.json({ templates });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `读取流程模板失败: ${message}` }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as FlowTemplate;

    if (!body?.name?.trim()) {
      return NextResponse.json({ error: '流程名不能为空' }, { status: 400 });
    }
    if (!Array.isArray(body.steps) || body.steps.length === 0) {
      return NextResponse.json({ error: '流程至少需要一个步骤' }, { status: 400 });
    }

    const target = resolveFlowFile(body.name);
    const now = new Date().toISOString();

    let createdAt = now;
    try {
      const existing = JSON.parse(await fs.readFile(target, 'utf8')) as FlowTemplate;
      createdAt = existing.createdAt ?? now;
    } catch {
      // 新模板，沿用当前时间
    }

    const payload: FlowTemplate = {
      name: body.name.trim(),
      description: body.description?.trim() || undefined,
      continueOnFailure: body.continueOnFailure ?? true,
      delayMs: body.delayMs,
      steps: body.steps.map((s) => ({
        id: s.id,
        ...(s.stopOnFailure ? { stopOnFailure: true } : {}),
        ...(s.disabled ? { disabled: true } : {}),
        ...(s.delayMs ? { delayMs: s.delayMs } : {}),
        ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
      })),
      createdAt,
      updatedAt: now,
    };

    await fs.mkdir(FLOW_DIR, { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    return NextResponse.json({ success: true, template: payload });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `保存流程模板失败: ${message}` }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const name = req.nextUrl.searchParams.get('name');
    if (!name) {
      return NextResponse.json({ error: '缺少 name 参数' }, { status: 400 });
    }

    const target = resolveFlowFile(name);
    await fs.rm(target, { force: true });
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `删除流程模板失败: ${message}` }, { status: 500 });
  }
}
