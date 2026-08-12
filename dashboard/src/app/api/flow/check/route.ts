import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

import type { FlowCheckResult } from '@/lib/flow';

/**
 * 依赖静态检查。
 *
 * 复用 cetus 侧 orchestrator 的 planner（`flow check --json`），
 * dashboard 不重复实现依赖推理，只做转发与展示。
 * 该接口不执行任何测试用例，可随时点击。
 */

const isWin = process.platform === 'win32';
const nodeExec = process.execPath;
const WIN_NPM_CLI = path.join(
  path.dirname(nodeExec),
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js',
);

const CETUS_ROOT = path.resolve(process.cwd(), '..', 'cetus');
const TIMEOUT_MS = 30_000;

export const dynamic = 'force-dynamic';

function runCheck(ids: string[]): Promise<FlowCheckResult> {
  return new Promise((resolve, reject) => {
    const args = ['run', 'flow', '--', 'check', '--json', '--ids', ids.join(',')];
    const child = isWin
      ? spawn(nodeExec, [WIN_NPM_CLI, ...args], { cwd: CETUS_ROOT })
      : spawn('npm', args, { cwd: CETUS_ROOT, shell: true });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('依赖检查超时'));
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', () => {
      clearTimeout(timer);
      // npm 会混入 warning 等噪声，只取输出中的 JSON 段
      const start = stdout.indexOf('{');
      const end = stdout.lastIndexOf('}');
      if (start === -1 || end <= start) {
        reject(new Error(stderr.trim() || '依赖检查未返回结果'));
        return;
      }
      try {
        resolve(JSON.parse(stdout.slice(start, end + 1)) as FlowCheckResult);
      } catch {
        reject(new Error('依赖检查结果解析失败'));
      }
    });
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { ids?: string[] };
    const ids = (body.ids ?? []).filter((id) => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) {
      return NextResponse.json({ error: '请先选择要检查的功能' }, { status: 400 });
    }

    return NextResponse.json(await runCheck(ids));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[flow/check] 依赖检查失败:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
