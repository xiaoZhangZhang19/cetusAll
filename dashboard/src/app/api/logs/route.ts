import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

const LOGS_DIR = path.resolve(process.cwd(), '.logs');

async function ensureLogsDir() {
  await fs.mkdir(LOGS_DIR, { recursive: true });
}

export interface LogEntry {
  runId: string;
  testId: string;
  testName?: string;
  project: string;
  status: 'completed' | 'failed';
  startTime: number;
  endTime: number;
  duration: number;
  output: string[];
}

/** GET /api/logs — list or fetch single log */
export async function GET(req: NextRequest) {
  await ensureLogsDir();
  const { searchParams } = req.nextUrl;
  const runId = searchParams.get('runId');
  const download = searchParams.get('download') === '1';

  // Single log detail / download
  if (runId) {
    const filePath = path.join(LOGS_DIR, `${runId}.json`);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const entry: LogEntry = JSON.parse(raw);

      if (download) {
        const text = buildDownloadText(entry);
        return new Response(text, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="${entry.testId}-${runId}.txt"`,
          },
        });
      }

      return NextResponse.json(entry);
    } catch {
      return NextResponse.json({ error: 'Log not found' }, { status: 404 });
    }
  }

  // List logs — newest first, with optional filters
  const project  = searchParams.get('project');
  const testId   = searchParams.get('testId');
  const status   = searchParams.get('status');
  const limitStr = searchParams.get('limit');
  const limit    = limitStr ? parseInt(limitStr, 10) : 100;

  try {
    const files = await fs.readdir(LOGS_DIR);
    const jsonFiles = files.filter((f) => f.endsWith('.json')).sort().reverse();

    const entries: Omit<LogEntry, 'output'>[] = [];
    for (const file of jsonFiles) {
      if (entries.length >= limit) break;
      try {
        const raw = await fs.readFile(path.join(LOGS_DIR, file), 'utf-8');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e: any = JSON.parse(raw);
        if (project && e.project !== project) continue;
        if (testId  && e.testId  !== testId)  continue;
        if (status  && e.status  !== status)  continue;
        // Omit output array from list view for performance
        const { output: _o, ...summary } = e;
        void _o;
        entries.push(summary);
      } catch {
        // skip corrupt files
      }
    }

    return NextResponse.json({ logs: entries, total: entries.length });
  } catch {
    return NextResponse.json({ logs: [], total: 0 });
  }
}

/** DELETE /api/logs?runId=xxx — remove a single log */
export async function DELETE(req: NextRequest) {
  await ensureLogsDir();
  const runId = req.nextUrl.searchParams.get('runId');
  if (!runId) {
    return NextResponse.json({ error: 'runId required' }, { status: 400 });
  }
  const filePath = path.join(LOGS_DIR, `${runId}.json`);
  try {
    await fs.unlink(filePath);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Log not found' }, { status: 404 });
  }
}

function buildDownloadText(entry: LogEntry): string {
  const lines: string[] = [
    '='.repeat(60),
    `Test:      ${entry.testId}`,
    `Project:   ${entry.project}`,
    `Status:    ${entry.status === 'completed' ? 'PASSED ✓' : 'FAILED ✗'}`,
    `Start:     ${new Date(entry.startTime).toLocaleString('zh-CN')}`,
    `End:       ${new Date(entry.endTime).toLocaleString('zh-CN')}`,
    `Duration:  ${(entry.duration / 1000).toFixed(1)}s`,
    '='.repeat(60),
    '',
    ...entry.output,
  ];
  return lines.join('\n');
}
