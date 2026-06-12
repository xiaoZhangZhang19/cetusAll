import { NextRequest, NextResponse } from 'next/server';
import { getRunStatus } from '@/lib/github';

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get('runId');
  const mode = req.nextUrl.searchParams.get('mode') || 'github';
  
  if (!runId) {
    return NextResponse.json({ error: 'runId is required' }, { status: 400 });
  }

  try {
    if (mode === 'local') {
      // Query local test status from trigger API's in-memory storage
      const triggerUrl = new URL('/api/trigger', req.url);
      triggerUrl.searchParams.set('runId', runId);
      
      const response = await fetch(triggerUrl.toString());
      
      if (!response.ok) {
        if (response.status === 404) {
          return NextResponse.json({ error: 'Run not found' }, { status: 404 });
        }
        throw new Error(`Status check error: ${response.statusText}`);
      }

      const data = await response.json();
      
      // Map to common format
      return NextResponse.json({
        status: data.status === 'running' ? 'in_progress' : 'completed',
        conclusion: data.status === 'completed' ? 'success' : data.status === 'failed' ? 'failure' : null,
        duration: data.duration,
        output: data.output,
        html_url: '#', // No URL for local tests
      });
    } else {
      // Query GitHub Actions
      const status = await getRunStatus(Number(runId));
      return NextResponse.json(status);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
